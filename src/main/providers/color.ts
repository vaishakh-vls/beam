import path from "node:path";
import { app } from "electron";
import {
  addToHistory,
  ageLabel,
  colorDetails,
  parseColor,
  parsePickerOutput,
  swatchUrl,
  toHex,
  toHslString,
  toOklchString,
  toRgbString,
  type Rgb,
  type SavedColor,
} from "../color";
import { HIDE, type Entry, type EntryAction, type Section, type ViewProvider } from "../entry";
import { JsonStore } from "../store";
import { copyText, notify, runCapture } from "../system";

const HISTORY_SIZE = 50;
/** The helper gives up after five minutes; Beam waits a little longer. */
const PICK_TIMEOUT_MS = 310_000;
const PICKED = 0;
const CANCELLED = 3;

let store: JsonStore<{ colors: SavedColor[] }> | null = null;
let picking = false;

function history(): JsonStore<{ colors: SavedColor[] }> {
  store ??= new JsonStore("colors.json", () => ({ colors: [] }));
  if (!Array.isArray(store.data.colors)) store.data = { colors: [] };
  return store;
}

function saveColor(hex: string): void {
  history().data.colors = addToHistory(history().data.colors, hex, Date.now(), HISTORY_SIZE);
  history().save();
}

function helperPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "beam-pick-color")
    : path.join(app.getAppPath(), "packaging", "beam-pick-color");
}

/** Runs the portal picker, then copies, announces and saves the color. */
async function pickColor(): Promise<void> {
  if (picking) return;
  picking = true;
  try {
    const { code, stdout, stderr } = await runCapture("python3", ["-I", helperPath()], { timeoutMs: PICK_TIMEOUT_MS });
    if (code === CANCELLED) return;
    const color = code === PICKED ? parsePickerOutput(stdout) : null;
    if (!color) {
      notify("Could not pick a color", (stderr || stdout).trim().slice(0, 200));
      return;
    }
    const hex = toHex(color);
    copyText(hex);
    saveColor(hex);
    notify(`Copied ${hex}`, `${toRgbString(color)}  ·  ${toHslString(color)}`);
  } finally {
    picking = false;
  }
}

function pickAction(hide: () => void): EntryAction {
  return {
    id: "pick",
    title: "Pick Color",
    shortcut: "↵",
    run: () => {
      hide();
      // Let Beam's window disappear before the picker takes over the screen.
      setTimeout(() => void pickColor(), 150);
      return HIDE;
    },
  };
}

function copyAction(id: string, title: string, text: string): EntryAction {
  return {
    id,
    title,
    run: () => {
      copyText(text);
      return HIDE;
    },
  };
}

/** Copy actions in the given order; the first runs on Enter, the second on Ctrl+Enter. */
function copyActions(color: Rgb, first: "hex" | "rgb" = "hex"): EntryAction[] {
  const hex = copyAction("copy-hex", "Copy HEX", toHex(color));
  const rgb = copyAction("copy-rgb", "Copy RGB", toRgbString(color));
  const ordered = first === "hex" ? [hex, rgb] : [rgb, hex];
  return [
    { ...ordered[0], shortcut: "↵" },
    { ...ordered[1], shortcut: "Ctrl+↵" },
    { ...copyAction("copy-hsl", "Copy HSL", toHslString(color)), shortcut: "Ctrl+H" },
    { ...copyAction("copy-oklch", "Copy OKLCH", toOklchString(color)), shortcut: "Ctrl+O" },
  ];
}

function saveAction(color: Rgb): EntryAction {
  return {
    id: "save",
    title: "Save to History",
    shortcut: "Ctrl+S",
    run: () => {
      const hex = toHex(color);
      saveColor(hex);
      return { type: "stay", toast: `Saved ${hex} to Color History` };
    },
  };
}

function smallSwatch(color: Rgb): string {
  return swatchUrl(color, 22, 22, 6);
}

function largeSwatch(color: Rgb): string {
  return swatchUrl(color, 320, 140, 12);
}

