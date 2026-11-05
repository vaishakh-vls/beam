import fs from "node:fs";
import type { Entry, Section, ViewProvider } from "../entry";
import { bestScore } from "../fuzzy";
import { hotkeyFor } from "../keybinds";
import { JsonStore } from "../store";
import { isGnome, notify, runCapture } from "../system";
import type { RunResult, View } from "../../shared/types";

/** Whether the tour has been shown, so it opens by itself only on the first launch. */
const store = new JsonStore<{ welcomed: boolean }>("welcome.json", () => ({ welcomed: false }));

/** The view to open instead of the root search the first time Beam's window opens. */
export function firstRunView(): View | null {
  if (store.data.welcomed) return null;
  store.data.welcomed = true;
  store.saveNow();
  return "welcome";
}

/** Beam started in the background and nobody has seen the tour: say how to open it. */
export function announceFirstRun(): void {
  if (!store.data.welcomed) notify("Beam is ready", `Press ${hotkeyFor("toggle") ?? "Super+Space"} for a quick tour of what it can do.`);
}

interface Feature {
  id: string;
  title: string;
  subtitle: string;
  icon: string;
  /** How to use it, shown in the preview pane. */
  about: string;
  /** "Try It" types this into the main search, or opens this view. */
  tryQuery?: string;
  tryView?: View;
  keywords?: string[];
}

const SEARCH: Feature[] = [
  {
    id: "apps",
    title: "Apps, Files and Commands",
    subtitle: "Type a few letters of anything",
    icon: "🔎",
    about: "Type part of an app, file or command name and press Enter.\n\nOn a file, Ctrl+K shows more: Quick Look (Ctrl+Y) previews it inside Beam, Open With… (Ctrl+O) picks an app, Show in Folder, Copy Path and Convert.\n\nBeam learns what you open most and ranks it first. Ctrl+Shift+A gives any command an alias, Ctrl+Shift+H a hotkey of its own.",
    tryQuery: "terminal",
  },
  {
    id: "calculator",
    title: "Calculator and Conversions",
    subtitle: "Math, units and currencies right in the search",
    icon: "🧮",
    about: "Type a sum or a conversion and the answer appears at the top. Enter copies it.\n\nTry:\n  (12 + 30) * 4\n  18% of 2400\n  5 km to miles\n  100 usd to inr\n  72 f to c",
    tryQuery: "100 usd to inr",
    keywords: ["math", "currency", "units"],
  },
  {
    id: "clipboard",
    title: "Clipboard History",
    subtitle: "Everything you copied, searchable",
    icon: "📋",
    about: "Super+V opens what you copied recently. Enter copies an item again.\n\nPasswords from password managers and anything that looks like a token or key are not saved.",
    tryView: "clipboard",
  },
  {
    id: "snippets",
    title: "Snippets and Quicklinks",
    subtitle: "Saved text and links with keywords",
    icon: "✂️",
    about: "Snippets keep text you type often (addresses, replies, code). Give one a keyword and typing the keyword in Beam brings it up.\n\nQuicklinks open URLs with what you type, e.g. a Jira or GitHub search.\n\nCreate them with Create Snippet and Create Quicklink.",
    tryView: "snippets",
  },
  {
    id: "emoji",
    title: "Emoji and Symbols",
    subtitle: "Search and copy emoji",
    icon: "😀",
    about: "Search emoji and symbols by name and copy them with Enter.",
    tryView: "emoji",
  },
  {
    id: "windows",
    title: "Window Management",
    subtitle: "Halves, quarters, thirds and more",
    icon: "🪟",
    about: "Move the window you were using into a layout.\n\n  Ctrl+Super+Left / Right   left or right half\n  Ctrl+Super+Enter          maximize\n  Ctrl+Super+C              center\n  Ctrl+Super+Backspace      restore\n\nIt needs Beam's GNOME extension, which starts working after you log out and back in once.",
    tryView: "windows",
  },
];

