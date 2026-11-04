import fs from "node:fs";
import os from "node:os";
import { HIDE, type Entry, type EntryAction, type Section, type ViewProvider } from "../entry";
import { showForm } from "../forms";
import {
  cpuPercent,
  displayName,
  formatBytes,
  formatDuration,
  parseStat,
  splitCmdline,
  stateLabel,
} from "../procinfo";
import { copyText, notify, runCapture } from "../system";
import type { RunResult } from "../../shared/types";

/** USER_HZ, which Linux fixes at 100 for /proc. */
const TICKS_PER_SECOND = 100;
/** x86_64 and Ubuntu's arm64 kernels both use 4 KiB pages. */
const PAGE_SIZE = 4096;
const MAX_ROWS = 150;
/** CPU use is measured over at least this long, so fast typing doesn't make it jumpy. */
const MIN_SAMPLE_MS = 1000;

/**
 * Quitting these ends the desktop session or Beam itself, so Beam asks the
 * user to type the name first.
 */
const SESSION_CRITICAL: Record<string, string> = {
  systemd: "systemd runs your whole session. Ending it logs you out.",
  "gnome-shell": "On Wayland, GNOME Shell is the desktop itself. Ending it logs you out and closes every app.",
  "gnome-session-binary": "This is your GNOME session. Ending it logs you out.",
  "gnome-session-ctl": "This manages your GNOME session. Ending it logs you out.",
  Xwayland: "Every X11 app runs through Xwayland. Ending it closes those apps.",
  "dbus-daemon": "Apps talk to each other through D-Bus. Ending it breaks the session.",
  "dbus-broker": "Apps talk to each other through D-Bus. Ending it breaks the session.",
};

interface Proc {
  pid: number;
  /** Ticks after boot when it started: with the pid, names exactly one process. */
  start: number;
  name: string;
  args: string[];
  uid: number;
  state: string;
  ppid: number;
  threads: number;
  ticks: number;
  rss: number;
  cpu: number;
}

type SortKey = "cpu" | "memory";
let sortBy: SortKey = "cpu";

let baseline: { at: number; ticks: Map<string, number> } = { at: 0, ticks: new Map() };
let lastCpu = new Map<string, number>();

let users: Map<number, string> | null = null;

function userName(uid: number): string {
  if (!users) {
    users = new Map();
    try {
      for (const line of fs.readFileSync("/etc/passwd", "utf8").split("\n")) {
        const [name, , id] = line.split(":");
        if (name && id) users.set(Number(id), name);
      }
    } catch {
      // Fall back to numeric ids.
    }
  }
  return users.get(uid) ?? String(uid);
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Seconds since boot, from /proc/uptime. */
function uptime(): number {
  return Number(readText("/proc/uptime")?.split(" ")[0] ?? 0);
}

const key = (pid: number, start: number) => `${pid}:${start}`;

function readProcess(pid: number): Omit<Proc, "cpu"> | null {
  const stat = parseStat(readText(`/proc/${pid}/stat`) ?? "");
  // Kernel threads and zombies have no command line, and there is nothing to quit.
  const args = splitCmdline(readText(`/proc/${pid}/cmdline`) ?? "");
  if (!stat || !args.length) return null;
  let uid = -1;
  try {
    uid = fs.statSync(`/proc/${pid}`).uid;
  } catch {
    return null;
  }
  return {
    pid,
    start: stat.start,
    name: displayName(stat.comm, args),
    args,
    uid,
    state: stat.state,
    ppid: stat.ppid,
    threads: stat.threads,
    ticks: stat.ticks,
    rss: stat.rssPages * PAGE_SIZE,
  };
}

/** Reads every process. CPU use is the change since the previous sample. */
function listProcesses(): Proc[] {
  const now = Date.now();
  const up = uptime();
  const raw: Array<Omit<Proc, "cpu">> = [];
  for (const dir of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(dir)) continue;
    const proc = readProcess(Number(dir));
    if (proc) raw.push(proc);
  }

  const elapsed = (now - baseline.at) / 1000;
  if (now - baseline.at >= MIN_SAMPLE_MS) {
    const fresh = new Map<string, number>();
    for (const proc of raw) {
      const id = key(proc.pid, proc.start);
      const before = baseline.ticks.get(id);
      if (before !== undefined) fresh.set(id, cpuPercent(before, proc.ticks, elapsed, TICKS_PER_SECOND));
    }
    lastCpu = fresh;
    baseline = { at: now, ticks: new Map(raw.map((p) => [key(p.pid, p.start), p.ticks])) };
  }

  return raw.map((proc) => {
    const measured = lastCpu.get(key(proc.pid, proc.start));
    // Until there are two samples, use the average over the process's lifetime, as ps does.
    const age = up - proc.start / TICKS_PER_SECOND;
    const cpu = measured ?? (age > 0 ? (proc.ticks / TICKS_PER_SECOND / age) * 100 : 0);
    return { ...proc, cpu };
  });
}

