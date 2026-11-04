// Parses /proc/<pid>/stat and cmdline and formats process details. Pure, so it can be tested.

export interface ProcStat {
  /** The kernel's name for the process, cut at 15 characters. */
  comm: string;
  /** R running, S sleeping, D disk wait, Z zombie, T stopped, I idle. */
  state: string;
  ppid: number;
  /** CPU time used so far, user plus system, in clock ticks. */
  ticks: number;
  threads: number;
  /** Clock ticks after boot when the process started; with the pid it names one process. */
  start: number;
  /** Resident memory in pages. */
  rssPages: number;
}

/** Fields of /proc/<pid>/stat. The name can hold spaces and ")", so fields count from the last ")". */
export function parseStat(text: string): ProcStat | null {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  if (open < 0 || close < open) return null;
  const fields = text.slice(close + 2).trim().split(" ");
  if (fields.length < 22) return null;
  const num = (index: number) => Number(fields[index]);
  return {
    comm: text.slice(open + 1, close),
    state: fields[0],
    ppid: num(1),
    ticks: num(11) + num(12),
    threads: num(17),
    start: num(19),
    rssPages: num(21),
  };
}

/**
 * /proc/<pid>/cmdline as arguments. Chrome and Electron rewrite their title
 * into one space-separated string, so a single argument with spaces is split.
 */
export function splitCmdline(raw: string): string[] {
  const args = raw.split("\0").filter(Boolean);
  return args.length === 1 && args[0].includes(" ") ? args[0].split(" ").filter(Boolean) : args;
}

/** Thread names some runtimes give their main thread, which say nothing about the program. */
const GENERIC_COMMS = new Set(["MainThread", "Main Thread", "main"]);

/** The full program name where comm was cut short, e.g. "networkd-dispatcher" for "networkd-dispat". */
export function displayName(comm: string, args: string[]): string {
  // Node names its main thread "MainThread"; the executable says more.
  if (GENERIC_COMMS.has(comm) && args[0]) return args[0].split("/").pop() || comm;
  for (const arg of args.slice(0, 3)) {
    const base = arg.split("/").pop() ?? "";
    if (base.length > comm.length && base.startsWith(comm)) return base;
  }
  // Processes that set their own title, e.g. "next-server (v14.2.3)".
  const title = args.join(" ");
  if (comm.length === 15 && title.startsWith(comm) && title.length <= 40) return title;
  return comm;
}

const STATES: Record<string, string> = {
  R: "Running",
  S: "Sleeping",
  D: "Waiting for disk",
  Z: "Zombie",
  T: "Stopped",
  t: "Stopped by debugger",
  I: "Idle",
};

export function stateLabel(state: string): string {
  return STATES[state] ?? state;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1 << 30) return `${(bytes / (1 << 30)).toFixed(1)} GB`;
  if (bytes >= 1 << 20) return `${Math.round(bytes / (1 << 20))} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return `${Math.floor(seconds)}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Share of one core between two samples of a process's CPU ticks; 100% is one busy core, like top. */
export function cpuPercent(ticksBefore: number, ticksAfter: number, seconds: number, ticksPerSecond = 100): number {
  if (seconds <= 0) return 0;
  return Math.max(0, ((ticksAfter - ticksBefore) / ticksPerSecond / seconds) * 100);
}