const SYSTEM: Feature[] = [
  {
    id: "processes",
    title: "Processes",
    subtitle: "See what's running and quit it",
    icon: "⚙️",
    about: "A live list of processes sorted by CPU (Ctrl+M sorts by memory).\n\n  Enter              quit\n  Ctrl+Enter         force kill\n  Ctrl+Shift+Enter   quit every process with that name\n  Ctrl+Shift+C       copy the PID",
    tryView: "processes",
    keywords: ["kill", "pid", "task manager"],
  },
  {
    id: "wifi",
    title: "Wi-Fi",
    subtitle: "Connect, copy passwords, share with a QR code",
    icon: "📶",
    about: "Connect to networks, turn Wi-Fi on or off, disconnect and forget networks.\n\nOn a saved network: Copy Password, or Show Password and QR Code so a phone can join by scanning it. Saved networks out of range are listed too.",
    tryView: "wifi",
    keywords: ["password", "network"],
  },
  {
    id: "bluetooth",
    title: "Bluetooth",
    subtitle: "Connect, pair and forget devices",
    icon: "🔵",
    about: "Connect and disconnect devices, scan for new ones and pair them, and turn Bluetooth on or off.",
    tryView: "bluetooth",
  },
  {
    id: "audio",
    title: "Audio and Volume",
    subtitle: "Volume, speakers, microphones",
    icon: "🔊",
    about: "Switch between speakers and headphones, set the volume and mute the microphone.\n\nTyping \"volume 40\" in the main search sets the volume straight away.",
    tryQuery: "volume 40",
  },
  {
    id: "fans",
    title: "Fan Control",
    subtitle: "ThinkPad fan speed and temperatures",
    icon: "🌀",
    about: "Shows fan speed and CPU temperature and sets the fan level (Auto, 1–7, Full Speed).\n\nThe first time, Turn On Fan Control asks for your password once. If the CPU gets hot on a quiet level, Beam switches back to Auto.",
    tryView: "fans",
  },
  {
    id: "power",
    title: "Power and Battery",
    subtitle: "Power modes, battery health, charge limit, timers",
    icon: "🔋",
    about: "Battery level, time left, health and charge cycles.\n\nSwitch between Performance, Balanced and Power Saver. On ThinkPads, set a charge limit (stop at 80%) to make the battery last longer.\n\nTimers: type \"sleep 30\" or \"shutdown at 23:00\" in the view. Lock, Sleep, Restart and Shut Down are here too.",
    tryView: "power",
    keywords: ["battery", "shutdown", "sleep", "profile"],
  },
  {
    id: "caffeinate",
    title: "Caffeinate",
    subtitle: "Keep the laptop awake",
    icon: "☕",
    about: "Stops the screen from locking and the laptop from sleeping.\n\nIn the main search, type caffeinate, then:\n  Tab   hours\n  Tab   minutes\n  Enter start\n\nLeave the times empty to stay on until you stop it.",
    tryQuery: "caffeinate",
    keywords: ["awake", "sleep"],
  },
  {
    id: "speedtest",
    title: "Speed Test",
    subtitle: "Download, upload and ping",
    icon: "🚀",
    about: "Measures your internet speed.",
    tryView: "speedtest",
  },
  {
    id: "clean-keyboard",
    title: "Clean Keyboard",
    subtitle: "Lock the keys while you wipe them",
    icon: "🧽",
    about: "Locks the keyboard for 15 seconds to 2 minutes so you can clean it without typing anything.",
    tryView: "clean-keyboard",
  },
];

