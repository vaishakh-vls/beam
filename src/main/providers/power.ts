import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { HIDE, type Entry, type EntryAction, type Section, type ViewProvider } from "../entry";
import { showForm } from "../forms";
import { bestScore } from "../fuzzy";
import {
  adapterWatts,
  batteryFromUevent,
  batteryGaugeSvg,
  batteryReport,
  CHARGE_PRESETS,
  degradedText,
  describeDelay,
  formatMinutes,
  hasChargeLimit,
  healthLabel,
  healthPercent,
  MIN_END_THRESHOLD,
  parseCanAnswer,
  parseDelay,
  parsePowerProfiles,
  parseUevent,
  presetFor,
  profileHint,
  profileTitle,
  stateText,
  thresholdProblem,
  type Battery,
  type PowerProfiles,
} from "../power";
import { copyText, isGnome, launchDetached, notify, runCapture } from "../system";
import { themeTextColors } from "./themes";
import type { RunResult } from "../../shared/types";

const SUPPLY = "/sys/class/power_supply";
/** Restart, Shut Down and Log Out run on a second Enter within this time. */
const CONFIRM_MS = 4000;
/** Timers check the wall clock, so time spent asleep counts. */
const TIMER_TICK_MS = 5000;
/** A timer this overdue was due while the laptop slept; firing on wake would surprise. */
const OVERDUE_MS = 2 * 60_000;

interface PowerState {
  batteries: Battery[];
  onAc: boolean;
  adapterW: number | null;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

/** Every power supply in one pass: laptop batteries, the AC adapter and USB-C sources. */
function readPower(): PowerState {
  const state: PowerState = { batteries: [], onAc: false, adapterW: null };
  let names: string[] = [];
  try {
    names = fs.readdirSync(SUPPLY);
  } catch {
    return state;
  }
  for (const name of names) {
    const dir = path.join(SUPPLY, name);
    const props = parseUevent(readText(path.join(dir, "uevent")) ?? "");
    // Wireless mice and headsets report batteries too, with scope "Device".
    if (props.SCOPE === "Device") continue;
    if (props.TYPE === "Battery") {
      if (props.PRESENT === "0") continue;
      state.batteries.push(
        batteryFromUevent(props, {
          start: readText(path.join(dir, "charge_control_start_threshold")),
          end: readText(path.join(dir, "charge_control_end_threshold")),
        }),
      );
    } else if (props.ONLINE === "1") {
      state.onAc = true;
      const watts = adapterWatts(props);
      if (watts) state.adapterW = Math.max(state.adapterW ?? 0, watts);
    }
  }
  state.batteries.sort((a, b) => a.name.localeCompare(b.name));
  return state;
}

// Power profiles

async function readProfiles(): Promise<PowerProfiles | null> {
  const { code, stdout } = await runCapture("powerprofilesctl", ["list"], { timeoutMs: 5000 });
  if (code !== 0) return null;
  const profiles = parsePowerProfiles(stdout);
  return profiles.profiles.length ? profiles : null;
}

export async function setProfile(profile: string): Promise<RunResult> {
  const { code, stderr } = await runCapture("powerprofilesctl", ["set", profile], { timeoutMs: 10_000 });
  if (code === 0) return { type: "stay", toast: `Power mode set to ${profileTitle(profile)}` };
  if (/ENOENT/.test(stderr)) return { type: "error", message: "Power modes need power-profiles-daemon (sudo apt install power-profiles-daemon)." };
  return { type: "error", message: stderr.trim().split("\n").pop() || `powerprofilesctl failed with code ${code}` };
}

// Charge limit (root helper)

/** The root helper that writes the thresholds; pkexec runs it, allowed by Beam's polkit policy. */
function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "beam-power")
    : path.join(app.getAppPath(), "packaging", "beam-power");
}

async function setChargeLimit(start: number, end: number): Promise<RunResult> {
  const problem = thresholdProblem(start, end);
  if (problem) return { type: "error", message: problem };
  const { code, stderr } = await runCapture("pkexec", [helperPath(), "charge-limit", String(start), String(end)], {
    timeoutMs: 120_000,
  });
  if (code === 126 || code === 127) return { type: "error", message: "Not allowed: the password prompt was dismissed or refused." };
  if (code !== 0) return { type: "error", message: stderr.trim() || `beam-power failed with code ${code}` };
  return { type: "stay", toast: end >= 100 ? "Charging to 100%" : `Charging stops at ${end}%` };
}

