import { spawn, type ChildProcess } from "node:child_process";
import {
  MAX_DURATION_MS,
  caffeinateStatus,
  durationFromFields,
  formatDuration,
  formatRemaining,
  parseDuration,
} from "../caffeinate";
import { HIDE, type Entry, type Section, type ViewProvider } from "../entry";
import { childEnv, notify } from "../system";
import type { ArgDef, RunResult } from "../../shared/types";

/** Press Tab after typing the command: hours, Tab, minutes, Enter. */
const TIME_ARGS: ArgDef[] = [
  { name: "hours", placeholder: "Hours", numeric: true },
  { name: "minutes", placeholder: "Minutes", numeric: true },
  { name: "seconds", placeholder: "Seconds", numeric: true },
];

const PRESETS: Array<{ id: string; label: string; minutes: number }> = [
  { id: "15m", label: "15 minutes", minutes: 15 },
  { id: "30m", label: "30 minutes", minutes: 30 },
  { id: "1h", label: "1 hour", minutes: 60 },
  { id: "2h", label: "2 hours", minutes: 120 },
  { id: "4h", label: "4 hours", minutes: 240 },
  { id: "8h", label: "8 hours", minutes: 480 },
];

/** How often a timer re-checks the wall clock, which keeps counting through suspend. */
const CHECK_MS = 30_000;

interface Session {
  child: ChildProcess;
  /** When it ends (ms), or null to run until stopped. */
  until: number | null;
  timer: NodeJS.Timeout | null;
}

let session: Session | null = null;

/**
 * Starts the inhibitor: `gnome-session-inhibit … cat` with stdin as a pipe
 * Beam holds open. If Beam exits or crashes the pipe closes, `cat` ends and
 * the inhibitor goes with it, so none can be left behind.
 */
function spawnInhibitor(): ChildProcess {
  const child = spawn(
    "gnome-session-inhibit",
    ["--app-id", "beam", "--inhibit", "idle:suspend", "--reason", "Beam: Caffeinate", "cat"],
    { stdio: ["pipe", "ignore", "pipe"], env: childEnv() },
  );
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderr.length < 500) stderr += chunk.toString();
  });
  // Writing to or closing a pipe whose reader has gone must not crash Beam.
  child.stdin?.on("error", () => {});
  child.on("error", (error) => {
    if (session?.child !== child) return;
    clear();
    notify("Caffeinate failed", error.message);
  });
  child.on("exit", (code) => {
    if (session?.child !== child) return;
    clear();
    notify("Caffeinate stopped", stderr.trim().slice(0, 200) || `The inhibitor exited (${code ?? "signal"}).`);
  });
  return child;
}

/** Ends the inhibitor by closing its input; killing is only a fallback. */
function endChild(child: ChildProcess): void {
  child.stdin?.end();
  if (child.exitCode !== null || child.signalCode !== null) return;
  const kill = setTimeout(() => child.kill(), 2000);
  child.once("exit", () => clearTimeout(kill));
}

function clear(): Session | null {
  const current = session;
  session = null;
  if (current?.timer) clearTimeout(current.timer);
  return current;
}

function schedule(current: Session): void {
  if (current.timer) clearTimeout(current.timer);
  current.timer = null;
  if (current.until === null) return;
  const left = current.until - Date.now();
  if (left <= 0) {
    stopCaffeinate();
    notify("Caffeinate ended", "Time's up. Your laptop can sleep again.");
    return;
  }
  current.timer = setTimeout(() => {
    if (session === current) schedule(current);
  }, Math.min(left, CHECK_MS));
}

/** Keeps the laptop awake for `durationMs`, or until stopped when null. */
function start(durationMs: number | null): void {
  session ??= { child: spawnInhibitor(), until: null, timer: null };
  session.until = durationMs === null ? null : Date.now() + durationMs;
  schedule(session);
}

/** Stops Caffeinate quietly. Beam calls this on quit. */
export function stopCaffeinate(): boolean {
  const current = clear();
  if (!current) return false;
  endChild(current.child);
  return true;
}

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function status(): string | null {
  return session ? caffeinateStatus(session.until, Date.now()) : null;
}

function startFor(durationMs: number | null, label: string): RunResult {
  start(durationMs);
  notify(
    "Caffeinate on",
    durationMs === null
      ? "Your laptop stays awake until you stop it."
      : `Your laptop stays awake for ${label}, until ${clockTime(Date.now() + durationMs)}.`,
  );
  return HIDE;
}

