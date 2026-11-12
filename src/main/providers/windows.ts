import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { parsePointerReply, type Point } from "../displays";
import { HIDE, type Entry } from "../entry";
import { isGnome, notify, runCapture } from "../system";
import type { ArgDef } from "../../shared/types";

const UUID = "beam-windows@virallens.com";
const BUS_NAME = "org.virallens.BeamWindows";
const OBJECT_PATH = "/org/virallens/BeamWindows";

interface WindowCommand {
  action: string;
  title: string;
  icon: string;
  keywords?: string[];
  /** Fields typed beside the search box; `value` turns them into the action's value. */
  args?: ArgDef[];
  value?: (args: Record<string, string>) => string | null;
}

const SIZE_KEYWORDS = ["resize", "size"];

function desktopCommands(): WindowCommand[] {
  const commands: WindowCommand[] = [];
  for (let n = 1; n <= 9; n++) {
    commands.push({ action: `open-desktop:${n}`, title: `Open Desktop ${n}`, icon: "🖥", keywords: ["switch to desktop", `desktop ${n}`, "workspace", "space"] });
  }
  for (let n = 1; n <= 9; n++) {
    commands.push({ action: `move-to-desktop:${n}`, title: `Move to Desktop ${n}`, icon: "⇉", keywords: [`desktop ${n}`, "workspace", "space"] });
  }
  commands.push({ action: "close-desktop", title: "Close Desktop", icon: "✕", keywords: ["current desktop", "active desktop", "workspace", "space"] });
  for (let n = 1; n <= 9; n++) {
    commands.push({ action: `close-desktop:${n}`, title: `Close Desktop ${n}`, icon: "✕", keywords: [`desktop ${n}`, "workspace", "space"] });
  }
  return commands;
}

/** Two numbers typed into fields `a` and `b`, as "a,b", or null when either is missing. */
function pair(a: string, b: string): (args: Record<string, string>) => string | null {
  return (args) => {
    const first = (args[a] ?? "").trim();
    const second = (args[b] ?? "").trim();
    return /^\d+$/.test(first) && /^\d+$/.test(second) ? `${first},${second}` : null;
  };
}

/** Everything in Raycast's Window Management, except Rename Desktop: GNOME shows desktop names nowhere. */
export const WINDOW_COMMANDS: WindowCommand[] = [
  { action: "left-half", title: "Left Half", icon: "◧" },
  { action: "right-half", title: "Right Half", icon: "◨" },
  { action: "center-half", title: "Center Half", icon: "◫" },
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
  { action: "center-two-thirds", title: "Center Two Thirds", icon: "▋" },
  { action: "right-two-thirds", title: "Last Two Thirds", icon: "▋", keywords: ["right two thirds"] },
  { action: "first-fourth", title: "First Fourth", icon: "▏", keywords: ["left fourth", "quarter width"] },
  { action: "second-fourth", title: "Second Fourth", icon: "▏" },
  { action: "third-fourth", title: "Third Fourth", icon: "▏" },
  { action: "last-fourth", title: "Last Fourth", icon: "▏", keywords: ["right fourth"] },
  { action: "first-three-fourths", title: "First Three Fourths", icon: "▊", keywords: ["left three fourths"] },
  { action: "center-three-fourths", title: "Center Three Fourths", icon: "▊" },
  { action: "last-three-fourths", title: "Last Three Fourths", icon: "▊", keywords: ["right three fourths"] },
  { action: "top-left-sixth", title: "Top Left Sixth", icon: "◰" },
  { action: "top-center-sixth", title: "Top Center Sixth", icon: "⬒" },
  { action: "top-right-sixth", title: "Top Right Sixth", icon: "◳" },
  { action: "bottom-left-sixth", title: "Bottom Left Sixth", icon: "◱" },
  { action: "bottom-center-sixth", title: "Bottom Center Sixth", icon: "⬓" },
  { action: "bottom-right-sixth", title: "Bottom Right Sixth", icon: "◲" },
  { action: "maximize", title: "Maximize", icon: "⬜", keywords: ["full", "fill"] },
  { action: "almost-maximize", title: "Almost Maximize", icon: "▣" },
  { action: "maximize-height", title: "Maximize Height", icon: "↕" },
  { action: "maximize-width", title: "Maximize Width", icon: "↔" },
  { action: "reasonable-size", title: "Reasonable Size", icon: "▢" },
  { action: "make-larger", title: "Make Larger", icon: "⤢", keywords: ["grow", "bigger", ...SIZE_KEYWORDS] },
  { action: "make-smaller", title: "Make Smaller", icon: "⤡", keywords: ["shrink", ...SIZE_KEYWORDS] },
  {
    action: "resize-window",
    title: "Resize Window",
    icon: "⤡",
    keywords: ["width", "height", ...SIZE_KEYWORDS],
    args: [
      { name: "width", placeholder: "Width", numeric: true },
      { name: "height", placeholder: "Height", numeric: true },
    ],
    value: pair("width", "height"),
  },
  { action: "center", title: "Center", icon: "⊡", keywords: ["middle"] },
  { action: "move-up", title: "Move Up", icon: "↑", keywords: ["top edge"] },
  { action: "move-down", title: "Move Down", icon: "↓", keywords: ["bottom edge"] },
  { action: "move-left", title: "Move Left", icon: "←", keywords: ["left edge"] },
  { action: "move-right", title: "Move Right", icon: "→", keywords: ["right edge"] },
  {
    action: "move-window",
    title: "Move Window",
    icon: "✥",
    keywords: ["position", "x", "y"],
    args: [
      { name: "x", placeholder: "X", numeric: true },
      { name: "y", placeholder: "Y", numeric: true },
    ],
    value: pair("x", "y"),
  },
  { action: "restore", title: "Restore", icon: "↺", keywords: ["undo", "previous size"] },
  { action: "minimize", title: "Minimize", icon: "▁", keywords: ["hide"] },
  { action: "minimize-display", title: "Minimize on This Display", icon: "▁", keywords: ["minimize all", "hide all", "show desktop"] },
  { action: "toggle-fullscreen", title: "Toggle Fullscreen", icon: "⛶" },
  { action: "next-app-window", title: "Focus Next App Window", icon: "⇥", keywords: ["cycle", "switch window"] },
  { action: "previous-app-window", title: "Focus Previous App Window", icon: "⇤", keywords: ["cycle", "switch window"] },
  { action: "next-desktop", title: "Next Desktop", icon: "⇉", keywords: ["move to next desktop", "next space", "workspace"] },
  { action: "previous-desktop", title: "Previous Desktop", icon: "⇇", keywords: ["move to previous desktop", "previous space", "workspace"] },
  ...desktopCommands(),
  { action: "next-display", title: "Next Display", icon: "⇥", keywords: ["move to next display", "monitor", "screen"] },
  { action: "previous-display", title: "Previous Display", icon: "⇤", keywords: ["move to previous display", "monitor", "screen"] },
  { action: "focus-next-display", title: "Focus Next Display", icon: "⇥", keywords: ["switch display", "other display", "monitor", "screen", "focus"] },
  { action: "focus-previous-display", title: "Focus Previous Display", icon: "⇤", keywords: ["switch display", "other display", "monitor", "screen", "focus"] },
];