function customLimitForm(battery: Battery): RunResult {
  const end = hasChargeLimit(battery) ? battery.endThreshold! : 80;
  return showForm(
    {
      title: "Custom Charge Limit",
      submitLabel: "Set Charge Limit",
      fields: [
        { name: "end", label: "Stop charging at (%)", type: "text", value: String(end), hint: `${MIN_END_THRESHOLD}–100` },
        {
          name: "start",
          label: "Start charging below (%)",
          type: "text",
          value: String(hasChargeLimit(battery) ? battery.startThreshold ?? end - 5 : end - 5),
          hint: "A few points lower, so the battery isn't topped up over and over",
        },
      ],
    },
    async (values) => {
      const result = await setChargeLimit(Number(values.start.trim()), Number(values.end.trim()));
      return result.type === "error" ? result : { type: "view", view: "power" };
    },
  );
}

// Session

let canHibernate: boolean | null = null;

async function hibernateAvailable(): Promise<boolean> {
  if (canHibernate === null) {
    const { stdout } = await runCapture(
      "busctl",
      ["call", "org.freedesktop.login1", "/org/freedesktop/login1", "org.freedesktop.login1.Manager", "CanHibernate"],
      { timeoutMs: 5000 },
    );
    canHibernate = parseCanAnswer(stdout);
  }
  return canHibernate;
}

type SessionEnd = "logout" | "reboot" | "poweroff";

/**
 * Ends the session the way GNOME's own menu does once confirmed: apps get to
 * quit, and one with unsaved work can still stop it. Beam has asked already,
 * so GNOME's 60-second dialog is skipped.
 */
async function endSession(kind: SessionEnd): Promise<string | null> {
  if (isGnome()) {
    const call = kind === "logout" ? ["Logout", "1"] : [kind === "reboot" ? "RequestReboot" : "RequestShutdown"];
    const { code, stderr } = await runCapture(
      "gdbus",
      ["call", "--session", "--dest", "org.gnome.SessionManager", "--object-path", "/org/gnome/SessionManager",
        "--method", `org.gnome.SessionManager.${call[0]}`, ...call.slice(1)],
      { timeoutMs: 15_000 },
    );
    return code === 0 ? null : stderr.trim() || `gdbus failed with code ${code}`;
  }
  if (kind === "logout") {
    const session = process.env.XDG_SESSION_ID;
    if (!session) return "Log out from the system menu: this desktop isn't GNOME.";
    launchDetached("loginctl", ["terminate-session", session]);
  } else {
    launchDetached("systemctl", [kind]);
  }
  return null;
}

let armed: { id: string; until: number } | null = null;

const isArmed = (id: string) => armed?.id === id && Date.now() < armed.until;

/** The first Enter arms the action and the second, within a few seconds, runs it. */
function confirmTwice(id: string, verb: string, run: () => Promise<RunResult>): () => Promise<RunResult> | RunResult {
  return () => {
    if (isArmed(id)) {
      armed = null;
      return run();
    }
    armed = { id, until: Date.now() + CONFIRM_MS };
    return { type: "stay", toast: `Press ↵ again to ${verb}` };
  };
}

function sessionEnd(kind: SessionEnd): () => Promise<RunResult> {
  return async () => {
    const error = await endSession(kind);
    return error ? { type: "error", message: error } : HIDE;
  };
}

function detached(command: string, ...args: string[]): () => RunResult {
  return () => {
    launchDetached(command, args);
    return HIDE;
  };
}

// Timers

type TimerKind = "sleep" | "shutdown";

let timer: { kind: TimerKind; at: number; warned: boolean; interval: NodeJS.Timeout } | null = null;

const timerVerb = (kind: TimerKind) => (kind === "sleep" ? "Sleep" : "Shut down");

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function cancelTimer(): RunResult {
  if (!timer) return { type: "stay" };
  clearInterval(timer.interval);
  const verb = timerVerb(timer.kind);
  timer = null;
  return { type: "stay", toast: `${verb} timer cancelled` };
}

function fireTimer(kind: TimerKind): void {
  if (kind === "sleep") {
    launchDetached("systemctl", ["suspend"]);
    return;
  }
  void endSession("poweroff").then((error) => {
    if (error) notify("Beam could not shut down", error);
  });
}

function tick(): void {
  if (!timer) return;
  const left = timer.at - Date.now();
  if (left < -OVERDUE_MS) {
    const verb = timerVerb(timer.kind);
    cancelTimer();
    notify(`${verb} timer cancelled`, "It was due while the laptop was asleep.");
  } else if (left <= 0) {
    const kind = timer.kind;
    cancelTimer();
    fireTimer(kind);
  } else if (left <= 60_000 && !timer.warned) {
    timer.warned = true;
    notify(`${timerVerb(timer.kind)} in 1 minute`, "Open Beam › Power Management to cancel.");
  }
}

