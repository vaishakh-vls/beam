// Reads what nearby Apple devices say about themselves, for the Devices view:
// the battery levels AirPods broadcast over Bluetooth, and what a trusted
// iPhone answers through libimobiledevice.

/** Apple's Bluetooth company id, the key of its ManufacturerData. */
const APPLE = 76;
/** The broadcast AirPods and Beats send with their battery levels ("proximity pairing"). */
const PROXIMITY = 0x07;
const PROXIMITY_LENGTH = 0x19;
/** A level the earbud does not report, e.g. while it is out of its case and asleep. */
const UNKNOWN = 15;

export interface Earbuds {
  /** Random and changing every few minutes: only good for telling apart what is nearby now. */
  address: string;
  model: string;
  /** Headphones (AirPods Max, Beats Solo) have one battery and no case. */
  single: boolean;
  /** Percent in steps of 10, or null when not reported. */
  left: number | null;
  right: number | null;
  case: number | null;
  chargingLeft: boolean;
  chargingRight: boolean;
  chargingCase: boolean;
  /** Signal strength in dBm; nearer to 0 is closer. */
  rssi: number;
}

/** Model ids as they stand in the broadcast (bytes 3 and 4). */
const MODELS: Record<number, [string, boolean?]> = {
  0x0220: ["AirPods"],
  0x0f20: ["AirPods (2nd generation)"],
  0x1320: ["AirPods (3rd generation)"],
  0x1920: ["AirPods 4"],
  0x1b20: ["AirPods 4 (ANC)"],
  0x0e20: ["AirPods Pro"],
  0x1420: ["AirPods Pro 2"],
  0x2420: ["AirPods Pro 2"],
  0x2720: ["AirPods Pro 3"],
  0x0a20: ["AirPods Max", true],
  0x1f20: ["AirPods Max", true],
  0x0320: ["Powerbeats3"],
  0x0b20: ["Powerbeats Pro"],
  0x1d20: ["Powerbeats Pro 2"],
  0x0520: ["BeatsX", true],
  0x0620: ["Beats Solo3", true],
  0x0920: ["Beats Studio3", true],
  0x0c20: ["Beats Solo Pro", true],
  0x1020: ["Beats Flex", true],
  0x1120: ["Beats Studio Buds"],
  0x1220: ["Beats Fit Pro"],
  0x1620: ["Beats Studio Buds+"],
  0x1720: ["Beats Studio Pro", true],
};

function level(nibble: number): number | null {
  return nibble === UNKNOWN ? null : Math.min(nibble, 10) * 10;
}

/** The battery broadcast's bytes (after the company id), or null if they are some other Apple message. */
export function decodeProximity(bytes: number[]): Omit<Earbuds, "address" | "rssi"> | null {
  if (bytes.length < 8 || bytes[0] !== PROXIMITY || bytes[1] !== PROXIMITY_LENGTH) return null;
  const [model, single = false] = MODELS[(bytes[3] << 8) | bytes[4]] ?? ["AirPods or Beats"];
  // Which earbud is sending decides which half of the byte is the left one.
  const flipped = (bytes[5] & 0x20) === 0;
  const high = bytes[6] >> 4;
  const low = bytes[6] & 0x0f;
  const flags = bytes[7] >> 4;
  const left = level(flipped ? high : low);
  const right = level(flipped ? low : high);
  if (single) {
    // One battery, reported in either half.
    const only = [left, right].filter((value): value is number => value !== null);
    const percent = only.length ? Math.max(...only) : null;
    // What the charging bits mean on headphones is not known, so none is shown.
    return { model, single, left: percent, right: percent, case: null, chargingLeft: false, chargingRight: false, chargingCase: false };
  }
  return {
    model,
    single,
    left,
    right,
    case: level(bytes[7] & 0x0f),
    chargingLeft: (flags & (flipped ? 2 : 1)) !== 0,
    chargingRight: (flags & (flipped ? 1 : 2)) !== 0,
    chargingCase: (flags & 4) !== 0,
  };
}

/**
 * `gdbus call --system --dest org.bluez --object-path / --method
 * org.freedesktop.DBus.ObjectManager.GetManagedObjects`: every device BlueZ
 * knows, as GVariant text. Only those heard in the scan now running have an
 * RSSI. The nearest come first.
 */
