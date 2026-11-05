import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ipcMain, type BrowserWindow } from "electron";
import { config, CONFIG_DIR, saveConfig } from "../config";
import { HIDE, type Entry, type EntryAction, type Section, type ViewProvider } from "../entry";
import { showForm } from "../forms";
import { bestScore } from "../fuzzy";
import { notify, openPath, revealInFolder, runCapture } from "../system";
import {
  appliedTheme,
  BUILTIN_THEMES,
  parseColorScheme,
  parseUserTheme,
  resolveTheme,
  SYSTEM_PAIR,
  SYSTEM_THEME_ID,
  themeDetails,
  themeFileText,
  themeIconSvg,
  themePreviewSvg,
  themeSlug,
  USER_THEME_PREFIX,
  type Appearance,
  type Theme,
} from "../themes";
import type { RunResult } from "../../shared/types";

export const THEMES_DIR = path.join(CONFIG_DIR, "themes");

/** Renderer channels: it asks for the theme once at startup, then Beam pushes changes. */
const GET_CHANNEL = "beam:get-theme";
const PUSH_CHANNEL = "beam:theme";

let getWindow: () => BrowserWindow | null = () => null;
let systemScheme: Appearance = "dark";
let schemeReadAt = 0;
let lastSent = "";

interface BrokenTheme {
  id: string;
  file: string;
  error: string;
}

function userThemeFiles(): string[] {
  try {
    return fs.readdirSync(THEMES_DIR).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
}

function loadUserTheme(name: string): Theme | BrokenTheme {
  const file = path.join(THEMES_DIR, name);
  const id = name.replace(/\.json$/, "");
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return { id, file, error: (error as Error).message };
  }
  const parsed = parseUserTheme(text, id, file);
  return "error" in parsed ? { id, file, error: parsed.error } : parsed;
}

const isTheme = (t: Theme | BrokenTheme): t is Theme => !("error" in t);

/** The chosen theme. A user theme's file is read each time, so edits show on the next open. */
export function currentTheme(): Theme {
  const id = config().theme;
  const user = id.startsWith(USER_THEME_PREFIX) ? loadUserTheme(`${id.slice(USER_THEME_PREFIX.length)}.json`) : null;
  return resolveTheme(id, user && isTheme(user) ? [user] : [], systemScheme);
}

/** Colors for images drawn in the current theme, such as font samples and the battery gauge. */
export function themeTextColors(): { text: string; dim: string; accent: string } {
  const { vars } = currentTheme();
  return { text: vars["--text"], dim: vars["--text-dim"], accent: vars["--accent"] };
}

function push(): void {
  const theme = appliedTheme(currentTheme());
  const json = JSON.stringify(theme);
  const win = getWindow();
  if (json === lastSent || !win || win.isDestroyed()) return;
  lastSent = json;
  win.webContents.send(PUSH_CHANNEL, theme);
}

async function readSystemScheme(): Promise<void> {
  schemeReadAt = Date.now();
  const { code, stdout } = await runCapture("gsettings", ["get", "org.gnome.desktop.interface", "color-scheme"], { timeoutMs: 3000 });
  if (code === 0) systemScheme = parseColorScheme(stdout);
}

/** Answers the renderer's first request and pushes the theme whenever it changes. Call once at startup. */
export function startThemes(windowGetter: () => BrowserWindow | null): void {
  getWindow = windowGetter;
  ipcMain.handle(GET_CHANNEL, () => {
    const theme = appliedTheme(currentTheme());
    lastSent = JSON.stringify(theme);
    return theme;
  });
  void readSystemScheme().then(push);
}

/**
 * Call as the window opens: picks up an edited theme file at once, and a
 * dark/light switch made while Beam was hidden a moment later.
 */
export function refreshTheme(): void {
  push();
  if (config().theme === SYSTEM_THEME_ID) void readSystemScheme().then(push);
}

function applyTheme(id: string, name: string): RunResult {
  config().theme = id;
  saveConfig();
  push();
  return { type: "stay", toast: `Theme set to ${name}` };
}

