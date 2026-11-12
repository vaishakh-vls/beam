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
//
//   gdbus call --session --dest org.virallens.BeamWindows \
//     --object-path /org/virallens/BeamWindows \
//     --method org.virallens.BeamWindows.Confetti
//
//   gdbus call --session --dest org.virallens.BeamWindows \
//     --object-path /org/virallens/BeamWindows \
//     --method org.virallens.BeamWindows.Pointer
//
//   gdbus call --session --dest org.virallens.BeamWindows \
//     --object-path /org/virallens/BeamWindows \
//     --method org.virallens.BeamWindows.ClipboardEvents
//
// Pointer returns where the mouse pointer is, so Beam opens on that display:
// Beam runs through XWayland, which only sees the pointer over Beam itself.
//
// ClipboardEvents answers true: this extension tells Beam each time something
// is copied, by sending "clipboard:changed" to Beam's command socket, so Beam
// doesn't have to keep asking. It also sends "clipboard:watching" when it
// starts and "clipboard:stopped" when it stops (as when the screen locks);
// Beam reads the clipboard itself while it is stopped. Each event ends with
// the shell's monotonic clock ("clipboard:watching:1234567"), so Beam can
// drop one that arrives after a later one.
//
// Apply takes an action, with its value after a colon where it needs one:
// "move-window:100,80", "resize-window:1200,800", "move-to-desktop:3".
//
// It also lets Beam quit before you log out, restart or shut down. Beam draws
// through XWayland, which closes together with the shell, and Electron crashes
// when its display goes away. GNOME warns only the apps that register with its
// session manager, and Electron apps don't, so this extension registers for
// Beam: when the session ends it sends "session:end" to Beam's socket and holds
// the logout until Beam's processes have exited (for at most a few seconds).
// That part stays on while the screen is locked, so a shutdown from the lock
// screen is covered too; everything else is off while locked.

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
    <method name="Confetti">
      <arg type="b" direction="out" name="ok"/>
      <arg type="s" direction="out" name="message"/>
    </method>
    <method name="Pointer">
      <arg type="i" direction="out" name="x"/>
      <arg type="i" direction="out" name="y"/>
    </method>
    <method name="ClipboardEvents">
      <arg type="b" direction="out" name="sent"/>
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

const SESSION_MANAGER = "org.gnome.SessionManager";
const SESSION_PATH = "/org/gnome/SessionManager";
const CLIENT_INTERFACE = "org.gnome.SessionManager.ClientPrivate";
/** How long a logout waits for Beam to quit before it goes on anyway. */
const QUIT_WAIT_MS = 3000;
const QUIT_POLL_MS = 100;

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
  "center-half": [1 / 4, 0, 1 / 2, 1],
  "center-two-thirds": [1 / 6, 0, 2 / 3, 1],
  "first-fourth": [0, 0, 1 / 4, 1],
  "second-fourth": [1 / 4, 0, 1 / 4, 1],
  "third-fourth": [1 / 2, 0, 1 / 4, 1],
  "last-fourth": [3 / 4, 0, 1 / 4, 1],
  "first-three-fourths": [0, 0, 3 / 4, 1],
  "center-three-fourths": [1 / 8, 0, 3 / 4, 1],
  "last-three-fourths": [1 / 4, 0, 3 / 4, 1],
  "top-left-sixth": [0, 0, 1 / 3, 1 / 2],
  "top-center-sixth": [1 / 3, 0, 1 / 3, 1 / 2],
  "top-right-sixth": [2 / 3, 0, 1 / 3, 1 / 2],
  "bottom-left-sixth": [0, 1 / 2, 1 / 3, 1 / 2],
  "bottom-center-sixth": [1 / 3, 1 / 2, 1 / 3, 1 / 2],
  "bottom-right-sixth": [2 / 3, 1 / 2, 1 / 3, 1 / 2],
};

/** Make Larger / Make Smaller change each side by this share of the work area. */
const RESIZE_STEP = 0.1;