/** True while the process that was listed is still alive (not a reused pid, not a zombie). */
function isRunning(pid: number, start: number): boolean {
  const stat = parseStat(readText(`/proc/${pid}/stat`) ?? "");
  return Boolean(stat && stat.start === start && stat.state !== "Z");
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForExit(pid: number, start: number, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    if (!isRunning(pid, start)) return true;
    await sleep(100);
  }
  return !isRunning(pid, start);
}

/**
 * Sends `signal` to one process. Another user's process (root's, say) goes
 * through pkexec, which asks for the password.
 */
async function sendSignal(proc: Proc, signal: "SIGTERM" | "SIGKILL"): Promise<string | null> {
  if (!isRunning(proc.pid, proc.start)) return null;
  try {
    process.kill(proc.pid, signal);
    return null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return null;
    if (code !== "EPERM") return (error as Error).message;
  }
  const { code, stderr } = await runCapture(
    "pkexec",
    ["/usr/bin/kill", "-s", signal.slice(3), String(proc.pid)],
    { timeoutMs: 120_000 },
  );
  if (code === 0) return null;
  if (code === 126 || code === 127) return "Not allowed: the password prompt was dismissed or refused.";
  return stderr.trim() || `kill failed with code ${code}`;
}

async function endProcess(proc: Proc, signal: "SIGTERM" | "SIGKILL"): Promise<RunResult> {
  const label = `${proc.name} (${proc.pid})`;
  const error = await sendSignal(proc, signal);
  if (error) {
    notify(`Could not end ${label}`, error);
    return { type: "error", message: error };
  }
  if (await waitForExit(proc.pid, proc.start, signal === "SIGKILL" ? 1000 : 1500)) {
    return { type: "stay", toast: `Ended ${label}` };
  }
  return { type: "stay", toast: `${label} is still running. Force Kill with Ctrl+↵` };
}

function criticalReason(proc: Proc): string | null {
  if (proc.pid === 1) return "This is the system's first process. Ending it shuts the computer down.";
  if (proc.pid === process.pid || proc.ppid === process.pid) {
    return "This is Beam itself. Use Quit Beam instead.";
  }
  return SESSION_CRITICAL[proc.name] ?? null;
}

/** For processes whose end takes the session with them: type the name to confirm. */
function confirmEnd(proc: Proc, signal: "SIGTERM" | "SIGKILL", reason: string): RunResult {
  return showForm(
    {
      title: `End ${proc.name}?`,
      submitLabel: signal === "SIGKILL" ? "Force Kill" : "Quit Process",
      fields: [
        {
          name: "confirm",
          label: `Type ${proc.name} to confirm`,
          type: "text",
          placeholder: proc.name,
          hint: reason,
        },
      ],
    },
    async (values) => {
      if (values.confirm.trim() !== proc.name) {
        return { type: "error", message: `Type ${proc.name} exactly, or press Esc to go back.` };
      }
      const result = await endProcess(proc, signal);
      return result.type === "error" ? result : { type: "view", view: "processes" };
    },
  );
}

function endAction(proc: Proc, signal: "SIGTERM" | "SIGKILL"): () => Promise<RunResult> | RunResult {
  return () => {
    const reason = criticalReason(proc);
    return reason ? confirmEnd(proc, signal, reason) : endProcess(proc, signal);
  };
}

/** Quits every process of this name that the user owns, e.g. all of Chrome's helpers. */
async function endAllNamed(name: string): Promise<RunResult> {
  const uid = process.getuid?.() ?? -1;
  const targets = listProcesses().filter(
    (p) => p.name === name && p.uid === uid && p.pid !== process.pid && !criticalReason(p),
  );
  if (!targets.length) return { type: "error", message: `No ${name} processes of yours to quit.` };
  for (const proc of targets) await sendSignal(proc, "SIGTERM");
  await sleep(800);
  const left = targets.filter((p) => isRunning(p.pid, p.start)).length;
  const ended = targets.length - left;
  return {
    type: "stay",
    toast: left ? `Ended ${ended} of ${targets.length}; ${left} still running` : `Ended ${ended} ${name} processes`,
  };
}