function startTimer(kind: TimerKind, ms: number): RunResult {
  if (timer) clearInterval(timer.interval);
  // Short timers skip the one-minute warning.
  timer = { kind, at: Date.now() + ms, warned: ms <= 90_000, interval: setInterval(tick, TIMER_TICK_MS) };
  const when = describeDelay(ms);
  notify(`${timerVerb(kind)} ${when}`, "Cancel it from Beam › Power Management.");
  return { type: "stay", toast: `${timerVerb(kind)} ${when}` };
}

function timerForm(kind: TimerKind): RunResult {
  return showForm(
    {
      title: kind === "sleep" ? "Sleep in…" : "Shut Down in…",
      submitLabel: "Start Timer",
      fields: [
        {
          name: "delay",
          label: "When",
          type: "text",
          placeholder: "30m, 1h 30m or 23:00",
          hint: "Minutes, hours or a clock time. Beam warns a minute before.",
        },
      ],
    },
    (values) => {
      const ms = parseDelay(values.delay);
      if (ms === null) return { type: "error", message: "Try 30, 45m, 1h 30m or 23:00 (up to 24 hours)." };
      startTimer(kind, ms);
      return { type: "view", view: "power" };
    },
  );
}

// View

function batteryIcon(battery: Battery): string {
  if (battery.status === "Charging") return "⚡";
  return battery.percent <= 20 && battery.status === "Discharging" ? "🪫" : "🔋";
}

function showReport(state: PowerState, battery: Battery | undefined): RunResult {
  if (!battery) return { type: "output", title: "Battery", text: "No battery found: this computer runs on mains power." };
  const colors = themeTextColors();
  return {
    type: "output",
    title: `Battery · ${battery.percent}%`,
    text: batteryReport(battery, state.onAc, state.adapterW),
    image: batteryGaugeSvg(battery.percent, battery.status === "Charging", { fill: colors.accent, frame: colors.dim, text: colors.text }),
  };
}

function reportActions(state: PowerState, battery: Battery): EntryAction[] {
  return [
    { id: "report", title: "Show Battery Report", shortcut: "↵", run: () => showReport(state, battery) },
    {
      id: "copy-report",
      title: "Copy Battery Report",
      shortcut: "Ctrl+↵",
      run: () => {
        copyText(batteryReport(battery, state.onAc, state.adapterW));
        return { type: "stay", toast: "Battery report copied" };
      },
    },
  ];
}

function batteryEntries(state: PowerState): Entry[] {
  const entries: Entry[] = [];
  const many = state.batteries.length > 1;
  for (const battery of state.batteries) {
    const rate = battery.powerW && battery.powerW >= 0.5 ? `${battery.powerW.toFixed(1)} W` : null;
    const health = healthPercent(battery);
    entries.push({
      id: `power:battery:${battery.name}`,
      title: `${battery.percent}% · ${stateText(battery, state.onAc)}`,
      subtitle: rate ? (battery.status === "Charging" ? `Charging at ${rate}` : `Drawing ${rate}`) : undefined,
      icon: batteryIcon(battery),
      accessory: many ? battery.name : undefined,
      keywords: ["battery", "charge", "time remaining", "power draw", "watts"],
      actions: reportActions(state, battery),
    });
    entries.push({
      id: `power:health:${battery.name}`,
      title: health === null ? "Health unknown" : `Health ${health}% · ${healthLabel(health)}`,
      subtitle: [
        battery.energyFull && battery.energyDesign
          ? `${battery.energyFull.toFixed(1)} Wh of ${battery.energyDesign.toFixed(1)} Wh when new`
          : "",
        battery.cycles ? `${battery.cycles} cycles` : "",
      ].filter(Boolean).join(" · "),
      icon: "🩺",
      accessory: many ? battery.name : undefined,
      keywords: ["battery health", "capacity", "wear", "cycles"],
      actions: reportActions(state, battery),
    });
  }
  entries.push({
    id: "power:adapter",
    title: state.onAc ? `Plugged in${state.adapterW ? ` · ${state.adapterW} W adapter` : ""}` : "On battery power",
    subtitle: state.onAc ? undefined : "No charger connected",
    icon: "🔌",
    keywords: ["ac", "adapter", "charger", "usb-c"],
    actions: state.batteries[0] ? reportActions(state, state.batteries[0]) : [],
  });
  return entries;
}

