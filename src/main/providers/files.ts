import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { config } from "../config";
import { HIDE, type Entry } from "../entry";
import { fuzzyScore } from "../fuzzy";
import { copyText, openPath, revealInFolder } from "../system";

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

interface FileRecord {
  name: string;
  path: string;
  isDir: boolean;
}

let index: FileRecord[] = [];
let indexing = false;

async function walk(dir: string, depth: number, out: FileRecord[]): Promise<void> {
  if (out.length >= MAX_ENTRIES) return;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    const isDir = entry.isDirectory();
    out.push({ name: entry.name, path: full, isDir });
    if (isDir && depth > 0 && !SKIP_DIRS.has(entry.name)) subdirs.push(full);
    if (out.length >= MAX_ENTRIES) return;
  }
  for (const sub of subdirs) await walk(sub, depth - 1, out);
}

export async function rebuildFileIndex(): Promise<void> {
  if (indexing) return;
  indexing = true;
  try {
    const home = os.homedir();
    const next: FileRecord[] = [];
    for (const root of config().fileSearchRoots) {
      await walk(path.resolve(home, root), config().fileSearchMaxDepth, next);
    }
    index = next;
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
  const scored: Array<{ record: FileRecord; score: number }> = [];
  for (const record of index) {
    const score = fuzzyScore(q, record.name);
    // Loose subsequence matches on file names are mostly noise.
    if (score >= 300) scored.push({ record, score });
  }
  scored.sort((a, b) => b.score - a.score || a.record.path.length - b.record.path.length);
  return scored.slice(0, limit).map(({ record }) => fileEntry(record));
}

function fileEntry(record: FileRecord): Entry {
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
