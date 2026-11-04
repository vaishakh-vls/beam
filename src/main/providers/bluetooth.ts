import {
  bluetoothError,
  bluetoothFailed,
  deviceType,
  hasRealName,
  parseAirplane,
  parseController,
  parseDeviceInfo,
  parseDeviceList,
  sortDevices,
  type Airplane,
  type BtDevice,
  type Controller,
} from "../bluetooth";
import { HIDE, type Entry, type EntryAction, type Section, type ViewProvider } from "../entry";
import { bestScore } from "../fuzzy";
import { launchDetached, notify, runCapture } from "../system";
import type { RunResult } from "../../shared/types";

const QUERY_MS = 5000;
const CONNECT_MS = 30_000;
const PAIR_MS = 45_000;
const SCAN_SECONDS = 8;
/** A busy office can have dozens of devices nearby; only the first ones get looked up. */
const MAX_NEW_DEVICES = 20;
/** Typing filters the same snapshot instead of asking BlueZ again on every key. */
const CACHE_MS = 1000;

const RFKILL_INTERFACE = "org.gnome.SettingsDaemon.Rfkill";
const RFKILL = ["call", "--session", "--dest", RFKILL_INTERFACE, "--object-path", "/org/gnome/SettingsDaemon/Rfkill"];

interface Snapshot {
  controller: Controller;
  airplane: Airplane;
  paired: BtDevice[];
  found: BtDevice[];
  error: string | null;
}

let cache: { at: number; snapshot: Snapshot } | null = null;
let scanning = false;

function bluetoothctl(args: string[], timeoutMs = QUERY_MS) {
  return runCapture("bluetoothctl", args, { timeoutMs });
}

/** Null when it worked, otherwise a readable reason. */
async function run(args: string[], timeoutMs = QUERY_MS): Promise<string | null> {
  const { code, stdout, stderr } = await bluetoothctl(args, timeoutMs);
  const output = `${stdout}\n${stderr}`;
  return bluetoothFailed(code, output) ? bluetoothError(output) : null;
}

function invalidate(): void {
  cache = null;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readAirplane(): Promise<Airplane> {
  const { code, stdout } = await runCapture(
    "gdbus",
    [...RFKILL, "--method", "org.freedesktop.DBus.Properties.GetAll", RFKILL_INTERFACE],
    { timeoutMs: QUERY_MS },
  );
  return code === 0 ? parseAirplane(stdout) : { blocked: null, hardware: null };
}

async function setAirplane(blocked: boolean): Promise<boolean> {
  const { code } = await runCapture(
    "gdbus",
    [...RFKILL, "--method", "org.freedesktop.DBus.Properties.Set", RFKILL_INTERFACE, "BluetoothAirplaneMode", `<${blocked}>`],
    { timeoutMs: QUERY_MS },
  );
  return code === 0;
}

async function isOn(): Promise<boolean> {
  const [show, airplane] = await Promise.all([bluetoothctl(["show"]), readAirplane()]);
  return parseController(show.stdout).powered && airplane.blocked !== true;
}

/**
 * Uses GNOME's own switch (gsd-rfkill), so the Quick Settings toggle and
 * Settings agree with Beam, then makes sure the adapter is powered.
 */
async function setPower(on: boolean): Promise<string | null> {
  invalidate();
  const airplane = await readAirplane();
  if (on && airplane.hardware) return "Bluetooth is blocked by a hardware switch.";
  const viaGnome = airplane.blocked !== null && (await setAirplane(!on));
  if (!on) {
    if (viaGnome) return null;
    const error = await run(["power", "off"]);
    return error ? `Could not turn Bluetooth off. ${error}` : null;
  }
  if (viaGnome && airplane.blocked) {
    // BlueZ powers the adapter on by itself once it is unblocked; give it a moment.
    for (let i = 0; i < 10; i++) {
      if (parseController((await bluetoothctl(["show"])).stdout).powered) return null;
      await delay(300);
    }
  }
  const error = await run(["power", "on"]);
  return error ? `Could not turn Bluetooth on. ${error}` : null;
}

async function toggleBluetooth(): Promise<RunResult> {
  const on = !(await isOn());
  const error = await setPower(on);
  if (error) return { type: "error", message: error };
  notify(on ? "Bluetooth turned on" : "Bluetooth turned off");
  return HIDE;
}

async function snapshot(): Promise<Snapshot> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.snapshot;
  const [show, airplane, all, pairedList] = await Promise.all([
    bluetoothctl(["show"]),
    readAirplane(),
    bluetoothctl(["devices"]),
    bluetoothctl(["devices", "Paired"]),
  ]);
  const controller = parseController(show.stdout);
  const paired = parseDeviceList(pairedList.stdout);
  const pairedAddresses = new Set(paired.map((device) => device.address));
  const found = parseDeviceList(all.stdout)
    .filter((device) => !pairedAddresses.has(device.address) && hasRealName(device.name, device.address))
    .slice(0, MAX_NEW_DEVICES);
  const lookup = (devices: Array<{ address: string; name: string }>, isPaired: boolean) =>
    Promise.all(
      devices.map(async (device): Promise<BtDevice> => {
        const info = parseDeviceInfo((await bluetoothctl(["info", device.address])).stdout);
        return info ?? { ...device, icon: "", paired: isPaired, trusted: false, connected: false, battery: null };
      }),
    );
  const [pairedInfo, foundInfo] = await Promise.all([lookup(paired, true), lookup(found, false)]);
  const result: Snapshot = {
    controller,
    airplane,
    paired: sortDevices(pairedInfo),
    // A device may have finished pairing between the two lists.
    found: sortDevices(foundInfo.filter((device) => !device.paired)),
    error: show.code !== 0 && !controller.present && /ENOENT/.test(show.stderr) ? "bluetoothctl is not installed" : null,
  };
  cache = { at: Date.now(), snapshot: result };
  return result;
}

