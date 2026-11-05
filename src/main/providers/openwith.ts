import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HIDE, type Entry, type EntryAction, type Section, type ViewProvider } from "../entry";
import { bestScore } from "../fuzzy";
import { iconUrl, resolveIcon } from "../icons";
import {
  describeType,
  isJsonFile,
  isPreviewableImage,
  looksBinary,
  parseContentType,
  parseGioMime,
  prettyJson,
  type MimeApps,
} from "../openwith";
import { formatBytes } from "../procinfo";
import { launchDetached, runCapture } from "../system";
import { loadApps } from "./apps";
import type { RunResult } from "../../shared/types";

/** Quick Look reads at most this much of a text file. */
const MAX_TEXT_BYTES = 256 * 1024;
/** Images are sent to the window as data: URLs, so very large ones are left out. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_FOLDER_ENTRIES = 300;

/** The file the Open With view is for, with its type and the apps gio suggests. */
let target: { file: string; mime: string | null; apps: MimeApps } | null = null;

function displayPath(full: string): string {
  const home = os.homedir();
  return full.startsWith(home) ? "~" + full.slice(home.length) : full;
}

async function contentType(file: string): Promise<string | null> {
  const { code, stdout } = await runCapture("gio", ["info", "-a", "standard::content-type", file], { timeoutMs: 5000 });
  return code === 0 ? parseContentType(stdout) : null;
}

async function mimeApps(mime: string | null): Promise<MimeApps> {
  if (!mime) return { defaultApp: null, apps: [] };
  const { code, stdout } = await runCapture("gio", ["mime", mime], { timeoutMs: 5000 });
  return code === 0 ? parseGioMime(stdout) : { defaultApp: null, apps: [] };
}

/** "Open With…" for a file or folder: lists the apps for its type, then every other app. */
export function openWithAction(file: string): EntryAction {
  return {
    id: "open-with",
    title: "Open With…",
    shortcut: "Ctrl+O",
    run: async () => {
      const mime = await contentType(file);
      target = { file, mime, apps: await mimeApps(mime) };
      return { type: "view", view: "open-with" };
    },
  };
}

function openWith(desktopId: string, file: string): RunResult {
  // gtk-launch passes the file through the app's Exec field codes, as the file manager does.
  launchDetached("gtk-launch", [desktopId.replace(/\.desktop$/, ""), file], os.homedir());
  return HIDE;
}

async function makeDefault(desktopId: string, name: string, mime: string): Promise<RunResult> {
  const { code, stderr } = await runCapture("gio", ["mime", mime, desktopId], { timeoutMs: 5000 });
  if (code !== 0) return { type: "error", message: `Could not make ${name} the default: ${stderr.trim()}` };
  if (target) target.apps = await mimeApps(mime);
  return { type: "stay", toast: `${describeType(mime)} files now open with ${name}` };
}

function appEntries(ids: string[], defaultApp: string | null): Entry[] {
  if (!target) return [];
  const { file, mime } = target;
  const byId = new Map(loadApps().map((app) => [app.id, app]));
  return ids.map((id) => {
    const app = byId.get(id);
    const name = app?.name ?? id.replace(/\.desktop$/, "");
    const iconPath = app?.icon ? resolveIcon(app.icon) : null;
    const isDefault = id === defaultApp;
    const actions: EntryAction[] = [
      { id: "open", title: `Open with ${name}`, shortcut: "↵", run: () => openWith(id, file) },
    ];
    if (mime && !isDefault) {
      actions.push({
        id: "default",
        title: `Always Open ${describeType(mime)} Files with ${name}`,
        shortcut: "Ctrl+↵",
        run: () => makeDefault(id, name, mime),
      });
    }
    return {
      id: `open-with:${id}`,
      title: name,
      subtitle: app?.comment,
      icon: iconPath ? iconUrl(iconPath) : "🧩",
      accessory: isDefault ? "Default" : undefined,
      keywords: [...(app?.keywords ?? []), id.replace(/\.desktop$/, "")],
      actions,
    };
  });
}

