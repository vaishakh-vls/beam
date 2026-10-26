import { globalShortcut } from "electron";
import { toGnomeAccelerator } from "./accelerators";
import { config, type Keybind } from "./config";
import { isGnome, runCapture } from "./system";

const SCHEMA = "org.gnome.settings-daemon.plugins.media-keys";
const LIST_KEY = "custom-keybindings";
const PATH_PREFIX = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings/";
const BEAM_PATH = `${PATH_PREFIX}beam-`;

function parseStringList(text: string): string[] {
  return [...text.matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

function formatStringList(items: string[]): string {
  return `[${items.map((i) => `'${i}'`).join(", ")}]`;
}

/** A command line GNOME can run; only arguments with spaces are quoted. */
function launchCommand(launcher: string[], ref: string): string {
  return [...launcher, "--run", ref]
    .map((part) => (/[\s"']/.test(part) ? `"${part.replace(/(["\\])/g, "\\$1")}"` : part))
    .join(" ");
}

/** gsettings parses values as GVariant text, so strings must be quoted. */
function gvariantString(value: string): string {
  return `'${value.replace(/(['\\])/g, "\\$1")}'`;
}

export interface KeybindSyncResult {
  warnings: string[];
}

/**
 * Registers the configured hotkeys. On GNOME they are written as custom
 * keyboard shortcuts (works on X11 and Wayland, and shows up in Settings →
 * Keyboard); elsewhere Electron's global shortcuts are used.
 */
export async function syncKeybinds(
  launcher: string[],
  runRef: (ref: string) => void,
): Promise<KeybindSyncResult> {
  const binds = config().keybinds;
  const warnings: string[] = [];
  for (const bind of binds) {
    if (!toGnomeAccelerator(bind.keys)) warnings.push(`Invalid hotkey "${bind.keys}" for ${bind.ref}`);
  }

  if (!isGnome()) {
    globalShortcut.unregisterAll();
    for (const bind of binds) {
      try {
        if (!globalShortcut.register(bind.keys, () => runRef(bind.ref))) {
          warnings.push(`${bind.keys} is already used by another app`);
        }
      } catch {
        warnings.push(`Invalid hotkey "${bind.keys}"`);
      }
    }
    return { warnings };
  }

  const current = await runCapture("gsettings", ["get", SCHEMA, LIST_KEY]);
  const others = parseStringList(current.stdout).filter((p) => !p.startsWith(BEAM_PATH));
  const valid = binds.filter((b) => toGnomeAccelerator(b.keys));
  const paths = valid.map((_, i) => `${BEAM_PATH}${i}/`);
  for (const [i, bind] of valid.entries()) {
    const schema = `${SCHEMA}.custom-keybinding:${paths[i]}`;
    await runCapture("gsettings", ["set", schema, "name", gvariantString(`Beam: ${bind.ref}`)]);
    await runCapture("gsettings", ["set", schema, "command", gvariantString(launchCommand(launcher, bind.ref))]);
    await runCapture("gsettings", ["set", schema, "binding", gvariantString(toGnomeAccelerator(bind.keys)!)]);
  }
  await runCapture("gsettings", ["set", SCHEMA, LIST_KEY, formatStringList([...others, ...paths])]);
  warnings.push(...(await findConflicts(valid)));
  return { warnings };
}

/** Warns when a Beam hotkey is also a built-in GNOME shortcut. */
async function findConflicts(binds: Keybind[]): Promise<string[]> {
  const builtins = [
    ["org.gnome.desktop.wm.keybindings", "activate-window-menu", "the window menu"],
    ["org.gnome.desktop.wm.keybindings", "switch-input-source", "switching input source"],
    ["org.gnome.shell.keybindings", "toggle-message-tray", "the notification list"],
    ["org.gnome.shell.keybindings", "toggle-overview", "the Activities overview"],
  ];
  const warnings: string[] = [];
  for (const [schema, key, label] of builtins) {
    const { stdout } = await runCapture("gsettings", ["get", schema, key]);
    const taken = parseStringList(stdout).map((a) => a.toLowerCase());
    for (const bind of binds) {
      const accel = toGnomeAccelerator(bind.keys)?.toLowerCase();
      if (accel && taken.includes(accel)) {
        warnings.push(`${bind.keys} is also GNOME's shortcut for ${label} (${schema} ${key}).`);
      }
    }
  }
  return warnings;
}

export function setHotkey(ref: string, keys: string): string | null {
  const binds = config().keybinds.filter((b) => b.ref !== ref);
  if (keys.trim()) {
    if (!toGnomeAccelerator(keys)) return `"${keys}" is not a valid hotkey. Try something like Ctrl+Alt+J.`;
    const clash = binds.find((b) => b.keys.toLowerCase() === keys.trim().toLowerCase());
    if (clash) return `${keys} is already assigned to ${clash.ref}.`;
    binds.push({ keys: keys.trim(), ref });
  }
  config().keybinds = binds;
  return null;
}

export function hotkeyFor(ref: string): string | undefined {
  return config().keybinds.find((b) => b.ref === ref)?.keys;
}