function openSettings(): RunResult {
  launchDetached("gnome-control-center", ["bluetooth"]);
  return HIDE;
}

function startScan(): RunResult {
  if (scanning) return { type: "stay", toast: "Already scanning" };
  scanning = true;
  invalidate();
  // BlueZ stops discovery when bluetoothctl exits; found devices stay listed for about 30 seconds after.
  void bluetoothctl(["--timeout", String(SCAN_SECONDS), "scan", "on"], (SCAN_SECONDS + 7) * 1000).finally(() => {
    scanning = false;
    invalidate();
  });
  return { type: "stay", toast: `Scanning for ${SCAN_SECONDS} seconds…` };
}

async function connect(device: BtDevice): Promise<RunResult> {
  const error = await run(["connect", device.address], CONNECT_MS);
  invalidate();
  if (error) return { type: "error", message: `Could not connect to ${device.name}. ${error}` };
  return { type: "stay", toast: `Connected to ${device.name}` };
}

async function disconnect(device: BtDevice): Promise<RunResult> {
  const error = await run(["disconnect", device.address], CONNECT_MS);
  invalidate();
  if (error) return { type: "error", message: `Could not disconnect ${device.name}. ${error}` };
  return { type: "stay", toast: `Disconnected ${device.name}` };
}

async function remove(device: BtDevice): Promise<RunResult> {
  const error = await run(["remove", device.address]);
  invalidate();
  if (error) return { type: "error", message: `Could not remove ${device.name}. ${error}` };
  return { type: "stay", toast: `Removed ${device.name}` };
}

/** Trusting lets the device reconnect by itself later, as GNOME Settings does. */
async function pairAndConnect(device: BtDevice): Promise<RunResult> {
  const { code, stdout, stderr } = await bluetoothctl(["pair", device.address], PAIR_MS);
  const output = `${stdout}\n${stderr}`;
  if (bluetoothFailed(code, output) && !/AlreadyExists/.test(output)) {
    invalidate();
    return { type: "error", message: `Could not pair with ${device.name}. ${bluetoothError(output)}` };
  }
  await run(["trust", device.address]);
  const error = await run(["connect", device.address], CONNECT_MS);
  invalidate();
  if (error) return { type: "error", message: `Paired with ${device.name}, but could not connect. ${error}` };
  return { type: "stay", toast: `Connected to ${device.name}` };
}

const settingsAction: EntryAction = { id: "settings", title: "Open Bluetooth Settings", shortcut: "Ctrl+↵", run: openSettings };
const scanAction: EntryAction = { id: "scan", title: "Scan for New Devices", shortcut: "Ctrl+Shift+S", run: startScan };

function deviceEntry(device: BtDevice): Entry {
  const type = deviceType(device.icon);
  const actions: EntryAction[] = device.paired
    ? [
        device.connected
          ? { id: "disconnect", title: "Disconnect", shortcut: "↵", run: () => disconnect(device) }
          : { id: "connect", title: "Connect", shortcut: "↵", run: () => connect(device) },
        settingsAction,
        scanAction,
        { id: "remove", title: "Remove Device", shortcut: "Ctrl+D", danger: true, run: () => remove(device) },
      ]
    : [{ id: "pair", title: "Pair & Connect", shortcut: "↵", run: () => pairAndConnect(device) }, settingsAction];
  return {
    // The same id before and after pairing, so the selection stays on the device.
    id: `bt:dev:${device.address}`,
    title: device.name,
    subtitle: [type.label, device.battery !== null ? `Battery ${device.battery}%` : ""].filter(Boolean).join("  ·  "),
    icon: type.emoji,
    accessory: device.connected ? "Connected" : device.paired ? "Not Connected" : undefined,
    keywords: [type.label, device.address, device.connected ? "connected" : ""],
    actions,
  };
}