function uniqueFile(slug: string): string {
  let file = path.join(THEMES_DIR, `${slug}.json`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(THEMES_DIR, `${slug}-${n}.json`);
  return file;
}

/** Copies a theme into a new file in the themes folder, applies it and opens it for editing. */
function newThemeFrom(source: Theme): RunResult {
  return showForm(
    {
      title: `New Theme from ${source.name}`,
      submitLabel: "Create and Edit",
      fields: [
        {
          name: "name",
          label: "Name",
          type: "text",
          value: `My ${source.name.replace(/^My /, "")}`,
          hint: `Saved in ${THEMES_DIR}. Change the colors there; Beam picks them up the next time it opens.`,
        },
      ],
    },
    (values) => {
      const name = values.name.trim();
      if (!name) return { type: "error", message: "Give the theme a name." };
      fs.mkdirSync(THEMES_DIR, { recursive: true });
      const file = uniqueFile(themeSlug(name));
      fs.writeFileSync(file, themeFileText(source, name));
      applyTheme(`${USER_THEME_PREFIX}${path.basename(file, ".json")}`, name);
      openPath(file);
      notify(`Created theme ${name}`, `Edit ${file}, then open Beam to see it.`);
      return HIDE;
    },
  );
}

function openThemesFolder(): RunResult {
  fs.mkdirSync(THEMES_DIR, { recursive: true });
  openPath(THEMES_DIR);
  return HIDE;
}

function sharedActions(source: Theme): EntryAction[] {
  return [
    { id: "new", title: "New Theme from This…", shortcut: "Ctrl+N", run: () => newThemeFrom(source) },
    { id: "folder", title: "Open Themes Folder", shortcut: "Ctrl+Shift+O", run: openThemesFolder },
  ];
}

function fileActions(file: string): EntryAction[] {
  return [
    { id: "edit", title: "Edit Theme File", shortcut: "Ctrl+E", run: () => (openPath(file), HIDE) },
    { id: "reveal", title: "Show in Folder", run: () => (revealInFolder(file), HIDE) },
  ];
}

function themeEntry(theme: Theme, current: string): Entry {
  const kind = theme.appearance === "dark" ? "Dark" : "Light";
  return {
    id: `theme:${theme.id}`,
    title: theme.name,
    subtitle: theme.file ? `${kind} · ${path.basename(theme.file)}` : kind,
    icon: themeIconSvg(theme),
    accessory: theme.id === current ? "✓ Current" : undefined,
    previewImage: themePreviewSvg(theme),
    preview: themeDetails(theme),
    keywords: [kind, theme.id],
    actions: [
      { id: "apply", title: "Apply Theme", shortcut: "↵", run: () => applyTheme(theme.id, theme.name) },
      ...sharedActions(theme),
      ...(theme.file ? fileActions(theme.file) : []),
    ],
  };
}

function systemEntry(current: string): Entry {
  const shown = resolveTheme(SYSTEM_THEME_ID, [], systemScheme);
  const pair = `${BUILTIN_THEMES.find((t) => t.id === SYSTEM_PAIR.dark)!.name} or ${BUILTIN_THEMES.find((t) => t.id === SYSTEM_PAIR.light)!.name}`;
  return {
    id: "theme:system",
    title: "Follow System",
    subtitle: `${pair} with GNOME's style · now ${systemScheme === "dark" ? "Dark" : "Light"}`,
    icon: "🌓",
    accessory: current === SYSTEM_THEME_ID ? "✓ Current" : undefined,
    previewImage: themePreviewSvg(shown),
    preview: themeDetails(shown, `Follow System: ${pair}, switching with GNOME's dark style (Settings › Appearance).`),
    keywords: ["auto", "automatic", "dark mode", "light mode", "appearance", "gnome"],
    actions: [
      { id: "apply", title: "Apply Theme", shortcut: "↵", run: () => applyTheme(SYSTEM_THEME_ID, "Follow System") },
      ...sharedActions(shown),
    ],
  };
}

function brokenEntry(broken: BrokenTheme): Entry {
  return {
    id: `theme:broken:${broken.id}`,
    title: path.basename(broken.file),
    subtitle: broken.error,
    icon: "⚠️",
    preview: `${broken.file}\n\nBeam can't use this theme:\n${broken.error}`,
    actions: [...fileActions(broken.file), { id: "folder", title: "Open Themes Folder", shortcut: "Ctrl+Shift+O", run: openThemesFolder }],
  };
}

export const themesView: ViewProvider = {
  info: {
    title: "Themes",
    placeholder: "Search themes…",
    preview: true,
    grid: false,
  },
  async sections(query): Promise<Section[]> {
    // Typing filters the list; the setting is read again only when the view has been open a while.
    if (Date.now() - schemeReadAt > 2000) await readSystemScheme();
    const current = config().theme;
    const loaded = userThemeFiles().map(loadUserTheme);
    const q = query.trim();
    const keep = (e: Entry) => !q || bestScore(q, [e.title, ...(e.keywords ?? [])]) > 0;
    const create: Entry = {
      id: "theme:create",
      title: "Create a Theme…",
      subtitle: "Start from the current theme",
      icon: "➕",
      preview: [
        `Your themes are JSON files in ${THEMES_DIR.replace(os.homedir(), "~")}.`,
        "Only the colors you change are needed; the rest come from Beam Dark or Beam Light.",
        "Beam reads a theme again each time it opens, so edits show right away.",
        "",
        themeFileText(currentTheme(), "My Theme").trim(),
        "",
        "Colors: background, text, accent, elevated, selected, dim, faint, danger (hex, #rrggbbaa for transparency).",
        "vars: any of Beam's CSS variables, such as --radius.",
      ].join("\n"),
      keywords: ["new", "custom", "make"],
      actions: [
        { id: "new", title: "New Theme from Current…", shortcut: "↵", run: () => newThemeFrom(currentTheme()) },
        { id: "folder", title: "Open Themes Folder", shortcut: "Ctrl+Shift+O", run: openThemesFolder },
      ],
    };
    return [
      { title: "Appearance", entries: [systemEntry(current)].filter(keep) },
      { title: "Built-in", entries: BUILTIN_THEMES.map((t) => themeEntry(t, current)).filter(keep) },
      {
        title: "Your Themes",
        entries: [
          ...loaded.map((t) => (isTheme(t) ? themeEntry(t, current) : brokenEntry(t))),
          create,
        ].filter(keep),
      },
    ];
  },
};

export function themesCommands(_hide: () => void): Entry[] {
  return [
    {
      id: "cmd:themes",
      ref: "cmd:themes",
      title: "Change Beam Theme",
      subtitle: "Themes",
      icon: "🎨",
      accessory: "Command",
      keywords: [
        "theme", "theming", "appearance", "colors", "dark", "light", "catppuccin", "nord", "tokyo night",
        "gruvbox", "dracula", "rose pine",
      ],
      actions: [{ id: "run", title: "Run Command", shortcut: "↵", run: () => ({ type: "view", view: "themes" }) }],
    },
  ];
}
