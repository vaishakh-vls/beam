// Parses nmcli's terse output for the Wi-Fi view and formats what it shows.

export interface WifiNetwork {
  ssid: string;
  /** 0-100. For the network in use, the signal of the access point Beam is connected to. */
  signal: number;
  /** nmcli's summary, e.g. "WPA2", "WPA1 WPA2", "WPA3"; empty for open networks. */
  security: string;
  inUse: boolean;
}

export interface WifiProfile {
  name: string;
  uuid: string;
  /** Last time the profile connected (seconds), 0 if never. */
  timestamp: number;
}

export interface WifiDevice {
  name: string;
  /** "connected", "disconnected", "unavailable", "connecting (configuring)"... */
  state: string;
  /** Name of the active profile, empty when not connected. */
  connection: string;
}

export interface Radio {
  /** Not blocked by a hardware switch. */
  hardware: boolean;
  enabled: boolean;
}

/** How Beam connects to a network it has no profile for. */
export type NetworkKind = "open" | "wpa-psk" | "sae" | "unsupported";

/**
 * Splits a line of `nmcli -t` output. nmcli escapes ":" and "\" inside
 * values with a backslash, which matters for SSIDs and BSSIDs.
 */
export function splitTerse(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length) {
      current += line[++i];
    } else if (ch === ":") {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim());
}

/** `nmcli -t -f WIFI-HW,WIFI radio` */
export function parseRadio(text: string): Radio {
  const [hardware, enabled] = splitTerse(lines(text)[0] ?? "");
  return { hardware: hardware === "enabled", enabled: enabled === "enabled" };
}

/** The first Wi-Fi device in `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status`. */
export function parseWifiDevice(text: string): WifiDevice | null {
  for (const line of lines(text)) {
    const [name, type, state, connection = ""] = splitTerse(line);
    if (type === "wifi") return { name, state, connection };
  }
  return null;
}

/**
 * `nmcli -t -f IN-USE,SIGNAL,SECURITY,SSID device wifi list`: one line per
 * access point, so a network with several (mesh, 2.4 and 5 GHz) appears
 * several times. Returns one entry per SSID, the one in use first, then the
 * strongest. Hidden networks have no SSID and are skipped.
 */
export function parseNetworks(text: string): WifiNetwork[] {
  const bySsid = new Map<string, WifiNetwork>();
  for (const line of lines(text)) {
    const [inUseField = "", signalField = "", securityField = "", ssid = ""] = splitTerse(line);
    if (!ssid || ssid === "--") continue;
    const network: WifiNetwork = {
      ssid,
      signal: Number(signalField) || 0,
      security: securityField === "--" ? "" : securityField.trim(),
      inUse: inUseField.trim() === "*",
    };
    const known = bySsid.get(ssid);
    // The access point in use wins even when another one is stronger, so
    // the signal shown is the one the connection actually has.
    if (!known || (network.inUse && !known.inUse) || (network.inUse === known.inUse && network.signal > known.signal)) {
      bySsid.set(ssid, network);
    }
  }
  return [...bySsid.values()].sort(
    (a, b) => Number(b.inUse) - Number(a.inUse) || b.signal - a.signal || a.ssid.localeCompare(b.ssid),
  );
}

/** Wi-Fi profiles from `nmcli -t -f NAME,UUID,TYPE,TIMESTAMP connection show`, newest first. */
export function parseWifiProfiles(text: string): WifiProfile[] {
  const profiles: WifiProfile[] = [];
  for (const line of lines(text)) {
    const [name, uuid, type, timestamp] = splitTerse(line);
    if (type === "802-11-wireless" && uuid) profiles.push({ name, uuid, timestamp: Number(timestamp) || 0 });
  }
  return profiles.sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * Profile SSIDs from `nmcli -t -e no -f connection.uuid,802-11-wireless.ssid
 * connection show uuid A uuid B`. Escaping is off there, so each value is
 * everything after the first colon.
 */
export function parseProfileSsids(text: string): Map<string, string> {
  const ssids = new Map<string, string>();
  let uuid = "";
  for (const line of lines(text)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon);
    const value = line.slice(colon + 1);
    if (key === "connection.uuid") uuid = value;
    else if (key === "802-11-wireless.ssid" && uuid) ssids.set(uuid, value);
  }
  return ssids;
}

/** First address from `nmcli -t -e no -f IP4.ADDRESS device show <dev>`, without the prefix length. */
export function parseIpv4(text: string): string | null {
  const match = /^IP4\.ADDRESS(?:\[\d+\])?:([\d.]+)/m.exec(text);
  return match ? match[1] : null;
}

/** The new profile's UUID from "Connection 'X' (uuid) successfully added." */
export function parseAddedUuid(text: string): string | null {
  return /\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/i.exec(text)?.[1] ?? null;
}

/**
 * Enterprise (802.1X) and WEP networks need more than a password, so Beam
 * leaves them to GNOME Settings. OWE is encrypted but needs no password.
 */
