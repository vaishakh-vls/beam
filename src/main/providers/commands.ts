import { app } from "electron";
import { CONFIG_DIR } from "../config";
import { HIDE, type Entry } from "../entry";
import { launchDetached, notify, openPath, runCapture } from "../system";
import { openCreateQuicklinkForm } from "./quicklinks";
import { openCreateScriptForm } from "./scripts";
import { openCreateSnippetForm } from "./snippets";
import type { RunResult, View } from "../../shared/types";

interface BuiltinCommand {
  name: string;
  title: string;
  subtitle: string;
  icon: string;
  keywords?: string[];
  run: () => RunResult | Promise<RunResult>;
}

function view(name: View): () => RunResult {
  return () => ({ type: "view", view: name });
}

function detached(command: string, ...args: string[]): () => RunResult {
  return () => {
    launchDetached(command, args);
    return HIDE;
  };
}

async function toggleDarkMode(): Promise<RunResult> {
  const { stdout } = await runCapture("gsettings", ["get", "org.gnome.desktop.interface", "color-scheme"]);
  const dark = stdout.includes("prefer-dark");
  await runCapture("gsettings", [
    "set",
    "org.gnome.desktop.interface",
    "color-scheme",
    dark ? "default" : "prefer-dark",
  ]);
  // Ubuntu's Yaru theme also needs the GTK theme switched for older apps.
  await runCapture("gsettings", ["set", "org.gnome.desktop.interface", "gtk-theme", dark ? "Yaru" : "Yaru-dark"]);
  notify(dark ? "Light mode on" : "Dark mode on");
  return HIDE;
}

function volume(change: string): () => Promise<RunResult> {
  return async () => {
    await runCapture("wpctl", ["set-volume", "-l", "1.0", "@DEFAULT_AUDIO_SINK@", change]);
    return { type: "stay", toast: "Volume changed" };
  };
}

export function builtinCommands(reload: () => void): BuiltinCommand[] {
  return [
    // Beam features
    { name: "clipboard", title: "Clipboard History", subtitle: "Beam", icon: "📋", keywords: ["clipboard", "paste", "copy"], run: view("clipboard") },
    { name: "snippets", title: "Search Snippets", subtitle: "Beam", icon: "✂️", keywords: ["snippets", "text", "expand"], run: view("snippets") },
    { name: "create-snippet", title: "Create Snippet", subtitle: "Beam", icon: "✂️", run: openCreateSnippetForm },
    { name: "quicklinks", title: "Search Quicklinks", subtitle: "Beam", icon: "🔗", keywords: ["quicklinks", "bookmark", "url"], run: view("quicklinks") },
    { name: "create-quicklink", title: "Create Quicklink", subtitle: "Beam", icon: "🔗", run: openCreateQuicklinkForm },
    { name: "emoji", title: "Search Emoji & Symbols", subtitle: "Beam", icon: "😀", keywords: ["emoji", "emoticon", "smiley", "symbols"], run: view("emoji") },
    { name: "windows", title: "Window Management", subtitle: "Beam", icon: "🪟", keywords: ["tile", "snap", "resize", "layout"], run: view("windows") },
    { name: "scripts", title: "Script Commands", subtitle: "Beam", icon: "⚡", keywords: ["extensions"], run: view("scripts") },
    { name: "create-script", title: "Create Script Command", subtitle: "Beam", icon: "⚡", keywords: ["extension", "new"], run: openCreateScriptForm },
    { name: "open-config", title: "Open Beam Settings Folder", subtitle: "Beam", icon: "⚙️", keywords: ["preferences", "config"], run: () => { openPath(CONFIG_DIR); return HIDE; } },
    { name: "reload", title: "Reload Beam", subtitle: "Beam", icon: "🔄", keywords: ["refresh", "apps"], run: () => { reload(); return { type: "stay", toast: "Reloaded settings, apps and scripts" }; } },
    { name: "quit", title: "Quit Beam", subtitle: "Beam", icon: "⏻", run: () => { app.quit(); return HIDE; } },

    // System
    { name: "lock", title: "Lock Screen", subtitle: "System", icon: "🔒", run: detached("loginctl", "lock-session") },
    { name: "sleep", title: "Sleep", subtitle: "System", icon: "🌙", keywords: ["suspend"], run: detached("systemctl", "suspend") },
    { name: "logout", title: "Log Out", subtitle: "System", icon: "🚪", keywords: ["sign out"], run: detached("gnome-session-quit", "--logout") },
    { name: "restart", title: "Restart", subtitle: "System", icon: "🔁", keywords: ["reboot"], run: detached("gnome-session-quit", "--reboot") },
    { name: "shutdown", title: "Shut Down", subtitle: "System", icon: "⏼", keywords: ["power off"], run: detached("gnome-session-quit", "--power-off") },
    { name: "dark-mode", title: "Toggle System Appearance", subtitle: "System", icon: "🌓", keywords: ["dark mode", "light mode", "theme"], run: toggleDarkMode },
    { name: "empty-trash", title: "Empty Trash", subtitle: "System", icon: "🗑️", run: async () => { await runCapture("gio", ["trash", "--empty"]); notify("Trash emptied"); return HIDE; } },
    { name: "volume-up", title: "Volume Up", subtitle: "System", icon: "🔊", keywords: ["sound", "louder"], run: volume("10%+") },
    { name: "volume-down", title: "Volume Down", subtitle: "System", icon: "🔉", keywords: ["sound", "quieter"], run: volume("10%-") },
    { name: "mute", title: "Toggle Mute", subtitle: "System", icon: "🔇", keywords: ["sound", "silence"], run: async () => { await runCapture("wpctl", ["set-mute", "@DEFAULT_AUDIO_SINK@", "toggle"]); return HIDE; } },
    { name: "settings", title: "Open System Settings", subtitle: "System", icon: "🛠️", keywords: ["preferences", "control center"], run: detached("gnome-control-center") },
  ];
}

export function commandEntries(reload: () => void): Entry[] {
  return builtinCommands(reload).map((command) => ({
    id: `cmd:${command.name}`,
    ref: `cmd:${command.name}`,
    title: command.title,
    subtitle: command.subtitle,
    icon: command.icon,
    accessory: "Command",
    keywords: command.keywords,
    actions: [{ id: "run", title: "Run Command", shortcut: "↵", run: command.run }],
  }));
}
