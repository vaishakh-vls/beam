// Parses playerctl output for Spotify and formats track times. No Electron here, so it can be tested.

/** Fields separated by tabs; the last three never contain one, so they are read from the end. */
export const METADATA_FORMAT = [
  "{{title}}",
  "{{artist}}",
  "{{album}}",
  "{{mpris:artUrl}}",
  "{{mpris:length}}",
  "{{xesam:url}}",
].join("\t");

export type PlaybackStatus = "Playing" | "Paused" | "Stopped";
export type LoopStatus = "None" | "Playlist" | "Track";

export interface Track {
  title: string;
  artist: string;
  album: string;
  /** An https URL on i.scdn.co, or undefined. */
  artUrl?: string;
  /** Length in seconds, or undefined when the player does not say. */
  length?: number;
  /** The track's open.spotify.com link. */
  url?: string;
}

export function parseMetadata(stdout: string): Track | null {
  const line = stdout.replace(/\r?\n$/, "");
  if (!line.trim()) return null;
  const parts = line.split("\t");
  if (parts.length < 6) return null;
  const [url, length, artUrl] = [parts.pop()!, parts.pop()!, parts.pop()!];
  // A tab inside a title would add parts; artist and album keep their places from the end.
  const album = parts.pop()!;
  const artist = parts.pop()!;
  const title = parts.join("\t");
  if (!title.trim()) return null;
  const micros = Number(length);
  return {
    title: title.trim(),
    artist: artist.trim(),
    album: album.trim(),
    artUrl: normalizeArtUrl(artUrl),
    length: length.trim() && Number.isFinite(micros) && micros > 0 ? micros / 1e6 : undefined,
    url: /^https:\/\/open\.spotify\.com\//.test(url.trim()) ? url.trim() : undefined,
  };
}

/**
 * Older Spotify builds report art as open.spotify.com/image/<id>, which
 * redirects to i.scdn.co. Beam's CSP allows i.scdn.co only, so rewrite it.
 */
export function normalizeArtUrl(raw: string): string | undefined {
  const url = raw.trim();
  const legacy = url.match(/^https?:\/\/open\.spotify\.com\/image\/([\w-]+)$/);
  if (legacy) return `https://i.scdn.co/image/${legacy[1]}`;
  return /^https:\/\/i\.scdn\.co\//.test(url) ? url : undefined;
}

export function parseStatus(stdout: string): PlaybackStatus | null {
  const value = stdout.trim();
  return value === "Playing" || value === "Paused" || value === "Stopped" ? value : null;
}

/** `playerctl position` prints seconds, e.g. "83.512000". */
export function parsePosition(stdout: string): number | null {
  const value = Number(stdout.trim());
  return stdout.trim() && Number.isFinite(value) && value >= 0 ? value : null;
}

/** `playerctl volume` prints 0.0 to 1.0; returns a whole percentage. */
export function parseVolume(stdout: string): number | null {
  const value = Number(stdout.trim());
  return stdout.trim() && Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
}

export function parseShuffle(stdout: string): boolean | null {
  const value = stdout.trim().toLowerCase();
  if (value === "on" || value === "true") return true;
  if (value === "off" || value === "false") return false;
  return null;
}

export function parseLoop(stdout: string): LoopStatus | null {
  const value = stdout.trim();
  return value === "None" || value === "Playlist" || value === "Track" ? value : null;
}

/** Repeat cycles like Spotify's own button: off, then the playlist, then the track. */
export function nextLoop(current: LoopStatus | null): LoopStatus {
  if (current === "Playlist") return "Track";
  if (current === "Track") return "None";
  return "Playlist";
}

export function loopLabel(loop: LoopStatus): string {
  return loop === "None" ? "Off" : loop;
}

/** Why a playerctl call failed: not installed, Spotify not running, or something else. */
export function classifyPlayerError(stderr: string): "missing" | "not-running" | "other" {
  if (/ENOENT/.test(stderr)) return "missing";
  if (/No players? (found|could handle)/i.test(stderr)) return "not-running";
  return "other";
}

/** "3:07", or "1:02:09" past an hour. */
export function formatTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** "1:23 / 3:45", or just the position when the length is unknown. */
export function formatProgress(position: number | null, length: number | undefined): string {
  if (position === null) return length ? formatTime(length) : "";
  return length ? `${formatTime(Math.min(position, length))} / ${formatTime(length)}` : formatTime(position);
}

/** Identifies a track, to notice when Next or Previous has taken effect. */
export function trackKey(track: Track | null): string {
  return track ? track.url ?? `${track.title}\u0000${track.artist}\u0000${track.album}` : "";
}

export function spotifySearchUri(query: string): string {
  return `spotify:search:${encodeURIComponent(query.trim())}`;
}

export function spotifyWebSearchUrl(query: string): string {
  return `https://open.spotify.com/search/${encodeURIComponent(query.trim())}`;
}