const CONFETTI_PIECES = 160;
const CONFETTI_MS = 4500;
/** Each press adds a burst on top of the ones still falling, up to this many at once. */
const MAX_CONFETTI_BURSTS = 8;
const CONFETTI_COLORS = ["#ff3b30", "#ff9500", "#ffcc00", "#34c759", "#00c7be", "#0a84ff", "#5e5ce6", "#bf5af2", "#ff2d55"];

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/** "100,80" → [100, 80], or null unless it is exactly `count` numbers. */
function numbers(text, count) {
  const values = text.split(",").map((part) => Number(part.trim()));
  return values.length === count && values.every(Number.isFinite) ? values : null;
}

/** The window's size, no bigger than the work area. */
function fitted(area, frame) {
  return [Math.min(frame.width, area.width), Math.min(frame.height, area.height)];
}

/** Windows that belong to Beam itself are never the target. */
function isBeam(win) {
  return (win.get_wm_class() ?? "").toLowerCase() === "beam";
}

function beamSocket() {
  return GLib.build_filenamev([GLib.get_user_runtime_dir(), "beam.sock"]);
}

/** Reads /proc/<pid>/stat: [name, state, parent pid], or null once the process is gone. */
function processStat(pid) {
  try {
    const [, bytes] = GLib.file_get_contents(`/proc/${pid}/stat`);
    const stat = new TextDecoder().decode(bytes);
    // "pid (name) state ppid ...": the name can hold spaces and brackets, so split at the last ")".
    const close = stat.lastIndexOf(")");
    const [state, ppid] = stat.slice(close + 2).split(" ");
    return [stat.slice(stat.indexOf("(") + 1, close), state, Number(ppid)];
  } catch {
    return null;
  }
}

