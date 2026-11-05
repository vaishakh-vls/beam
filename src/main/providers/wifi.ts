import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import QRCode from "qrcode";
import { HIDE, type Entry, type EntryAction, type Section, type ViewProvider } from "../entry";
import { showForm } from "../forms";
import { bestScore } from "../fuzzy";
import { copyText, launchDetached, notify, runCapture } from "../system";
import { copyConcealed } from "./clipboard";
import {
  networkKind,
  nmcliError,
  parseAddedUuid,
  parseIpv4,
  parseNetworks,
  parseProfileSsids,
  parseRadio,
  parseWifiDevice,
  parseSecret,
  parseWifiProfiles,
  passwdFileLine,
  passwordProblem,
  SECRET_FIELDS,
  signalBars,
  lastUsedText,
  wifiQrText,
  type NetworkKind,
  type Radio,
  type WifiDevice,
  type WifiNetwork,
  type WifiProfile,
  type WifiSecret,
} from "../wifi";
import type { RunResult } from "../../shared/types";

const QUERY_MS = 10_000;
/** How long nmcli waits for a connection to come up; runCapture allows a little more. */
const CONNECT_WAIT_S = 30;
const CONNECT_MS = (CONNECT_WAIT_S + 10) * 1000;
/** Typing filters the same snapshot instead of asking nmcli again on every key. */
const CACHE_MS = 1000;
/** Password files left behind by a crash are removed once they are this old. */
const STALE_SECRETS_MS = 5 * 60 * 1000;
/** NetworkManager scans rarely while connected, so the open view asks for a scan this often. */
const AUTO_SCAN_MS = 60_000;

interface Snapshot {
  radio: Radio;
  device: WifiDevice | null;
  networks: WifiNetwork[];
  /** Saved profiles by SSID, newest first. */
  saved: Map<string, WifiProfile[]>;
  ip: string | null;
  error: string | null;
}

/** Doubles as the profile's key-mgmt value. */
type SecuredKind = Extract<NetworkKind, "wpa-psk" | "sae">;

let cache: { at: number; snapshot: Snapshot } | null = null;
let lastScan = 0;
/** A profile's SSID rarely changes, so each profile is looked up once. */
const ssidByUuid = new Map<string, string>();

function nmcli(args: string[], timeoutMs = QUERY_MS) {
  return runCapture("nmcli", args, { timeoutMs });
}

function invalidate(): void {
  cache = null;
}

async function snapshot(): Promise<Snapshot> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.snapshot;
  const [radio, devices, list, connections] = await Promise.all([
    nmcli(["-t", "-f", "WIFI-HW,WIFI", "radio"]),
    nmcli(["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"]),
    nmcli(["-t", "-f", "IN-USE,SIGNAL,SECURITY,SSID", "device", "wifi", "list", "--rescan", "no"]),
    nmcli(["-t", "-f", "NAME,UUID,TYPE,TIMESTAMP", "connection", "show"]),
  ]);
  const device = parseWifiDevice(devices.stdout);
  const profiles = parseWifiProfiles(connections.stdout);
  const unknown = profiles.filter((profile) => !ssidByUuid.has(profile.uuid));
  const [ssids, address] = await Promise.all([
    unknown.length
      ? nmcli([
          "-t", "-e", "no", "-f", "connection.uuid,802-11-wireless.ssid", "connection", "show",
          ...unknown.flatMap((profile) => ["uuid", profile.uuid]),
        ])
      : null,
    device?.state === "connected"
      ? nmcli(["-t", "-e", "no", "-f", "IP4.ADDRESS", "device", "show", device.name])
      : null,
  ]);
  for (const [uuid, ssid] of parseProfileSsids(ssids?.stdout ?? "")) ssidByUuid.set(uuid, ssid);

  const saved = new Map<string, WifiProfile[]>();
  for (const profile of profiles) {
    // Profiles are usually named after their network, which stands in until the lookup works.
    const ssid = ssidByUuid.get(profile.uuid) ?? profile.name;
    saved.set(ssid, [...(saved.get(ssid) ?? []), profile]);
  }
  const result: Snapshot = {
    radio: parseRadio(radio.stdout),
    device,
    networks: parseNetworks(list.stdout),
    saved,
    ip: address ? parseIpv4(address.stdout) : null,
    error: radio.code !== 0 ? nmcliError(radio.stderr) : null,
  };
  cache = { at: Date.now(), snapshot: result };
  return result;
}

function openSettings(): RunResult {
  launchDetached("gnome-control-center", ["wifi"]);
  return HIDE;
}