const MEDIA: Feature[] = [
  {
    id: "spotify",
    title: "Spotify",
    subtitle: "Play, pause, skip",
    icon: "🎵",
    about: "Control Spotify (or any player) without switching windows: play, pause, next, previous.",
    tryView: "media",
    keywords: ["music"],
  },
  {
    id: "chrome",
    title: "Chrome Bookmarks and History",
    subtitle: "Find any page you visited",
    icon: "🌐",
    about: "Search Chrome's bookmarks and history, and open new or incognito windows.",
    tryView: "chrome",
  },
  {
    id: "tabs",
    title: "Browser Tabs",
    subtitle: "Search open Chrome tabs and jump to one",
    icon: "🗂️",
    about: "Search every open Chrome tab by title or address and switch to it, close it or copy its link.\n\nBeam adds a small extension to Chrome for this. Restart Chrome once after installing Beam to load it; if Chrome asks, turn it on. The view shows the steps if it isn't connected.",
    tryView: "tabs",
    keywords: ["chrome", "tab", "browser"],
  },
  {
    id: "gifs",
    title: "GIF Search",
    subtitle: "Find and copy GIFs",
    icon: "🎞️",
    about: "Search GIPHY and copy a GIF's link. The first time, Beam asks for a free GIPHY API key.",
    tryView: "gifs",
  },
  {
    id: "colors",
    title: "Color Picker",
    subtitle: "Pick any color on screen",
    icon: "🎨",
    about: "Pick a color anywhere on the screen and copy it as HEX, RGB or HSL.\n\nTyping a color in the main search, like #ff8800 or rgb(10, 20, 30), converts it.",
    tryView: "colors",
  },
];

const LOOK: Feature[] = [
  {
    id: "themes",
    title: "Themes",
    subtitle: "Catppuccin, Nord, Tokyo Night, light and more",
    icon: "🎨",
    about: "Change how Beam looks: 10 built-in themes, Follow System for light and dark, or your own theme file (New Theme from This… starts one).",
    tryView: "themes",
    keywords: ["theme", "dark", "light", "colors"],
  },
  {
    id: "fonts",
    title: "Fonts",
    subtitle: "Browse installed fonts with live previews",
    icon: "🔤",
    about: "Every installed font with a preview drawn in it. Type \"your text in quotes to preview your own words. Copy the family name or the CSS font-family, or install a font file.",
    tryView: "fonts",
  },
];

const DEVELOPER: Feature[] = [
  {
    id: "devtools",
    title: "Developer Tools",
    subtitle: "JWT, JSON, Base64, timestamps, hashes, UUIDs",
    icon: "🛠️",
    about: "Paste anything and Beam works out what it is:\n\n  a JWT or Bearer token   decoded, with expiry\n  JSON                    formatted, minified, validated\n  a Unix timestamp        as a date\n  Base64, URLs            decoded\n  any text                hashes, case styles, Base64\n\nOpened with nothing typed, it reads the clipboard. Generate UUID, Generate Password and Format JSON in Clipboard work straight from the main search.",
    tryView: "devtools",
    keywords: ["jwt", "json", "bearer", "token", "base64", "uuid"],
  },
  {
    id: "convert",
    title: "Convert Files",
    subtitle: "PNG → JPEG, HEIC → JPG, MP4 → GIF, DOCX → PDF",
    icon: "🔄",
    about: "Convert images, videos, audio and documents. Copy files in the Files app (Ctrl+C) and open Convert Files, or pick files there.\n\nThe converted file is saved next to the original.",
    tryView: "convert",
    keywords: ["png", "jpg", "heic", "pdf", "gif"],
  },
  {
    id: "scripts",
    title: "Script Commands",
    subtitle: "Your own commands as shell scripts",
    icon: "⚡",
    about: "Any script in Beam's scripts folder becomes a command. Create Script Command makes one from a template.",
    tryView: "scripts",
  },
];

function tryResult(feature: Feature): RunResult {
  if (feature.tryQuery) return { type: "search", query: feature.tryQuery };
  return { type: "view", view: feature.tryView ?? "root" };
}

function featureEntry(feature: Feature): Entry {
  return {
    id: `welcome:${feature.id}`,
    title: feature.title,
    subtitle: feature.subtitle,
    icon: feature.icon,
    preview: feature.about,
    keywords: feature.keywords,
    actions: [{ id: "try", title: "Try It", shortcut: "↵", run: () => tryResult(feature) }],
  };
}