function profileEntries(profiles: PowerProfiles): Entry[] {
  const icons: Record<string, string> = { performance: "🚀", balanced: "⚖️", "power-saver": "🍃" };
  // Show fastest first, like GNOME's menu.
  const order = ["performance", "balanced", "power-saver"];
  return [...profiles.profiles]
    .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99))
    .map((profile) => ({
      id: `power:profile:${profile}`,
      title: profileTitle(profile),
      subtitle: profile === "performance" && profiles.degraded ? degradedText(profiles.degraded) : profileHint(profile),
      icon: icons[profile] ?? "⚙️",
      accessory: profile === profiles.active ? "✓ Current" : undefined,
      keywords: ["power mode", "power profile", profile],
      actions: [{ id: "set", title: "Set Power Mode", shortcut: "↵", run: () => setProfile(profile) }],
    }));
}

function chargeEntries(battery: Battery): Entry[] {
  const current = presetFor(battery);
  const entries: Entry[] = CHARGE_PRESETS.map((preset) => ({
    id: `power:limit:${preset.id}`,
    title: preset.title,
    subtitle: preset.hint,
    icon: preset.end === 100 ? "🔋" : "🌱",
    accessory: current?.id === preset.id ? "✓ Current" : undefined,
    keywords: ["charge limit", "charge threshold", "battery care", "longevity", `${preset.end}%`],
    actions: [{ id: "set", title: "Set Charge Limit", shortcut: "↵", run: () => setChargeLimit(preset.start, preset.end) }],
  }));
  entries.push({
    id: "power:limit:custom",
    title: "Custom Limit…",
    subtitle: current ? "Choose your own stop and start levels" : `Now: stop at ${battery.endThreshold}%, resume below ${battery.startThreshold}%`,
    icon: "🎚️",
    accessory: current ? undefined : "✓ Current",
    keywords: ["charge limit", "charge threshold"],
    actions: [{ id: "set", title: "Set Custom Limit…", shortcut: "↵", run: () => customLimitForm(battery) }],
  });
  return entries;
}

function chargeTitle(battery: Battery): string {
  if (!hasChargeLimit(battery)) return "Charge Limit · off";
  return `Charge Limit · stops at ${battery.endThreshold}%`;
}

async function sessionEntries(): Promise<Entry[]> {
  const confirmEntry = (id: string, title: string, verb: string, icon: string, kind: SessionEnd, keywords: string[]): Entry => ({
    id: `power:session:${id}`,
    title: isArmed(id) ? `Press ↵ again to ${verb}` : title,
    subtitle: isArmed(id) ? "Or wait to cancel" : undefined,
    icon,
    accessory: isArmed(id) ? "Confirm" : undefined,
    keywords,
    actions: [{ id: "run", title, shortcut: "↵", danger: true, run: confirmTwice(id, verb, sessionEnd(kind)) }],
  });
  const entries: Entry[] = [
    {
      id: "power:session:lock",
      title: "Lock Screen",
      icon: "🔒",
      keywords: ["lock"],
      actions: [{ id: "run", title: "Lock Screen", shortcut: "↵", run: detached("loginctl", "lock-session") }],
    },
    {
      id: "power:session:sleep",
      title: "Sleep",
      icon: "🌙",
      keywords: ["suspend"],
      actions: [{ id: "run", title: "Sleep", shortcut: "↵", run: detached("systemctl", "suspend") }],
    },
  ];
  if (await hibernateAvailable()) {
    entries.push({
      id: "power:session:hibernate",
      title: "Hibernate",
      subtitle: "Saves your session to disk and powers off",
      icon: "🐻",
      keywords: ["hibernate", "suspend to disk"],
      actions: [{ id: "run", title: "Hibernate", shortcut: "↵", run: detached("systemctl", "hibernate") }],
    });
  }
  entries.push(
    confirmEntry("logout", "Log Out", "log out", "🚪", "logout", ["sign out", "log off"]),
    confirmEntry("restart", "Restart", "restart", "🔁", "reboot", ["reboot"]),
    confirmEntry("shutdown", "Shut Down", "shut down", "⏻", "poweroff", ["power off", "turn off"]),
  );
  return entries;
}