async function setRadio(on: boolean): Promise<string | null> {
  const { code, stderr } = await nmcli(["radio", "wifi", on ? "on" : "off"]);
  invalidate();
  return code === 0 ? null : `Could not turn Wi-Fi ${on ? "on" : "off"}: ${nmcliError(stderr)}`;
}

async function toggleWifi(): Promise<RunResult> {
  const radio = await nmcli(["-t", "-f", "WIFI-HW,WIFI", "radio"]);
  if (radio.code !== 0) return { type: "error", message: `Could not read the Wi-Fi state: ${nmcliError(radio.stderr)}` };
  const on = !parseRadio(radio.stdout).enabled;
  const error = await setRadio(on);
  if (error) return { type: "error", message: error };
  notify(on ? "Wi-Fi turned on" : "Wi-Fi turned off");
  return HIDE;
}

/** Like opening GNOME's Wi-Fi menu: ask for a scan without waiting, so the list fills in on the next refresh. */
function scanInBackground(): void {
  if (Date.now() - lastScan < AUTO_SCAN_MS) return;
  lastScan = Date.now();
  // NetworkManager refuses scans while connecting or just after another one; the list then stays as it is.
  void nmcli(["device", "wifi", "rescan"], 20_000).then(invalidate);
}

async function rescan(): Promise<RunResult> {
  lastScan = Date.now();
  const { code, stderr } = await nmcli(["device", "wifi", "rescan"], 20_000);
  invalidate();
  if (code !== 0) return { type: "error", message: `Could not rescan: ${nmcliError(stderr)}` };
  return { type: "stay", toast: "Scanning for networks…" };
}

async function activate(uuid: string, passwdFile?: string): Promise<string | null> {
  const args = ["--wait", String(CONNECT_WAIT_S), "connection", "up", "uuid", uuid];
  if (passwdFile) args.push("passwd-file", passwdFile);
  const { code, stderr } = await nmcli(args, CONNECT_MS);
  invalidate();
  return code === 0 ? null : nmcliError(stderr);
}

async function connect(network: WifiNetwork, profiles: WifiProfile[], device: WifiDevice | null): Promise<RunResult> {
  const kind = networkKind(network.security);
  let error: string | null;
  if (profiles.length) {
    error = await activate(profiles[0].uuid);
  } else if (kind === "unsupported") {
    return openSettings();
  } else if (kind === "open") {
    const args = ["--wait", String(CONNECT_WAIT_S), "device", "wifi", "connect", network.ssid];
    if (device) args.push("ifname", device.name);
    const result = await nmcli(args, CONNECT_MS);
    invalidate();
    error = result.code === 0 ? null : nmcliError(result.stderr);
  } else {
    return passwordForm(network, kind, device);
  }
  if (error) return { type: "error", message: `Could not connect to ${network.ssid}: ${error}` };
  return { type: "stay", toast: `Connected to ${network.ssid}` };
}

function passwordForm(network: WifiNetwork, kind: SecuredKind, device: WifiDevice | null): RunResult {
  return showForm(
    {
      title: `Connect to ${network.ssid}`,
      submitLabel: "Connect",
      fields: [
        {
          name: "password",
          label: "Password",
          type: "password",
          placeholder: "Network password",
          hint: `${network.security} network. The password is saved with the network, as in GNOME Settings.`,
        },
      ],
    },
    async (values) => {
      const problem = passwordProblem(values.password, kind);
      if (problem) return { type: "error", message: problem };
      const error = await addAndConnect(network.ssid, kind, values.password, device);
      if (error) return { type: "error", message: error };
      return { type: "view", view: "wifi" };
    },
  );
}

/** $XDG_RUNTIME_DIR is private to the user and lives in memory, so secrets never reach the disk. */
function secretsBase(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  return runtime && fs.existsSync(runtime) ? runtime : os.tmpdir();
}

function removeStaleSecrets(base: string): void {
  for (const name of fs.readdirSync(base)) {
    if (!name.startsWith("beam-wifi-")) continue;
    const dir = path.join(base, name);
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > STALE_SECRETS_MS) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Already gone.
    }
  }
}

/**
 * Saves a profile for a new secured network and connects with the password.
 * The password goes to nmcli through a passwd-file (mode 0600, in a 0700
 * folder, deleted afterwards) because anything in argv is visible to every
 * user through `ps`, and nmcli's --ask mode is meant for terminals.
 */