/** A process and all its descendants (Beam's zygote, GPU and renderer processes), by PID. */
function processFamily(root) {
  const children = new Map();
  let entries;
  try {
    entries = Gio.File.new_for_path("/proc").enumerate_children("standard::name", Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
  } catch {
    return new Set([root]);
  }
  for (let info = entries.next_file(null); info; info = entries.next_file(null)) {
    const pid = Number(info.get_name());
    if (!Number.isInteger(pid)) continue;
    const ppid = processStat(pid)?.[2];
    if (ppid) children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  entries.close(null);
  const family = new Set([root]);
  for (const pid of family) for (const child of children.get(pid) ?? []) family.add(child);
  return family;
}

/** Still running: there, and not a zombie that has exited but not been reaped yet. */
function alive(pid) {
  const state = processStat(pid)?.[1];
  return state !== undefined && state !== "Z" && state !== "X";
}

/**
 * A client of GNOME's session manager, registered for Beam (see the top of
 * this file). Every QueryEndSession and EndSession gets an answer, as an
 * unanswered client holds up the logout.
 */
class SessionClient {
  constructor() {
    this._path = null;
    this._signalId = 0;
    this._waitId = 0;
    this._deadlineId = 0;
    this._ending = false;
    this._destroyed = false;
    Gio.DBus.session.call(
      SESSION_MANAGER,
      SESSION_PATH,
      SESSION_MANAGER,
      "RegisterClient",
      new GLib.Variant("(ss)", ["beam-windows", ""]),
      new GLib.VariantType("(o)"),
      Gio.DBusCallFlags.NO_AUTO_START,
      -1,
      null,
      (connection, result) => {
        let path;
        try {
          [path] = connection.call_finish(result).deepUnpack();
        } catch {
          // No GNOME session manager here, or the session is already ending.
          return;
        }
        // Disabled before the answer came: don't leave a client nobody answers for.
        if (this._destroyed) {
          unregisterClient(path);
          return;
        }
        this._path = path;
        this._signalId = connection.signal_subscribe(
          SESSION_MANAGER,
          CLIENT_INTERFACE,
          null,
          path,
          null,
          Gio.DBusSignalFlags.NONE,
          (_connection, _sender, _path, _interface, signal) => this._onSignal(signal),
        );
      },
    );
  }

  _onSignal(signal) {
    if (signal === "QueryEndSession") {
      // Beam never objects to a logout.
      this._respond();
    } else if (signal === "EndSession") {
      if (this._ending) return;
      this._ending = true;
      // Whatever happens below, GNOME gets its answer: a client that doesn't
      // answer holds the logout up for a minute and a half.
      this._deadlineId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, QUIT_WAIT_MS + 1000, () => {
        this._deadlineId = 0;
        this._finishEnd();
        return GLib.SOURCE_REMOVE;
      });
      try {
        this._quitBeam();
      } catch (error) {
        console.warn(`beam-windows: ${error}`);
        this._finishEnd();
      }
    }
  }

  /**
   * Tells Beam to quit and answers once Beam's processes have all exited:
   * Beam's socket says which process is listening (Beam's main process), and
   * the helper waits for it and its children, for at most QUIT_WAIT_MS.
   */
  _quitBeam() {
    const file = beamSocket();
    if (!GLib.file_test(file, GLib.FileTest.EXISTS)) {
      this._finishEnd();
      return;
    }
    new Gio.SocketClient().connect_async(Gio.UnixSocketAddress.new(file), null, (client, result) => {
      let connection;
      try {
        connection = client.connect_finish(result);
      } catch {
        // Beam isn't running (its socket file was left behind).
        this._finishEnd();
        return;
      }
      let family;
      try {
        family = processFamily(connection.get_socket().get_credentials().get_unix_pid());
      } catch {
        family = new Set();
      }
      const bytes = new GLib.Bytes(new TextEncoder().encode("session:end"));
      connection.get_output_stream().write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, null, (stream, written) => {
        try {
          stream.write_bytes_finish(written);
        } catch {
          // Beam went away already.
        }
        connection.close_async(GLib.PRIORITY_DEFAULT, null, null);
        if (this._ending) this._waitForExit(family);
      });
    });
  }

  _waitForExit(family) {
    const started = GLib.get_monotonic_time();
    const check = () => {
      const running = [...family].some(alive);
      if (running && GLib.get_monotonic_time() - started < QUIT_WAIT_MS * 1000) return GLib.SOURCE_CONTINUE;
      if (running) console.warn("beam-windows: Beam did not quit before the session ended");
      this._waitId = 0;
      this._finishEnd();
      return GLib.SOURCE_REMOVE;
    };
    if (check() === GLib.SOURCE_CONTINUE) this._waitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, QUIT_POLL_MS, check);
  }

  /** Answers the EndSession, once. */
  _finishEnd() {
    if (!this._ending) return;
    this._ending = false;
    if (this._deadlineId) GLib.source_remove(this._deadlineId);
    if (this._waitId) GLib.source_remove(this._waitId);
    this._deadlineId = 0;
    this._waitId = 0;
    if (!this._destroyed) this._respond();
  }

  _respond() {
    if (!this._path) return;
    Gio.DBus.session.call(
      SESSION_MANAGER,
      this._path,
      CLIENT_INTERFACE,
      "EndSessionResponse",
      new GLib.Variant("(bs)", [true, ""]),
      null,
      Gio.DBusCallFlags.NO_AUTO_START,
      -1,
      null,
      null,
    );
  }

  destroy() {
    this._destroyed = true;
    if (this._waitId) GLib.source_remove(this._waitId);
    if (this._deadlineId) GLib.source_remove(this._deadlineId);
    this._waitId = 0;
    this._deadlineId = 0;
    if (this._signalId) Gio.DBus.session.signal_unsubscribe(this._signalId);
    this._signalId = 0;
    if (this._path) unregisterClient(this._path);
    this._path = null;
  }
}

function unregisterClient(path) {
  Gio.DBus.session.call(
    SESSION_MANAGER,
    SESSION_PATH,
    SESSION_MANAGER,
    "UnregisterClient",
    new GLib.Variant("(o)", [path]),
    null,
    Gio.DBusCallFlags.NO_AUTO_START,
    -1,
    null,
    null,
  );
}

