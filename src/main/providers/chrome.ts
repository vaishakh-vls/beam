import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HISTORY_SCRIPT,
  displayUrl,
  flattenBookmarks,
  isOpenableUrl,
  lastUsedProfile,
  markdownLink,
  parseHistoryRows,
  relativeTime,
  searchBookmarks,
  type Bookmark,
  type HistoryItem,
} from "../chrome";
import { HIDE, type Entry, type ViewProvider } from "../entry";
import { appIconUrl } from "./apps";
import { copyText, launchDetached, runCapture, truncate } from "../system";
import type { RunResult } from "../../shared/types";

const CHROME_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "google-chrome");
/** Typing re-queries the same copy; Chrome's live file is copied again after this long. */
const HISTORY_COPY_TTL_MS = 30_000;
const HISTORY_LIMIT = 30;
const BOOKMARK_LIMIT = 20;
/** With an empty query the whole list is shown, up to this many. */
const ALL_BOOKMARKS_LIMIT = 200;

// Parsed files, re-read only when their mtime changes.
const fileCache = new Map<string, { mtimeMs: number; value: unknown }>();

function readCached<T>(file: string, parse: (text: string) => T, fallback: T): T {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return fallback;
  }
  const hit = fileCache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.value as T;
  let value = fallback;
  try {
    value = parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`beam: could not read ${file}:`, error);
  }
  fileCache.set(file, { mtimeMs, value });
  return value;
}

/** The profile folder name Chrome used last, e.g. "Default". */
function profileName(): string {
  return readCached(path.join(CHROME_DIR, "Local State"), lastUsedProfile, "Default");
}

function bookmarks(profileDir: string): Bookmark[] {
  return readCached(path.join(profileDir, "Bookmarks"), flattenBookmarks, []);
}

function chrome(...args: string[]): void {
  launchDetached("google-chrome", [`--profile-directory=${profileName()}`, ...args]);
}

// History is locked while Chrome runs, so queries read a private copy.
let historyCopy: { source: string; path: string; at: number } | null = null;
let copying: Promise<string> | null = null;
let cleanupRegistered = false;

function copyPath(): string {
  const dir = path.join(process.env.XDG_RUNTIME_DIR || os.tmpdir(), "beam");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return path.join(dir, "chrome-history.sqlite");
}

/** Chrome uses a rollback journal today and may use WAL; copy whichever exists. */
const SIDE_FILES = ["-journal", "-wal"];

async function copyHistory(source: string): Promise<string> {
  const dest = copyPath();
  // A stale journal or WAL from an earlier copy would be replayed into this one.
  for (const suffix of ["", ...SIDE_FILES, "-shm"]) await fsp.rm(dest + suffix, { force: true });
  for (const suffix of ["", ...SIDE_FILES]) {
    if (suffix && !fs.existsSync(source + suffix)) continue;
    await fsp.copyFile(source + suffix, dest + suffix);
    await fsp.chmod(dest + suffix, 0o600);
  }
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once("exit", () => {
      for (const suffix of ["", ...SIDE_FILES, "-shm"]) fs.rmSync(dest + suffix, { force: true });
    });
  }
  historyCopy = { source, path: dest, at: Date.now() };
  return dest;
}

function historyDb(source: string): Promise<string> {
  if (historyCopy && historyCopy.source === source && Date.now() - historyCopy.at < HISTORY_COPY_TTL_MS) {
    return Promise.resolve(historyCopy.path);
  }
  copying ??= copyHistory(source).finally(() => {
    copying = null;
  });
  return copying;
}

async function searchHistory(profileDir: string, query: string): Promise<{ items: HistoryItem[]; error?: string }> {
  const source = path.join(profileDir, "History");
  if (!fs.existsSync(source)) return { items: [] };
  try {
    const db = await historyDb(source);
    const { code, stdout, stderr } = await runCapture("python3", ["-I", "-c", HISTORY_SCRIPT, db, query, String(HISTORY_LIMIT)], {
      timeoutMs: 5000,
    });
    if (code !== 0) throw new Error(stderr.trim().split("\n").pop() || `python3 exited with ${code}`);
    return { items: parseHistoryRows(stdout).filter((item) => isOpenableUrl(item.url)) };
  } catch (error) {
    // Possibly copied mid-write; copy afresh next time.
    historyCopy = null;
    console.error("beam: Chrome history search failed:", error);
    return { items: [], error: (error as Error).message };
  }
}

