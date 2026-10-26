import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { clipboard, shell } from "electron";

/**
 * The real desktop name, e.g. "ubuntu:GNOME". Electron rewrites
 * XDG_CURRENT_DESKTOP to "Unity" for tray support and keeps the original
 * in ORIGINAL_XDG_CURRENT_DESKTOP.
 */
export function currentDesktop(): string {
  return process.env.ORIGINAL_XDG_CURRENT_DESKTOP || process.env.XDG_CURRENT_DESKTOP || "";
}

export function isGnome(): boolean {
  return currentDesktop().toUpperCase().includes("GNOME");
}

/** Environment for launched programs, without Electron's own changes. */
export function childEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("ELECTRON_") || key === "CHROME_DESKTOP") delete env[key];
  }
  if (env.ORIGINAL_XDG_CURRENT_DESKTOP) {
    env.XDG_CURRENT_DESKTOP = env.ORIGINAL_XDG_CURRENT_DESKTOP;
    delete env.ORIGINAL_XDG_CURRENT_DESKTOP;
  }
  return env;
}

/** Start a program that outlives Beam. */
export function launchDetached(command: string, args: string[] = [], cwd?: string): void {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    env: childEnv(),
  });
  child.on("error", (error) => console.error(`beam: failed to start ${command}:`, error));
  child.unref();
}

export function openUrl(url: string): void {
  shell.openExternal(url).catch((error) => console.error("beam: openExternal failed:", error));
}

export function openPath(target: string): void {
  launchDetached("xdg-open", [target]);
}

export function revealInFolder(target: string): void {
  shell.showItemInFolder(target);
}

export function copyText(text: string): void {
  clipboard.writeText(text);
}

const isX11 = process.env.XDG_SESSION_TYPE === "x11";
const canAutoPaste =
  isX11 && (process.env.PATH ?? "").split(":").some((dir) => fs.existsSync(path.join(dir, "xdotool")));

/** "Paste" where Beam can type into the previous app, otherwise "Copy". */
export function pasteVerb(): "Paste" | "Copy" {
  return canAutoPaste ? "Paste" : "Copy";
}

/**
 * Put text on the clipboard and, where the system allows it, paste it into
 * the window that was focused before Beam opened. Pasting needs X11 and
 * xdotool; on Wayland the text is only copied.
 * Returns true when it pasted.
 */
export async function pasteText(text: string, hideWindow: () => void): Promise<boolean> {
  clipboard.writeText(text);
  hideWindow();
  if (!canAutoPaste) {
    notify("Copied to clipboard", truncate(text, 80));
    return false;
  }
  setTimeout(() => {
    execFile("xdotool", ["key", "--clearmodifiers", "ctrl+v"], (error) => {
      if (error) console.error("beam: xdotool paste failed:", error);
    });
  }, 120);
  return true;
}

export function notify(title: string, body = ""): void {
  execFile("notify-send", ["--app-name=Beam", title, body], (error) => {
    if (error) console.error("beam: notify-send failed:", error);
  });
}

export function runCapture(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { cwd: options.cwd, timeout: options.timeoutMs ?? 60_000, env: childEnv(), maxBuffer: 4 << 20 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) || (error?.message ?? "") });
      },
    );
  });
}

export function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}
