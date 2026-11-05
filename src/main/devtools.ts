// Works out what pasted text is (a JWT, JSON, a timestamp, a URL, Base64, a
// UUID, a number) and converts it for the Developer Tools view. Nothing here
// touches Electron, so the tests run it directly.

import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";

/** One converted value: a row in the Developer Tools view. */
export interface DevResult {
  /** Unique within the view, e.g. "jwt:payload". */
  id: string;
  /** What the value is, e.g. "SHA-256" or "Payload". Shown beside the title. */
  label: string;
  /** What Copy puts on the clipboard. */
  value: string;
  /** The row's text when the value is not one readable line, e.g. "Expires in 2h 13m · Wed 4 Nov, 18:30". */
  title?: string;
  /** The preview pane, when it should show more than the value. */
  preview?: string;
  /** Name of the copy action; defaults to "Copy <label>". */
  copyTitle?: string;
  /** Keep out of clipboard history and notifications: tokens, passwords, secrets. */
  secret?: boolean;
  /** The input looks like this kind but is broken, e.g. invalid JSON. */
  error?: boolean;
}

/** An extra copy action on every row of a group, e.g. the token itself. */
export interface DevCopy {
  id: string;
  title: string;
  shortcut: string;
  text: string;
}

export type DevKind =
  | "jwt"
  | "json"
  | "time"
  | "uuid"
  | "url"
  | "number"
  | "base64"
  | "encode"
  | "hash"
  | "case"
  | "stats"
  | "generate";

export interface DevGroup {
  kind: DevKind;
  /** Section title, e.g. "JWT (signature not verified)" or "JSON · 12 keys". */
  title: string;
  icon: string;
  results: DevResult[];
  extras?: DevCopy[];
  /** Every row is sensitive, as with a token's claims. */
  secret?: boolean;
}

// ---------------------------------------------------------------------------
// Base64

const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function utf8(bytes: Uint8Array): string | null {
  try {
    return utf8Decoder.decode(bytes);
  } catch {
    return null;
  }
}

/** Readable text: no control characters apart from tabs and line breaks. */
function isPrintable(text: string): boolean {
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f�]/.test(text);
}

/** Bytes of standard or URL-safe Base64, padded or not; null when it is not Base64. */
export function base64Bytes(text: string): Buffer | null {
  const clean = text.replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/_-]*$/.test(clean) || clean.length % 4 === 1) return null;
  // Node reads both alphabets in "base64" mode.
  return Buffer.from(clean, "base64");
}

/**
 * Decodes Base64 or Base64URL that holds readable UTF-8 text. Strict on
 * purpose: most words and hex strings are valid Base64 too, but they decode
 * to bytes that are not text, or do not encode back to the same string.
 */
export function decodeBase64Text(text: string): { text: string; urlSafe: boolean } | null {
  let t = text.trim();
  // Wrapped output from `base64` or MIME has a line break every 76 characters.
  if (/\n/.test(t) && /^[A-Za-z0-9+/=\s]+$/.test(t)) t = t.replace(/\s+/g, "");
  if (t.length < 8 || /^\d+$/.test(t)) return null;
  const standard = /^[A-Za-z0-9+/]+={0,2}$/.test(t);
  const urlSafe = !standard && /^[A-Za-z0-9_-]+={0,2}$/.test(t);
  if (!standard && !urlSafe) return null;
  if (t.includes("=") && t.length % 4 !== 0) return null;
  const bytes = base64Bytes(t);
  if (!bytes || !bytes.length) return null;
  const reencoded = bytes.toString(urlSafe ? "base64url" : "base64").replace(/=+$/, "");
  if (reencoded !== t.replace(/=+$/, "")) return null;
  const decoded = utf8(bytes);
  if (decoded === null || !decoded.trim() || !isPrintable(decoded)) return null;
  return { text: decoded, urlSafe };
}

// ---------------------------------------------------------------------------
// JSON

interface RawJsonApi {
  rawJSON?: (text: string) => unknown;
  isRawJSON?: (value: unknown) => boolean;
}
const JSON_EXT = JSON as unknown as RawJsonApi;

/**
 * JSON.parse that keeps numbers exactly as written. Plain parsing rounds
 * big IDs (12345678901234567890 becomes 12345678901234567000) and respells
 * 1.50 as 1.5, which a formatter must never do.
 */
function parseExact(text: string): unknown {
  const raw = JSON_EXT.rawJSON;
  if (!raw) return JSON.parse(text);
  return JSON.parse(text, (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === "number" && context?.source !== undefined && String(value) !== context.source
      ? raw(context.source)
      : value,
  );
}

function isRaw(value: unknown): boolean {
  return Boolean(JSON_EXT.isRawJSON?.(value));
}

export interface JsonProblem {
  message: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  offset: number;
}

export type JsonCheck = { ok: true; value: unknown } | ({ ok: false } & JsonProblem);

interface JsonStop {
  jsonStop: true;
  message: string;
  offset: number;
}

/**
 * Finds the first syntax error in text that JSON.parse rejected. V8 only
 * gives a position for some errors, so Beam scans the text itself.
 */
function scanJson(text: string): { message: string; offset: number } | null {
  let i = 0;
  const stop = (message: string, at = i): never => {
    const found: JsonStop = { jsonStop: true, message, offset: at };
    throw found;
  };
  const space = () => {
    while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };
  const needMore = () => {
    if (i >= text.length) stop("Unexpected end of input");
  };
  const string = () => {
    const start = i;
    i++;
    for (;;) {
      if (i >= text.length) stop("Unterminated string", start);
      const code = text.charCodeAt(i);
      if (code === 34) {
        i++;
        return;
      }
      if (code < 0x20) stop(code === 10 ? "Line break inside a string (write it as \\n)" : "Control character inside a string");
      if (code === 92) {
        const next = text[i + 1];
        if (next === "u") {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) stop("Invalid \\u escape");
          i += 6;
          continue;
        }
        if (next === undefined || !'"\\/bfnrt'.includes(next)) stop(`Invalid escape \\${next ?? ""}`);
        i += 2;
        continue;
      }
      i++;
    }
  };
  const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  const container = (close: "}" | "]") => {
    const object = close === "}";
    i++;
    space();
    if (text[i] === close) {
      i++;
      return;
    }
    for (;;) {
      space();
      needMore();
      if (object) {
        if (text[i] === "}") stop("Trailing comma before }");
        if (text[i] !== '"') stop(text[i] === "'" ? "Property names need double quotes" : "Expected a property name in double quotes");
        string();
        space();
        needMore();
        if (text[i] !== ":") stop("Expected ':' after the property name");
        i++;
      } else if (text[i] === "]") {
        stop("Trailing comma before ]");
      }
      value();
      space();
      needMore();
      if (text[i] === ",") {
        i++;
        continue;
      }
      if (text[i] === close) {
        i++;
        return;
      }
      stop(`Expected ',' or '${close}' after the ${object ? "property value" : "array item"}`);
    }
  };
  const value = (): void => {
    space();
    needMore();
    const ch = text[i];
    if (ch === "{") return container("}");
    if (ch === "[") return container("]");
    if (ch === '"') return string();
    if (ch === "-" || (ch >= "0" && ch <= "9")) {
      NUMBER.lastIndex = i;
      if (!NUMBER.exec(text)) stop("Invalid number");
      i = NUMBER.lastIndex;
      return;
    }
    for (const word of ["true", "false", "null"]) {
      if (text.startsWith(word, i)) {
        i += word.length;
        return;
      }
    }
    if (ch === "," || ch === "]" || ch === "}") stop(`Expected a value before '${ch}'`);
    stop(ch === "'" ? "Strings need double quotes" : `Unexpected character ${JSON.stringify(ch)}`);
  };
  try {
    value();
    space();
    if (i < text.length) stop("Unexpected text after the JSON value");
    return null;
  } catch (error) {
    if (error && typeof error === "object" && "jsonStop" in error) {
      const { message, offset } = error as JsonStop;
      return { message, offset };
    }
    // Nesting deep enough to overflow the stack.
    return null;
  }
}