/**
 * Sends a command ref to Beam's socket, the way `beam-run` does, without
 * waiting. Nothing happens when Beam isn't running.
 */
function tellBeam(ref) {
  const file = beamSocket();
  if (!GLib.file_test(file, GLib.FileTest.EXISTS)) return;
  new Gio.SocketClient().connect_async(Gio.UnixSocketAddress.new(file), null, (client, result) => {
    let connection;
    try {
      connection = client.connect_finish(result);
    } catch {
      return;
    }
    const bytes = new GLib.Bytes(new TextEncoder().encode(ref));
    connection.get_output_stream().write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, null, (stream, written) => {
      try {
        stream.write_bytes_finish(written);
      } catch {
        // Beam went away; nothing to tell.
      }
      connection.close_async(GLib.PRIORITY_DEFAULT, null, null);
    });
  });
}

export default class BeamWindowsExtension extends Extension {
  enable() {
    this._session = new SessionClient();
    this._started = false;
    this._modeId = Main.sessionMode.connect("updated", () => this._syncMode());
    this._syncMode();
  }

  disable() {
    if (this._modeId) Main.sessionMode.disconnect(this._modeId);
    this._modeId = null;
    this._stopFeatures();
    this._session?.destroy();
    this._session = null;
  }

  /** Window management, the keyboard lock and clipboard events are off while the screen is locked. */
  _syncMode() {
    if (Main.sessionMode.isLocked) this._stopFeatures();
    else this._startFeatures();
  }

  _startFeatures() {
    if (this._started) return;
    this._started = true;
    this._lock = null;
    this._confettiShows = new Set();
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
    this._selectionId = global.display.get_selection().connect("owner-changed", (_selection, type) => {
      if (type === Meta.SelectionType.SELECTION_CLIPBOARD) tellBeam(`clipboard:changed:${GLib.get_monotonic_time()}`);
    });
    tellBeam(`clipboard:watching:${GLib.get_monotonic_time()}`);
  }