export function networkKind(security: string): NetworkKind {
  const parts = security.split(/\s+/).filter(Boolean);
  if (parts.some((part) => part === "802.1X" || part === "WEP")) return "unsupported";
  if (parts.some((part) => part === "WPA1" || part === "WPA2")) return "wpa-psk";
  if (parts.includes("WPA3")) return "sae";
  return "open";
}

/** WPA passphrases are 8-63 printable ASCII characters, or a 64-digit hex key. WPA3 allows any length. */
export function passwordProblem(password: string, kind: NetworkKind): string | null {
  if (!password) return "Enter the network's password.";
  if (kind !== "wpa-psk") return null;
  if (/^[0-9a-f]{64}$/i.test(password)) return null;
  if (!/^[\x20-\x7e]*$/.test(password)) return "Wi-Fi passwords use only standard keyboard characters.";
  if (password.length < 8 || password.length > 63) return "Wi-Fi passwords are 8 to 63 characters long.";
  return null;
}

/**
 * The line for nmcli's passwd-file. nmcli trims spaces around the value and
 * reads backslash escapes, so backslashes are doubled and any leading or
 * trailing whitespace is written as octal escapes.
 */
export function passwdFileLine(password: string): string {
  const octal = (spaces: string) => [...spaces].map((ch) => "\\" + ch.charCodeAt(0).toString(8).padStart(3, "0")).join("");
  const value = password.replace(/\\/g, "\\\\").replace(/^\s+|\s+$/g, octal);
  return `802-11-wireless-security.psk:${value}\n`;
}

export interface WifiSecret {
  /** The profile's key-mgmt: "wpa-psk", "sae", "none" (WEP), "wpa-eap"…; empty for open networks. */
  keyMgmt: string;
  /** Empty when the profile has no saved password. */
  password: string;
}

/** The fields `nmcli -s -t -e no -f <fields> connection show uuid X` is asked for. */
export const SECRET_FIELDS = [
  "802-11-wireless-security.key-mgmt",
  "802-11-wireless-security.psk",
  "802-11-wireless-security.wep-key0",
  "802-1x.password",
].join(",");

/**
 * The saved password from `nmcli -s -t -e no -f SECRET_FIELDS`. nmcli leaves
 * out the fields of settings a profile doesn't have, so values are read by
 * name rather than position.
 */
export function parseSecret(text: string): WifiSecret {
  const values = new Map<string, string>();
  for (const line of text.split("\n")) {
    const colon = line.indexOf(":");
    if (colon > 0) values.set(line.slice(0, colon), line.slice(colon + 1));
  }
  return {
    keyMgmt: values.get("802-11-wireless-security.key-mgmt") ?? "",
    password:
      values.get("802-11-wireless-security.psk") ||
      values.get("802-11-wireless-security.wep-key0") ||
      values.get("802-1x.password") ||
      "",
  };
}

/**
 * What a phone camera reads to join a network: the WIFI: scheme Android and
 * iOS both understand. Backslash, ; , : and " are escaped inside values.
 */
export function wifiQrText(ssid: string, secret: WifiSecret): string {
  const escape = (value: string) => value.replace(/([\\;,:"])/g, "\\$1");
  if (!secret.password) return `WIFI:T:nopass;S:${escape(ssid)};;`;
  const type = secret.keyMgmt === "sae" ? "SAE" : secret.keyMgmt === "none" ? "WEP" : "WPA";
  return `WIFI:T:${type};S:${escape(ssid)};P:${escape(secret.password)};;`;
}

/** "Last used 3 days ago" from a profile's TIMESTAMP (seconds; 0 when it never connected). */
export function lastUsedText(timestamp: number, nowSeconds: number): string {
  if (!timestamp) return "Saved, never connected";
  const days = Math.floor((nowSeconds - timestamp) / 86_400);
  if (days < 1) return "Last used today";
  if (days < 2) return "Last used yesterday";
  if (days < 14) return `Last used ${days} days ago`;
  if (days < 60) return `Last used ${Math.floor(days / 7)} weeks ago`;
  if (days < 730) return `Last used ${Math.floor(days / 30)} months ago`;
  return `Last used ${Math.floor(days / 365)} years ago`;
}

/** nmcli's own bars: ▂▄▆█ for a strong signal, with _ for the missing ones. */
export function signalBars(signal: number): string {
  const count = signal > 80 ? 4 : signal > 55 ? 3 : signal > 30 ? 2 : signal > 5 ? 1 : 0;
  return [..."▂▄▆█"].map((bar, i) => (i < count ? bar : "_")).join("");
}

/** The useful part of an nmcli error, without "Error:" and the journalctl hint. */
export function nmcliError(stderr: string): string {
  const line = lines(stderr).find((l) => !l.startsWith("Hint:")) ?? "";
  return line.replace(/^Error:\s*/, "").replace(/^Connection activation failed:\s*/, "").trim() || "nmcli failed";
}