async function addAndConnect(ssid: string, kind: SecuredKind, password: string, device: WifiDevice | null): Promise<string | null> {
  let dir: string | null = null;
  try {
    const base = secretsBase();
    removeStaleSecrets(base);
    dir = fs.mkdtempSync(path.join(base, "beam-wifi-"));
    const file = path.join(dir, "secrets");
    fs.writeFileSync(file, passwdFileLine(password), { mode: 0o600, flag: "wx" });

    const args = ["connection", "add", "type", "wifi", "con-name", ssid, "ssid", ssid, "wifi-sec.key-mgmt", kind];
    if (device) args.push("ifname", device.name);
    const added = await nmcli(args);
    const uuid = parseAddedUuid(added.stdout);
    if (added.code !== 0 || !uuid) return `Could not save ${ssid}: ${nmcliError(added.stderr)}`;

    const error = await activate(uuid, file);
    if (!error) return null;
    // A profile with a wrong password would show as saved and keep failing.
    await nmcli(["connection", "delete", "uuid", uuid]);
    invalidate();
    return `Could not connect to ${ssid}. Check the password and try again. (${error})`;
  } catch (error) {
    return `Could not connect to ${ssid}: ${(error as Error).message}`;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function disconnect(device: WifiDevice | null, ssid: string): Promise<RunResult> {
  if (!device) return { type: "error", message: "No Wi-Fi adapter found" };
  // The same as GNOME's Disconnect: it stays off this network until asked to reconnect.
  const { code, stderr } = await nmcli(["device", "disconnect", device.name], 20_000);
  invalidate();
  if (code !== 0) return { type: "error", message: `Could not disconnect: ${nmcliError(stderr)}` };
  return { type: "stay", toast: `Disconnected from ${ssid}` };
}

async function forget(ssid: string, profiles: WifiProfile[]): Promise<RunResult> {
  const { code, stderr } = await nmcli(["connection", "delete", ...profiles.flatMap((profile) => ["uuid", profile.uuid])]);
  invalidate();
  if (code !== 0) return { type: "error", message: `Could not forget ${ssid}: ${nmcliError(stderr)}` };
  for (const profile of profiles) ssidByUuid.delete(profile.uuid);
  return { type: "stay", toast: `Forgot ${ssid}` };
}

/** The newest profile's saved password. NetworkManager gives the session's user its secrets without a prompt. */
async function readSecret(ssid: string, profiles: WifiProfile[]): Promise<WifiSecret | string> {
  const { code, stdout, stderr } = await nmcli([
    "-s", "-t", "-e", "no", "-f", SECRET_FIELDS, "connection", "show", "uuid", profiles[0].uuid,
  ]);
  if (code !== 0) return `Could not read the password for ${ssid}: ${nmcliError(stderr)}`;
  return parseSecret(stdout);
}

async function copyPassword(ssid: string, profiles: WifiProfile[]): Promise<RunResult> {
  const secret = await readSecret(ssid, profiles);
  if (typeof secret === "string") return { type: "error", message: secret };
  if (!secret.password) return { type: "error", message: `${ssid} has no saved password` };
  // Kept out of clipboard history, like a password manager's copy.
  copyConcealed(secret.password);
  return { type: "stay", toast: `Password for ${ssid} copied` };
}

/** The password, plus a QR code a phone camera scans to join. Enterprise networks have no such code. */
async function showPassword(ssid: string, profiles: WifiProfile[]): Promise<RunResult> {
  const secret = await readSecret(ssid, profiles);
  if (typeof secret === "string") return { type: "error", message: secret };
  if (!secret.password) return { type: "error", message: `${ssid} has no saved password` };
  const lines = [`Network   ${ssid}`, `Password  ${secret.password}`];
  if (secret.keyMgmt === "wpa-eap") return { type: "output", title: ssid, text: lines.join("\n") };
  const svg = await QRCode.toString(wifiQrText(ssid, secret), { type: "svg", margin: 2, errorCorrectionLevel: "M" });
  lines.push("", "Scan the code with a phone camera to join this network.");
  return {
    type: "output",
    title: ssid,
    text: lines.join("\n"),
    image: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
  };
}

function passwordActions(ssid: string, profiles: WifiProfile[], copyShortcut: string, showShortcut: string): EntryAction[] {
  return [
    { id: "copy-password", title: "Copy Password", shortcut: copyShortcut, run: () => copyPassword(ssid, profiles) },
    { id: "show-password", title: "Show Password and QR Code", shortcut: showShortcut, run: () => showPassword(ssid, profiles) },
  ];
}

const rescanAction: EntryAction = { id: "rescan", title: "Rescan Networks", shortcut: "Ctrl+Shift+S", run: rescan };

function networkEntry(network: WifiNetwork, snap: Snapshot): Entry {
  const profiles = snap.saved.get(network.ssid) ?? [];
  const saved = profiles.length > 0;
  const security = network.security || "Open";
  const copyName = (shortcut: string): EntryAction => ({
    id: "copy-name",
    title: "Copy Network Name",
    shortcut,
    run: () => {
      copyText(network.ssid);
      return { type: "stay", toast: "Network name copied" };
    },
  });

  const kind = networkKind(network.security);
  // Saved secured networks have a password to copy or show; OWE and open ones don't.
  const hasPassword = saved && kind !== "open";
  let actions: EntryAction[];
  if (network.inUse) {
    const ip = snap.ip;
    const disconnectAction = (shortcut: string): EntryAction => ({
      id: "disconnect",
      title: "Disconnect",
      shortcut,
      run: () => disconnect(snap.device, network.ssid),
    });
    const copyIp = (shortcut: string): EntryAction[] =>
      ip
        ? [
            {
              id: "copy-ip",
              title: "Copy IP Address",
              shortcut,
              run: () => {
                copyText(ip);
                return { type: "stay", toast: "IP address copied" };
              },
            },
          ]
        : [];
    actions = hasPassword
      ? [
          ...passwordActions(network.ssid, profiles, "↵", "Ctrl+↵"),
          ...copyIp("Ctrl+I"),
          disconnectAction("Ctrl+Shift+D"),
          copyName("Ctrl+Shift+C"),
        ]
      : ip
        ? [...copyIp("↵"), disconnectAction("Ctrl+↵"), copyName("Ctrl+Shift+C")]
        : [copyName("↵"), disconnectAction("Ctrl+↵")];
  } else {
    const title = saved || kind !== "unsupported" ? "Connect" : "Connect in Settings…";
    actions = [
      { id: "connect", title, shortcut: "↵", run: () => connect(network, profiles, snap.device) },
      ...(hasPassword ? passwordActions(network.ssid, profiles, "Ctrl+↵", "Ctrl+Shift+P") : []),
      copyName(hasPassword ? "Ctrl+Shift+C" : "Ctrl+↵"),
    ];
  }
  actions.push(rescanAction);
  if (saved) {
    actions.push({
      id: "forget",
      title: "Forget Network",
      shortcut: "Ctrl+D",
      danger: true,
      run: () => forget(network.ssid, profiles),
    });
  }

  const subtitle = network.inUse
    ? [`${network.signal}%`, security, snap.ip].filter(Boolean).join("  ·  ")
    : [security, saved ? "Saved" : ""].filter(Boolean).join("  ·  ");
  return {
    id: `wifi:net:${network.ssid}`,
    title: network.ssid,
    subtitle,
    icon: network.inUse ? "✅" : network.security ? "🔒" : "🌐",
    accessory: network.inUse ? "Connected" : `${signalBars(network.signal)} ${network.signal}%`,
    keywords: [security, saved ? "saved" : "", hasPassword ? "password" : "", network.inUse ? "connected current" : ""],
    actions,
  };
}

/** A saved network that isn't in range: its password can still be copied or shown. */
function savedEntry(ssid: string, profiles: WifiProfile[]): Entry {
  return {
    id: `wifi:saved:${ssid}`,
    title: ssid,
    subtitle: lastUsedText(profiles[0].timestamp, Date.now() / 1000),
    icon: "💾",
    accessory: "Not in range",
    keywords: ["saved", "password", "known"],
    actions: [
      ...passwordActions(ssid, profiles, "↵", "Ctrl+↵"),
      {
        id: "copy-name",
        title: "Copy Network Name",
        shortcut: "Ctrl+Shift+C",
        run: () => {
          copyText(ssid);
          return { type: "stay", toast: "Network name copied" };
        },
      },
      { id: "forget", title: "Forget Network", shortcut: "Ctrl+D", danger: true, run: () => forget(ssid, profiles) },
    ],
  };
}

function savedSection(snap: Snapshot, matches: (entry: Entry) => boolean): Section {
  const inRange = new Set(snap.networks.map((network) => network.ssid));
  const entries = [...snap.saved]
    .filter(([ssid]) => !inRange.has(ssid))
    .map(([ssid, profiles]) => savedEntry(ssid, profiles))
    .filter(matches);
  return { title: "Saved Networks", entries };
}

function powerEntry(radio: Radio): Entry {
  const title = radio.enabled ? "Turn Wi-Fi Off" : "Turn Wi-Fi On";
  return {
    id: "wifi:power",
    title,
    subtitle: !radio.hardware ? "Blocked by a hardware switch" : radio.enabled ? "Wi-Fi is on" : "Wi-Fi is off",
    icon: radio.enabled ? "📶" : "📴",
    accessory: radio.enabled ? "On" : "Off",
    keywords: ["toggle", "power", "on", "off", "enable", "disable"],
    actions: [
      {
        id: "toggle",
        title,
        shortcut: "↵",
        run: async () => {
          const error = await setRadio(!radio.enabled);
          if (error) return { type: "error", message: error };
          return { type: "stay", toast: radio.enabled ? "Wi-Fi turned off" : "Wi-Fi turned on" };
        },
      },
    ],
  };
}

const rescanEntry: Entry = {
  id: "wifi:rescan",
  title: "Rescan Networks",
  subtitle: "Look for networks again",
  icon: "🔄",
  keywords: ["scan", "refresh", "search"],
  actions: [{ ...rescanAction, shortcut: "↵" }],
};

const settingsEntry: Entry = {
  id: "wifi:settings",
  title: "Open Wi-Fi Settings",
  subtitle: "Hidden and enterprise networks, hotspot",
  icon: "⚙️",
  keywords: ["preferences", "hidden", "enterprise", "hotspot", "gnome"],
  actions: [{ id: "open", title: "Open Wi-Fi Settings", shortcut: "↵", run: openSettings }],
};

function messageEntry(title: string, subtitle: string): Entry {
  return { id: "wifi:message", title, subtitle, icon: "⚠️", actions: [{ id: "settings", title: "Open Wi-Fi Settings", shortcut: "↵", run: openSettings }] };
}

export function wifiCommands(_hide: () => void): Entry[] {
  return [
    {
      id: "cmd:wifi",
      ref: "cmd:wifi",
      title: "Wi-Fi",
      subtitle: "Wi-Fi",
      icon: "📶",
      accessory: "Command",
      keywords: ["wifi", "wireless", "network", "wlan", "internet", "ssid", "connect"],
      actions: [{ id: "run", title: "Open Wi-Fi", shortcut: "↵", run: () => ({ type: "view", view: "wifi" }) }],
    },
    {
      id: "cmd:toggle-wifi",
      ref: "cmd:toggle-wifi",
      title: "Toggle Wi-Fi",
      subtitle: "Wi-Fi",
      icon: "📶",
      accessory: "Command",
      keywords: ["wifi", "wireless", "turn on", "turn off", "enable", "disable"],
      actions: [{ id: "run", title: "Toggle Wi-Fi", shortcut: "↵", run: toggleWifi }],
    },
  ];
}

export const wifiView: ViewProvider = {
  info: { title: "Wi-Fi", placeholder: "Search Wi-Fi networks…", preview: false, grid: false, refreshMs: 4000 },
  async sections(query: string): Promise<Section[]> {
    const snap = await snapshot();
    const q = query.trim();
    const matches = (entry: Entry) => !q || bestScore(q, [entry.title, ...(entry.keywords ?? [])]) > 0;
    if (snap.error) return [{ title: "Wi-Fi", entries: [messageEntry("Could Not Read Wi-Fi", snap.error)] }];
    if (!snap.device) return [{ title: "Wi-Fi", entries: [messageEntry("No Wi-Fi Adapter Found", "NetworkManager reports no Wi-Fi device")] }];
    if (!snap.radio.enabled) {
      return [
        { title: "Wi-Fi", entries: [powerEntry(snap.radio), settingsEntry].filter(matches) },
        savedSection(snap, matches),
      ];
    }
    if (!q) scanInBackground();

    const shown = snap.networks
      .map((network) => ({ network, entry: networkEntry(network, snap) }))
      .filter(({ entry }) => matches(entry));
    // The toggle sits below the networks so Enter on a freshly opened view never turns Wi-Fi off.
    return [
      { title: "Current Network", entries: shown.filter(({ network }) => network.inUse).map(({ entry }) => entry) },
      { title: "Networks", entries: shown.filter(({ network }) => !network.inUse).map(({ entry }) => entry) },
      savedSection(snap, matches),
      { title: "Wi-Fi", entries: [powerEntry(snap.radio), rescanEntry, settingsEntry].filter(matches) },
    ];
  },
};
