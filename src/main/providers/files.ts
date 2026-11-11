import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../config";
import { HIDE, type Entry } from "../entry";
import { FileIndex, FileIndexBuilder, type FileHit } from "../fileindex";
import { fuzzyScore } from "../fuzzy";
import { copyText, openPath, revealInFolder } from "../system";
import { convertFileAction } from "./convert";
import { openWithAction, quickLookAction } from "./openwith";

const SKIP_DIRS = new Set([
  "node_modules",
  "__pycache__",
  "venv",
  "site-packages",
  "dist",
  "build",
  "target",
  "snap",
]);
const MAX_ENTRIES = 80_000;
const REFRESH_MS = 10 * 60 * 1000;

let index = FileIndex.empty();
let indexing = false;

async function walk(dir: string, depth: number, out: FileIndexBuilder): Promise<void> {
  if (out.size >= MAX_ENTRIES) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const folder = out.addFolder(dir);
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const isDir = entry.isDirectory();
    out.add(folder, entry.name, isDir);
    if (isDir && depth > 0 && !SKIP_DIRS.has(entry.name)) subdirs.push(path.join(dir, entry.name));
    if (out.size >= MAX_ENTRIES) break;
  }
  for (const sub of subdirs) await walk(sub, depth - 1, out);
}

export async function rebuildFileIndex(): Promise<void> {
  if (indexing) return;
  indexing = true;
  try {
    const home = os.homedir();
    const next = new FileIndexBuilder();
    for (const root of config().fileSearchRoots) {
      await walk(path.resolve(home, root), config().fileSearchMaxDepth, next);
    }
    index = next.build();
  } finally {
    indexing = false;
  }
}

export function startFileIndexer(): void {
  void rebuildFileIndex();
  setInterval(() => void rebuildFileIndex(), REFRESH_MS).unref();
}

function displayPath(full: string): string {
  const home = os.homedir();
  return full.startsWith(home) ? "~" + full.slice(home.length) : full;
}

/** Ranked file matches; only file names are matched, like Raycast. */
export function searchFiles(query: string, limit: number): Entry[] {
  const q = query.trim();
  if (q.length < 2) return [];
  const scored: Array<{ record: FileHit; score: number }> = [];
  // Loose subsequence matches on file names are mostly noise, so only
  // names containing the query are scored.
  for (const id of index.containing(q.toLowerCase())) {
    const score = fuzzyScore(q, index.name(id));
    if (score >= 300) scored.push({ record: index.hit(id), score });
  }
  scored.sort((a, b) => b.score - a.score || a.record.path.length - b.record.path.length);
  return scored.slice(0, limit).map(({ record }) => fileEntry(record));
}

function fileEntry(record: FileHit): Entry {
  return {
    id: `file:${record.path}`,
    title: record.name,
    subtitle: displayPath(path.dirname(record.path)),
    icon: record.isDir ? "📁" : fileEmoji(record.name),
    accessory: record.isDir ? "Folder" : "File",
    actions: [
      {
        id: "open",
        title: record.isDir ? "Open Folder" : "Open File",
        shortcut: "↵",
        run: () => {
          openPath(record.path);
          return HIDE;
        },
      },
      {
        id: "reveal",
        title: "Show in Folder",
        shortcut: "Ctrl+↵",
        run: () => {
          revealInFolder(record.path);
          return HIDE;
        },
      },
      quickLookAction(record.path),
      openWithAction(record.path),
      ...(record.isDir ? [] : [convertFileAction(record.path)].filter((action) => action !== null)),
      {
        id: "copy-path",
        title: "Copy Path",
        shortcut: "Ctrl+Shift+C",
        run: () => {
          copyText(record.path);
          return { type: "stay", toast: "Path copied" };
        },
      },
    ],
  };
}

function fileEmoji(name: string): string {
  const ext = path.extname(name).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"].includes(ext)) return "🖼️";
  if ([".pdf"].includes(ext)) return "📕";
  if ([".md", ".txt", ".docx", ".odt"].includes(ext)) return "📝";
  if ([".xlsx", ".csv", ".ods"].includes(ext)) return "📊";
  if ([".zip", ".tar", ".gz", ".xz", ".7z"].includes(ext)) return "🗜️";
  if ([".mp4", ".mkv", ".mov", ".webm"].includes(ext)) return "🎬";
  if ([".mp3", ".wav", ".flac", ".ogg"].includes(ext)) return "🎵";
  return "📄";
}