function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lastBreak = before.lastIndexOf("\n");
  return { line: before.split("\n").length, column: offset - lastBreak };
}

export function checkJson(text: string): JsonCheck {
  try {
    return { ok: true, value: parseExact(text) };
  } catch (error) {
    const found = scanJson(text);
    const offset = found?.offset ?? text.length;
    const message = found?.message ?? String((error as Error)?.message ?? error).replace(/ in JSON at position.*$/, "");
    return { ok: false, message, offset, ...lineColumn(text, offset) };
  }
}

/** The broken line with a caret under the error, for the preview pane. */
function errorContext(text: string, problem: JsonProblem): string {
  const line = (text.split("\n")[problem.line - 1] ?? "").replace(/\t/g, " ").replace(/\r$/, "");
  // Minified JSON is one long line, so show a window around the error.
  const start = Math.max(0, problem.column - 1 - 40);
  const prefix = start > 0 ? "…" : "";
  const snippet = prefix + line.slice(start, start + 80) + (line.length > start + 80 ? "…" : "");
  return `${snippet}\n${" ".repeat(prefix.length + problem.column - 1 - start)}^`;
}

/** Starts like JSON, so a parse error is worth reporting rather than ignoring. */
function looksLikeJson(text: string): boolean {
  if (!/^[[{]/.test(text)) return false;
  return /[\]}]$/.test(text) || text.includes('":') || text.startsWith("{");
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && !isRaw(value)) {
    // A null prototype keeps a "__proto__" key an ordinary key.
    const sorted: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value).sort()) sorted[key] = sortKeys((value as Record<string, unknown>)[key]);
    return sorted;
  }
  return value;
}

function plural(count: number, word: string): string {
  return `${count.toLocaleString("en-US")} ${word}${count === 1 ? "" : "s"}`;
}

function jsonShape(value: unknown): string {
  if (Array.isArray(value)) return plural(value.length, "item");
  if (value && typeof value === "object") return plural(Object.keys(value).length, "key");
  return "";
}