export function colorCommands(hide: () => void): Entry[] {
  return [
    {
      id: "cmd:pick-color",
      ref: "cmd:pick-color",
      title: "Pick Color",
      subtitle: "Color Picker",
      icon: "🎨",
      accessory: "Command",
      keywords: ["color picker", "eyedropper", "colour", "hex", "screen color"],
      actions: [{ ...pickAction(hide), id: "run", title: "Run Command" }],
    },
    {
      id: "cmd:color-history",
      ref: "cmd:color-history",
      title: "Color History",
      subtitle: "Color Picker",
      icon: "🌈",
      accessory: "Command",
      keywords: ["colors", "colour", "picked colors", "hex", "rgb", "hsl"],
      actions: [{ id: "run", title: "Run Command", shortcut: "↵", run: () => ({ type: "view", view: "colors" }) }],
    },
  ];
}

/** Root search: a typed "#f80", "rgb(…)" or "hsl(…)" becomes a conversion. */
export function colorEntry(query: string): Entry | null {
  const q = query.trim();
  // Only explicit color syntax counts, never bare numbers or words.
  if (!/^(#|rgba?\(|hsla?\()/i.test(q)) return null;
  const color = parseColor(q);
  if (!color) return null;
  const fromHex = q.startsWith("#");
  const title = fromHex ? toRgbString(color) : toHex(color);
  return {
    id: "color:convert",
    title,
    subtitle: [toHex(color), toRgbString(color), toHslString(color)].filter((s) => s !== title).join("  ·  "),
    icon: smallSwatch(color),
    accessory: "Color",
    actions: [...copyActions(color, fromHex ? "rgb" : "hex"), saveAction(color)],
  };
}

function historyEntry(saved: SavedColor, color: Rgb, now: number): Entry {
  const hex = toHex(color);
  return {
    id: `color:${hex}`,
    title: hex,
    subtitle: toRgbString(color),
    icon: smallSwatch(color),
    accessory: ageLabel(saved.savedAt, now),
    preview: colorDetails(color),
    previewImage: largeSwatch(color),
    actions: [
      ...copyActions(color),
      {
        id: "delete",
        title: "Delete Color",
        shortcut: "Ctrl+D",
        danger: true,
        run: () => {
          history().data.colors = history().data.colors.filter((c) => c.hex !== saved.hex);
          history().save();
          return { type: "stay", toast: `Deleted ${hex}` };
        },
      },
      {
        id: "clear",
        title: "Clear History",
        shortcut: "Ctrl+Shift+D",
        danger: true,
        run: () => {
          history().data.colors = [];
          history().saveNow();
          return { type: "stay", toast: "Color history cleared" };
        },
      },
    ],
  };
}

export const colorView: ViewProvider = {
  info: {
    title: "Color History",
    placeholder: "Filter colors, or type #hex, rgb() or hsl()…",
    preview: true,
    grid: false,
  },
  sections(query, hide) {
    const q = query.trim().toLowerCase();
    const sections: Section[] = [];

    const typed = q ? parseColor(q, { bareHex: true }) : null;
    if (typed) {
      sections.push({
        title: "Typed Color",
        entries: [
          {
            id: "color:typed",
            title: toHex(typed),
            subtitle: toRgbString(typed),
            icon: smallSwatch(typed),
            preview: colorDetails(typed),
            previewImage: largeSwatch(typed),
            actions: [...copyActions(typed), saveAction(typed)],
          },
        ],
      });
    }

    if (!q) {
      sections.push({
        title: "Pick",
        entries: [
          {
            id: "color:pick",
            title: "Pick Color",
            subtitle: "From anywhere on the screen",
            icon: "🎨",
            preview: "Click anywhere on the screen to pick its color.\nPress Esc to cancel.\n\nThe color is copied as HEX and saved here.",
            actions: [pickAction(hide)],
          },
        ],
      });
    }

    const now = Date.now();
    const needle = q.replace(/^#/, "");
    const entries: Entry[] = [];
    for (const saved of history().data.colors) {
      // The file is hand-editable; skip anything that is not a color.
      const color = typeof saved?.hex === "string" ? parseColor(saved.hex) : null;
      if (!color) continue;
      const haystack = `${toHex(color)} ${toRgbString(color)} ${toHslString(color)}`.toLowerCase();
      if (needle && !haystack.includes(needle)) continue;
      entries.push(historyEntry(saved, color, now));
    }
    sections.push({ title: "History", entries });
    return sections;
  },
};
