import { bluetoothScan } from "../btscan";
import { deviceType, parseDeviceInfo, parseDeviceList, type BtDevice } from "../bluetooth";
import {
  earbudsLevels,
  gigabytes,
  nearness,
  parseEarbuds,
  parseIdeviceInfo,
  parseUdids,
  phoneFrom,
  phoneProblem,
  type Earbuds,
  type Phone,
} from "../devices";
import { type Entry, type EntryAction, type Section, type ViewProvider } from "../entry";
import { bestScore } from "../fuzzy";
import { copyText, runCapture } from "../system";
import type { RunResult } from "../../shared/types";

const QUERY_MS = 5000;
/** One listen for broadcasts; the view starts the next while it stays open. */
const SCAN_SECONDS = 10;
/** Weaker than this is across the office: somebody else's. */
const MIN_RSSI = -80;
const MAX_EARBUDS = 6;
/** The phone is asked over USB, which takes a moment; its battery does not move faster than this. */
const PHONE_CACHE_MS = 10_000;
const INSTALL_COMMAND = "sudo apt install libimobiledevice-utils";

let scanning = false;
let phones: { at: number; entries: Entry[] } | null = null;

/** AirPods only show up while BlueZ is scanning; nothing keeps listening after the view is closed. */
function listen(): void {
  if (scanning) return;
  scanning = true;
  void bluetoothScan(SCAN_SECONDS, "le").finally(() => {
    scanning = false;
  });
}

const openBluetooth: EntryAction = { id: "bluetooth", title: "Open Bluetooth", shortcut: "Ctrl+↵", run: () => ({ type: "view", view: "bluetooth" }) };

function copyAction(title: string, text: string): EntryAction {
  return {
    id: "copy",
    title,
    shortcut: "↵",
    run: (): RunResult => {
      copyText(text);
      return { type: "stay", toast: "Copied" };
    },
  };
}

function hint(id: string, title: string, subtitle: string, icon: string, actions: EntryAction[] = [{ ...openBluetooth, shortcut: "↵" }]): Entry {
  return { id: `devices:${id}`, title, subtitle, icon, actions };
}

function earbudsEntry(buds: Earbuds): Entry {
  const levels = earbudsLevels(buds);
  return {
    id: `devices:buds:${buds.address}`,
    title: buds.model,
    subtitle: levels,
    icon: "🎧",
    accessory: nearness(buds.rssi),
    keywords: ["airpods", "beats", "earbuds", "headphones", "battery"],
    actions: [copyAction("Copy Battery Levels", `${buds.model}: ${levels}`), openBluetooth],
  };
}

async function earbudsEntries(): Promise<Entry[]> {
  const { code, stdout } = await runCapture(
    "gdbus",
    ["call", "--system", "--dest", "org.bluez", "--object-path", "/", "--method", "org.freedesktop.DBus.ObjectManager.GetManagedObjects"],
    { timeoutMs: QUERY_MS },
  );
  if (code !== 0) return [hint("no-bluetooth", "Bluetooth Is Unavailable", "AirPods are read over Bluetooth", "⚠️")];
  if (!/'Powered': <true>/.test(stdout)) return [hint("bluetooth-off", "Bluetooth Is Off", "Turn it on to see AirPods nearby", "⚪")];
  listen();
  const near = parseEarbuds(stdout)
    .filter((buds) => buds.rssi >= MIN_RSSI)
    .slice(0, MAX_EARBUDS);
  if (near.length) return near.map(earbudsEntry);
  return [hint("no-buds", "Looking for AirPods…", "Open the case lid or put them in your ears", "🎧")];
}

async function ideviceinfo(udid: string, domain?: string): Promise<{ ok: boolean; output: string }> {
  const { code, stdout, stderr } = await runCapture("ideviceinfo", ["-u", udid, ...(domain ? ["-q", domain] : [])], { timeoutMs: QUERY_MS });
  return { ok: code === 0, output: code === 0 ? stdout : `${stdout}\n${stderr}` };
}

function phoneEntry(phone: Phone): Entry {
  const battery = phone.battery === null ? "" : `Battery ${phone.battery}%${phone.charging ? " ⚡" : ""}`;
  const storage = phone.free !== null && phone.capacity ? `${gigabytes(phone.free)} free of ${gigabytes(phone.capacity)}` : "";
  const subtitle = [battery, phone.version ? `iOS ${phone.version}` : "", storage].filter(Boolean).join("  ·  ");
  return {
    id: `devices:phone:${phone.udid}`,
    title: phone.name,
    subtitle,
    icon: "📱",
    accessory: phone.kind,
    keywords: ["iphone", "ipad", "phone", "battery", "ios"],
    actions: [copyAction("Copy Details", `${phone.name}: ${subtitle}`)],
  };
}

