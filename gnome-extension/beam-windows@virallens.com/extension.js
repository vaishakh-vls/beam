// Exposes window management and keyboard locking to Beam over D-Bus. GNOME
// on Wayland only lets the shell itself move other apps' windows or swallow
// shell shortcuts, so Beam asks this extension.
//
//   gdbus call --session --dest org.virallens.BeamWindows \
//     --object-path /org/virallens/BeamWindows \
//     --method org.virallens.BeamWindows.Apply left-half
//
//   gdbus call --session --dest org.virallens.BeamWindows \
//     --object-path /org/virallens/BeamWindows \
//     --method org.virallens.BeamWindows.LockKeyboard 30

import Clutter from "gi://Clutter";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import Meta from "gi://Meta";
import Shell from "gi://Shell";
import St from "gi://St";
import * as Main from "resource:///org/gnome/shell/ui/main.js";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";

const BUS_NAME = "org.virallens.BeamWindows";
const OBJECT_PATH = "/org/virallens/BeamWindows";
const INTERFACE_XML = `
<node>
  <interface name="org.virallens.BeamWindows">
    <method name="Apply">
      <arg type="s" direction="in" name="action"/>
      <arg type="b" direction="out" name="ok"/>
      <arg type="s" direction="out" name="message"/>
    </method>
    <method name="LockKeyboard">
      <arg type="u" direction="in" name="seconds"/>
      <arg type="b" direction="out" name="ok"/>
      <arg type="s" direction="out" name="message"/>
    </method>
  </interface>
</node>`;

/** A keyboard lock never outlasts this, whatever the caller asks for. */
const MAX_LOCK_SECONDS = 300;

/** Fractions of the work area: [x, y, width, height]. */
const LAYOUTS = {
  "left-half": [0, 0, 1 / 2, 1],
  "right-half": [1 / 2, 0, 1 / 2, 1],
  "top-half": [0, 0, 1, 1 / 2],
  "bottom-half": [0, 1 / 2, 1, 1 / 2],
  "top-left": [0, 0, 1 / 2, 1 / 2],
  "top-right": [1 / 2, 0, 1 / 2, 1 / 2],
  "bottom-left": [0, 1 / 2, 1 / 2, 1 / 2],
  "bottom-right": [1 / 2, 1 / 2, 1 / 2, 1 / 2],
  "left-third": [0, 0, 1 / 3, 1],
  "center-third": [1 / 3, 0, 1 / 3, 1],
  "right-third": [2 / 3, 0, 1 / 3, 1],
  "left-two-thirds": [0, 0, 2 / 3, 1],
  "right-two-thirds": [1 / 3, 0, 2 / 3, 1],
  "almost-maximize": [0.05, 0.05, 0.9, 0.9],
  "reasonable-size": [0.2, 0.15, 0.6, 0.7],
};

/** Windows that belong to Beam itself are never the target. */
function isBeam(win) {
  return (win.get_wm_class() ?? "").toLowerCase() === "beam";
}

