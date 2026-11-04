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
  ],
  aliases: {},
  fileSearchRoots: ["."],
  fileSearchMaxDepth: 6,
  clipboardHistorySize: 300,
  clipboardIgnoreSecrets: true,
  webSearchUrl: "https://www.google.com/search?q=%s",
  currency: "auto",
};

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
