import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { HIDE, type Entry } from "../entry";
import { isGnome, notify, runCapture } from "../system";

const UUID = "beam-windows@virallens.com";
const BUS_NAME = "org.virallens.BeamWindows";
const OBJECT_PATH = "/org/virallens/BeamWindows";

interface WindowCommand {
  action: string;
  title: string;
  icon: string;
  keywords?: string[];
}

/** Same command set as Raycast's Window Management. */
export const WINDOW_COMMANDS: WindowCommand[] = [
  { action: "left-half", title: "Left Half", icon: "◧" },
  { action: "right-half", title: "Right Half", icon: "◨" },
  { action: "top-half", title: "Top Half", icon: "⬒" },
  { action: "bottom-half", title: "Bottom Half", icon: "⬓" },
  { action: "top-left", title: "Top Left Quarter", icon: "◰" },
  { action: "top-right", title: "Top Right Quarter", icon: "◳" },
  { action: "bottom-left", title: "Bottom Left Quarter", icon: "◱" },
  { action: "bottom-right", title: "Bottom Right Quarter", icon: "◲" },
  { action: "left-third", title: "First Third", icon: "▏", keywords: ["left third"] },
  { action: "center-third", title: "Center Third", icon: "▕" },
  { action: "right-third", title: "Last Third", icon: "▕", keywords: ["right third"] },
  { action: "left-two-thirds", title: "First Two Thirds", icon: "▋", keywords: ["left two thirds"] },
  { action: "right-two-thirds", title: "Last Two Thirds", icon: "▋", keywords: ["right two thirds"] },
  { action: "maximize", title: "Maximize", icon: "⬜", keywords: ["full", "fill"] },
  { action: "almost-maximize", title: "Almost Maximize", icon: "▣" },
  { action: "reasonable-size", title: "Reasonable Size", icon: "▢" },
  { action: "center", title: "Center", icon: "⊡", keywords: ["middle"] },
  { action: "maximize-height", title: "Maximize Height", icon: "↕" },
  { action: "maximize-width", title: "Maximize Width", icon: "↔" },
  { action: "restore", title: "Restore", icon: "↺", keywords: ["undo", "previous size"] },
  { action: "minimize", title: "Minimize", icon: "▁", keywords: ["hide"] },
  { action: "toggle-fullscreen", title: "Toggle Fullscreen", icon: "⛶" },
  { action: "next-display", title: "Next Display", icon: "⇥", keywords: ["monitor", "screen"] },
  { action: "previous-display", title: "Previous Display", icon: "⇤", keywords: ["monitor", "screen"] },
];

/** Asks the GNOME extension to move the window that was active before Beam. */
export async function applyWindowAction(action: string): Promise<void> {
  const { code, stdout, stderr } = await runCapture(
    "gdbus",
    [
      "call",
      "--session",
      "--dest",
      BUS_NAME,
      "--object-path",
      OBJECT_PATH,
      "--method",
      `${BUS_NAME}.Apply`,
      action,
    ],
    { timeoutMs: 5000 },
  );
  if (code !== 0) {
    if (/ServiceUnknown|not provided|was not provided/i.test(stderr)) {
      notify(
        "Window management needs one log out",
        "Beam installed its GNOME helper. Log out and back in once to activate it.",
      );
    } else {
      notify("Window management failed", stderr.trim().slice(0, 200));
    }
    return;
  }
  if (stdout.includes("false")) {
    const message = stdout.match(/'([^']*)'/)?.[1] ?? "Could not change the window";
    notify("Window management", message);
  }
}

export function windowEntries(hide: () => void): Entry[] {
  return WINDOW_COMMANDS.map((command) => ({
    id: `window:${command.action}`,
    ref: `window:${command.action}`,
    title: command.title,
    subtitle: "Window Management",
    icon: command.icon,
    accessory: "Command",
    keywords: ["window", ...(command.keywords ?? [])],
    actions: [
      {
        id: "run",
        title: "Run Command",
        shortcut: "↵",
        run: () => {
          hide();
          // Give focus a moment to return to the previous window first.
          setTimeout(() => void applyWindowAction(command.action), 120);
          return HIDE;
        },
      },
    ],
  }));
}

function bundledExtensionDir(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return path.join(base, "gnome-extension", UUID);
}

function readVersion(dir: string): number {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "metadata.json"), "utf8")).version ?? 0;
  } catch {
    return -1;
  }
}

/**
 * Copies the GNOME helper extension into the user's extensions folder and
 * marks it enabled. GNOME on Wayland only discovers new extensions at login,
 * so the first install needs one log out.
 */
export async function ensureWindowExtension(): Promise<void> {
  if (!isGnome()) return;
  const source = bundledExtensionDir();
  if (!fs.existsSync(source)) return;
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local/share");
  const target = path.join(dataHome, "gnome-shell/extensions", UUID);
  if (readVersion(target) !== readVersion(source)) {
    fs.mkdirSync(target, { recursive: true });
    for (const file of fs.readdirSync(source)) {
      fs.copyFileSync(path.join(source, file), path.join(target, file));
    }
  }

  const { stdout } = await runCapture("gsettings", ["get", "org.gnome.shell", "enabled-extensions"]);
  if (!stdout.includes(UUID)) {
    const current = [...stdout.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    const list = `[${[...current, UUID].map((id) => `'${id}'`).join(", ")}]`;
    await runCapture("gsettings", ["set", "org.gnome.shell", "enabled-extensions", list]);
  }
  // Works immediately when GNOME already knows the extension (e.g. on X11
  // after a shell restart, or after the first login).
  await runCapture("gnome-extensions", ["enable", UUID]);
}