function powerEntry(on: boolean, airplane: Airplane): Entry {
  const title = on ? "Turn Bluetooth Off" : "Turn Bluetooth On";
  return {
    id: "bt:power",
    title,
    subtitle: airplane.hardware ? "Blocked by a hardware switch" : on ? "Bluetooth is on" : "Bluetooth is off",
    icon: on ? "🔵" : "⚪",
    accessory: on ? "On" : "Off",
    keywords: ["toggle", "power", "on", "off", "enable", "disable"],
    actions: [
      {
        id: "toggle",
        title,
        shortcut: "↵",
        run: async () => {
          const error = await setPower(!on);
          if (error) return { type: "error", message: error };
          return { type: "stay", toast: on ? "Bluetooth turned off" : "Bluetooth turned on" };
        },
      },
    ],
  };
}

function scanEntry(): Entry {
  return {
    id: "bt:scan",
    title: scanning ? "Scanning for Devices…" : "Scan for New Devices",
    subtitle: scanning ? "New devices appear as they are found" : "Put the device in pairing mode first",
    icon: "🔍",
    keywords: ["pair", "discover", "add", "search"],
    actions: [{ ...scanAction, shortcut: "↵" }],
  };
}

const settingsEntry: Entry = {
  id: "bt:settings",
  title: "Open Bluetooth Settings",
  subtitle: "For devices that need a PIN or code",
  icon: "⚙️",
  keywords: ["preferences", "pin", "gnome"],
  actions: [{ ...settingsAction, shortcut: "↵" }],
};

export function bluetoothCommands(_hide: () => void): Entry[] {
  return [
    {
      id: "cmd:bluetooth",
      ref: "cmd:bluetooth",
      title: "Bluetooth",
      subtitle: "Bluetooth",
      icon: "🔵",
      accessory: "Command",
      keywords: ["bt", "devices", "headphones", "pair", "connect", "wireless"],
      actions: [{ id: "run", title: "Open Bluetooth", shortcut: "↵", run: () => ({ type: "view", view: "bluetooth" }) }],
    },
    {
      id: "cmd:toggle-bluetooth",
      ref: "cmd:toggle-bluetooth",
      title: "Toggle Bluetooth",
      subtitle: "Bluetooth",
      icon: "🔵",
      accessory: "Command",
      keywords: ["bt", "turn on", "turn off", "enable", "disable"],
      actions: [{ id: "run", title: "Toggle Bluetooth", shortcut: "↵", run: toggleBluetooth }],
    },
  ];
}

export const bluetoothView: ViewProvider = {
  info: { title: "Bluetooth", placeholder: "Search Bluetooth devices…", preview: false, grid: false, refreshMs: 2000 },
  async sections(query: string): Promise<Section[]> {
    const snap = await snapshot();
    const q = query.trim();
    const matches = (entry: Entry) => !q || bestScore(q, [entry.title, ...(entry.keywords ?? [])]) > 0;
    if (snap.error) {
      return [{ title: "Bluetooth", entries: [{ ...settingsEntry, title: "Bluetooth Is Unavailable", subtitle: snap.error, icon: "⚠️" }] }];
    }
    const on = snap.controller.powered && snap.airplane.blocked !== true;
    if (!snap.controller.present && snap.airplane.blocked !== true) {
      return [{ title: "Bluetooth", entries: [{ ...settingsEntry, title: "No Bluetooth Adapter Found", icon: "⚠️" }] }];
    }
    if (!on) return [{ title: "Bluetooth", entries: [powerEntry(false, snap.airplane), settingsEntry].filter(matches) }];
    // The toggle sits below the devices so Enter on a freshly opened view never turns Bluetooth off.
    return [
      { title: "My Devices", entries: snap.paired.map(deviceEntry).filter(matches) },
      { title: "New Devices", entries: snap.found.map(deviceEntry).filter(matches) },
      { title: "Bluetooth", entries: [scanEntry(), powerEntry(true, snap.airplane), settingsEntry].filter(matches) },
    ];
  },
};