function timerEntries(delayMs: number | null, only: TimerKind | null): Entry[] {
  const entries: Entry[] = [];
  if (timer) {
    const t = timer;
    entries.push({
      id: "power:timer:active",
      title: `${timerVerb(t.kind)} at ${clockTime(t.at)}`,
      subtitle: `in ${formatMinutes(Math.max(1, Math.round((t.at - Date.now()) / 60_000)))}`,
      icon: "⏲️",
      accessory: "Timer",
      keywords: ["timer", "cancel"],
      actions: [{ id: "cancel", title: "Cancel Timer", shortcut: "↵", danger: true, run: cancelTimer }],
    });
  }
  for (const kind of ["sleep", "shutdown"] as const) {
    if (only && only !== kind) continue;
    const label = kind === "sleep" ? "Sleep" : "Shut Down";
    entries.push({
      id: `power:timer:${kind}`,
      title: delayMs === null ? `${label} in…` : `${label} ${describeDelay(delayMs)}`,
      subtitle: delayMs === null ? "Type a time like 30m, 1h 30m or 23:00 to set it here" : undefined,
      icon: kind === "sleep" ? "💤" : "⏲️",
      keywords: ["timer", "later", "schedule", kind === "sleep" ? "suspend" : "power off"],
      actions: [
        {
          id: "start",
          title: delayMs === null ? `${label} in…` : "Start Timer",
          shortcut: "↵",
          run: () => (delayMs === null ? timerForm(kind) : startTimer(kind, delayMs)),
        },
      ],
    });
  }
  return entries;
}

/** "45m", "sleep 30", "shutdown in 1h", "power off at 23:00" in the search field. */
function timerQuery(query: string): { kind: TimerKind | null; ms: number } | null {
  const match = query.trim().toLowerCase().match(/^(?:(sleep|suspend|shut ?down|power ?off)\s+)?(.+)$/);
  // A bare number could be a search for "80%", so it needs "sleep" or "shutdown" in front.
  if (!match || (!match[1] && /^\d+(\.\d+)?$/.test(match[2].trim()))) return null;
  const ms = parseDelay(match[2]);
  if (ms === null) return null;
  return { kind: match[1] ? (/^s(leep|uspend)/.test(match[1]) ? "sleep" : "shutdown") : null, ms };
}

export const powerView: ViewProvider = {
  info: {
    title: "Power",
    placeholder: "Battery, power mode, charge limit, sleep in 30m…",
    preview: false,
    grid: false,
    refreshMs: 3000,
  },
  async sections(query): Promise<Section[]> {
    const timed = timerQuery(query);
    if (timed) return [{ title: "Timer", entries: timerEntries(timed.ms, timed.kind) }];

    const state = readPower();
    const [profiles, session] = await Promise.all([readProfiles(), sessionEntries()]);
    const battery = state.batteries[0];
    const sections: Section[] = [
      { title: "Battery", entries: state.batteries.length ? batteryEntries(state) : [] },
      { title: profiles?.active ? `Power Mode · ${profileTitle(profiles.active)}` : "Power Mode", entries: profiles ? profileEntries(profiles) : [] },
      { title: battery ? chargeTitle(battery) : "Charge Limit", entries: battery && battery.endThreshold !== null ? chargeEntries(battery) : [] },
      { title: "Session", entries: session },
      { title: "Timers", entries: timerEntries(null, null) },
    ];
    const q = query.trim();
    if (!q) return sections;
    return sections.map((section) => ({
      ...section,
      entries: section.entries.filter((e) => bestScore(q, [e.title, ...(e.keywords ?? [])]) > 0),
    }));
  },
};

export function powerCommands(_hide: () => void): Entry[] {
  const command = (name: string, title: string, icon: string, run: () => RunResult | Promise<RunResult>, keywords: string[]): Entry => ({
    id: `cmd:${name}`,
    ref: `cmd:${name}`,
    title,
    subtitle: "Power",
    icon,
    accessory: "Command",
    keywords,
    actions: [{ id: "run", title: "Run Command", shortcut: "↵", run }],
  });
  return [
    command("power", "Power Management", "🔋", () => ({ type: "view", view: "power" }), [
      "battery", "power mode", "power profile", "charge limit", "sleep timer", "shutdown timer", "hibernate",
    ]),
    command("battery", "Battery Status", "🔋", () => {
      const state = readPower();
      return showReport(state, state.batteries[0]);
    }, ["battery", "health", "charge", "time remaining", "cycles"]),
    command("power-performance", "Set Power Profile: Performance", "🚀", () => setProfile("performance"), ["power mode", "fast", "turbo"]),
    command("power-balanced", "Set Power Profile: Balanced", "⚖️", () => setProfile("balanced"), ["power mode", "default"]),
    command("power-saver", "Set Power Profile: Power Saver", "🍃", () => setProfile("power-saver"), ["power mode", "battery saver", "low power", "eco"]),
  ];
}
