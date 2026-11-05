import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HIDE, type Entry, type EntryAction, type Section, type ViewProvider } from "../entry";
import { showForm } from "../forms";
import { bestScore } from "../fuzzy";
import {
  cssFontFamily,
  FC_FORMAT,
  fontDetails,
  fontIconSvg,
  fontPreviewSvg,
  parseFcList,
  splitPreviewQuery,
  type FontFamily,
} from "../fonts";
import { copyText, launchDetached, notify, revealInFolder, runCapture } from "../system";
import { themeTextColors } from "./themes";
import type { RunResult } from "../../shared/types";

const USER_FONTS = path.join(os.homedir(), ".local", "share", "fonts");
/** Typing filters one fc-list snapshot; a newly installed font shows up within a minute, or at once via Install. */
const CACHE_MS = 60_000;
const FONT_FILE = /\.(ttf|otf|ttc|otc)$/i;

let cache: { at: number; families: FontFamily[] } | null = null;

async function families(): Promise<FontFamily[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.families;
  const { code, stdout, stderr } = await runCapture("fc-list", ["--format", FC_FORMAT], { timeoutMs: 20_000 });
  if (code !== 0) throw new Error(stderr.trim() || `fc-list failed with code ${code}`);
  cache = { at: Date.now(), families: parseFcList(stdout, os.homedir()) };
  return cache.families;
}

let fontViewer: boolean | null = null;

/** GNOME Fonts is preinstalled on Ubuntu but optional. */
function hasFontViewer(): boolean {
  fontViewer ??= (process.env.PATH ?? "").split(":").some((dir) => dir && fs.existsSync(path.join(dir, "gnome-font-viewer")));
  return fontViewer;
}

function fontActions(family: FontFamily): EntryAction[] {
  const file = family.files[0];
  const actions: EntryAction[] = [
    { id: "copy-name", title: "Copy Family Name", shortcut: "↵", run: () => (copyText(family.name), HIDE) },
    { id: "copy-css", title: "Copy CSS font-family", shortcut: "Ctrl+↵", run: () => (copyText(cssFontFamily(family)), HIDE) },
    { id: "reveal", title: "Show Font File in Folder", shortcut: "Ctrl+Shift+F", run: () => (revealInFolder(file), HIDE) },
  ];
  if (hasFontViewer()) {
    actions.push({
      id: "open-viewer",
      title: "Open in GNOME Fonts",
      shortcut: "Ctrl+O",
      run: () => (launchDetached("gnome-font-viewer", [file]), HIDE),
    });
  }
  actions.push(
    {
      id: "copy-path",
      title: "Copy File Path",
      shortcut: "Ctrl+Shift+C",
      run: () => {
        copyText(file);
        return { type: "stay", toast: "Path copied" };
      },
    },
    { id: "install", title: "Install Font File…", shortcut: "Ctrl+Shift+I", run: openInstallForm },
  );
  return actions;
}

function fontKeywords(family: FontFamily): string[] {
  return [
    ...(family.mono ? ["monospace", "mono", "code"] : []),
    ...(family.variable ? ["variable"] : []),
    ...(family.location !== "system" ? ["user", "installed", "my fonts"] : []),
  ];
}

function fontEntry(family: FontFamily, colors: { text: string; dim: string }, custom: string | null): Entry {
  const kind = [family.mono ? "Monospace" : "", family.variable ? "Variable" : ""].filter(Boolean);
  return {
    id: `font:${family.name}`,
    title: family.name,
    subtitle: kind.join(" · "),
    icon: fontIconSvg(family, colors.text),
    accessory: family.styles.length === 1 ? "1 style" : `${family.styles.length} styles`,
    previewImage: fontPreviewSvg(family, colors, custom),
    preview: fontDetails(family),
    keywords: fontKeywords(family),
    actions: fontActions(family),
  };
}

/** Font files from a path: the file itself, or those in a folder and its subfolders. */
function fontFilesAt(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) return FONT_FILE.test(target) ? [target] : [];
  const found: string[] = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && FONT_FILE.test(entry.name)) found.push(path.join(entry.parentPath, entry.name));
  }
  return found;
}