async function pair(udid: string): Promise<RunResult> {
  const { code, stdout, stderr } = await runCapture("idevicepair", ["-u", udid, "pair"], { timeoutMs: QUERY_MS });
  phones = null;
  if (code === 0) return { type: "stay", toast: "Trusted" };
  return { type: "stay", toast: phoneProblem(`${stdout}\n${stderr}`) };
}

async function readPhone(udid: string): Promise<Entry> {
  const info = await ideviceinfo(udid);
  if (!info.ok) {
    return hint(`phone:${udid}`, "iPhone Connected", phoneProblem(info.output), "📱", [{ id: "pair", title: "Pair with This iPhone", shortcut: "↵", run: () => pair(udid) }]);
  }
  const [battery, disk] = await Promise.all([ideviceinfo(udid, "com.apple.mobile.battery"), ideviceinfo(udid, "com.apple.disk_usage")]);
  return phoneEntry(phoneFrom(udid, parseIdeviceInfo(info.output), battery.ok ? parseIdeviceInfo(battery.output) : {}, disk.ok ? parseIdeviceInfo(disk.output) : {}));
}

async function phoneEntries(): Promise<Entry[]> {
  if (phones && Date.now() - phones.at < PHONE_CACHE_MS) return phones.entries;
  const list = await runCapture("idevice_id", ["-l"], { timeoutMs: QUERY_MS });
  let entries: Entry[];
  if (list.code !== 0 && /ENOENT/.test(list.stderr)) {
    entries = [hint("install", "iPhone Support Is Not Installed", `Enter copies the command: ${INSTALL_COMMAND}`, "📱", [copyAction("Copy Install Command", INSTALL_COMMAND)])];
  } else {
    // Without a phone plugged in the helper service is not running, and idevice_id fails: the same as none.
    const udids = [...new Set(parseUdids(list.stdout))];
    entries = udids.length
      ? await Promise.all(udids.map(readPhone))
      : [hint("no-phone", "No iPhone Connected", "Plug it in with a cable, unlock it and tap Trust", "📱", [{ id: "refresh", title: "Look Again", shortcut: "↵", run: () => ({ type: "stay", toast: "Looking…" }) }])];
  }
  phones = { at: Date.now(), entries };
  return entries;
}

function bluetoothEntry(device: BtDevice): Entry {
  const type = deviceType(device.icon);
  const battery = device.battery !== null ? `Battery ${device.battery}%` : "";
  return {
    id: `devices:bt:${device.address}`,
    title: device.name,
    subtitle: [type.label, battery].filter(Boolean).join("  ·  "),
    icon: type.emoji,
    accessory: "Connected",
    keywords: [type.label, "bluetooth", "battery"],
    actions: [{ ...openBluetooth, shortcut: "↵" }],
  };
}

/** Connected Bluetooth devices: the ones that can say how full they are. */
async function bluetoothEntries(): Promise<Entry[]> {
  const list = await runCapture("bluetoothctl", ["devices", "Connected"], { timeoutMs: QUERY_MS });
  const devices = await Promise.all(
    parseDeviceList(list.stdout).map(async ({ address }) => parseDeviceInfo((await runCapture("bluetoothctl", ["info", address], { timeoutMs: QUERY_MS })).stdout)),
  );
  return devices.filter((device): device is BtDevice => device !== null && device.connected).map(bluetoothEntry);
}

export function devicesCommands(_hide: () => void): Entry[] {
  return [
    {
      id: "cmd:devices",
      ref: "cmd:devices",
      title: "Devices",
      subtitle: "Battery of your iPhone, AirPods and Bluetooth devices",
      icon: "🔋",
      accessory: "Command",
      keywords: ["iphone", "airpods", "battery", "nearby", "beats", "ipad", "headphones", "charge"],
      actions: [{ id: "run", title: "Open Devices", shortcut: "↵", run: () => ({ type: "view", view: "devices" }) }],
    },
  ];
}

export const devicesView: ViewProvider = {
  info: { title: "Devices", placeholder: "Search devices…", preview: false, grid: false, refreshMs: 2000 },
  async sections(query: string): Promise<Section[]> {
    const [phoneList, buds, bluetooth] = await Promise.all([phoneEntries(), earbudsEntries(), bluetoothEntries()]);
    const q = query.trim();
    const matches = (entry: Entry) => !q || bestScore(q, [entry.title, ...(entry.keywords ?? [])]) > 0;
    return [
      { title: "iPhone and iPad", entries: phoneList.filter(matches) },
      { title: "AirPods Nearby", entries: buds.filter(matches) },
      { title: "Connected over Bluetooth", entries: bluetooth.filter(matches) },
    ];
  },
};