/** Starts for the time typed in the fields, or returns null when they were left empty. */
function startFromFields(args?: Record<string, string>): RunResult | null {
  const ms = durationFromFields(args ?? {});
  if (ms === null) return null;
  if (ms === 0) return { type: "error", message: "Enter a time above zero, or leave the fields empty" };
  if (ms > MAX_DURATION_MS) return { type: "error", message: "Up to 24 hours; leave the fields empty to stay on until stopped" };
  return startFor(ms, formatDuration(ms));
}

function decaffeinate(): RunResult {
  if (stopCaffeinate()) notify("Caffeinate off", "Your laptop can sleep again.");
  else notify("Caffeinate is already off");
  return HIDE;
}

export function caffeinateCommands(_hide: () => void): Entry[] {
  const current = status();
  const keywords = ["awake", "keep awake", "prevent sleep", "no sleep", "inhibit", "amphetamine", "coffee"];
  return [
    {
      id: "cmd:caffeinate",
      ref: "cmd:caffeinate",
      title: "Caffeinate",
      subtitle: session ? "Tab to change the time, Enter to stop" : "Tab to set a time, Enter to stay on until stopped",
      icon: "☕",
      accessory: current ?? "Command",
      keywords,
      args: TIME_ARGS,
      actions: [
        {
          id: "run",
          title: session ? "Decaffeinate" : "Caffeinate",
          shortcut: "↵",
          run: (args) => startFromFields(args) ?? (session ? decaffeinate() : startFor(null, "")),
        },
      ],
    },
    {
      id: "cmd:caffeinate-for",
      ref: "cmd:caffeinate-for",
      title: "Caffeinate For…",
      subtitle: "Tab to set a time, Enter to pick from a list",
      icon: "⏲️",
      accessory: current ?? "Command",
      keywords: [...keywords, "timer", "duration", "hours", "minutes", "limit"],
      args: TIME_ARGS,
      actions: [
        {
          id: "run",
          title: "Run Command",
          shortcut: "↵",
          run: (args) => startFromFields(args) ?? { type: "view", view: "caffeinate" },
        },
      ],
    },
    {
      id: "cmd:decaffeinate",
      ref: "cmd:decaffeinate",
      title: "Decaffeinate",
      subtitle: "System",
      icon: "😴",
      accessory: current ?? "Command",
      keywords: ["caffeinate off", "stop caffeinate", "allow sleep"],
      actions: [{ id: "run", title: "Run Command", shortcut: "↵", run: decaffeinate }],
    },
  ];
}

function durationEntry(id: string, title: string, durationMs: number | null, subtitle?: string): Entry {
  return {
    id: `caffeinate:${id}`,
    title,
    subtitle,
    icon: durationMs === null ? "♾️" : "⏲️",
    accessory: durationMs === null ? "Until stopped" : `Until ${clockTime(Date.now() + durationMs)}`,
    actions: [
      {
        id: "start",
        title: session ? "Change Caffeinate Timer" : "Start Caffeinate",
        shortcut: "↵",
        run: () => startFor(durationMs, durationMs === null ? "" : formatDuration(durationMs)),
      },
    ],
  };
}

export const caffeinateView: ViewProvider = {
  info: {
    title: "Caffeinate",
    placeholder: "Pick a duration, or type one: 45m, 1.5h, 2h30m…",
    preview: false,
    grid: false,
    // Keeps "42m left" and the end times current.
    refreshMs: 1000,
  },
  sections(query) {
    const sections: Section[] = [];
    if (session) {
      sections.push({
        title: "Status",
        entries: [
          {
            id: "caffeinate:status",
            title: "Caffeinated",
            subtitle: session.until === null ? "Until you stop it" : formatRemaining(session.until - Date.now()),
            icon: "☕",
            accessory: session.until === null ? "" : `Ends ${clockTime(session.until)}`,
            actions: [{ id: "stop", title: "Decaffeinate", shortcut: "↵", run: decaffeinate }],
          },
        ],
      });
    }

    const q = query.trim().toLowerCase();
    const typed = q ? parseDuration(q) : null;
    if (typed !== null) {
      const entry =
        typed > MAX_DURATION_MS
          ? {
              id: "caffeinate:too-long",
              title: "Up to 24 hours",
              subtitle: "Use Caffeinate without a timer for longer",
              icon: "⚠️",
              actions: [],
            }
          : durationEntry("custom", formatDuration(typed), typed, "Custom duration");
      sections.push({ title: "Custom", entries: [entry] });
      return sections;
    }

    const presets = [
      ...PRESETS.map((p) => durationEntry(p.id, p.label, p.minutes * 60_000)),
      durationEntry("indefinite", "Until stopped", null),
    ].filter((entry) => !q || entry.title.toLowerCase().includes(q));
    sections.push({ title: "Durations", entries: presets });
    return sections;
  },
};