export function parseEarbuds(text: string): Earbuds[] {
  const found: Earbuds[] = [];
  for (const chunk of text.split(/'\/org\/bluez\/hci\d+\/dev_/).slice(1)) {
    const data = new RegExp(`uint16 ${APPLE}: <\\[byte ([^\\]]+)\\]>`).exec(chunk);
    const rssi = /'RSSI': <int16 (-?\d+)>/.exec(chunk);
    const address = /'Address': <'([0-9A-Fa-f:]{17})'>/.exec(chunk);
    if (!data || !rssi || !address) continue;
    const decoded = decodeProximity(data[1].split(",").map((byte) => Number.parseInt(byte.trim(), 16)));
    if (decoded) found.push({ ...decoded, address: address[1].toUpperCase(), rssi: Number(rssi[1]) });
  }
  return found.sort((a, b) => b.rssi - a.rssi);
}

export interface Connected {
  address: string;
  name: string;
  /** Freedesktop icon name from BlueZ, e.g. "input-mouse". */
  icon: string;
  /** Percent, when the device reports it. */
  battery: number | null;
}

/** A GVariant string property; gdbus writes a text holding an apostrophe in double quotes. */
function textProperty(chunk: string, name: string): string | null {
  const match = new RegExp(`'${name}': <(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")>`).exec(chunk);
  return match ? (match[1] ?? match[2]).replace(/\\(.)/g, "$1") : null;
}

/** The devices connected to the laptop, from the same GetManagedObjects text, by name. */
export function parseConnected(text: string): Connected[] {
  const found: Connected[] = [];
  for (const chunk of text.split(/'\/org\/bluez\/hci\d+\/dev_/).slice(1)) {
    const address = /'Address': <'([0-9A-Fa-f:]{17})'>/.exec(chunk);
    if (!address || !/'Connected': <true>/.test(chunk)) continue;
    const battery = /'org\.bluez\.Battery1': \{[^}]*'Percentage': <byte 0x([0-9a-fA-F]{2})>/.exec(chunk);
    found.push({
      address: address[1].toUpperCase(),
      name: textProperty(chunk, "Alias") || textProperty(chunk, "Name") || address[1].toUpperCase(),
      icon: textProperty(chunk, "Icon") ?? "",
      battery: battery ? Number.parseInt(battery[1], 16) : null,
    });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/** How far a signal of this strength roughly is. */
export function nearness(rssi: number): string {
  if (rssi >= -55) return "Next to you";
  if (rssi >= -70) return "Nearby";
  return "Farther away";
}

function part(label: string, percent: number | null, charging: boolean): string {
  return `${label} ${percent === null ? "–" : `${percent}%`}${charging ? " ⚡" : ""}`;
}

/** "Left 90%  ·  Right 80% ⚡  ·  Case 40%" */
export function earbudsLevels(buds: Earbuds): string {
  if (buds.single) return part("Battery", buds.left, buds.chargingLeft);
  return [part("Left", buds.left, buds.chargingLeft), part("Right", buds.right, buds.chargingRight), part("Case", buds.case, buds.chargingCase)].join("  ·  ");
}

/** `idevice_id -l`: one UDID per line. */
export function parseUdids(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((udid) => /^[0-9A-Fa-f-]{20,}$/.test(udid));
}

/** `ideviceinfo`: "Key: value" per line. */
export function parseIdeviceInfo(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Za-z][\w.-]*): (.*)$/.exec(line);
    if (match) fields[match[1]] = match[2].trim();
  }
  return fields;
}

export interface Phone {
  udid: string;
  name: string;
  /** "iPhone" or "iPad". */
  kind: string;
  version: string;
  battery: number | null;
  charging: boolean;
  /** Bytes, when the phone reports its storage. */
  free: number | null;
  capacity: number | null;
}

function count(value: string | undefined): number | null {
  const number = Number(value);
  return value !== undefined && value !== "" && Number.isFinite(number) ? number : null;
}

/** A phone from what ideviceinfo printed for it, for its battery and for its disk. */
export function phoneFrom(udid: string, info: Record<string, string>, battery: Record<string, string>, disk: Record<string, string>): Phone {
  const kind = info.DeviceClass || (/^iPad/.test(info.ProductType ?? "") ? "iPad" : "iPhone");
  return {
    udid,
    name: info.DeviceName || kind,
    kind,
    version: info.ProductVersion ?? "",
    battery: count(battery.BatteryCurrentCapacity),
    charging: battery.BatteryIsCharging === "true",
    free: count(disk.TotalDataAvailable),
    capacity: count(disk.TotalDataCapacity),
  };
}

/** Why ideviceinfo could not read a plugged-in phone, in words that say what to do. */
export function phoneProblem(output: string): string {
  if (/Password protected|-17\b/i.test(output)) return "Unlock the iPhone, then it shows here";
  if (/Pairing dialog response pending|-19\b/i.test(output)) return "Tap Trust on the iPhone";
  if (/user denied|-18\b/i.test(output)) return "Trust was declined; unplug, plug in again and tap Trust";
  if (/Invalid HostID|not paired|-21\b/i.test(output)) return "Not trusted yet: press Enter to pair, then tap Trust on the iPhone";
  return "Could not read the iPhone; unplug it and plug it in again";
}

/** "128 GB" */
export function gigabytes(bytes: number): string {
  const gb = bytes / 1e9;
  return `${gb >= 100 ? Math.round(gb) : Math.round(gb * 10) / 10} GB`;
}