async function installFonts(input: string): Promise<RunResult> {
  // Accept what file managers and terminals paste: file:// URIs and quoted paths.
  let typed = input.trim().replace(/^(['"])(.*)\1$/, "$2");
  if (typed.startsWith("file://")) typed = decodeURIComponent(typed.slice(7));
  const target = path.resolve(typed.replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(target)) return { type: "error", message: `Not found: ${target}` };
  const files = fontFilesAt(target);
  if (!files.length) return { type: "error", message: "No .ttf, .otf or .ttc files there." };
  fs.mkdirSync(USER_FONTS, { recursive: true });
  for (const file of files) {
    // Already in the fonts folder: fc-cache below is all it needs.
    if (!file.startsWith(USER_FONTS + path.sep)) fs.copyFileSync(file, path.join(USER_FONTS, path.basename(file)));
  }
  const { code, stderr } = await runCapture("fc-cache", ["-f", USER_FONTS], { timeoutMs: 60_000 });
  cache = null;
  if (code !== 0) return { type: "error", message: `Copied, but fc-cache failed: ${stderr.trim()}` };
  notify(files.length === 1 ? `Installed ${path.basename(files[0])}` : `Installed ${files.length} font files`, `In ${USER_FONTS}`);
  return { type: "view", view: "fonts" };
}

function openInstallForm(): RunResult {
  return showForm(
    {
      title: "Install Font File",
      submitLabel: "Install",
      fields: [
        {
          name: "path",
          label: "Font file or folder",
          type: "text",
          placeholder: "~/Downloads/Inter.ttf",
          hint: `.ttf, .otf or .ttc files are copied to ${USER_FONTS.replace(os.homedir(), "~")}, just for you.`,
        },
      ],
    },
    (values) => (values.path.trim() ? installFonts(values.path) : { type: "error", message: "Enter a file or folder." }),
  );
}

export const fontsView: ViewProvider = {
  info: {
    title: "Fonts",
    placeholder: "Search fonts, or type \"text to preview it…",
    preview: true,
    grid: false,
  },
  async sections(query): Promise<Section[]> {
    let all: FontFamily[];
    try {
      all = await families();
    } catch (error) {
      return [
        {
          title: "Fonts",
          entries: [{ id: "font:error", title: "Could not list fonts", subtitle: (error as Error).message, icon: "⚠️", actions: [] }],
        },
      ];
    }
    const { text, filter } = splitPreviewQuery(query);
    const colors = themeTextColors();
    const matching = filter
      ? all
          .map((family) => ({ family, score: bestScore(filter, [family.name, ...fontKeywords(family)]) }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .map(({ family }) => family)
      : all;
    const mine = matching.filter((f) => f.location !== "system").map((f) => fontEntry(f, colors, text));
    const system = matching.filter((f) => f.location === "system").map((f) => fontEntry(f, colors, text));
    const install: Entry = {
      id: "font:install",
      title: "Install Font File…",
      subtitle: "Add a .ttf, .otf or .ttc file for your account",
      icon: "➕",
      keywords: ["install", "add", "font file"],
      actions: [{ id: "install", title: "Install Font File…", shortcut: "↵", run: openInstallForm }],
    };
    const showInstall = !filter || bestScore(filter, [install.title, ...(install.keywords ?? [])]) > 0;
    return [
      { title: `Your Fonts · ${mine.length}`, entries: mine },
      { title: `System Fonts · ${system.length}`, entries: system },
      { title: "Add Fonts", entries: showInstall ? [install] : [] },
    ];
  },
};

export function fontsCommands(_hide: () => void): Entry[] {
  return [
    {
      id: "cmd:fonts",
      ref: "cmd:fonts",
      title: "Search Fonts",
      subtitle: "Fonts",
      icon: "🔤",
      accessory: "Command",
      keywords: ["font", "fonts", "typeface", "typography", "monospace", "fc-list", "font viewer"],
      actions: [{ id: "run", title: "Run Command", shortcut: "↵", run: () => ({ type: "view", view: "fonts" }) }],
    },
  ];
}
