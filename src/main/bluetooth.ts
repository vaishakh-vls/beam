// Parses bluetoothctl and gsd-rfkill output for the Bluetooth view.

export interface Controller {
  present: boolean;
  powered: boolean;
  discovering: boolean;
}

/** GNOME's Bluetooth switch, from gsd-rfkill. Null when gsd-rfkill isn't running. */
export interface Airplane {
  /** Bluetooth turned off in GNOME (soft-blocked). */
  blocked: boolean | null;
  /** Blocked by a hardware switch, which software can't undo. */
  hardware: boolean | null;
}

export interface BtDevice {
  address: string;
  name: string;
  /** Freedesktop icon name from BlueZ, e.g. "audio-headset" or "input-mouse". */
  icon: string;
  paired: boolean;
  trusted: boolean;
  connected: boolean;
  /** Percent, when the device reports it. */
  battery: number | null;
}

const ADDRESS = String.raw`[0-9A-F]{2}(?::[0-9A-F]{2}){5}`;

/** bluetoothctl colors some lines even when not on a terminal. */
function plain(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
}

/** `bluetoothctl show` */
export function parseController(text: string): Controller {
  const t = plain(text);
  return {
    present: new RegExp(`^Controller ${ADDRESS}`, "mi").test(t),
    powered: /^\s+Powered: yes$/m.test(t),
    discovering: /^\s+Discovering: yes$/m.test(t),
  };
}

/** `gdbus call ... org.freedesktop.DBus.Properties.GetAll org.gnome.SettingsDaemon.Rfkill` */
export function parseAirplane(text: string): Airplane {
  const flag = (name: string) => {
    const match = new RegExp(`'${name}': <(true|false)>`).exec(text);
    return match ? match[1] === "true" : null;
  };
  return { blocked: flag("BluetoothAirplaneMode"), hardware: flag("BluetoothHardwareAirplaneMode") };
}

/** `bluetoothctl devices [Paired]`: "Device <address> <alias>" per line. */
export function parseDeviceList(text: string): Array<{ address: string; name: string }> {
  const pattern = new RegExp(`^Device (${ADDRESS}) (.*)$`, "i");
  const devices: Array<{ address: string; name: string }> = [];
  for (const line of plain(text).split("\n")) {
    const match = pattern.exec(line.trim());
    if (match) devices.push({ address: match[1].toUpperCase(), name: match[2].trim() });
  }
  return devices;
}

/** `bluetoothctl info <address>` */
export function parseDeviceInfo(text: string): BtDevice | null {
  const t = plain(text);
  const header = new RegExp(`^Device (${ADDRESS})`, "mi").exec(t);
  if (!header) return null;
  const fields = new Map<string, string>();
  for (const line of t.slice(header.index).split("\n").slice(1)) {
    const match = /^\t([A-Za-z][\w. ]*?): ?(.*)$/.exec(line);
    // UUID repeats; the first of each key is enough.
    if (match && !fields.has(match[1])) fields.set(match[1], match[2].trim());
  }
  // "Device <address> not available" has no fields.
  if (!fields.has("Paired")) return null;
  const address = header[1].toUpperCase();
  const battery = /\((\d+)\)/.exec(fields.get("Battery Percentage") ?? "");
  return {
    address,
    name: fields.get("Alias") || fields.get("Name") || address,
    icon: fields.get("Icon") ?? "",
    paired: fields.get("Paired") === "yes",
    trusted: fields.get("Trusted") === "yes",
    connected: fields.get("Connected") === "yes",
    battery: battery ? Number(battery[1]) : null,
  };
}

/** Devices without a name are listed under their address, written with dashes. */
export function hasRealName(name: string, address: string): boolean {
  const n = name.trim();
  return n !== "" && n.replace(/-/g, ":").toUpperCase() !== address.toUpperCase();
}

const TYPES: Array<[RegExp, string, string]> = [
  [/^audio-head(set|phones)/, "🎧", "Headphones"],
  [/^audio-/, "🔊", "Audio"],
  [/^input-keyboard/, "⌨️", "Keyboard"],
  [/^input-mouse/, "🖱️", "Mouse"],
  [/^input-gaming/, "🎮", "Game Controller"],
  [/^input-tablet/, "✏️", "Tablet"],
  [/^phone/, "📱", "Phone"],
  [/^computer/, "💻", "Computer"],
  [/^video-display/, "🖥️", "Display"],
  [/^camera-/, "📷", "Camera"],
  [/^printer/, "🖨️", "Printer"],
  [/^multimedia-player/, "🎵", "Media Player"],
  [/^(modem|network-)/, "📡", "Network"],
];

/** Emoji and label for BlueZ's icon name. */
export function deviceType(icon: string): { emoji: string; label: string } {
  for (const [pattern, emoji, label] of TYPES) if (pattern.test(icon)) return { emoji, label };
  return { emoji: "🔹", label: "Device" };
}

/** Connected devices first, then by name. */
export function sortDevices(devices: BtDevice[]): BtDevice[] {
  return [...devices].sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name));
}

/** bluetoothctl exits non-zero on failure, but older versions only print "Failed to ...". */
export function bluetoothFailed(code: number, output: string): boolean {
  return code !== 0 || /Failed to |not available|No default controller/i.test(plain(output));
}

/** A readable reason for a failed bluetoothctl command. */
export function bluetoothError(output: string): string {
  const t = plain(output);
  if (/Authentication(Failed|Rejected|Canceled|Timeout)/.test(t)) {
    return "Pairing was refused. Devices that need a PIN or code can be paired in Bluetooth Settings.";
  }
  if (/page-timeout|Host is down|ConnectionAttemptFailed|le-connection-abort/i.test(t)) {
    return "The device didn't respond. Make sure it's on and nearby.";
  }
  if (/not available/i.test(t)) return "The device is out of range. Put it in pairing mode and scan again.";
  if (/Error\.(Blocked|NotReady)|No default controller/.test(t)) return "Bluetooth is off.";
  if (/Error\.InProgress/.test(t)) return "Bluetooth is busy. Try again in a moment.";
  const line = t.split("\n").map((l) => l.trim()).find((l) => /Failed|Error/.test(l)) ?? t.trim().split("\n").pop() ?? "";
  return line.replace(/^Failed to \w+( \w+)?: /, "") || "bluetoothctl failed";
}
