// How lean Beam runs. In low-memory mode Beam closes its window once it has
// been hidden a while, which gives back the 40 MB or so its page takes, and
// opens it again the next time it's called: a few hundred milliseconds on
// slow hardware instead of instantly. No Electron here, so it can be tested.

export type LowMemorySetting = "auto" | "on" | "off";

/** With "auto", machines with this much RAM or less run in low-memory mode. */
export const LOW_MEMORY_RAM = 4 * 1024 ** 3;

/** In low-memory mode the window closes after being hidden this long. */
export const CLOSE_HIDDEN_AFTER_MS = 60_000;

export function lowMemoryMode(setting: unknown, totalRam: number): boolean {
  if (setting === "on" || setting === true) return true;
  if (setting === "off" || setting === false) return false;
  return totalRam <= LOW_MEMORY_RAM;
}

/** One of Beam's processes: Electron's type for it and the memory it uses, in KB. */
export interface ProcessUse {
  type: string;
  /** Utility processes say which service they run. */
  service?: string;
  kb: number;
}

const PROCESS_NAMES: Record<string, string> = {
  Browser: "Main process",
  Tab: "Window",
  GPU: "Graphics (GPU)",
  Zygote: "Process launcher",
  "Sandbox helper": "Sandbox",
};

function processName(use: ProcessUse): string {
  if (use.type === "Utility" && use.service?.includes("NetworkService")) return "Network service";
  return PROCESS_NAMES[use.type] ?? use.service ?? use.type;
}

const mb = (kb: number) => `${Math.round(kb / 1024)} MB`;

/** The text of Beam Memory Usage: a total, then each kind of process, largest first. */
export function footprintReport(processes: ProcessUse[], notes: string[]): string {
  const groups = new Map<string, { kb: number; count: number }>();
  for (const use of processes) {
    const name = processName(use);
    const group = groups.get(name) ?? { kb: 0, count: 0 };
    group.kb += use.kb;
    group.count++;
    groups.set(name, group);
  }
  const total = processes.reduce((sum, use) => sum + use.kb, 0);
  const rows = [...groups]
    .sort((a, b) => b[1].kb - a[1].kb)
    .map(([name, { kb, count }]) => `  ${(count > 1 ? `${name} (${count})` : name).padEnd(24)}${mb(kb).padStart(8)}`);
  const count = processes.length;
  return [`Beam is using ${mb(total)} of memory in ${count} ${count === 1 ? "process" : "processes"}.`, "", ...rows, "", ...notes].join("\n");
}