  _stopFeatures() {
    if (!this._started) return;
    this._started = false;
    if (this._selectionId) global.display.get_selection().disconnect(this._selectionId);
    this._selectionId = null;
    tellBeam(`clipboard:stopped:${GLib.get_monotonic_time()}`);
    // Also runs when the screen locks, so a keyboard lock can never outlive the session.
    this._unlockKeyboard();
    for (const show of [...this._confettiShows]) this._stopConfetti(show);
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
   * D-Bus method: confetti bursts from the bottom corners for a few seconds,
   * on top of any still falling. Returns [ok, message].
   */
  Confetti() {
    try {
      return this._confetti();
    } catch (error) {
      return [false, String(error)];
    }
  }

  /** D-Bus method: the pointer's position, in the same layout coordinates as the displays. */
  Pointer() {
    const [x, y] = global.get_pointer();
    return [x, y];
  }

  /** D-Bus method: true, as this version sends clipboard events to Beam. */
  ClipboardEvents() {
    return true;
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

  _apply(request) {
    const [action, value = ""] = request.split(":");

    // These don't act on one window.
    switch (action) {
      case "open-desktop":
        return this._openDesktop(Number(value));
      case "close-desktop":
        return this._closeDesktop(value ? Number(value) : null);
      case "minimize-display":
        return this._minimizeDisplay();
      case "focus-next-display":
      case "focus-previous-display":
        return this._focusDisplay(action === "focus-next-display" ? 1 : -1);
    }

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
        const index = win.get_workspace().index() + (action === "next-desktop" ? 1 : -1);
        if (index < 0) return [false, "Already on the first desktop"];
        if (index >= global.workspace_manager.get_n_workspaces()) return [false, "Already on the last desktop"];
        return this._moveToDesktop(win, index);
      }
      case "move-to-desktop": {
        const number = Number(value);
        if (!(number >= 1)) return [false, "Which desktop?"];
        return this._moveToDesktop(win, number - 1);
      }
      case "next-app-window":
      case "previous-app-window":
        return this._cycleAppWindow(win, action === "next-app-window" ? 1 : -1);
      case "move-up":
        this._place(win, (area, frame) => [frame.x, area.y, ...fitted(area, frame)]);
        break;
      case "move-down":
        this._place(win, (area, frame) => {
          const [width, height] = fitted(area, frame);
          return [frame.x, area.y + area.height - height, width, height];
        });
        break;
      case "move-left":
        this._place(win, (area, frame) => [area.x, frame.y, ...fitted(area, frame)]);
        break;
      case "move-right":
        this._place(win, (area, frame) => {
          const [width, height] = fitted(area, frame);
          return [area.x + area.width - width, frame.y, width, height];
        });
        break;
      case "make-larger":
      case "make-smaller": {
        const direction = action === "make-larger" ? 1 : -1;
        this._place(win, (area, frame) => {
          const width = clamp(frame.width + direction * area.width * RESIZE_STEP, area.width * 0.2, area.width);
          const height = clamp(frame.height + direction * area.height * RESIZE_STEP, area.height * 0.2, area.height);
          // Grows or shrinks around its centre, kept on screen.
          const x = clamp(frame.x + (frame.width - width) / 2, area.x, area.x + area.width - width);
          const y = clamp(frame.y + (frame.height - height) / 2, area.y, area.y + area.height - height);
          return [x, y, width, height];
        });
        break;
      }
      case "move-window": {
        const point = numbers(value, 2);
        if (!point) return [false, "Type the position as X and Y"];
        // From the top-left of the screen's usable area, kept on screen.
        this._place(win, (area, frame) => {
          const [width, height] = fitted(area, frame);
          return [
            clamp(area.x + point[0], area.x, area.x + area.width - width),
            clamp(area.y + point[1], area.y, area.y + area.height - height),
            width,
            height,
          ];
        });
        break;
      }
      case "resize-window": {
        const size = numbers(value, 2);
        if (!size || size[0] < 1 || size[1] < 1) return [false, "Type the size as width and height"];
        this._place(win, (area, frame) => {
          const width = Math.min(size[0], area.width);
          const height = Math.min(size[1], area.height);
          return [
            clamp(frame.x, area.x, area.x + area.width - width),
            clamp(frame.y, area.y, area.y + area.height - height),
            width,
            height,
          ];
        });
        break;
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

  /**
   * Focuses the top window on the next (or previous) display and puts the
   * pointer on it, so typing, scrolling and Beam all go there. On a display
   * with no windows the pointer moves to its centre.
   */
  _focusDisplay(step) {
    const count = global.display.get_n_monitors();
    if (count < 2) return [false, "Only one display connected"];
    const from = this._target()?.get_monitor() ?? global.display.get_current_monitor();
    const monitor = (from + step + count) % count;
    // Includes windows on every desktop, such as those on a secondary display.
    const candidates = global.workspace_manager.get_active_workspace().list_windows().filter((w) =>
      w.get_monitor() === monitor &&
      !w.minimized &&
      !w.skip_taskbar &&
      !isBeam(w) &&
      w.get_window_type() === Meta.WindowType.NORMAL);
    const win = global.display.sort_windows_by_stacking(candidates).at(-1);
    const rect = win ? win.get_frame_rect() : global.display.get_monitor_geometry(monitor);
    if (win) win.activate(global.get_current_time());
    Clutter.get_default_backend().get_default_seat()
      .warp_pointer(Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2));
    return [true, win ? win.get_title() ?? "" : "No windows on that display"];
  }

  /** Moves the window to the desktop at `index` and switches there with it focused. */
  _moveToDesktop(win, index) {
    if (win.is_on_all_workspaces()) return [false, "This window is on every desktop"];
    const manager = global.workspace_manager;
    const current = win.get_workspace().index();
    const dynamic = Meta.prefs_get_dynamic_workspaces();
    if (dynamic) {
      // GNOME keeps one empty desktop at the end; a higher number means that one.
      index = Math.min(index, manager.get_n_workspaces() - 1);
    } else {
      while (manager.get_n_workspaces() <= index) manager.append_new_workspace(false, global.get_current_time());
    }
    if (index === current) return [false, `Already on desktop ${index + 1}`];
    // GNOME removes a desktop once it's empty, so a window alone on its
    // desktop gains nothing by moving onto the empty one after it.
    const others = win.get_workspace().list_windows()
      .filter((other) => other !== win && !other.is_on_all_workspaces() && !other.skip_taskbar);
    if (dynamic && others.length === 0 && index === manager.get_n_workspaces() - 1)
      return [false, "This window already has its own desktop"];
    // (Activating a window on another desktop only marks it as wanting attention.)
    const workspace = manager.get_workspace_by_index(index);
    win.change_workspace(workspace);
    workspace.activate_with_focus(win, global.get_current_time());
    return [true, `Desktop ${workspace.index() + 1}`];
  }

  _openDesktop(number) {
    if (!(number >= 1)) return [false, "Which desktop?"];
    const manager = global.workspace_manager;
    let index = number - 1;
    if (Meta.prefs_get_dynamic_workspaces()) index = Math.min(index, manager.get_n_workspaces() - 1);
    else while (manager.get_n_workspaces() <= index) manager.append_new_workspace(false, global.get_current_time());
    manager.get_workspace_by_index(index).activate(global.get_current_time());
    return [true, `Desktop ${index + 1}`];
  }

  /** Closes a desktop (the current one without a number); its windows move to the desktop beside it. */
  _closeDesktop(number) {
    const manager = global.workspace_manager;
    const count = manager.get_n_workspaces();
    const index = number ? number - 1 : manager.get_active_workspace_index();
    if (!(index >= 0 && index < count)) return [false, `There is no desktop ${number}`];
    const dynamic = Meta.prefs_get_dynamic_workspaces();
    // With dynamic desktops the empty one at the end doesn't count.
    if ((dynamic ? count - 1 : count) <= 1) return [false, "This is the only desktop"];
    if (dynamic && index === count - 1) return [false, "That desktop is empty already"];
    const workspace = manager.get_workspace_by_index(index);
    const neighbor = manager.get_workspace_by_index(index > 0 ? index - 1 : index + 1);
    for (const win of workspace.list_windows()) {
      if (!win.is_on_all_workspaces()) win.change_workspace(neighbor);
    }
    if (manager.get_active_workspace() === workspace) neighbor.activate(global.get_current_time());
    // GNOME removes an empty desktop by itself when desktops are dynamic.
    if (!dynamic) manager.remove_workspace(workspace, global.get_current_time());
    return [true, `Closed desktop ${index + 1}`];
  }

  /** Minimizes every window on the current desktop of the display the target window (or pointer) is on. */
  _minimizeDisplay() {
    const monitor = this._target()?.get_monitor() ?? global.display.get_current_monitor();
    const windows = global.workspace_manager.get_active_workspace().list_windows().filter((win) =>
      win.get_monitor() === monitor && !win.minimized && win.can_minimize() && !isBeam(win) &&
      win.get_window_type() === Meta.WindowType.NORMAL);
    for (const win of windows) win.minimize();
    return [true, `Minimized ${windows.length} windows`];
  }

  /** Focuses the app's next or previous window, in the order they were opened. */
  _cycleAppWindow(win, step) {
    const app = Shell.WindowTracker.get_default().get_window_app(win);
    const windows = (app?.get_windows() ?? [])
      .filter((other) => !other.skip_taskbar)
      .sort((a, b) => a.get_stable_sequence() - b.get_stable_sequence());
    if (windows.length < 2) return [false, "This app has only one window"];
    const next = windows[(windows.indexOf(win) + step + windows.length) % windows.length];
    Main.activateWindow(next);
    return [true, "Focused"];
  }

  _confetti() {
    if (Main.sessionMode.isLocked) return [false, "The screen is locked"];
    if (this._confettiShows.size >= MAX_CONFETTI_BURSTS) return [false, "That's plenty of confetti for now"];
    const monitor = Main.layoutManager.currentMonitor ?? Main.layoutManager.primaryMonitor;
    // Above every window and the top bar; never takes clicks or focus.
    const layer = new Clutter.Actor({
      reactive: false,
      x: monitor.x,
      y: monitor.y,
      width: monitor.width,
      height: monitor.height,
    });
    Main.uiGroup.add_child(layer);
    Main.uiGroup.set_child_above_sibling(layer, null);
    const show = { layer, timeline: null };
    this._confettiShows.add(show);
    try {
      this._launchConfetti(show, monitor);
    } catch (error) {
      this._stopConfetti(show);
      throw error;
    }
    return [true, `Confetti (${this._confettiShows.size} at once)`];
  }

  _launchConfetti(show, monitor) {
    const { layer } = show;

    // Distances suit a 1000 px tall screen and scale with the real one.
    const scaleY = monitor.height / 1000;
    const scaleX = monitor.width / 1700;
    const gravity = 900 * scaleY;
    // Air drag: paper slows quickly and falls at gravity / drag.
    const drag = 2;
    const pieces = [];
    for (let i = 0; i < CONFETTI_PIECES; i++) {
      const fromLeft = i % 2 === 0;
      // Up and inwards from a bottom corner, 12-58 degrees off vertical.
      const angle = ((12 + Math.random() * 46) * Math.PI) / 180;
      const speed = 2200 + Math.random() * 1300;
      const width = 6 + Math.random() * 6;
      const height = 9 + Math.random() * 9;
      const actor = new St.Widget({
        width,
        height,
        visible: false,
        style: `background-color: ${CONFETTI_COLORS[i % CONFETTI_COLORS.length]}; border-radius: ${Math.random() < 0.3 ? width / 2 : 2}px;`,
      });
      actor.set_pivot_point(0.5, 0.5);
      layer.add_child(actor);
      pieces.push({
        actor,
        x0: fromLeft ? -width : monitor.width,
        vx: (fromLeft ? 1 : -1) * Math.sin(angle) * speed * scaleX,
        vy: -Math.cos(angle) * speed * scaleY,
        delay: Math.random() * 0.18,
        spin: (Math.random() - 0.5) * 900,
        flip: 4 + Math.random() * 8,
        sway: (25 + Math.random() * 45) * scaleX,
        phase: Math.random() * Math.PI * 2,
      });
    }

    // Positions come from the time since launch, not from frame to frame
    // steps, so a slow or dropped frame never throws a piece off course.
    const terminal = gravity / drag;
    const timeline = new Clutter.Timeline({ actor: layer, duration: CONFETTI_MS });
    timeline.connect("new-frame", (_timeline, elapsed) => {
      const now = elapsed / 1000;
      for (const piece of pieces) {
        const t = now - piece.delay;
        if (t < 0) continue;
        piece.actor.visible = true;
        const decay = (1 - Math.exp(-drag * t)) / drag;
        const sway = Math.sin(t * 3 + piece.phase) * piece.sway * Math.min(1, t);
        const x = piece.x0 + piece.vx * decay + sway;
        const y = monitor.height + terminal * t + (piece.vy - terminal) * decay;
        piece.actor.set_position(x, y);
        piece.actor.rotation_angle_z = piece.spin * t + (piece.phase * 180) / Math.PI;
        // Tumbling paper: the piece turns edge-on and back.
        piece.actor.scale_y = Math.cos(t * piece.flip + piece.phase);
      }
      const fadeStart = CONFETTI_MS * 0.7;
      if (elapsed > fadeStart) layer.opacity = Math.round(255 * Math.max(0, 1 - (elapsed - fadeStart) / (CONFETTI_MS - fadeStart)));
    });
    timeline.connect("completed", () => this._stopConfetti(show));
    show.timeline = timeline;
    timeline.start();
  }

  _stopConfetti(show) {
    if (!this._confettiShows?.delete(show)) return;
    show.timeline?.stop();
    show.layer.destroy();
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