function pretty(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/** Pretty-printed JSON, also unwrapping JSON that was escaped into a string. */
export function formatJson(text: string): { ok: true; text: string; shape: string } | ({ ok: false } & JsonProblem) {
  const check = checkJson(text.trim());
  if (!check.ok) return check;
  let value = check.value;
  if (typeof value === "string") {
    const inner = checkJson(value.trim());
    if (inner.ok && inner.value && typeof inner.value === "object") value = inner.value;
  }
  return { ok: true, text: pretty(value), shape: jsonShape(value) };
}

function jsonError(text: string, problem: JsonProblem): DevResult {
  const where = `line ${problem.line}, column ${problem.column}`;
  return {
    id: "json:error",
    label: "Invalid JSON",
    title: `${problem.message} · ${where}`,
    value: `${problem.message} at ${where}`,
    preview: `Invalid JSON: ${problem.message}\nLine ${problem.line}, column ${problem.column}\n\n${errorContext(text, problem)}`,
    copyTitle: "Copy Error",
    error: true,
  };
}

function jsonGroup(t: string): DevGroup | null {
  // A JSON string literal with escapes, e.g. a payload logged as "{\"id\":1}".
  if (t.length > 2 && t.startsWith('"') && t.endsWith('"') && t.includes("\\")) {
    const check = checkJson(t);
    if (!check.ok || typeof check.value !== "string") return null;
    const results: DevResult[] = [{ id: "json:unescaped", label: "Unescaped String", value: check.value }];
    const inner = checkJson(check.value.trim());
    if (inner.ok && inner.value && typeof inner.value === "object") {
      results.unshift({ id: "json:inner", label: "Formatted JSON", value: pretty(inner.value) });
    }
    return { kind: "json", title: "JSON String", icon: "🧩", results };
  }
  if (!looksLikeJson(t)) return null;
  const check = checkJson(t);
  if (!check.ok) return { kind: "json", title: "JSON", icon: "⚠️", results: [jsonError(t, check)] };
  const formatted = pretty(check.value);
  const minified = JSON.stringify(check.value);
  const sorted = pretty(sortKeys(check.value));
  const results: DevResult[] = [
    { id: "json:formatted", label: "Formatted JSON", value: formatted },
    { id: "json:minified", label: "Minified", value: minified },
  ];
  if (sorted !== formatted) results.push({ id: "json:sorted", label: "Sorted Keys", value: sorted });
  results.push({ id: "json:escaped", label: "Escaped String", value: JSON.stringify(minified) });
  return { kind: "json", title: `JSON · ${jsonShape(check.value)}`, icon: "🧩", results };
}

// ---------------------------------------------------------------------------
// Dates and durations

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** The local UTC offset at that moment, e.g. "+05:30". */
function offsetText(ms: number): string {
  const minutes = -new Date(ms).getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** The local time zone's short name, e.g. "IST", "GMT+1" or "UTC". */
function zoneName(ms: number): string {
  try {
    const part = new Intl.DateTimeFormat("en-IN", { timeZoneName: "short" })
      .formatToParts(new Date(ms))
      .find((p) => p.type === "timeZoneName");
    if (part?.value) return part.value;
  } catch {
    // Fall back to the offset below.
  }
  return `UTC${offsetText(ms)}`;
}

/** "Wed 4 Nov 2026, 18:30:05 IST": local time with seconds and the zone. */
export function formatLocal(ms: number): string {
  const d = new Date(ms);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${time} ${zoneName(ms)}`;
}

/** "Wed 4 Nov, 18:30", with the year only when it is not the current one. */
export function formatShort(ms: number, now: number): string {
  const d = new Date(ms);
  const year = d.getFullYear() === new Date(now).getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}${year}, ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** ISO 8601 in local time with its offset, e.g. "2026-11-04T18:30:00+05:30". */
export function isoLocal(ms: number): string {
  const d = new Date(ms);
  const fraction = d.getMilliseconds() ? `.${pad(d.getMilliseconds(), 3)}` : "";
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${fraction}${offsetText(ms)}`
  );
}

/** A rough length of time: "45s", "13m", "2h 13m", "1 day 4h", "3 days", "5 months", "2 years". */
export function durationText(ms: number): string {
  const seconds = Math.floor(Math.abs(ms) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 2) return hours % 24 ? `1 day ${hours % 24}h` : "1 day";
  if (days < 60) return `${days} days`;
  // Rounded, so the first values past each threshold read "2 months" and "2 years".
  if (days < 730) return `${Math.round(days / 30.44)} months`;
  return `${Math.round(days / 365.25)} years`;
}

/** "in 2h 13m", "3 days ago" or "just now". */
export function relativeTime(ms: number, now: number): string {
  const diff = ms - now;
  if (Math.abs(diff) < 1000) return "just now";
  return diff > 0 ? `in ${durationText(diff)}` : `${durationText(diff)} ago`;
}

export type TimeSource = "seconds" | "milliseconds" | "microseconds" | "nanoseconds" | "date" | "now";

const ISO_DATE =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;
const MONTH_WORD = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?$/i;
const DAY_WORD = /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?$/i;

function parseIsoDate(t: string): number | null {
  const m = ISO_DATE.exec(t);
  if (!m) return null;
  const [year, month, day, hour = 0, minute = 0, second = 0] = m.slice(1, 7).map((part) => Number(part ?? 0));
  const millis = m[7] ? Number(m[7].slice(0, 3).padEnd(3, "0")) : 0;
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return null;
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  const zone = m[8];
  if (!zone) {
    // No offset means local time, for date-only strings too, unlike Date.parse.
    return new Date(year, month - 1, day, hour, minute, second, millis).getTime();
  }
  let offset = 0;
  if (zone.toUpperCase() !== "Z") {
    const digits = zone.slice(1).replace(":", "");
    offset = (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2) || 0)) * (zone[0] === "-" ? -1 : 1);
  }
  return Date.UTC(year, month - 1, day, hour, minute, second, millis) - offset * 60_000;
}

/**
 * Written-out dates such as "Wed, 04 Nov 2026 13:00:00 GMT" or "4 Nov 2026".
 * Date.parse accepts almost anything with a month and a year in it ("May the
 * force 2026"), so every word must be a date part first.
 */
function parseWrittenDate(t: string): number | null {
  if (t.length > 80) return null;
  const words = t.replace(/\s*\([^)]*\)$/, "").split(/[\s,]+/).filter(Boolean);
  let month = false;
  let year = false;
  for (const word of words) {
    if (MONTH_WORD.test(word)) month = true;
    else if (/^\d{4}$/.test(word)) year = true;
    else if (
      !DAY_WORD.test(word) &&
      !/^\d{1,2}(st|nd|rd|th)?$/i.test(word) &&
      !/^\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(word) &&
      !/^(am|pm|gmt|utc|ut|z|[ecmp][sd]t)$/i.test(word) &&
      !/^(gmt|utc)?[+-]\d{2}:?\d{2}$/i.test(word)
    ) {
      return null;
    }
  }
  if (!month || !year) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : null;
}

/** A moment from an epoch number, an ISO or written date, or the word "now". */
export function parseTimeInput(text: string, now: number): { ms: number; source: TimeSource } | null {
  const t = text.trim();
  if (/^now$/i.test(t)) return { ms: now, source: "now" };
  if (/^\d{10}(\.\d+)?$/.test(t)) return { ms: Math.round(Number(t) * 1000), source: "seconds" };
  if (/^\d{13}$/.test(t)) return { ms: Number(t), source: "milliseconds" };
  if (/^\d{16}$/.test(t)) return { ms: Math.floor(Number(t) / 1000), source: "microseconds" };
  if (/^\d{19}$/.test(t)) return { ms: Number(BigInt(t) / 1_000_000n), source: "nanoseconds" };
  const ms = parseIsoDate(t) ?? parseWrittenDate(t);
  return ms === null || Math.abs(ms) > 8.64e15 ? null : { ms, source: "date" };
}

const YEAR_2100_MS = 4_102_444_800_000;

/**
 * A 10-digit (seconds) or 13-digit (milliseconds) epoch between 2001 and 2100,
 * for the main search. The range leaves out Indian mobile numbers, which are
 * 10 digits starting with 6 to 9.
 */
export function inlineEpoch(text: string): number | null {
  const t = text.trim();
  const ms = /^\d{10}$/.test(t) ? Number(t) * 1000 : /^\d{13}$/.test(t) ? Number(t) : null;
  return ms !== null && ms >= 1e12 && ms < YEAR_2100_MS ? ms : null;
}

