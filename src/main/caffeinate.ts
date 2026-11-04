// Durations for Caffeinate: parsing what the user types and formatting what is left.

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Longer timers are refused; "Caffeinate" without a timer covers the rest. */
export const MAX_DURATION_MS = 24 * HOUR;

const UNITS: Record<string, number> = {
  s: SECOND, sec: SECOND, secs: SECOND, second: SECOND, seconds: SECOND,
  m: MINUTE, min: MINUTE, mins: MINUTE, minute: MINUTE, minutes: MINUTE,
  h: HOUR, hr: HOUR, hrs: HOUR, hour: HOUR, hours: HOUR,
};

/**
 * Milliseconds for "45m", "1.5h", "90" (minutes), "2h30m", "2h 30", "1 hour",
 * or null when the text is not a duration.
 */
export function parseDuration(input: string): number | null {
  const text = input.trim().toLowerCase();
  if (!text) return null;
  // A bare number means minutes.
  if (/^\d+(\.\d+)?$/.test(text)) return positive(Number(text) * MINUTE);

  const part = /(\d+(?:\.\d+)?|\.\d+)\s*([a-z]+)?\s*/y;
  let total = 0;
  let previousUnit = 0;
  let index = 0;
  while (index < text.length) {
    part.lastIndex = index;
    const match = part.exec(text);
    if (!match) return null;
    index = part.lastIndex;
    const value = Number(match[1]);
    let unit = match[2] ? UNITS[match[2]] : undefined;
    if (match[2] && !unit) return null;
    // A trailing bare number takes the next smaller unit: "2h30" is 2h 30m.
    if (!unit) {
      if (index < text.length || previousUnit === 0 || previousUnit === SECOND) return null;
      unit = previousUnit === HOUR ? MINUTE : SECOND;
    }
    if (previousUnit && unit >= previousUnit) return null;
    previousUnit = unit;
    total += value * unit;
  }
  return positive(total);
}

function positive(ms: number): number | null {
  return Number.isFinite(ms) && ms >= SECOND ? Math.round(ms) : null;
}

/** "2h 30m", "45m", "1m 30s", "20s". */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / SECOND);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const totalMinutes = Math.round(totalSeconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
}

/** Time left, rounded up so it never reads "0m" while still running. */
export function formatRemaining(ms: number): string {
  if (ms < MINUTE) return `${Math.max(1, Math.ceil(ms / SECOND))}s left`;
  const totalMinutes = Math.ceil(ms / MINUTE);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (!hours) return `${minutes}m left`;
  return minutes ? `${hours}h ${minutes}m left` : `${hours}h left`;
}

/** Shown beside the commands: "On · 42m left" or "On until stopped". */
export function caffeinateStatus(until: number | null, now: number): string {
  return until === null ? "On until stopped" : `On · ${formatRemaining(until - now)}`;
}