/** Calls a method of Beam's GNOME helper extension. */
function callHelper(method: string, ...args: string[]) {
  return runCapture(
    "gdbus",
    ["call", "--session", "--dest", BUS_NAME, "--object-path", OBJECT_PATH, "--method", `${BUS_NAME}.${method}`, ...args],
    { timeoutMs: 5000 },
  );
}

/**
 * Where the pointer is, asked of GNOME Shell. Beam runs through XWayland,
 * which only learns the pointer's position while it is over one of Beam's
 * own windows, so Electron's own answer is often stale. Null until the
 * helper has this method (one log out after an update).
 */
export async function pointerPosition(): Promise<Point | null> {
  if (!isGnome()) return null;
  const { code, stdout } = await runCapture(
    "gdbus",
    ["call", "--session", "--dest", BUS_NAME, "--object-path", OBJECT_PATH, "--method", `${BUS_NAME}.Pointer`],
    { timeoutMs: 300 },
  );
  return code === 0 ? parsePointerReply(stdout) : null;
}

/** Whether the running GNOME helper tells Beam about copies (version 7 on). */
export async function helperSendsClipboardEvents(): Promise<boolean> {
  if (!isGnome()) return false;
  const { code, stdout } = await callHelper("ClipboardEvents");
  return code === 0 && stdout.includes("true");
}

/** Confetti over the screen, drawn by the GNOME helper. */
export async function confetti(): Promise<void> {
  const { code, stderr } = await callHelper("Confetti");
  if (code !== 0 && /ServiceUnknown|not provided|UnknownMethod|No such method/i.test(stderr)) {
    notify("Confetti needs one log out", "Beam updated its GNOME helper. Log out and back in once to load it.");
  }
}

/** Asks the GNOME extension to move the window that was active before Beam. */
export async function applyWindowAction(action: string): Promise<void> {
  const { code, stdout, stderr } = await callHelper("Apply", action);
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
    // Refs keep the action's own name (e.g. "window:move-to-desktop:3") for hotkeys and aliases.
    id: `window:${command.action}`,
    ref: `window:${command.action}`,
    title: command.title,
    subtitle: "Window Management",
    icon: command.icon,
    accessory: "Command",
    keywords: ["window", ...(command.keywords ?? [])],
    args: command.args,
    actions: [
      {
        id: "run",
        title: "Run Command",
        shortcut: "↵",
        run: (args) => {
          let action = command.action;
          if (command.value) {
            const value = command.value(args ?? {});
            if (value === null) {
              const names = (command.args ?? []).map((arg) => arg.placeholder).join(" and ");
              return { type: "error", message: `Type ${names} first (Tab moves between them)` };
            }
            action = `${action}:${value}`;
          }
          hide();
          // Give focus a moment to return to the previous window first.
          setTimeout(() => void applyWindowAction(action), 120);
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
  // Only a list that was really read is written back with the helper added:
  // after a failed read, writing back just the helper would turn off every
  // other extension.
  const listed = stdout.trim();
  if (!/^(@as )?\[.*\]$/s.test(listed)) return;
  if (!listed.includes(UUID)) {
    const current = [...listed.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    const list = `[${[...current, UUID].map((id) => `'${id}'`).join(", ")}]`;
    await runCapture("gsettings", ["set", "org.gnome.shell", "enabled-extensions", list]);
  }
  // Works immediately when GNOME already knows the extension (e.g. on X11
  // after a shell restart, or after the first login).
  await runCapture("gnome-extensions", ["enable", UUID]);
}