function timeGroup(t: string, now: number): DevGroup | null {
  const parsed = parseTimeInput(t, now);
  if (!parsed) return null;
  const { ms, source } = parsed;
  const seconds: DevResult = { id: "time:seconds", label: "Unix Seconds", value: String(Math.floor(ms / 1000)) };
  const millis: DevResult = { id: "time:ms", label: "Unix Milliseconds", value: String(ms) };
  const local: DevResult = { id: "time:local", label: "Local Time", value: formatLocal(ms) };
  const relative: DevResult = { id: "time:relative", label: "Relative", value: relativeTime(ms, now) };
  const utc: DevResult = { id: "time:utc", label: "UTC", value: new Date(ms).toUTCString() };
  const iso: DevResult = { id: "time:iso", label: "ISO 8601 (UTC)", value: new Date(ms).toISOString() };
  const isoZoned: DevResult = { id: "time:iso-local", label: "ISO 8601 (Local)", value: isoLocal(ms) };
  const preview = [local, relative, utc, iso, isoZoned, seconds, millis]
    .map((r) => `${r.label.padEnd(18)} ${r.value}`)
    .join("\n");
  const ordered =
    source === "now"
      ? [seconds, millis, local, utc, iso, isoZoned]
      : source === "date"
        ? [seconds, millis, local, relative, utc, iso, isoZoned]
        : [local, relative, utc, iso, isoZoned, source === "seconds" ? millis : seconds];
  const title = source === "now" ? "Now" : source === "date" ? "Date" : `Timestamp (${source})`;
  return { kind: "time", title, icon: "🕒", results: ordered.map((r) => ({ ...r, preview: `${r.value}\n\n${preview}` })) };
}

// ---------------------------------------------------------------------------
// JWT

export interface Jwt {
  /** The compact token, without "Bearer" or a header name. */
  token: string;
  header: Record<string, unknown>;
  /** The claims; null when the payload is encrypted (JWE) or not a JSON object. */
  claims: Record<string, unknown> | null;
  /** The decoded payload as text, or "" when it is encrypted or not UTF-8. */
  payloadText: string;
  /** Size of the decoded payload in bytes. */
  payloadBytes: number;
  /** Five parts: an encrypted token (JWE) whose payload needs the key. */
  encrypted: boolean;
  signature: string;
}

export interface JwtError {
  error: string;
}

/** The token from "eyJ…", "Bearer eyJ…" or "Authorization: Bearer eyJ…", quotes removed. */
export function extractToken(text: string): string {
  return text
    .trim()
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^authorization\s*:\s*/i, "")
    .replace(/^bearer\s+/i, "")
    .trim();
}

