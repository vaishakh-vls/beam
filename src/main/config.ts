import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
  "beam",
);
export const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
export const SCRIPTS_DIR = path.join(CONFIG_DIR, "scripts");

/**
 * Commands are referred to by a string "ref" everywhere (hotkeys, aliases,
 * usage ranking, `beam --run <ref>`):
 *   toggle | view:<view> | app:<desktop-id> | cmd:<builtin> | script:<file>
 *   | quicklink:<id> | snippet:<id>
 */
export interface Keybind {
  /** e.g. "Super+Space" or "Super+V". */
  keys: string;
  ref: string;
}

export interface BeamConfig {
  keybinds: Keybind[];
  /** Short names that pin a command to the top, keyed by ref. */
  aliases: Record<string, string>;
  /** Folders indexed for file search, relative to the home folder. */
  fileSearchRoots: string[];
  fileSearchMaxDepth: number;
  clipboardHistorySize: number;
  /** Skip API tokens, private keys and similar when recording clipboard history. */
  clipboardIgnoreSecrets: boolean;
  webSearchUrl: string;
  /** Currency that "10 usd" converts to: an ISO code such as "INR", or "auto" for the region's. */
  currency: string;
  /** For GIF search; free from developers.giphy.com. Empty until the user adds one. */
  giphyApiKey: string;
  /** Beam's window theme: a built-in id such as "nord", "system" to follow GNOME's dark style, or "user:<file>" for ~/.config/beam/themes/<file>.json. */
  theme: string;
  /** Show Beam's icon in the top bar (its menu opens Beam, clipboard history and snippets, reloads and quits). */
  trayIcon: boolean;
  /** Refs of the default keybinds already offered, so a new default is added once and a removed one stays removed. */
  offeredKeybinds: string[];
}

const DEFAULT_CONFIG: BeamConfig = {
  keybinds: [
    { keys: "Super+Space", ref: "toggle" },
    { keys: "Super+V", ref: "view:clipboard" },
    { keys: "Ctrl+Super+Left", ref: "window:left-half" },
    { keys: "Ctrl+Super+Right", ref: "window:right-half" },
    { keys: "Ctrl+Super+Enter", ref: "window:maximize" },
    { keys: "Ctrl+Super+Down", ref: "window:reasonable-size" },
    { keys: "Ctrl+Super+C", ref: "window:center" },
    { keys: "Ctrl+Super+Backspace", ref: "window:restore" },
    { keys: "Super+Shift+C", ref: "cmd:confetti" },
  ],
  aliases: {},
  fileSearchRoots: ["."],
  fileSearchMaxDepth: 6,
  clipboardHistorySize: 300,
  clipboardIgnoreSecrets: true,
  webSearchUrl: "https://www.google.com/search?q=%s",
  currency: "auto",
  giphyApiKey: "",
  theme: "beam-dark",
  trayIcon: true,
  offeredKeybinds: [],
};
DEFAULT_CONFIG.offeredKeybinds = DEFAULT_CONFIG.keybinds.map((bind) => bind.ref);

/** The default keybinds of Beam 0.2.2 and earlier, which configs from then have already been given. */
const FIRST_DEFAULT_REFS = [
  "toggle",
  "view:clipboard",
  "window:left-half",
  "window:right-half",
  "window:maximize",
  "window:reasonable-size",
  "window:center",
  "window:restore",
];

/**
 * Adds the default keybinds not offered before, unless their command or keys
 * are already bound. Returns the new list and what was added.
 */
export function offerNewKeybinds(
  keybinds: Keybind[],
  offered: string[],
  defaults: Keybind[],
): { keybinds: Keybind[]; added: Keybind[] } {
  const result = [...keybinds];
  const added: Keybind[] = [];
  for (const bind of defaults) {
    if (offered.includes(bind.ref)) continue;
    const taken = result.some((other) => other.ref === bind.ref || other.keys.toLowerCase() === bind.keys.toLowerCase());
    if (taken) continue;
    result.push(bind);
    added.push(bind);
  }
  return { keybinds: result, added };
}

const EXAMPLE_SCRIPT = `#!/bin/bash

# Required parameters:
# @raycast.schemaVersion 1
# @raycast.title Say Hello
# @raycast.mode fullOutput

# Optional parameters:
# @raycast.icon 👋
# @raycast.argument1 { "type": "text", "placeholder": "Name", "optional": true }
# @raycast.description Example script command. Edit or delete me.

echo "Hello \${1:-there}! This output came from $(basename "$0")."
echo "Scripts live in ${SCRIPTS_DIR}"
`;

let current: BeamConfig = { ...DEFAULT_CONFIG };

export function config(): BeamConfig {
  return current;
}

export function loadConfig(): BeamConfig {
  ensureConfigDir();
  if (!fs.existsSync(CONFIG_FILE)) {
    current = structuredClone(DEFAULT_CONFIG);
    saveConfig();
    return current;
  }
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    current = { ...structuredClone(DEFAULT_CONFIG), ...raw };
    if (Array.isArray(raw.keybinds)) {
      const offered: string[] = Array.isArray(raw.offeredKeybinds) ? raw.offeredKeybinds : FIRST_DEFAULT_REFS;
      const { keybinds } = offerNewKeybinds(raw.keybinds, offered, DEFAULT_CONFIG.keybinds);
      current.keybinds = keybinds;
      current.offeredKeybinds = [...new Set([...offered, ...DEFAULT_CONFIG.offeredKeybinds])];
      if (keybinds.length !== raw.keybinds.length || current.offeredKeybinds.length !== offered.length) saveConfig();
    }
  } catch (error) {
    console.error(`beam: invalid ${CONFIG_FILE}, using defaults:`, error);
    current = structuredClone(DEFAULT_CONFIG);
  }
  return current;
}

export function saveConfig(): void {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(current, null, 2) + "\n");
}

function ensureConfigDir(): void {
  const fresh = !fs.existsSync(SCRIPTS_DIR);
  fs.mkdirSync(SCRIPTS_DIR, { recursive: true });
  if (fresh) {
    fs.writeFileSync(path.join(SCRIPTS_DIR, "say-hello.sh"), EXAMPLE_SCRIPT, { mode: 0o755 });
  }
}