function pageEntry(id: string, title: string, url: string, subtitle: string, icon: string, accessory: string): Entry {
  return {
    id,
    title: truncate(title, 120),
    subtitle,
    icon,
    accessory,
    actions: [
      {
        id: "open",
        title: "Open in Chrome",
        shortcut: "↵",
        run: () => {
          chrome(url);
          return HIDE;
        },
      },
      {
        id: "incognito",
        title: "Open in Incognito Window",
        shortcut: "Ctrl+↵",
        run: () => {
          chrome("--incognito", url);
          return HIDE;
        },
      },
      {
        id: "copy-url",
        title: "Copy URL",
        shortcut: "Ctrl+Shift+C",
        run: () => {
          copyText(url);
          return { type: "stay", toast: "URL copied" };
        },
      },
      {
        id: "copy-markdown",
        title: "Copy as Markdown Link",
        shortcut: "Ctrl+Shift+M",
        run: () => {
          copyText(markdownLink(title, url));
          return { type: "stay", toast: "Markdown link copied" };
        },
      },
    ],
  };
}

function bookmarkEntry(bookmark: Bookmark): Entry {
  const host = displayUrl(bookmark.url).split("/")[0];
  return pageEntry(`chrome:bookmark:${bookmark.id}`, bookmark.title, bookmark.url, bookmark.folder, "⭐", host);
}

function historyEntry(item: HistoryItem): Entry {
  return pageEntry(
    `chrome:history:${item.id}`,
    item.title,
    item.url,
    truncate(displayUrl(item.url), 90),
    "🕘",
    relativeTime(item.lastVisit),
  );
}

function notice(id: string, title: string, subtitle: string): Entry {
  return { id: `chrome:${id}`, title, subtitle, icon: "⚠️", actions: [] };
}

function chromeAction(args: string[]): () => RunResult {
  return () => {
    chrome(...args);
    return HIDE;
  };
}

export function chromeCommands(_hide: () => void): Entry[] {
  const logo = appIconUrl("Google Chrome");
  const command = (name: string, title: string, icon: string, keywords: string[], run: () => RunResult): Entry => ({
    id: `cmd:${name}`,
    ref: `cmd:${name}`,
    title,
    subtitle: "Google Chrome",
    app: "Google Chrome",
    icon: logo ?? icon,
    accessory: "Command",
    keywords,
    actions: [{ id: "run", title: "Run Command", shortcut: "↵", run }],
  });
  return [
    command("chrome-search", "Search Chrome", "🌐", ["bookmarks", "history", "browser", "tabs", "google chrome"], () => ({
      type: "view",
      view: "chrome",
    })),
    command("chrome-new-tab", "New Chrome Tab", "🌐", ["browser", "google chrome", "open", "tab"], chromeAction(["chrome://newtab"])),
    command("chrome-new-window", "New Chrome Window", "🌐", ["browser", "google chrome", "open"], chromeAction(["--new-window"])),
    command("chrome-new-incognito", "New Incognito Window", "🕶️", ["browser", "google chrome", "private"], chromeAction(["--incognito"])),
  ];
}

export const chromeView: ViewProvider = {
  info: {
    title: "Google Chrome",
    placeholder: "Search Chrome bookmarks and history…",
    preview: false,
    grid: false,
  },
  async sections(query) {
    const q = query.trim();
    const profileDir = path.join(CHROME_DIR, profileName());
    if (!fs.existsSync(profileDir)) {
      return [{ title: "Google Chrome", entries: [notice("missing", "No Chrome Profile Found", `Looked in ${profileDir}`)] }];
    }
    const all = bookmarks(profileDir).filter((bookmark) => isOpenableUrl(bookmark.url));
    const history = await searchHistory(profileDir, q);
    const historyNotice = history.error ? [notice("history-error", "Couldn't Read Chrome History", history.error)] : [];

    if (!q) {
      return [
        { title: "Recent History", entries: [...historyNotice, ...history.items.map(historyEntry)] },
        { title: "Bookmarks", entries: all.slice(0, ALL_BOOKMARKS_LIMIT).map(bookmarkEntry) },
      ];
    }
    const matched = searchBookmarks(all, q, BOOKMARK_LIMIT);
    // A bookmarked page is listed once, as the bookmark.
    const bookmarked = new Set(matched.map((bookmark) => bookmark.url));
    return [
      { title: "Bookmarks", entries: matched.map(bookmarkEntry) },
      {
        title: "History",
        entries: [...historyNotice, ...history.items.filter((item) => !bookmarked.has(item.url)).map(historyEntry)],
      },
    ];
  },
};