export default class BeamWindowsExtension extends Extension {
  enable() {
    this._lock = null;
    this._lastWindow = null;
    this._previous = new WeakMap();
    this._focusId = global.display.connect("notify::focus-window", () => {
      const win = global.display.focus_window;
      if (win && !isBeam(win) && win.get_window_type() === Meta.WindowType.NORMAL) {
        this._lastWindow = win;
      }
    });
    this._dbus = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, this);
    this._dbus.export(Gio.DBus.session, OBJECT_PATH);
    this._ownerId = Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.NONE, null, null, null);
  }

  disable() {
    // Also runs when the screen locks, so a lock can never outlive the session.
    this._unlockKeyboard();
    if (this._focusId) global.display.disconnect(this._focusId);
    this._dbus?.unexport();
    if (this._ownerId) Gio.bus_unown_name(this._ownerId);
    this._focusId = null;
    this._dbus = null;
    this._ownerId = null;
    this._lastWindow = null;
    this._previous = null;
  }

  /** D-Bus method: returns [ok, message]. */
  Apply(action) {
    try {
      return this._apply(action);
    } catch (error) {
      return [false, String(error)];
    }
  }

  /**
   * D-Bus method: covers every monitor and swallows all keys, shell
   * shortcuts included, for `seconds` (at most 300) so the keyboard can be
   * wiped. The mouse can still click Unlock. Returns [ok, message] at once.
   */
  LockKeyboard(seconds) {
    try {
      return this._lockKeyboard(seconds);
    } catch (error) {
      this._unlockKeyboard();
      return [false, String(error)];
    }
  }

  _lockKeyboard(seconds) {
    if (this._lock) return [false, "The keyboard is already locked"];
    if (Main.sessionMode.isLocked) return [false, "The screen is locked"];
    const total = Math.min(MAX_LOCK_SECONDS, Math.floor(seconds));
    if (!(total >= 1)) return [false, "Lock for at least one second"];

    const overlay = new St.Widget({
      name: "beamKeyboardLock",
      reactive: true,
      constraints: new Clutter.BindConstraint({ source: global.stage, coordinate: Clutter.BindCoordinate.ALL }),
    });
    const countdowns = [];
    for (const monitor of Main.layoutManager.monitors) {
      const { pane, countdown } = this._lockPane(monitor);
      overlay.add_child(pane);
      countdowns.push(countdown);
    }
    // Keys stop here, before St's focus handling could reach the button;
    // pointer events still go through so Unlock can be clicked.
    overlay.connect("captured-event", (_actor, event) => {
      const type = event.type();
      return type === Clutter.EventType.KEY_PRESS || type === Clutter.EventType.KEY_RELEASE
        ? Clutter.EVENT_STOP
        : Clutter.EVENT_PROPAGATE;
    });
    // Registered before the grab so any failure below is fully undone.
    const lock = {
      overlay,
      grab: null,
      countdowns,
      endTime: GLib.get_monotonic_time() + total * 1000000,
      timerId: 0,
    };
    this._lock = lock;
    Main.uiGroup.add_child(overlay);

    // Action mode NONE makes the shell's keybinding filter reject every
    // shortcut (Super, Alt+Tab, media keys, workspace and VT switching).
    lock.grab = Main.pushModal(overlay, { actionMode: Shell.ActionMode.NONE });
    if (lock.grab.get_seat_state() !== Clutter.GrabState.ALL) {
      this._unlockKeyboard();
      return [false, "Another window is holding the keyboard. Try again."];
    }

    this._updateCountdown();
    lock.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
      if (this._updateCountdown()) return GLib.SOURCE_CONTINUE;
      lock.timerId = 0;
      if (this._lock === lock) this._unlockKeyboard();
      return GLib.SOURCE_REMOVE;
    });
    return [true, `Keyboard locked for ${total} seconds`];
  }

  /** One monitor's dimmed cover with the message, countdown and Unlock button. */
  _lockPane(monitor) {
    const pane = new St.Widget({
      layout_manager: new Clutter.BinLayout(),
      x: monitor.x,
      y: monitor.y,
      width: monitor.width,
      height: monitor.height,
      style: "background-color: rgba(0, 0, 0, 0.82);",
    });
    const box = new St.BoxLayout({
      vertical: true,
      x_align: Clutter.ActorAlign.CENTER,
      y_align: Clutter.ActorAlign.CENTER,
      style: "spacing: 18px;",
    });
    const label = (text, style) =>
      new St.Label({ text, x_align: Clutter.ActorAlign.CENTER, style: `color: #ffffff; ${style}` });
    box.add_child(label("Keyboard locked for cleaning", "font-size: 26pt; font-weight: bold;"));
    const countdown = label("", 'font-size: 64pt; font-weight: bold; font-feature-settings: "tnum";');
    box.add_child(countdown);
    box.add_child(label("Every key is ignored until the timer ends.", "font-size: 13pt; color: rgba(255, 255, 255, 0.7);"));
    const button = new St.Button({
      label: "Unlock",
      style_class: "button",
      // Not focusable, so no key can ever press it.
      can_focus: false,
      reactive: true,
      track_hover: true,
      x_align: Clutter.ActorAlign.CENTER,
      style: "margin-top: 12px; padding: 8px 32px; font-size: 13pt;",
    });
    button.connect("clicked", () => this._unlockKeyboard());
    box.add_child(button);
    pane.add_child(box);
    return { pane, countdown };
  }

  /** Shows the time left; false once it has run out. */
  _updateCountdown() {
    const lock = this._lock;
    if (!lock) return false;
    const left = Math.ceil((lock.endTime - GLib.get_monotonic_time()) / 1000000);
    if (left <= 0) return false;
    const text = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
    for (const countdown of lock.countdowns) countdown.text = text;
    return true;
  }

  _unlockKeyboard() {
    const lock = this._lock;
    if (!lock) return;
    this._lock = null;
    if (lock.timerId) GLib.source_remove(lock.timerId);
    // Pop before destroying: pushModal's destroy handler would pop it too.
    if (lock.grab) {
      try {
        Main.popModal(lock.grab);
      } catch (error) {
        console.warn(`beam: keyboard unlock: ${error}`);
      }
    }
    lock.overlay.destroy();
  }

  _target() {
    const focused = global.display.focus_window;
    if (focused && !isBeam(focused)) return focused;
    const last = this._lastWindow;
    // The remembered window may have been closed since.
    if (last && last.get_compositor_private()) return last;
    return null;
  }

  _apply(action) {
    const win = this._target();
    if (!win) return [false, "No window to manage"];

    switch (action) {
      case "maximize":
        this._remember(win);
        win.maximize(Meta.MaximizeFlags.BOTH);
        break;
      case "maximize-height":
        this._place(win, (area, frame) => [frame.x, area.y, frame.width, area.height]);
        break;
      case "maximize-width":
        this._place(win, (area, frame) => [area.x, frame.y, area.width, frame.height]);
        break;
      case "center":
        this._place(win, (area, frame) => [
          area.x + (area.width - frame.width) / 2,
          area.y + (area.height - frame.height) / 2,
          frame.width,
          frame.height,
        ]);
        break;
      case "restore": {
        const rect = this._previous.get(win);
        if (!rect) return [false, "Nothing to restore"];
        this._unmaximize(win);
        win.move_resize_frame(true, rect.x, rect.y, rect.width, rect.height);
        this._previous.delete(win);
        break;
      }
      case "minimize":
        win.minimize();
        return [true, "Minimized"];
      case "toggle-fullscreen":
        if (win.is_fullscreen()) win.unmake_fullscreen();
        else win.make_fullscreen();
        break;
      case "next-desktop":
      case "previous-desktop": {
        if (win.is_on_all_workspaces()) return [false, "This window is on every desktop"];
        const index = win.get_workspace().index() + (action === "next-desktop" ? 1 : -1);
        if (index < 0) return [false, "Already on the first desktop"];
        // With dynamic desktops (GNOME's default) the last one is always
        // empty, so moving there makes a new desktop for the window.
        const manager = global.workspace_manager;
        if (index >= manager.get_n_workspaces()) return [false, "Already on the last desktop"];
        // GNOME removes a desktop once it's empty, so a window alone on its
        // desktop gains nothing by moving onto the empty one after it.
        const others = win.get_workspace().list_windows()
          .filter((other) => other !== win && !other.is_on_all_workspaces() && !other.skip_taskbar);
        if (others.length === 0 && index === manager.get_n_workspaces() - 1 && Meta.prefs_get_dynamic_workspaces())
          return [false, "This window already has its own desktop"];
        // Moves there with the window, focused. (Activating a window on
        // another desktop only marks it as wanting attention.)
        const workspace = manager.get_workspace_by_index(index);
        win.change_workspace(workspace);
        workspace.activate_with_focus(win, global.get_current_time());
        return [true, action];
      }
      case "next-display":
      case "previous-display": {
        const count = global.display.get_n_monitors();
        if (count < 2) return [false, "Only one display connected"];
        const step = action === "next-display" ? 1 : count - 1;
        win.move_to_monitor((win.get_monitor() + step) % count);
        break;
      }
      default: {
        const layout = LAYOUTS[action];
        if (!layout) return [false, `Unknown action: ${action}`];
        const [fx, fy, fw, fh] = layout;
        this._place(win, (area) => [
          area.x + area.width * fx,
          area.y + area.height * fy,
          area.width * fw,
          area.height * fh,
        ]);
      }
    }
    win.activate(global.get_current_time());
    return [true, action];
  }

  _remember(win) {
    if (!this._previous.has(win)) this._previous.set(win, win.get_frame_rect());
  }

  _unmaximize(win) {
    if (win.get_maximized()) win.unmaximize(Meta.MaximizeFlags.BOTH);
    if (win.is_fullscreen()) win.unmake_fullscreen();
  }

  /** Moves/resizes using a function of (work area, current frame). */
  _place(win, compute) {
    this._remember(win);
    this._unmaximize(win);
    const area = win.get_work_area_current_monitor();
    const [x, y, width, height] = compute(area, win.get_frame_rect()).map(Math.round);
    win.move_resize_frame(true, x, y, width, height);
  }
}
