import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import type { Entry, Section, ViewProvider } from "../entry";
import {
  FAN_LEVELS,
  GUARD_TEMP_C,
  levelHint,
  levelTitle,
  parseFanFile,
  shouldRevertToAuto,
  type FanLevel,
  type FanState,
} from "../fan";
import { notify, runCapture } from "../system";
import type { RunResult } from "../../shared/types";

const FAN_FILE = "/proc/acpi/ibm/fan";
const HWMON = "/sys/class/hwmon";
const GUARD_INTERVAL_MS = 15_000;

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return null;
  }
}

function readFan(): FanState | null {
  const text = readText(FAN_FILE);
  return text === null ? null : parseFanFile(text);
}

/** hwmon folders by driver name, e.g. "thinkpad", "coretemp", "nvme". */
function hwmonDirs(): Map<string, string> {
  const dirs = new Map<string, string>();
  try {
    for (const entry of fs.readdirSync(HWMON)) {
      const dir = path.join(HWMON, entry);
      const name = readText(path.join(dir, "name"));
      if (name && !dirs.has(name)) dirs.set(name, dir);
    }
  } catch {
    // No hwmon on this machine.
  }
  return dirs;
}

/** Each fan's RPM from the ThinkPad hwmon device; the procfs file only shows the first fan. */
function fanSpeeds(dirs: Map<string, string>): number[] {
  const dir = dirs.get("thinkpad");
  if (!dir) return [];
  const speeds: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const rpm = readText(path.join(dir, `fan${i}_input`));
    if (rpm === null) break;
    speeds.push(Number(rpm));
  }
  return speeds;
}

function tempOf(dir: string | undefined, label?: string): number | null {
  if (!dir) return null;
  try {
    for (const file of fs.readdirSync(dir)) {
      const match = file.match(/^(temp\d+)_input$/);
      if (!match) continue;
      if (label && readText(path.join(dir, `${match[1]}_label`)) !== label) continue;
      const milli = Number(readText(path.join(dir, file)));
      if (Number.isFinite(milli)) return milli / 1000;
    }
  } catch {
    // Sensor went away.
  }
  return null;
}

/** CPU package temperature: Intel's coretemp, AMD's k10temp, else the ACPI zone. */
function cpuTemp(dirs = hwmonDirs()): number | null {
  return (
    tempOf(dirs.get("coretemp"), "Package id 0") ??
    tempOf(dirs.get("k10temp"), "Tctl") ??
    tempOf(dirs.get("acpitz"))
  );
}

/** The root helper that writes the fan level; pkexec runs it, allowed by Beam's polkit policy. */
function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "beam-fan")
    : path.join(app.getAppPath(), "packaging", "beam-fan");
}

async function runHelper(args: string[]): Promise<string | null> {
  const { code, stderr } = await runCapture("pkexec", [helperPath(), ...args], { timeoutMs: 120_000 });
  if (code === 0) return null;
  if (code === 126 || code === 127) return "Not allowed: the password prompt was dismissed or refused.";
  return stderr.trim() || `beam-fan failed with code ${code}`;
}

export async function setFanLevel(level: FanLevel): Promise<RunResult> {
  const fan = readFan();
  if (!fan) return { type: "error", message: "This laptop has no ThinkPad fan control." };
  if (!fan.controllable) return { type: "view", view: "fans" };
  const error = await runHelper(["set", level]);
  if (error) return { type: "error", message: error };
  return { type: "stay", toast: `Fan set to ${levelTitle(level)}` };
}

/** One-time setup: turns on thinkpad_acpi's fan_control. Asks for the password. */
async function enableFanControl(): Promise<RunResult> {
  const error = await runHelper(["enable"]);
  if (error) return { type: "error", message: error };
  if (readFan()?.controllable) return { type: "stay", toast: "Fan control is on" };
  notify("Fan control turns on after a restart", "The ThinkPad driver was busy, so it will load the new setting at the next start.");
  return { type: "stay", toast: "Fan control turns on after a restart" };
}

/**
 * While a quiet manual level is set, watch the CPU and hand control back to
 * the firmware before it gets hot. Cheap: two small file reads every 15 s.
 */
