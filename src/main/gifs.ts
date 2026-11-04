// Builds GIPHY requests and turns responses into GIFs with the right URLs. No Electron here, so it can be tested.

export const GIPHY_KEY_URL = "https://developers.giphy.com/dashboard/";
const API = "https://api.giphy.com/v1/gifs";
/** Bigger originals are slow to unfurl in chat; the downsized rendition is under 2 MB. */
const MAX_SHARE_BYTES = 5_000_000;

export interface Gif {
  id: string;
  title: string;
  /** The GIF's page on giphy.com. */
  pageUrl: string;
  /** A direct .gif link for pasting into chat. */
  gifUrl: string;
  /** A small still, for the list. */
  iconUrl?: string;
  /** A small animated rendition, for the preview pane. */
  previewUrl?: string;
  /** Size of the gifUrl rendition. */
  width?: number;
  height?: number;
  bytes?: number;
  rating?: string;
}

export type GiphyError = "auth" | "rate-limit" | "server" | "bad-response";

export type GiphyResult = { ok: true; gifs: Gif[] } | { ok: false; error: GiphyError; status: number };

/** Search for `query`, or trending GIFs when it is empty. */
export function giphyRequestUrl(apiKey: string, query: string, limit = 24): string {
  const q = query.trim();
  const params = new URLSearchParams({ api_key: apiKey, limit: String(limit), rating: "pg-13" });
  if (q) params.set("q", q);
  return `${API}/${q ? "search" : "trending"}?${params}`;
}

export function errorForStatus(status: number): GiphyError | null {
  if (status >= 200 && status < 300) return null;
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate-limit";
  return "server";
}

interface Rendition {
  url?: unknown;
  width?: unknown;
  height?: unknown;
  size?: unknown;
}

interface RawGif {
  id?: unknown;
  title?: unknown;
  url?: unknown;
  rating?: unknown;
  images?: Record<string, Rendition | undefined>;
}

/** Only GIPHY's own https hosts; the renderer's CSP allows nothing else. */
function giphyUrl(value: unknown): string | undefined {
  return typeof value === "string" && /^https:\/\/([a-z0-9-]+\.)*giphy\.com\//i.test(value) ? value : undefined;
}

function count(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" && value ? Number(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Drops GIPHY's tracking parameters so the pasted link is short and ends in .gif. */
export function cleanGifUrl(url: string): string {
  return url.split(/[?#]/)[0];
}

/** The original when it is small enough to unfurl quickly, otherwise the downsized copy. */
export function chooseShareRendition(images: Record<string, Rendition | undefined>): Rendition | undefined {
  const original = images.original;
  const downsized = images.downsized;
  const originalBytes = count(original?.size);
  if (giphyUrl(original?.url) && (!originalBytes || originalBytes <= MAX_SHARE_BYTES || !giphyUrl(downsized?.url))) {
    return original;
  }
  return giphyUrl(downsized?.url) ? downsized : undefined;
}

export function parseGif(raw: RawGif): Gif | null {
  const images = raw.images ?? {};
  const share = chooseShareRendition(images);
  const gifUrl = giphyUrl(share?.url);
  const pageUrl = giphyUrl(raw.url);
  if (typeof raw.id !== "string" || !raw.id || !gifUrl || !pageUrl) return null;
  const title = typeof raw.title === "string" ? raw.title.replace(/\s+/g, " ").trim() : "";
  return {
    id: raw.id,
    title: title || "Untitled GIF",
    pageUrl,
    gifUrl: cleanGifUrl(gifUrl),
    iconUrl:
      giphyUrl(images.fixed_height_small_still?.url) ??
      giphyUrl(images.fixed_height_still?.url) ??
      giphyUrl(images.fixed_height_small?.url),
    previewUrl: giphyUrl(images.fixed_height?.url) ?? giphyUrl(images.downsized?.url) ?? gifUrl,
    width: count(share?.width),
    height: count(share?.height),
    bytes: count(share?.size),
    rating: typeof raw.rating === "string" && raw.rating ? raw.rating : undefined,
  };
}

/** Reads a search or trending response; `status` is the HTTP status. */
export function parseGiphyResponse(status: number, body: unknown): GiphyResult {
  // GIPHY repeats the status in meta; trust whichever reports a failure.
  const metaStatus = count((body as { meta?: { status?: unknown } } | null)?.meta?.status);
  const failed = errorForStatus(status) ? status : metaStatus && errorForStatus(metaStatus) ? metaStatus : null;
  if (failed) return { ok: false, error: errorForStatus(failed)!, status: failed };
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return { ok: false, error: "bad-response", status };
  const seen = new Set<string>();
  const gifs: Gif[] = [];
  for (const raw of data) {
    const gif = raw && typeof raw === "object" ? parseGif(raw as RawGif) : null;
    // Item ids must be unique; GIPHY occasionally repeats a GIF.
    if (gif && !seen.has(gif.id)) {
      seen.add(gif.id);
      gifs.push(gif);
    }
  }
  return { ok: true, gifs };
}

/** "1.2 MB", "340 KB". */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1000))} KB`;
}

/** Markdown that shows the GIF inline: ![title](url). */
export function gifMarkdown(gif: Gif): string {
  return `![${gif.title.replace(/([\\[\]])/g, "\\$1")}](${gif.gifUrl})`;
}

/** Cache key for a query: case and spacing don't change GIPHY's results. */
export function queryKey(query: string): string {
  return query.trim().replace(/\s+/g, " ").toLowerCase();
}