/** Steps a fresh install still needs, so the tour can say what is left. */
async function setupEntries(): Promise<Entry[]> {
  const hotkey = hotkeyFor("toggle") ?? "Super+Space";
  const entries: Entry[] = [
    {
      id: "welcome:hotkey",
      title: `Open Beam with ${hotkey}`,
      subtitle: "From anywhere, any time",
      icon: "⌨️",
      preview: `Press ${hotkey} to open Beam, type, and press Enter. Esc closes it.\n\nIn any list:\n  Enter        run the highlighted item\n  Ctrl+Enter   its second action\n  Ctrl+K       every action for it\n  Backspace    go back (when the search is empty)\n\nSuper+V opens clipboard history.\n\nThis tour is always there as Welcome to Beam.`,
      actions: [{ id: "try", title: "Start Searching", shortcut: "↵", run: () => ({ type: "view", view: "root" }) }],
    },
  ];
  if (isGnome()) {
    const { stdout } = await runCapture("gnome-extensions", ["info", "beam-windows@virallens.com"], { timeoutMs: 3000 });
    if (!/State:\s*(ACTIVE|ENABLED)/.test(stdout)) {
      entries.push({
        id: "welcome:logout",
        title: "Log Out and Back In Once",
        subtitle: "Turns on window layouts and Clean Keyboard",
        icon: "🚪",
        preview: "Beam installed a small GNOME extension for moving windows and locking the keyboard. GNOME only loads new extensions at login, so log out and back in once.\n\nEverything else works now.",
        actions: [{ id: "try", title: "Start Searching", shortcut: "↵", run: () => ({ type: "view", view: "root" }) }],
      });
    }
  }
  try {
    if (!/^commands:/m.test(fs.readFileSync("/proc/acpi/ibm/fan", "utf8"))) {
      entries.push({
        id: "welcome:fans",
        title: "Turn On Fan Control",
        subtitle: "ThinkPad only; asks for your password once",
        icon: "🌀",
        preview: "Fan Control needs the ThinkPad driver's fan control switched on. It asks for your password once.",
        actions: [{ id: "try", title: "Open Fan Control", shortcut: "↵", run: () => ({ type: "view", view: "fans" }) }],
      });
    }
  } catch {
    // Not a ThinkPad.
  }
  return entries;
}

export const welcomeView: ViewProvider = {
  info: { title: "Welcome to Beam", placeholder: "What can Beam do? Pick anything and press Enter to try it…", preview: true, grid: false },
  async sections(query): Promise<Section[]> {
    const q = query.trim();
    const matches = (entry: Entry) => !q || bestScore(q, [entry.title, entry.subtitle ?? "", ...(entry.keywords ?? [])]) > 0;
    return [
      { title: "Get Started", entries: (await setupEntries()).filter(matches) },
      { title: "Search", entries: SEARCH.map(featureEntry).filter(matches) },
      { title: "Your Laptop", entries: SYSTEM.map(featureEntry).filter(matches) },
      { title: "Media and Web", entries: MEDIA.map(featureEntry).filter(matches) },
      { title: "Look and Feel", entries: LOOK.map(featureEntry).filter(matches) },
      { title: "For Developers", entries: DEVELOPER.map(featureEntry).filter(matches) },
    ];
  },
};

export function welcomeCommands(): Entry[] {
  return [
    {
      id: "cmd:welcome",
      ref: "cmd:welcome",
      title: "Welcome to Beam",
      subtitle: "Beam",
      icon: "👋",
      accessory: "Command",
      keywords: ["tour", "help", "intro", "getting started", "what can", "features", "guide"],
      actions: [{ id: "run", title: "Open Tour", shortcut: "↵", run: () => ({ type: "view", view: "welcome" }) }],
    },
  ];
}