function decodeJsonPart(part: string): Record<string, unknown> | null {
  const bytes = base64Bytes(part);
  const text = bytes ? utf8(bytes) : null;
  if (text === null) return null;
  try {
    const value = parseExact(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A JWT (signed) or JWE (encrypted), or null when the text is not a token at
 * all. Text that starts like a token ("eyJ") but does not decode is reported
 * as an error instead, so a truncated paste says what is wrong.
 */
export function parseJwt(text: string): Jwt | JwtError | null {
  const token = extractToken(text);
  if (!/^[A-Za-z0-9_=-]+(\.[A-Za-z0-9_=-]*)+$/.test(token)) return null;
  const tokenLike = token.startsWith("eyJ");
  const parts = token.split(".");
  if (parts.length !== 3 && parts.length !== 5) {
    return tokenLike ? { error: `A JWT has 3 parts (5 when encrypted), separated by dots. This one has ${parts.length}.` } : null;
  }
  const header = decodeJsonPart(parts[0]);
  if (!header || (typeof header.alg !== "string" && typeof header.enc !== "string")) {
    return tokenLike ? { error: "The header is not Base64URL-encoded JSON. The token may be cut off or mistyped." } : null;
  }
  if (parts.length === 5) {
    return { token, header, claims: null, payloadText: "", payloadBytes: 0, encrypted: true, signature: "" };
  }
  const bytes = base64Bytes(parts[1]);
  if (!bytes) return { error: "The payload is not valid Base64URL. The token may be cut off or mistyped." };
  const payloadText = utf8(bytes) ?? "";
  return {
    token,
    header,
    claims: decodeJsonPart(parts[1]),
    payloadText,
    payloadBytes: bytes.length,
    encrypted: false,
    signature: parts[2],
  };
}

export const UNVERIFIED_NOTE =
  "The signature is not verified. Anyone can make a token with these claims; only the issuer's key proves it is genuine.";

/** Seconds since the epoch from a NumericDate claim, which some issuers send as a string. */
function numericDate(value: unknown): number | null {
  const n = typeof value === "string" && /^\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n * 1000 : null;
}

/** "expires in 2h 13m", "expired 3 days ago" or "no expiry". */
export function expiryPhrase(claims: Record<string, unknown> | null, now: number): string {
  const exp = numericDate(claims?.exp);
  if (exp === null) return claims && "exp" in claims ? "expiry unreadable" : "no expiry";
  return exp > now ? `expires in ${durationText(exp - now)}` : `expired ${durationText(now - exp)} ago`;
}

/** "Expires in 2h 13m · Wed 4 Nov, 18:30" or "Expired 3 days ago · Sun 1 Nov, 10:00". */
export function expiryText(claims: Record<string, unknown> | null, now: number): string {
  const exp = numericDate(claims?.exp);
  if (exp === null) {
    if (!claims) return "No expiry: the payload is not readable";
    return "exp" in claims ? `Unreadable expiry: ${JSON.stringify(claims.exp)}` : "No expiry: the token has no exp claim";
  }
  const phrase = expiryPhrase(claims, now);
  return `${phrase[0].toUpperCase()}${phrase.slice(1)} · ${formatShort(exp, now)}`;
}

function claimText(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (Array.isArray(value)) return value.map(claimText).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Label/value rows for the summary: who issued the token, for whom, and when it is valid. */
export function jwtClaimRows(jwt: Jwt, now: number): Array<[string, string]> {
  const rows: Array<[string, string]> = [];
  const add = (label: string, value: unknown) => {
    const text = claimText(value);
    if (text) rows.push([label, text]);
  };
  const h = jwt.header;
  const c = jwt.claims ?? {};
  add("Algorithm", h.alg);
  if (jwt.encrypted) add("Encryption", h.enc);
  add("Type", h.typ);
  add("Key ID", h.kid);
  add("Issuer", c.iss);
  add("Subject", c.sub);
  add("Audience", c.aud);
  add("Client", c.azp ?? c.client_id);
  add("Scope", c.scope ?? c.scp);
  add("Roles", c.roles);
  add("Email", c.email);
  add("Name", c.name ?? c.preferred_username);
  const time = (label: string, claim: string) => {
    const ms = numericDate(c[claim]);
    if (ms !== null) rows.push([label, `${formatLocal(ms)} (${relativeTime(ms, now)})`]);
  };
  time("Expires", "exp");
  time("Issued", "iat");
  time("Not before", "nbf");
  const exp = numericDate(c.exp);
  const iat = numericDate(c.iat);
  if (exp !== null && iat !== null && exp > iat) add("Lifetime", durationText(exp - iat));
  add("Token ID", c.jti);
  return rows;
}

function table(rows: Array<[string, string]>): string {
  const width = Math.max(0, ...rows.map(([label]) => label.length)) + 2;
  return rows.map(([label, value]) => label.padEnd(width) + value).join("\n");
}

/** One line naming the token: algorithm, who it is for, who issued it. */
export function jwtHeadline(jwt: Jwt): string {
  const c = jwt.claims ?? {};
  const who = claimText(c.email ?? c.preferred_username ?? c.name ?? c.sub);
  let issuer = claimText(c.iss);
  try {
    if (/^https?:\/\//.test(issuer)) issuer = new URL(issuer).host;
  } catch {
    // Keep the issuer as written.
  }
  const alg = claimText(jwt.header.alg) || "JWT";
  return [jwt.encrypted ? `${alg} / ${claimText(jwt.header.enc)}` : alg, who, issuer].filter(Boolean).join(" · ");
}

function payloadDisplay(jwt: Jwt): string {
  if (jwt.encrypted) return "Encrypted (JWE): the payload can only be read with the recipient's key.";
  if (jwt.claims) return pretty(jwt.claims);
  if (jwt.payloadText) return jwt.payloadText;
  return jwt.payloadBytes ? `Binary payload (${plural(jwt.payloadBytes, "byte")}), not text.` : "Empty payload (detached content).";
}

/** The whole token decoded, for the output screen and the summary preview. */
export function jwtReport(jwt: Jwt, now: number): string {
  const sections = [
    jwt.encrypted ? "Encrypted JWT (JWE) · claims encrypted" : `JWT · ${expiryPhrase(jwt.claims, now)}`,
    table(jwtClaimRows(jwt, now)),
    jwt.encrypted ? "" : UNVERIFIED_NOTE,
    `Header\n${pretty(jwt.header)}`,
    `Payload\n${payloadDisplay(jwt)}`,
  ];
  if (!jwt.encrypted) sections.push(`Signature (not verified)\n${jwt.signature || "None: the token is unsigned (alg \"none\")."}`);
  return sections.filter(Boolean).join("\n\n");
}

function jwtGroup(jwt: Jwt, now: number): DevGroup {
  const report = jwtReport(jwt, now);
  const summary = table(jwtClaimRows(jwt, now));
  const results: DevResult[] = [
    {
      id: "jwt:claims",
      label: "Claims",
      title: jwtHeadline(jwt),
      value: summary,
      preview: report,
    },
  ];
  const claims = jwt.claims;
  if (!jwt.encrypted) {
    results.push({ id: "jwt:expiry", label: "Expiry", value: expiryText(claims, now), preview: report });
    const iat = numericDate(claims?.iat);
    if (iat !== null) {
      results.push({
        id: "jwt:iat",
        label: "Issued At (iat)",
        value: `Issued ${relativeTime(iat, now)} · ${formatShort(iat, now)}`,
        preview: report,
      });
    }
    const nbf = numericDate(claims?.nbf);
    if (nbf !== null) {
      results.push({
        id: "jwt:nbf",
        label: "Not Before (nbf)",
        value:
          nbf > now
            ? `Not valid yet · valid ${relativeTime(nbf, now)} · ${formatShort(nbf, now)}`
            : `Valid since ${formatShort(nbf, now)} (${relativeTime(nbf, now)})`,
        preview: report,
      });
    }
  }
  const payload = payloadDisplay(jwt);
  results.push({
    id: "jwt:payload",
    label: claims || jwt.encrypted ? "Payload" : "Payload (not JSON)",
    title: claims ? JSON.stringify(claims) : payload,
    value: payload,
  });
  results.push({ id: "jwt:header", label: "Header", title: JSON.stringify(jwt.header), value: pretty(jwt.header) });
  if (!jwt.encrypted) {
    results.push({
      id: "jwt:signature",
      label: "Signature · not verified",
      title: jwt.signature || "None: unsigned token (alg \"none\")",
      value: jwt.signature,
      preview: `${jwt.signature || "No signature."}\n\n${UNVERIFIED_NOTE}`,
      copyTitle: "Copy Signature",
    });
  }
  const extras: DevCopy[] = [];
  if (claims) extras.push({ id: "copy-payload", title: "Copy Payload JSON", shortcut: "Ctrl+Shift+C", text: pretty(claims) });
  extras.push(
    { id: "copy-token", title: "Copy Token", shortcut: "Ctrl+Shift+T", text: jwt.token },
    { id: "copy-auth-header", title: "Copy Authorization Header", shortcut: "Ctrl+Shift+A", text: `Authorization: Bearer ${jwt.token}` },
  );
  return {
    kind: "jwt",
    title: jwt.encrypted ? "Encrypted JWT (JWE)" : "JWT (signature not verified)",
    icon: "🔑",
    results,
    extras,
    secret: true,
  };
}

// ---------------------------------------------------------------------------
// UUID

export interface UuidInfo {
  uuid: string;
  version: number;
  versionName: string;
  variant: string;
  /** When the UUID was made, for time-based versions (1, 6, 7). */
  createdMs: number | null;
}

const UUID_RE = /^(?:urn:uuid:)?\{?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\}?$/i;
const VERSION_NAMES: Record<number, string> = {
  1: "time-based",
  2: "DCE security",
  3: "name-based, MD5",
  4: "random",
  5: "name-based, SHA-1",
  6: "time-based, sortable",
  7: "Unix time-based, sortable",
  8: "custom",
};
/** 100-nanosecond steps from the Gregorian calendar's start (1582-10-15) to the Unix epoch. */
const GREGORIAN_OFFSET = 122_192_928_000_000_000n;

export function uuidInfo(text: string): UuidInfo | null {
  const match = UUID_RE.exec(text.trim());
  if (!match) return null;
  const uuid = match[1].toLowerCase();
  const hex = uuid.replace(/-/g, "");
  if (/^0+$/.test(hex)) return { uuid, version: 0, versionName: "Nil UUID", variant: "none", createdMs: null };
  if (/^f+$/.test(hex)) return { uuid, version: 15, versionName: "Max UUID", variant: "none", createdMs: null };
  const version = parseInt(hex[12], 16);
  const variantBits = parseInt(hex[16], 16);
  const rfc = variantBits >= 8 && variantBits <= 11;
  const variant = rfc
    ? "RFC 9562 (RFC 4122)"
    : variantBits < 8
      ? "NCS (reserved, pre-RFC)"
      : variantBits < 14
        ? "Microsoft (reserved)"
        : "Reserved for future use";
  let createdMs: number | null = null;
  if (rfc && version === 7) createdMs = parseInt(hex.slice(0, 12), 16);
  if (rfc && (version === 1 || version === 6)) {
    const ticks =
      version === 1
        ? (BigInt(`0x${hex.slice(13, 16)}`) << 48n) | (BigInt(`0x${hex.slice(8, 12)}`) << 32n) | BigInt(`0x${hex.slice(0, 8)}`)
        : (BigInt(`0x${hex.slice(0, 12)}`) << 12n) | BigInt(`0x${hex.slice(13, 16)}`);
    createdMs = Number((ticks - GREGORIAN_OFFSET) / 10_000n);
  }
  return { uuid, version, versionName: VERSION_NAMES[version] ?? "unknown version", variant, createdMs };
}

function uuidGroup(t: string, now: number): DevGroup | null {
  const info = uuidInfo(t);
  if (!info) return null;
  const special = info.version === 0 || info.version === 15;
  const versionText = special ? info.versionName : `UUID v${info.version} · ${info.versionName}`;
  const lines = [
    `Version   ${special ? info.versionName : `${info.version} (${info.versionName})`}`,
    `Variant   ${info.variant}`,
  ];
  if (info.createdMs !== null) lines.push(`Created   ${formatLocal(info.createdMs)} (${relativeTime(info.createdMs, now)})`);
  const details = `${info.uuid}\n\n${lines.join("\n")}`;
  const results: DevResult[] = [
    { id: "uuid:info", label: "UUID Info", title: `${versionText} · ${info.variant} variant`, value: lines.join("\n"), preview: details },
  ];
  if (info.createdMs !== null) {
    results.push({ id: "uuid:created", label: "Created", value: formatLocal(info.createdMs), preview: details });
  }
  const bare = t.trim();
  if (info.uuid !== bare) results.push({ id: "uuid:lower", label: "Lowercase", value: info.uuid });
  if (info.uuid.toUpperCase() !== bare) results.push({ id: "uuid:upper", label: "Uppercase", value: info.uuid.toUpperCase() });
  results.push({ id: "uuid:compact", label: "Without Dashes", value: info.uuid.replace(/-/g, "") });
  return { kind: "uuid", title: "UUID", icon: "🆔", results };
}

/** A version 7 UUID: the time in milliseconds, then random bits, so they sort by creation time. */
export function uuidV7(now: number, random: Uint8Array = randomBytes(10)): string {
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 6; i++) bytes[i] = Math.floor(now / 2 ** (8 * (5 - i))) % 256;
  bytes.set(random.subarray(0, 10), 6);
  bytes[6] = 0x70 | (bytes[6] & 0x0f);
  bytes[8] = 0x80 | (bytes[8] & 0x3f);
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---------------------------------------------------------------------------
// URLs

export interface UrlParam {
  key: string;
  value: string;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Query parameters of a URL, or of a bare query string such as "a=1&b=2". */
export function urlParams(text: string): UrlParam[] | null {
  const t = text.trim();
  const url = parseUrl(t);
  if (url) return [...url.searchParams].map(([key, value]) => ({ key, value }));
  if (/^\??[^\s=&?]+=[^\s&]*(&[^\s=&]+=[^\s&]*)+$/.test(t)) {
    return [...new URLSearchParams(t)].map(([key, value]) => ({ key, value }));
  }
  return null;
}

export function parseUrl(text: string): URL | null {
  const t = text.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\/[^\s/?#]+\S*$/i.test(t)) return null;
  try {
    return new URL(t);
  } catch {
    return null;
  }
}

/** Parameter names that usually carry credentials, so copies stay out of clipboard history. */
const SECRET_PARAM = /token|secret|password|passwd|signature|^sig$|^code$|api[_-]?key|^key$|credential|session/i;

function paramResults(params: UrlParam[], prefix: string, label: string): DevResult[] {
  return params.map(({ key, value }, index) => {
    const json = checkJson(value);
    const structured = json.ok && json.value !== null && typeof json.value === "object";
    return {
      id: `${prefix}:${index}`,
      label,
      title: `${key} = ${value}`,
      value,
      preview: `${key}\n\n${structured ? pretty(json.value) : value}`,
      copyTitle: "Copy Value",
      secret: SECRET_PARAM.test(key),
    };
  });
}

function paramsJson(params: UrlParam[]): string {
  const object: Record<string, string | string[]> = Object.create(null);
  for (const { key, value } of params) {
    const known = object[key];
    object[key] = known === undefined ? value : Array.isArray(known) ? [...known, value] : [known, value];
  }
  return pretty(object);
}

function urlGroup(t: string): DevGroup | null {
  const url = parseUrl(t);
  const params = urlParams(t);
  if (!url && !params) return null;
  const results: DevResult[] = [];
  if (url) {
    const decoded = safeDecode(t);
    if (decoded !== t) results.push({ id: "url:decoded", label: "Decoded URL", value: decoded });
    results.push({ id: "url:host", label: "Host", value: url.host || url.protocol });
    if (url.pathname && url.pathname !== "/") results.push({ id: "url:path", label: "Path", value: safeDecode(url.pathname) });
  }
  const all = params ?? [];
  results.push(...paramResults(all, "url:param", "Query Parameter"));
  // OAuth's implicit flow puts the token in the fragment: #access_token=…&expires_in=3600.
  const fragment = url?.hash.slice(1) ?? "";
  const fragmentParams = /^[^\s=&]+=/.test(fragment) ? [...new URLSearchParams(fragment)].map(([key, value]) => ({ key, value })) : [];
  if (fragmentParams.length) results.push(...paramResults(fragmentParams, "url:fragment", "Fragment Parameter"));
  else if (fragment) results.push({ id: "url:hash", label: "Fragment", value: safeDecode(fragment) });
  const everyParam = [...all, ...fragmentParams];
  if (everyParam.length > 1) {
    results.push({
      id: "url:params-json",
      label: "Parameters as JSON",
      value: paramsJson(everyParam),
      secret: everyParam.some((p) => SECRET_PARAM.test(p.key)),
    });
  }
  return { kind: "url", title: url ? "URL" : "Query String", icon: "🔗", results };
}

// ---------------------------------------------------------------------------
// Numbers

export type NumberBase = 2 | 8 | 10 | 16;

/** Whole numbers in decimal, 0x hex, 0b binary or 0o octal; underscores allowed as separators. */
export function parseNumberInput(text: string): { value: bigint; base: NumberBase } | null {
  const t = text.trim().replace(/_/g, "");
  const match = /^(-?)(0x[0-9a-f]+|0b[01]+|0o[0-7]+|\d+)$/i.exec(t);
  if (!match || t.length > 80) return null;
  const digits = match[2].toLowerCase();
  const base: NumberBase = digits.startsWith("0x") ? 16 : digits.startsWith("0b") ? 2 : digits.startsWith("0o") ? 8 : 10;
  const magnitude = BigInt(digits);
  return { value: match[1] ? -magnitude : magnitude, base };
}

/** The number written in a base, e.g. 255 in base 16 is "0xff". */
export function formatBase(value: bigint, base: NumberBase): string {
  const sign = value < 0n ? "-" : "";
  const digits = (value < 0n ? -value : value).toString(base);
  return sign + (base === 16 ? "0x" : base === 2 ? "0b" : base === 8 ? "0o" : "") + digits;
}

function numberGroup(t: string): DevGroup | null {
  const parsed = parseNumberInput(t);
  if (!parsed) return null;
  const names: Record<NumberBase, string> = { 10: "Decimal", 16: "Hex", 2: "Binary", 8: "Octal" };
  const results: DevResult[] = ([10, 16, 2, 8] as NumberBase[])
    .filter((base) => base !== parsed.base)
    .map((base) => ({ id: `number:${base}`, label: names[base], value: formatBase(parsed.value, base) }));
  return { kind: "number", title: `Number (${names[parsed.base].toLowerCase()})`, icon: "🔢", results };
}

// ---------------------------------------------------------------------------
// Text: encodings, hashes, case styles and counts

function base64Group(t: string): DevGroup | null {
  const decoded = decodeBase64Text(t);
  if (!decoded) return null;
  const json = checkJson(decoded.text.trim());
  const label = decoded.urlSafe ? "Base64URL Decoded" : "Base64 Decoded";
  return {
    kind: "base64",
    title: "Base64",
    icon: "📦",
    results: [
      {
        id: "base64:decoded",
        label,
        value: decoded.text,
        preview: json.ok && json.value && typeof json.value === "object" ? pretty(json.value) : decoded.text,
      },
    ],
  };
}

function encodeGroup(text: string, decode: boolean): DevGroup {
  const bytes = Buffer.from(text, "utf8");
  const results: DevResult[] = [
    { id: "encode:base64", label: "Base64", value: bytes.toString("base64") },
    { id: "encode:base64url", label: "Base64URL", value: bytes.toString("base64url") },
  ];
  const encoded = encodeURIComponent(text);
  if (encoded !== text) results.push({ id: "encode:url", label: "URL Encoded", value: encoded });
  if (decode && /%[0-9a-f]{2}/i.test(text)) {
    const decoded = safeDecode(text);
    if (decoded !== text) results.unshift({ id: "encode:url-decoded", label: "URL Decoded", value: decoded });
  }
  return { kind: "encode", title: "Encode & Decode", icon: "🔤", results };
}

export function hashes(text: string): Array<{ label: string; value: string }> {
  return [
    ["MD5", "md5"],
    ["SHA-1", "sha1"],
    ["SHA-256", "sha256"],
    ["SHA-512", "sha512"],
  ].map(([label, algorithm]) => ({ label, value: createHash(algorithm).update(text, "utf8").digest("hex") }));
}

function hashGroup(text: string, title = "Hashes"): DevGroup {
  // A trailing newline from a terminal copy changes every hash, so say when it is included.
  const note = text !== text.trim() ? " · includes surrounding whitespace" : "";
  return {
    kind: "hash",
    title: `${title}${note}`,
    icon: "#️⃣",
    results: hashes(text).map(({ label, value }) => ({ id: `hash:${label.toLowerCase()}`, label, value })),
  };
}

/** Words of an identifier or phrase: "XMLHttpRequest" → XML, Http, Request; "user_id" → user, id. */
export function splitWords(text: string): string[] {
  return text
    .replace(/(\p{Ll}|\p{N})(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, "$1 $2")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/** camelCase, PascalCase, snake_case and the rest, skipping any that match the input. */
export function caseConversions(text: string): Array<{ id: string; label: string; value: string }> {
  const words = splitWords(text);
  if (!words.length) return [];
  const lower = words.map((w) => w.toLowerCase());
  const all = [
    { id: "camel", label: "camelCase", value: lower[0] + words.slice(1).map(capitalize).join("") },
    { id: "pascal", label: "PascalCase", value: words.map(capitalize).join("") },
    { id: "snake", label: "snake_case", value: lower.join("_") },
    { id: "constant", label: "CONSTANT_CASE", value: lower.join("_").toUpperCase() },
    { id: "kebab", label: "kebab-case", value: lower.join("-") },
    { id: "title", label: "Title Case", value: words.map(capitalize).join(" ") },
    { id: "lower", label: "lower case", value: text.toLowerCase() },
    { id: "upper", label: "UPPER CASE", value: text.toUpperCase() },
  ];
  const seen = new Set([text]);
  return all.filter(({ value }) => !seen.has(value) && Boolean(seen.add(value)));
}

function caseGroup(t: string): DevGroup | null {
  if (t.length > 100 || /\n/.test(t) || !/\p{L}/u.test(t)) return null;
  const results = caseConversions(t).map(({ id, label, value }) => ({ id: `case:${id}`, label, value }));
  return results.length ? { kind: "case", title: "Case", icon: "🔠", results } : null;
}

export interface TextStats {
  characters: number;
  words: number;
  lines: number;
  bytes: number;
}

export function textStats(text: string): TextStats {
  const breaks = text.match(/\r\n|\r|\n/g)?.length ?? 0;
  return {
    // Code points, so an emoji counts once rather than as two UTF-16 halves.
    characters: [...text].length,
    words: text.split(/\s+/).filter(Boolean).length,
    // A final line break ends the last line rather than starting a new one.
    lines: text ? breaks + (/(\r\n|\r|\n)$/.test(text) ? 0 : 1) : 0,
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

function statsGroup(text: string): DevGroup {
  const s = textStats(text);
  const summary = [plural(s.characters, "character"), plural(s.words, "word"), plural(s.lines, "line"), plural(s.bytes, "byte")].join(" · ");
  return {
    kind: "stats",
    title: "Text",
    icon: "📊",
    results: [{ id: "stats", label: "Text Stats", value: summary, preview: summary.replace(/ · /g, "\n") }],
  };
}

// ---------------------------------------------------------------------------
// Detection

/**
 * Everything Beam can tell about the text, most specific first: a token,
 * then structured data, then plain-text conversions that work on anything.
 */
export function analyze(text: string, now: number): DevGroup[] {
  const t = text.trim();
  if (!t) return [];
  const jwt = parseJwt(t);
  if (jwt && "error" in jwt) {
    const error: DevResult = { id: "jwt:error", label: "Invalid JWT", value: jwt.error, copyTitle: "Copy Error", error: true };
    return [{ kind: "jwt", title: "JWT", icon: "⚠️", results: [error] }, hashGroup(text), statsGroup(text)];
  }
  if (jwt) {
    // Hash the token itself: "Bearer " in front would change every hash.
    return [jwtGroup(jwt, now), hashGroup(jwt.token, "Hashes of the token"), statsGroup(jwt.token)];
  }
  const url = urlGroup(t);
  const specific = [jsonGroup(t), timeGroup(t, now), uuidGroup(t, now), url, numberGroup(t), base64Group(t)].filter(
    (g): g is DevGroup => g !== null,
  );
  const groups = [...specific];
  // Identifiers and phrases only: case styles of a URL or Base64 are noise.
  const cases = specific.length ? null : caseGroup(t);
  if (cases) groups.push(cases);
  // Encoding a number or "now" is never what was meant.
  if (!/^(now|-?[\d._]+|0[xbo][\da-f_]+)$/i.test(t)) groups.push(encodeGroup(t, !url));
  groups.push(hashGroup(text), statsGroup(text));
  return groups;
}

// ---------------------------------------------------------------------------
// Generators

const PASSWORD_SETS = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "!*+-.=?@^_"];

/**
 * A random password with upper and lower case letters, digits and symbols,
 * leaving out look-alikes (0/O, 1/l/I) and characters that need quoting in
 * shells, URLs and .env files.
 */
export function generatePassword(length = 20): string {
  const chars = PASSWORD_SETS.join("");
  for (;;) {
    let password = "";
    for (let i = 0; i < length; i++) password += chars[randomInt(chars.length)];
    // Redraw rather than patch in missing classes, so every position stays uniform.
    if (PASSWORD_SETS.every((set) => [...password].some((ch) => set.includes(ch)))) return password;
  }
}

/** 32 random bytes, for HMAC keys, session secrets and the like. */
export function generateSecret(): { hex: string; base64: string } {
  const bytes = randomBytes(32);
  return { hex: bytes.toString("hex"), base64: bytes.toString("base64") };
}

const GENERATOR_WORDS: Record<string, string[]> = {
  "gen:uuid4": ["uuid", "guid", "v4", "random"],
  "gen:uuid7": ["uuid", "guid", "v7", "sortable"],
  "gen:password": ["password", "passwd", "pwd"],
  "gen:secret-hex": ["secret", "random", "hex", "key", "bytes"],
  "gen:secret-base64": ["secret", "random", "base64", "key", "bytes"],
  "gen:unix": ["timestamp", "unix", "epoch", "seconds"],
  "gen:unix-ms": ["timestamp", "unix", "epoch", "milliseconds"],
  "gen:iso": ["iso", "timestamp", "date"],
};

/** Fresh values for the Generate section; with a query, only those it names (3+ letters). */
export function generators(now: number, query = ""): DevResult[] {
  const q = query.trim().toLowerCase();
  if (q && (q.length < 3 || !Object.values(GENERATOR_WORDS).some((words) => words.some((w) => w.startsWith(q))))) return [];
  const password = generatePassword();
  const secret = generateSecret();
  const seconds = String(Math.floor(now / 1000));
  const v4 = randomUUID();
  const v7 = uuidV7(now);
  const all: DevResult[] = [
    { id: "gen:uuid4", label: "UUID v4", value: v4, preview: `${v4}\n\nRandom (version 4). A new one each time the view opens.` },
    { id: "gen:uuid7", label: "UUID v7", value: v7, preview: `${v7}\n\nTime-ordered (version 7): starts with the current time, so IDs sort by creation.` },
    {
      id: "gen:password",
      label: "Password",
      value: password,
      preview: `${password}\n\n20 characters: upper and lower case letters, digits and symbols, from a cryptographic random source. Copies stay out of clipboard history.`,
      secret: true,
    },
    {
      id: "gen:secret-hex",
      label: "Secret (hex)",
      value: secret.hex,
      preview: `${secret.hex}\n\n32 random bytes (256 bits) as hex. Copies stay out of clipboard history.`,
      secret: true,
    },
    {
      id: "gen:secret-base64",
      label: "Secret (Base64)",
      value: secret.base64,
      preview: `${secret.base64}\n\nThe same 32 bytes as Base64. Copies stay out of clipboard history.`,
      secret: true,
    },
    { id: "gen:unix", label: "Unix Timestamp", value: seconds, preview: `${seconds}\n\n${formatLocal(now)}` },
    { id: "gen:unix-ms", label: "Unix Timestamp (ms)", value: String(now), preview: `${now}\n\n${formatLocal(now)}` },
    { id: "gen:iso", label: "ISO 8601", value: new Date(now).toISOString(), preview: `${new Date(now).toISOString()}\n\n${formatLocal(now)}` },
  ];
  return q ? all.filter((r) => (GENERATOR_WORDS[r.id] ?? []).some((w) => w.startsWith(q))) : all;
}
