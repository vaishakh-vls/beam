// Clean Keyboard: lock durations and reading the GNOME extension's replies.

/** The extension refuses longer locks, so Beam does too. */
export const MAX_LOCK_SECONDS = 300;

export const LOCK_CHOICES: Array<{ seconds: number; label: string }> = [
  { seconds: 15, label: "15 seconds" },
  { seconds: 30, label: "30 seconds" },
  { seconds: 60, label: "1 minute" },
  { seconds: 120, label: "2 minutes" },
];

/** Seconds for a typed "45", "45s", "1m" or "1.5 min", or null. */
export function parseLockSeconds(input: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?)?$/.exec(input.trim().toLowerCase());
  if (!match) return null;
  const seconds = Math.round(Number(match[1]) * (match[2]?.startsWith("m") ? 60 : 1));
  return seconds >= 1 ? seconds : null;
}

export function lockLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  const head = `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return rest ? `${head} ${rest} s` : head;
}

/** gdbus prints the reply as a GVariant tuple: "(true, 'Keyboard locked for 30 seconds')". */
export function parseLockReply(stdout: string): { ok: boolean; message: string } | null {
  const match = /^\((true|false),\s*(['"])(.*)\2,?\)$/s.exec(stdout.trim());
  if (!match) return null;
  return { ok: match[1] === "true", message: match[3] };
}

/**
 * Why a gdbus call failed: the extension is missing or is an older version
 * without LockKeyboard (GNOME loads new extension code only at login), or
 * something else.
 */
export function lockFailure(stderr: string): "needs-login" | "other" {
  return /UnknownMethod|No such method|ServiceUnknown|was not provided|not provided by any/i.test(stderr)
    ? "needs-login"
    : "other";
}
