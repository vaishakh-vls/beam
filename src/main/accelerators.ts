// Converts Beam hotkeys ("Ctrl+Alt+V") to GNOME accelerators ("<Control><Alt>v").

const MODIFIERS: Record<string, string> = {
  ctrl: "<Control>",
  control: "<Control>",
  cmdorctrl: "<Control>",
  alt: "<Alt>",
  option: "<Alt>",
  shift: "<Shift>",
  super: "<Super>",
  meta: "<Super>",
  cmd: "<Super>",
  command: "<Super>",
};

const KEY_NAMES: Record<string, string> = {
  space: "space",
  enter: "Return",
  return: "Return",
  tab: "Tab",
  esc: "Escape",
  escape: "Escape",
  backspace: "BackSpace",
  delete: "Delete",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  arrowup: "Up",
  arrowdown: "Down",
  arrowleft: "Left",
  arrowright: "Right",
  home: "Home",
  end: "End",
  pageup: "Page_Up",
  pagedown: "Page_Down",
  "/": "slash",
  ".": "period",
  ",": "comma",
  ";": "semicolon",
  "'": "apostrophe",
  "`": "grave",
  "-": "minus",
  "=": "equal",
  "[": "bracketleft",
  "]": "bracketright",
  "\\": "backslash",
};

/** Returns null when the hotkey has no modifier or an unknown key. */
export function toGnomeAccelerator(keys: string): string | null {
  const parts = keys.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const key = parts.pop()!;
  let result = "";
  for (const part of parts) {
    const modifier = MODIFIERS[part.toLowerCase()];
    if (!modifier) return null;
    result += modifier;
  }
  const lower = key.toLowerCase();
  if (KEY_NAMES[lower]) return result + KEY_NAMES[lower];
  if (/^[a-z0-9]$/i.test(key)) return result + lower;
  if (/^f([1-9]|1[0-2])$/i.test(key)) return result + key.toUpperCase();
  return null;
}