export function startFanGuard(): void {
  if (!fs.existsSync(FAN_FILE)) return;
  let reverting = false;
  setInterval(() => {
    const fan = readFan();
    if (!fan || reverting || !shouldRevertToAuto(fan.level, cpuTemp())) return;
    reverting = true;
    void runHelper(["set", "auto"]).then((error) => {
      reverting = false;
      if (error) notify("The CPU is hot but the fan could not be set to Auto", error);
      else notify("Fan set back to Auto", `The CPU reached ${GUARD_TEMP_C} °C on a quiet fan level.`);
    });
  }, GUARD_INTERVAL_MS).unref();
}

const formatTemp = (celsius: number | null) => (celsius === null ? "—" : `${Math.round(celsius)} °C`);

function statusEntries(fan: FanState | null): Entry[] {
  const dirs = hwmonDirs();
  const speeds = fanSpeeds(dirs);
  if (!speeds.length && fan?.speed != null) speeds.push(fan.speed);
  const others = [
    ["SSD", tempOf(dirs.get("nvme"))],
    ["Wi-Fi", tempOf(dirs.get("iwlwifi_1"))],
  ]
    .filter(([, value]) => value !== null)
    .map(([name, value]) => `${name} ${formatTemp(value as number)}`);
  return [
    ...speeds.map((rpm, i) => ({
      id: `fan:speed:${i + 1}`,
      title: speeds.length > 1 ? `Fan ${i + 1}: ${rpm} RPM` : `Fan: ${rpm} RPM`,
      subtitle: rpm === 0 ? "Stopped" : undefined,
      icon: "🌀",
      actions: [],
    })),
    {
      id: "fan:temp",
      title: `CPU ${formatTemp(cpuTemp(dirs))}`,
      subtitle: others.join("  ·  "),
      icon: "🌡️",
      actions: [],
    },
  ];
}

function levelEntries(current: string): Entry[] {
  const active = current === "disengaged" ? "full-speed" : current;
  return FAN_LEVELS.map((level) => ({
    id: `fan:level:${level}`,
    title: levelTitle(level),
    subtitle: levelHint(level),
    icon: level === "auto" ? "✨" : level === "full-speed" ? "💨" : "🌀",
    accessory: level === active ? "✓ Current" : undefined,
    actions: [{ id: "set", title: "Set Fan Speed", shortcut: "↵", run: () => setFanLevel(level) }],
  }));
}

export const fanView: ViewProvider = {
  info: {
    title: "Fan Control",
    placeholder: "Fan speed and temperatures…",
    preview: false,
    grid: false,
    refreshMs: 2000,
  },
  sections(query): Section[] {
    const fan = readFan();
    const q = query.trim().toLowerCase();
    const sections: Section[] = [{ title: "Now", entries: statusEntries(fan) }];
    if (!fan) {
      sections.push({
        title: "Fan Speed",
        entries: [
          {
            id: "fan:unsupported",
            title: "Fan control needs a ThinkPad",
            subtitle: "Beam sets the fan through the thinkpad_acpi driver, which this laptop doesn't use.",
            icon: "ℹ️",
            actions: [],
          },
        ],
      });
    } else if (!fan.controllable) {
      sections.push({
        title: "Setup",
        entries: [
          {
            id: "fan:enable",
            title: "Turn On Fan Control",
            subtitle: "One-time setup; asks for your password",
            icon: "🔓",
            actions: [{ id: "enable", title: "Turn On Fan Control", shortcut: "↵", run: enableFanControl }],
          },
        ],
      });
    } else {
      const levels = levelEntries(fan.level).filter(
        (e) => !q || `${e.title} ${e.subtitle}`.toLowerCase().includes(q),
      );
      sections.push({ title: `Fan Speed · now ${levelTitle(fan.level)}`, entries: levels });
    }
    return sections;
  },
};

export function fanCommands(): Entry[] {
  const command = (name: string, title: string, run: () => RunResult | Promise<RunResult>, keywords: string[]): Entry => ({
    id: `cmd:${name}`,
    ref: `cmd:${name}`,
    title,
    subtitle: "Fan",
    icon: "🌀",
    accessory: "Command",
    keywords: ["fan", ...keywords],
    actions: [{ id: "run", title: "Run Command", shortcut: "↵", run }],
  });
  return [
    command("fans", "Fan Control", () => ({ type: "view", view: "fans" }), [
      "cooling", "temperature", "thermal", "rpm", "noise", "quiet", "speed",
    ]),
    command("fan-auto", "Set Fan to Auto", () => setFanLevel("auto"), ["automatic", "default"]),
    command("fan-full", "Set Fan to Full Speed", () => setFanLevel("full-speed"), ["max", "maximum", "boost"]),
  ];
}
