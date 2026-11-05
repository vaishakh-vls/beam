// Browser Tabs: the wire format shared with packaging/beam-browser-host and
// chrome-extension/, plus ranking and display helpers. Pure on purpose: the
// tests run this file directly with Node's type stripping.

/** Native messaging host name; also the name of its manifest file. */
export const HOST_NAME = "com.virallens.beam";
/** Fixed by the "key" in chrome-extension/manifest.json, so the unpacked extension has this ID everywhere. */
export const EXTENSION_ID = "mgpijmbkbogdbehfmjlppgliampccfmp";
/** A tab list with favicons is a few hundred KB; anything near this is a broken stream. */
export const MAX_FRAME = 64 * 1024 * 1024;

export interface BrowserTab {
  id: number;
  windowId: number;
  /** Position within its window. */
  index: number;
  title: string;
  url: string;
  /** A data:image URL from Chrome's favicon cache. */
  favicon?: string;
  active: boolean;
  audible: boolean;
  muted: boolean;
  pinned: boolean;
  incognito: boolean;
  /** Unloaded to save memory; switching to it reloads the page. */
  discarded: boolean;
  /** Milliseconds since the epoch; 0 when Chrome does not say. */
  lastAccessed: number;
}

export interface Reply {
  id: number;
  ok: boolean;
  error?: string;
  /** The whole message, for request-specific fields. */
  body: Record<string, unknown>;
}

export interface Hello {
  version: string;
  userAgent: string;
  /** When the extension's service worker started, to tell restarts apart. */
  startedAt: number;
}

/** Length-prefixed JSON: a 4-byte little-endian length, then UTF-8 JSON. */
export function encodeFrame(message: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(message), "utf8");
  const frame = Buffer.alloc(4 + json.length);
  frame.writeUInt32LE(json.length, 0);
  json.copy(frame, 4);
  return frame;
}

/** Collects socket chunks into whole messages. */
export class FrameDecoder {
  #buffer: Buffer = Buffer.alloc(0);
  #limit: number;

  constructor(limit = MAX_FRAME) {
    this.#limit = limit;
  }

  /**
   * The messages this chunk completes. A frame that isn't JSON is skipped;
   * an oversized length throws, since the stream can no longer be trusted.
   */
  push(chunk: Buffer): unknown[] {
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    const messages: unknown[] = [];
    while (this.#buffer.length >= 4) {
      const size = this.#buffer.readUInt32LE(0);
      if (size > this.#limit) throw new Error(`Message of ${size} bytes is too large`);
      if (this.#buffer.length < 4 + size) break;
      const json = this.#buffer.subarray(4, 4 + size).toString("utf8");
      this.#buffer = this.#buffer.subarray(4 + size);
      try {
        messages.push(JSON.parse(json));
      } catch {
        // Keep reading: the next frame starts right after this one.
      }
    }
    return messages;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseReply(message: unknown): Reply | null {
  if (!isRecord(message) || typeof message.id !== "number" || typeof message.ok !== "boolean") return null;
  const error = typeof message.error === "string" ? message.error : undefined;
  return { id: message.id, ok: message.ok, error, body: message };
}

export function parseHello(body: Record<string, unknown>): Hello | null {
  if (typeof body.version !== "string") return null;
  return {
    version: body.version,
    userAgent: typeof body.userAgent === "string" ? body.userAgent : "",
    startedAt: typeof body.startedAt === "number" ? body.startedAt : 0,
  };
}

/** Tabs from a "list" reply. Favicons arrive once per reply in `icons` and tabs point at them by index. */
export function parseTabList(body: Record<string, unknown>): BrowserTab[] {
  const icons = Array.isArray(body.icons) ? body.icons : [];
  if (!Array.isArray(body.tabs)) return [];
  const tabs: BrowserTab[] = [];
  for (const raw of body.tabs) {
    if (!isRecord(raw) || !Number.isInteger(raw.id) || !Number.isInteger(raw.windowId)) continue;
    const icon = typeof raw.icon === "number" ? icons[raw.icon] : undefined;
    tabs.push({
      id: raw.id as number,
      windowId: raw.windowId as number,
      index: typeof raw.index === "number" ? raw.index : 0,
      title: typeof raw.title === "string" ? raw.title : "",
      url: typeof raw.url === "string" ? raw.url : "",
      favicon: typeof icon === "string" && icon.startsWith("data:image/") ? icon : undefined,
      active: raw.active === true,
      audible: raw.audible === true,
      muted: raw.muted === true,
      pinned: raw.pinned === true,
      incognito: raw.incognito === true,
      discarded: raw.discarded === true,
      lastAccessed: typeof raw.lastAccessed === "number" ? raw.lastAccessed : 0,
    });
  }
  return tabs;
}

/** "github.com" for web pages, "chrome://settings" for browser pages, the path for files. */
export function tabDomain(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.host.replace(/^www\./, "");
  if (parsed.protocol === "file:") return safeDecode(parsed.pathname);
  if (parsed.host) return `${parsed.protocol}//${parsed.host}`;
  // about:blank stays whole; data: and blob: URLs can be huge.
  return parsed.protocol === "about:" ? url : parsed.protocol.slice(0, -1);
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

export function tabTitle(tab: Pick<BrowserTab, "title" | "url">): string {
  return tab.title.replace(/\s+/g, " ").trim() || tabDomain(tab.url) || "Untitled";
}

/** Short state labels for the right-hand side. */
export function tabAccessory(tab: BrowserTab): string {
  const parts: string[] = [];
  if (tab.audible) parts.push(tab.muted ? "Muted" : "Playing");
  if (tab.pinned) parts.push("Pinned");
  if (tab.incognito) parts.push("Incognito");
  return parts.join(" · ");
}

/** Host and path without the query string, which would let short queries match almost any URL. */
function urlForSearch(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host ? parsed.host + parsed.pathname : url;
  } catch {
    return url;
  }
}

/** The shape of fuzzy.ts's bestScore; passed in so this file imports nothing. */
export type Scorer = (query: string, fields: Array<string | undefined>) => number;

/** Best fuzzy match first, then the most recently used. With no query, most recently used first. */
export function rankTabs<T extends BrowserTab>(tabs: T[], query: string, score: Scorer): T[] {
  const recent = (a: T, b: T) => b.lastAccessed - a.lastAccessed || a.windowId - b.windowId || a.index - b.index;
  const q = query.trim();
  if (!q) return [...tabs].sort(recent);
  return tabs
    .map((tab) => ({ tab, score: score(q, [tabTitle(tab), tabDomain(tab.url), urlForSearch(tab.url)]) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || recent(a.tab, b.tab))
    .map((item) => item.tab);
}

/** Chrome's native messaging host manifest, pointing at beam-browser-host. */
export function hostManifest(hostPath: string): Record<string, unknown> {
  return {
    name: HOST_NAME,
    description: "Beam launcher: Browser Tabs",
    path: hostPath,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
}