export const openWithView: ViewProvider = {
  get info() {
    const name = target ? path.basename(target.file) : "file";
    return { title: "Open With", placeholder: `Open ${name} with…`, preview: false, grid: false };
  },
  sections(query): Section[] {
    if (!target) return [];
    const q = query.trim();
    const matches = (entry: Entry) => !q || bestScore(q, [entry.title, ...(entry.keywords ?? [])]) > 0;
    const { defaultApp, apps } = target.apps;
    const suggested = defaultApp ? [defaultApp, ...apps] : apps;
    const others = loadApps()
      .map((app) => app.id)
      .filter((id) => !suggested.includes(id));
    const typeName = describeType(target.mime);
    return [
      { title: `Apps for ${typeName} Files`, entries: appEntries(suggested, defaultApp).filter(matches) },
      { title: "Other Apps", entries: appEntries(others, defaultApp).filter(matches) },
    ];
  },
};

/** Quick Look: shows a file inside Beam. Text as is, JSON formatted, images and a PDF's first page as pictures. */
export function quickLookAction(file: string): EntryAction {
  return { id: "quick-look", title: "Quick Look", shortcut: "Ctrl+Y", run: () => quickLook(file) };
}

async function quickLook(file: string): Promise<RunResult> {
  const name = path.basename(file);
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch (error) {
    return { type: "error", message: `Could not read ${name}: ${(error as Error).message}` };
  }
  const modified = stat.mtime.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  if (stat.isDirectory()) return { type: "output", title: name, text: await folderListing(file, modified) };

  const mime = await contentType(file);
  const header = `${describeType(mime)}  ·  ${formatBytes(stat.size)}  ·  Modified ${modified}\n${displayPath(file)}`;
  try {
    if (isPreviewableImage(mime) && stat.size <= MAX_IMAGE_BYTES) {
      const data = await fs.promises.readFile(file);
      return { type: "output", title: name, text: header, image: `data:${mime};base64,${data.toString("base64")}` };
    }
    if (mime === "application/pdf") return await pdfLook(file, name, header);
    const text = await readStart(file, stat.size);
    if (text === null) return { type: "output", title: name, text: `${header}\n\nNo preview for this kind of file. Open With… (Ctrl+O) picks an app for it.` };
    const truncated = stat.size > MAX_TEXT_BYTES;
    const pretty = !truncated && isJsonFile(name, mime) ? prettyJson(text) : null;
    const note = pretty ? "Formatted JSON" : truncated ? `Showing the first ${formatBytes(MAX_TEXT_BYTES)}` : "";
    return { type: "output", title: name, text: `${header}${note ? `  ·  ${note}` : ""}\n\n${pretty ?? text}` };
  } catch (error) {
    return { type: "error", message: `Could not read ${name}: ${(error as Error).message}` };
  }
}

/** The start of a file as UTF-8 text, or null when it is binary. */
async function readStart(file: string, size: number): Promise<string | null> {
  const handle = await fs.promises.open(file, "r");
  try {
    const buffer = Buffer.alloc(Math.min(size, MAX_TEXT_BYTES));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    return looksBinary(bytes) ? null : bytes.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function folderListing(dir: string, modified: string): Promise<string> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const visible = entries
    .filter((entry) => !entry.name.startsWith("."))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const folders = visible.filter((entry) => entry.isDirectory()).length;
  const lines = visible.slice(0, MAX_FOLDER_ENTRIES).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name));
  if (visible.length > MAX_FOLDER_ENTRIES) lines.push(`… and ${visible.length - MAX_FOLDER_ENTRIES} more`);
  const hidden = entries.length - visible.length;
  const counts = `${folders} folders, ${visible.length - folders} files${hidden ? `, ${hidden} hidden` : ""}`;
  return `Folder  ·  ${counts}  ·  Modified ${modified}\n${displayPath(dir)}\n\n${lines.join("\n")}`;
}

/** A PDF's first page, rendered by poppler's pdftoppm into a private temp folder. */
async function pdfLook(file: string, name: string, header: string): Promise<RunResult> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "beam-look-"));
  try {
    const prefix = path.join(dir, "page");
    const [render, info] = await Promise.all([
      runCapture("pdftoppm", ["-png", "-singlefile", "-f", "1", "-l", "1", "-scale-to", "900", file, prefix], { timeoutMs: 20_000 }),
      runCapture("pdfinfo", [file], { timeoutMs: 10_000 }),
    ]);
    const pages = /^Pages:\s+(\d+)/m.exec(info.stdout)?.[1];
    const text = pages ? `${header}  ·  ${pages} pages` : header;
    if (render.code !== 0) return { type: "output", title: name, text: `${text}\n\nCould not render a preview: ${render.stderr.trim()}` };
    const png = await fs.promises.readFile(`${prefix}.png`);
    return { type: "output", title: name, text, image: `data:image/png;base64,${png.toString("base64")}` };
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}
