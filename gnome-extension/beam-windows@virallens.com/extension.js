// Exposes window management to Beam over D-Bus. GNOME on Wayland only lets
// the shell itself move other apps' windows, so Beam asks this extension.
//
//   gdbus call --session --dest org.virallens.BeamWindows \
//     --object-path /org/virallens/BeamWindows \
//     --method org.virallens.BeamWindows.Apply left-half

import Gio from "gi://Gio";
import Meta from "gi://Meta";
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
  </interface>
</node>`;

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