function preview(proc: Proc, byPid: Map<number, Proc>): string {
  const parent = byPid.get(proc.ppid);
  const total = os.totalmem();
  const running = uptime() - proc.start / TICKS_PER_SECOND;
  const startedAt = new Date(Date.now() - running * 1000);
  const started = running < 86_400
    ? startedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : startedAt.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return [
    proc.name,
    "",
    `PID       ${proc.pid}`,
    `Parent    ${proc.ppid}${parent ? ` (${parent.name})` : ""}`,
    `User      ${userName(proc.uid)}`,
    `CPU       ${proc.cpu.toFixed(1)}%  (100% is one core)`,
    `Memory    ${formatBytes(proc.rss)}  (${((proc.rss / total) * 100).toFixed(1)}% of ${formatBytes(total)})`,
    `Threads   ${proc.threads}`,
    `State     ${stateLabel(proc.state)}`,
    `Running   ${formatDuration(running)}  (since ${started})`,
    "",
    proc.args.join(" "),
  ].join("\n");
}

function processEntry(proc: Proc, byPid: Map<number, Proc>): Entry {
  const mine = proc.uid === process.getuid?.();
  const actions: EntryAction[] = [
    { id: "quit", title: "Quit Process", shortcut: "↵", danger: true, run: endAction(proc, "SIGTERM") },
    { id: "kill", title: "Force Kill", shortcut: "Ctrl+↵", danger: true, run: endAction(proc, "SIGKILL") },
    {
      id: "quit-all",
      title: `Quit All ${proc.name} Processes`,
      shortcut: "Ctrl+Shift+↵",
      danger: true,
      run: () => endAllNamed(proc.name),
    },
    {
      id: "copy-pid",
      title: "Copy PID",
      shortcut: "Ctrl+Shift+C",
      run: () => {
        copyText(String(proc.pid));
        return { type: "stay", toast: `Copied ${proc.pid}` };
      },
    },
    {
      id: "copy-command",
      title: "Copy Command Line",
      run: () => {
        copyText(proc.args.join(" "));
        return HIDE;
      },
    },
    {
      id: "sort",
      title: sortBy === "cpu" ? "Sort by Memory" : "Sort by CPU",
      shortcut: "Ctrl+M",
      run: () => {
        sortBy = sortBy === "cpu" ? "memory" : "cpu";
        return { type: "stay", toast: `Sorted by ${sortBy === "cpu" ? "CPU" : "memory"}` };
      },
    },
  ];
  return {
    id: `proc:${proc.pid}:${proc.start}`,
    title: proc.name,
    subtitle: proc.args.slice(1).join(" "),
    icon: mine ? "⚙️" : "🔒",
    accessory: `${proc.cpu.toFixed(1)}%  ·  ${formatBytes(proc.rss)}  ·  ${proc.pid}`,
    preview: preview(proc, byPid),
    actions,
  };
}

function matches(proc: Proc, query: string): boolean {
  if (/^\d+$/.test(query)) return String(proc.pid).startsWith(query);
  const q = query.toLowerCase();
  return proc.name.toLowerCase().includes(q) || proc.args.join(" ").toLowerCase().includes(q);
}

export const processView: ViewProvider = {
  info: {
    title: "Processes",
    placeholder: "Filter by name, command or PID…",
    preview: true,
    grid: false,
    refreshMs: 1500,
  },
  sections(query): Section[] {
    const all = listProcesses();
    const byPid = new Map(all.map((p) => [p.pid, p]));
    const q = query.trim();
    const shown = (q ? all.filter((p) => matches(p, q)) : all).sort((a, b) =>
      sortBy === "cpu" ? b.cpu - a.cpu || b.rss - a.rss : b.rss - a.rss || b.cpu - a.cpu,
    );
    return [
      {
        title: `${shown.length} processes · by ${sortBy === "cpu" ? "CPU" : "memory"}`,
        entries: shown.slice(0, MAX_ROWS).map((proc) => processEntry(proc, byPid)),
      },
    ];
  },
};

export function processCommands(): Entry[] {
  return [
    {
      id: "cmd:processes",
      ref: "cmd:processes",
      title: "Search Processes",
      subtitle: "System",
      icon: "📊",
      accessory: "Command",
      keywords: ["kill", "process", "pid", "task manager", "top", "htop", "force quit", "cpu", "memory"],
      actions: [{ id: "run", title: "Open Command", shortcut: "↵", run: () => ({ type: "view", view: "processes" }) }],
    },
  ];
}
