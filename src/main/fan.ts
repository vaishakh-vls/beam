// Reads the ThinkPad fan state (thinkpad_acpi's /proc/acpi/ibm/fan) and names fan levels. Pure.

export interface FanState {
  /** RPM as the firmware reports it. */
  speed: number | null;
  /** "auto", "0"–"7", "full-speed" or "disengaged". */
  level: string;
  /** thinkpad_acpi lists its commands only when loaded with fan_control=1. */
  controllable: boolean;
}

export function parseFanFile(text: string): FanState {
  const value = (name: string) => text.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1].trim();
  const speed = Number(value("speed"));
  return {
    speed: Number.isFinite(speed) ? speed : null,
    level: value("level") ?? "auto",
    controllable: /^commands:/m.test(text),
  };
}

/**
 * The levels Beam offers. Level 0 (fan off) is left out on purpose: the
 * thinkpad_acpi docs warn it can overheat the laptop.
 */
export const FAN_LEVELS = ["auto", "1", "2", "3", "4", "5", "6", "7", "full-speed"] as const;
export type FanLevel = (typeof FAN_LEVELS)[number];

export function isFanLevel(value: string): value is FanLevel {
  return (FAN_LEVELS as readonly string[]).includes(value);
}

export function levelTitle(level: string): string {
  if (level === "auto") return "Auto";
  if (level === "full-speed" || level === "disengaged") return "Full Speed";
  return `Level ${level}`;
}

export function levelHint(level: string): string {
  switch (level) {
    case "auto":
      return "The laptop decides; recommended";
    case "1":
      return "Quietest";
    case "7":
      return "Fastest regulated speed";
    case "full-speed":
      return "Beyond level 7: loudest, for long heavy loads";
    case "0":
      return "Fan off";
    default:
      return Number(level) <= 3 ? "Quiet" : "Faster";
  }
}

/** Above this the CPU is near its throttling point, so a quiet manual level goes back to auto. */
export const GUARD_TEMP_C = 90;

/** True when a manual level below 7 is set and the CPU has reached the guard temperature. */
export function shouldRevertToAuto(level: string, cpuTempC: number | null): boolean {
  const manual = /^[0-6]$/.test(level);
  return manual && cpuTempC !== null && cpuTempC >= GUARD_TEMP_C;
}
