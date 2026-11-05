import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { clipboard, dialog } from "electron";
import {
  conversionsFor,
  durationArgs,
  extOf,
  ffmpegArgs,
  fileKind,
  formatElapsed,
  formatSize,
  frameListArgs,
  imageArgs,
  isNoop,
  KINDS,
  kindNoun,
  largestFrame,
  libreOfficeArgs,
  libreOfficeOutput,
  outputExt,
  outputPath,
  parseCopiedFiles,
  parseDuration,
  pdfPagesArgs,
  progressSeconds,
  SUPPORTED_EXTENSIONS,
  TIMEOUT_MS,
  toolError,
  toolFor,
  TOOLS,
  typeLabel,
  type Conversion,
  type FileKind,
  type Tool,
} from "../convert";
import { HIDE, type Entry, type EntryAction, type Section, type ViewProvider } from "../entry";
import { bestScore } from "../fuzzy";
import { childEnv, copyText, notify, openPath, revealInFolder, runCapture } from "../system";
import { showBeam } from "../window";
import type { RunResult, ViewInfo } from "../../shared/types";

/** Conversions are CPU-heavy; two at a time keeps the desktop responsive. */
const MAX_RUNNING = 2;
const MAX_RECENT = 20;
/** Longer selections are summed up in one line. */
const MAX_LISTED = 10;
const COPIED_FORMATS = ["x-special/gnome-copied-files", "text/uri-list"];

const KIND_ICON: Record<FileKind, string> = { image: "🖼️", video: "🎬", audio: "🎵", document: "📝", pdf: "📕" };

type JobState = "queued" | "running" | "done" | "failed" | "canceled";

/** The files converted by one Enter, reported in one notification. */
interface Batch {
  conversion: Conversion;
  jobs: Job[];
}

interface Job {
  id: number;
  batch: Batch;
  input: string;
  /** Picked when queued and reserved, so two jobs never write the same name. */
  output: string;
  state: JobState;
  error?: string;
  /** 0-1 for video and audio, which report how far they are. */
  progress?: number;
  startedAt?: number;
  child?: ChildProcess;
}

let selection: string[] = [];
/** The copied files last seen, so a new copy replaces the selection but an old one does not. */
let seenCopied = "";
let lastFolder = "";
let nextId = 1;
const queue: Job[] = [];
const running = new Set<Job>();
let recent: Job[] = [];
/** Outputs of jobs that have not written them yet. */
const reserved = new Set<string>();
/** Hidden work folders beside the outputs, removed when a job ends or Beam quits. */
const workDirs = new Set<string>();

function exists(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

const isTaken = (file: string) => reserved.has(file) || exists(file);

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function sizeOf(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

function displayPath(full: string): string {
  const home = os.homedir();
  return full === home || full.startsWith(home + "/") ? "~" + full.slice(home.length) : full;
}

function hasCommand(command: string): boolean {
  return (process.env.PATH ?? "").split(":").some((dir) => {
    try {
      fs.accessSync(path.join(dir, command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function readClipboard(format: string): string {
  try {
    return clipboard.read(format) || clipboard.readBuffer(format).toString("utf8");
  } catch {
    return "";
  }
}

/** Files copied (or cut) in the file manager; folders and other URIs are left out. */
function readCopiedFiles(): string[] {
  for (const format of COPIED_FORMATS) {
    const files = parseCopiedFiles(readClipboard(format)).paths.filter(isFile);
    if (files.length) return files;
  }
  return [];
}

function selectFiles(files: string[]): void {
  selection = [...new Set(files.map((file) => path.resolve(file)))];
  if (selection.length) lastFolder = path.dirname(selection[0]);
  // Whatever is on the clipboard now was there before this choice, so it must not replace it.
  seenCopied = readCopiedFiles().join("\n");
}

/** Newly copied files replace the selection; files copied earlier wait behind "Use Copied Files". */
function pickUpCopiedFiles(): string[] {
  const copied = readCopiedFiles();
  const key = copied.join("\n");
  if (key !== seenCopied) {
    seenCopied = key;
    if (copied.length) {
      selection = copied;
      lastFolder = path.dirname(copied[0]);
    }
  }
  return copied;
}

/** Selects a file from Beam's file search and opens the Convert view; null for types Beam can't convert. */
export function convertFileAction(filePath: string): EntryAction | null {
  if (!fileKind(filePath)) return null;
  return {
    id: "convert",
    title: "Convert File…",
    shortcut: "Ctrl+T",
    run: () => {
      selectFiles([filePath]);
      return { type: "view", view: "convert" };
    },
  };
}

function chooseFiles(hide: () => void): RunResult {
  // The chooser takes the focus, which hides Beam anyway; Beam comes back when it closes.
  hide();
  dialog
    .showOpenDialog({
      title: "Choose Files to Convert",
      buttonLabel: "Choose",
      defaultPath: lastFolder || os.homedir(),
      properties: ["openFile", "multiSelections"],
      filters: [
        { name: "Images, Videos, Audio and Documents", extensions: SUPPORTED_EXTENSIONS },
        { name: "All Files", extensions: ["*"] },
      ],
    })
    .then(({ canceled, filePaths }) => {
      if (!canceled && filePaths.length) selectFiles(filePaths);
    })
    .catch((error) => console.error("beam: file chooser failed:", error))
    .finally(() => showBeam({ view: "convert" }));
  return HIDE;
}

/** "to PNG" for a change of format, "(Compress)" for the rest. */
function target(conversion: Conversion): string {
  return conversion.suffix ? `(${conversion.title})` : `to ${conversion.title}`;
}

function convertFiles(conversion: Conversion, files: string[]): RunResult {
  const todo = files.filter((file) => !isNoop(file, conversion));
  if (!todo.length) return { type: "stay", toast: `Already ${conversion.title}` };
  const batch: Batch = { conversion, jobs: [] };
  for (const input of todo) {
    const output = outputPath(input, conversion, isTaken);
    reserved.add(output);
    const job: Job = { id: nextId++, batch, input, output, state: "queued" };
    batch.jobs.push(job);
    queue.push(job);
  }
  startQueued();
  const what = todo.length === 1 ? path.basename(todo[0]) : `${todo.length} files`;
  return { type: "stay", toast: `Converting ${what} ${target(conversion)}…` };
}

function startQueued(): void {
  while (running.size < MAX_RUNNING && queue.length) {
    const job = queue.shift()!;
    running.add(job);
    void runJob(job).finally(() => {
      running.delete(job);
      finish(job);
      startQueued();
    });
  }
}

function finish(job: Job): void {
  reserved.delete(job.output);
  recent = [job, ...recent.filter((other) => other !== job)].slice(0, MAX_RECENT);
  if (job.batch.jobs.every((other) => other.state !== "queued" && other.state !== "running")) notifyBatch(job.batch);
}

function cancel(job: Job): RunResult {
  if (job.state === "queued") {
    queue.splice(queue.indexOf(job), 1);
    job.state = "canceled";
    finish(job);
  } else if (job.state === "running") {
    job.state = "canceled";
    stop(job.child, "SIGTERM");
  }
  return { type: "stay", toast: "Conversion canceled" };
}

/** For quitting: stops running tools and removes their half-written files. */
export function stopConversions(): void {
  queue.length = 0;
  for (const job of running) {
    job.state = "canceled";
    stop(job.child, "SIGKILL");
  }
  for (const dir of workDirs) fs.rmSync(dir, { recursive: true, force: true });
}

/** Tools run in their own process group, so LibreOffice's helper processes stop too. */
function stop(child: ChildProcess | undefined, signal: NodeJS.Signals): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function runJob(job: Job): Promise<void> {
  job.state = "running";
  job.startedAt = Date.now();
  try {
    const kind = job.batch.conversion.kind;
    if (kind === "image") await convertImage(job);
    else if (kind === "video" || kind === "audio") await convertMedia(job);
    else if (kind === "document") await convertDocument(job);
    else await convertPdf(job);
    if (job.state === "running") job.state = "done";
  } catch (error) {
    if (job.state === "running") {
      job.state = "failed";
      job.error = describeError(error, job);
    }
  }
}

function describeError(error: unknown, job: Job): string {
  const tool = TOOLS[toolFor(job.batch.conversion.kind)];
  const { code, message } = error as NodeJS.ErrnoException;
  if (code === "ENOENT" && message.includes("spawn")) return `${tool.name} is not installed: sudo apt install ${tool.aptPackage}`;
  if (code === "EACCES" || code === "EROFS") return `Can't write to ${displayPath(path.dirname(job.input))}`;
  if (/no decode delegate/i.test(message) && ["heic", "heif", "avif"].includes(extOf(job.input))) {
    return `${message}. HEIC and AVIF photos need: sudo apt install libheif-plugin-libde265 libheif-plugin-aomdec`;
  }
  return message || "The conversion failed";
}

/**
 * Runs a tool without a shell. Resolves with its stderr on success and
 * rejects with the useful line of it otherwise.
 */
function runTool(job: Job, command: string, args: string[], onStdout?: (chunk: string) => void): Promise<string> {
  const timeoutMs = TIMEOUT_MS[job.batch.conversion.kind];
  return new Promise((resolve, reject) => {
    // Canceled while ffprobe or identify ran.
    if (job.state !== "running") return reject(new Error("Canceled"));
    const child = spawn(command, args, { env: childEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    job.child = child;
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop(child, "SIGKILL");
    }, timeoutMs);
    // stdout is always read, or a chatty tool would block once the pipe fills.
    child.stdout.on("data", (chunk: Buffer) => onStdout?.(chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-10_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      job.child = undefined;
      if (code === 0) resolve(stderr);
      else if (timedOut) reject(new Error(`Stopped after ${Math.round(timeoutMs / 60_000)} minutes`));
      else reject(new Error(toolError(stderr) || `${command} failed with exit code ${code}`));
    });
  });
}

function rename(job: Job): void {
  reserved.delete(job.output);
  job.output = outputPath(job.input, job.batch.conversion, isTaken);
  reserved.add(job.output);
}

/** Moves a finished file to its name without replacing a file that appeared meanwhile. */
function place(file: string, job: Job): void {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      // A hard link fails when the name exists, unlike rename.
      fs.linkSync(file, job.output);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        rename(job);
        continue;
      }
      // FAT drives and some network shares have no hard links.
      if (exists(job.output)) {
        rename(job);
        continue;
      }
      fs.renameSync(file, job.output);
      return;
    }
  }
  throw new Error("Could not find a free file name");
}

/**
 * Runs `make` with a hidden folder beside the output and moves the file it
 * returns into place. Half-written files never appear under the real name,
 * and the tools only ever see a plain temporary name.
 */
async function produce(job: Job, make: (dir: string) => Promise<string>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(path.dirname(job.output), ".beam-convert-"));
  workDirs.add(dir);
  try {
    const file = await make(dir);
    if (job.state !== "running") return; // Canceled just as it finished.
    if (!isFile(file)) throw new Error("The converter wrote no file");
    place(file, job);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    workDirs.delete(dir);
  }
}

async function convertImage(job: Job): Promise<void> {
  const { conversion } = job.batch;
  // An .ico holds several sizes; converting the largest one looks best.
  const frame = extOf(job.input) === "ico"
    ? largestFrame((await runCapture("identify", frameListArgs(job.input), { timeoutMs: 30_000 })).stdout)
    : 0;
  await produce(job, async (dir) => {
    const temp = path.join(dir, `output.${outputExt(job.input, conversion)}`);
    await runTool(job, TOOLS.imagemagick.command, imageArgs(conversion, job.input, temp, frame));
    return temp;
  });
}

async function convertMedia(job: Job): Promise<void> {
  const { conversion } = job.batch;
  const probe = await runCapture("ffprobe", durationArgs(job.input), { timeoutMs: 30_000 });
  const duration = parseDuration(probe.stdout);
  let progress = "";
  await produce(job, async (dir) => {
    const temp = path.join(dir, `output.${outputExt(job.input, conversion)}`);
    await runTool(job, TOOLS.ffmpeg.command, ffmpegArgs(conversion, job.input, temp), (chunk) => {
      progress = (progress + chunk).slice(-4000);
      // Only whole lines: a number cut off mid-chunk would make progress jump back.
      const done = progressSeconds(progress.slice(0, progress.lastIndexOf("\n") + 1));
      if (duration && done !== null) job.progress = Math.min(done / duration, 1);
    });
    return temp;
  });
}

async function convertDocument(job: Job): Promise<void> {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "beam-libreoffice-"));
  try {
    await produce(job, async (dir) => {
      const stderr = await runTool(job, TOOLS.libreoffice.command, libreOfficeArgs(job.input, dir, profile));
      const pdf = libreOfficeOutput(job.input, dir);
      // LibreOffice exits with 0 even when it could not open the file.
      if (!isFile(pdf)) throw new Error(toolError(stderr) || "LibreOffice could not open this file");
      return pdf;
    });
  } finally {
    fs.rmSync(profile, { recursive: true, force: true });
  }
}

async function convertPdf(job: Job): Promise<void> {
  for (;;) {
    try {
      // mkdir fails when the name exists, which makes the folder Beam's alone.
      fs.mkdirSync(job.output);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      rename(job);
    }
  }
  try {
    await runTool(job, TOOLS.poppler.command, pdfPagesArgs(job.input, job.output));
  } catch (error) {
    fs.rmSync(job.output, { recursive: true, force: true });
    throw error;
  }
}

function notifyBatch(batch: Batch): void {
  const done = batch.jobs.filter((job) => job.state === "done");
  const failed = batch.jobs.filter((job) => job.state === "failed");
  const total = done.length + failed.length;
  if (!total) return;
  const name = (file: string) => path.basename(file);
  if (!failed.length) {
    // PDF pages go to a folder.
    const saved = name(done[0].output) + (batch.conversion.kind === "pdf" ? "/" : "");
    const folders = new Set(done.map((job) => path.dirname(job.output)));
    const where = folders.size === 1 ? ` in ${displayPath([...folders][0])}` : "";
    if (done.length === 1) notify(`Converted ${name(done[0].input)}`, `Saved ${saved}${where}`);
    else notify(`Converted ${done.length} files ${target(batch.conversion)}`, `Saved next to the originals${where}`);
  } else if (!done.length) {
    const title = total === 1 ? `Could not convert ${name(failed[0].input)}` : `Could not convert ${total} files`;
    notify(title, failed[0].error ?? "");
  } else {
    notify(`Converted ${done.length} of ${total} files ${target(batch.conversion)}`, `${name(failed[0].input)}: ${failed[0].error ?? ""}`);
  }
}

function open(file: string): RunResult {
  openPath(file);
  return HIDE;
}

function reveal(file: string): RunResult {
  revealInFolder(file);
  return HIDE;
}

function busy(): boolean {
  return running.size > 0 || queue.length > 0;
}

function fileEntry(file: string): Entry {
  const kind = fileKind(file);
  const size = sizeOf(file);
  return {
    id: `convert:file:${file}`,
    title: path.basename(file),
    subtitle: [displayPath(path.dirname(file)), size === null ? "" : formatSize(size)].filter(Boolean).join("  ·  "),
    icon: kind ? KIND_ICON[kind] : "📄",
    accessory: kind ? typeLabel(file) : "Not Supported",
    actions: [
      { id: "open", title: "Open File", shortcut: "↵", run: () => open(file) },
      { id: "reveal", title: "Show in Folder", shortcut: "Ctrl+↵", run: () => reveal(file) },
      {
        id: "remove",
        title: "Remove from List",
        shortcut: "Ctrl+D",
        run: () => {
          selection = selection.filter((other) => other !== file);
          return { type: "stay" };
        },
      },
    ],
  };
}

function fileEntries(files: string[], copied: string[], hide: () => void): Entry[] {
  const entries = files.slice(0, MAX_LISTED).map(fileEntry);
  if (files.length > MAX_LISTED) {
    entries.push({
      id: "convert:more",
      title: `…and ${files.length - MAX_LISTED} more`,
      icon: "➕",
      actions: [],
    });
  }
  if (copied.length && copied.join("\n") !== files.join("\n")) {
    entries.push({
      id: "convert:use-copied",
      title: copied.length === 1 ? `Use Copied File: ${path.basename(copied[0])}` : `Use ${copied.length} Copied Files`,
      subtitle: "Files copied with Ctrl+C in Files",
      icon: "📋",
      keywords: ["clipboard", "copied", "paste"],
      actions: [
        {
          id: "use",
          title: "Use Copied Files",
          shortcut: "↵",
          run: () => {
            selectFiles(copied);
            return { type: "stay" };
          },
        },
      ],
    });
  }
  entries.push({
    id: "convert:choose",
    title: "Choose Files…",
    subtitle: files.length ? "Pick other files to convert" : "Or copy files in Files with Ctrl+C and open Convert Files again",
    icon: "📂",
    keywords: ["open", "browse", "pick", "select", "add"],
    actions: [{ id: "choose", title: "Choose Files…", shortcut: "↵", run: () => chooseFiles(hide) }],
  });
  if (files.length) {
    entries.push({
      id: "convert:clear",
      title: "Clear",
      subtitle: "Empty this list; the files stay where they are",
      icon: "🧹",
      keywords: ["clear", "reset", "remove", "empty"],
      actions: [
        {
          id: "clear",
          title: "Clear",
          shortcut: "↵",
          run: () => {
            selection = [];
            return { type: "stay" };
          },
        },
      ],
    });
  }
  return entries;
}

function installEntry(tool: Tool, kind: FileKind): Entry {
  const info = TOOLS[tool];
  const command = `sudo apt install ${info.aptPackage}`;
  return {
    id: `convert:install:${kind}`,
    title: `Install ${info.name} to Convert ${kindNoun(kind, 2)}`,
    subtitle: command,
    icon: "📦",
    accessory: "Not Installed",
    keywords: ["install", "missing", info.aptPackage],
    actions: [
      {
        id: "copy",
        title: "Copy Install Command",
        shortcut: "↵",
        run: () => {
          copyText(command);
          return { type: "stay", toast: "Install command copied" };
        },
      },
    ],
  };
}

function conversionIcon(conversion: Conversion): string {
  if (conversion.id === "compress") return "🗜️";
  if (conversion.id === "half" || conversion.id === "fit-1920") return "📐";
  if (conversion.ext === "mp3" || conversion.kind === "audio") return "🎵";
  if (conversion.ext === "pdf") return "📕";
  return conversion.kind === "video" && conversion.ext !== "gif" ? "🎬" : "🖼️";
}

function conversionEntry(conversion: Conversion, files: string[]): Entry {
  const todo = files.filter((file) => !isNoop(file, conversion));
  const jobs = [...running, ...queue].filter((job) => job.batch.conversion === conversion && files.includes(job.input));
  let accessory: string;
  if (jobs.length) accessory = "Converting…";
  else if (todo.length === 1) accessory = path.basename(outputPath(todo[0], conversion, isTaken)) + (conversion.kind === "pdf" ? "/" : "");
  else accessory = `${todo.length} files`;
  return {
    id: `convert:to:${conversion.kind}:${conversion.id}`,
    title: conversion.title,
    subtitle: conversion.hint,
    icon: conversionIcon(conversion),
    accessory,
    keywords: conversion.keywords,
    actions: [{ id: "convert", title: "Convert", shortcut: "↵", run: () => convertFiles(conversion, files) }],
  };
}

function conversionSections(files: string[]): Section[] {
  const sections: Section[] = [];
  for (const kind of KINDS) {
    const ofKind = files.filter((file) => fileKind(file) === kind);
    if (!ofKind.length) continue;
    const tool = toolFor(kind);
    const entries = hasCommand(TOOLS[tool].command)
      ? conversionsFor(kind)
          .filter((conversion) => ofKind.some((file) => !isNoop(file, conversion)))
          .map((conversion) => conversionEntry(conversion, ofKind))
      : [installEntry(tool, kind)];
    sections.push({ title: `Convert ${ofKind.length} ${kindNoun(kind, ofKind.length)}`, entries });
  }
  return sections;
}

function jobEntry(job: Job): Entry {
  const { conversion } = job.batch;
  const input = path.basename(job.input);
  const id = `convert:job:${job.id}`;
  const showIn = (file: string, shortcut: string): EntryAction => ({
    id: "reveal",
    title: "Show in Folder",
    shortcut,
    run: () => reveal(file),
  });
  const retry = (shortcut: string): EntryAction => ({
    id: "retry",
    title: "Try Again",
    shortcut,
    run: () => convertFiles(conversion, [job.input]),
  });

  if (job.state === "queued" || job.state === "running") {
    const elapsed = job.startedAt ? formatElapsed(Date.now() - job.startedAt) : "";
    const percent = job.progress === undefined ? "" : `${Math.round(job.progress * 100)}%`;
    return {
      id,
      title: `${input} → ${conversion.title}`,
      subtitle: job.state === "queued" ? "Waiting for the other conversions" : [percent || "Converting…", elapsed].join("  ·  "),
      icon: "⏳",
      accessory: job.state === "queued" ? "Queued" : "Converting",
      actions: [
        showIn(job.input, "↵"),
        { id: "cancel", title: "Cancel Conversion", shortcut: "Ctrl+↵", danger: true, run: () => cancel(job) },
      ],
    };
  }
  if (job.state === "done") {
    const output = path.basename(job.output);
    const isFolder = conversion.kind === "pdf";
    let accessory = "";
    if (isFolder) {
      const pages = fs.existsSync(job.output) ? fs.readdirSync(job.output).length : 0;
      accessory = `${pages} ${pages === 1 ? "page" : "pages"}`;
    } else {
      const before = sizeOf(job.input);
      const after = sizeOf(job.output);
      accessory = after === null ? "Moved or deleted" : before === null ? formatSize(after) : `${formatSize(before)} → ${formatSize(after)}`;
    }
    return {
      id,
      title: output + (isFolder ? "/" : ""),
      subtitle: `${input} → ${conversion.title}  ·  ${displayPath(path.dirname(job.output))}`,
      icon: "✅",
      accessory,
      actions: [
        { id: "open", title: isFolder ? "Open Folder" : "Open File", shortcut: "↵", run: () => open(job.output) },
        showIn(job.output, "Ctrl+↵"),
        {
          id: "copy-path",
          title: "Copy Path",
          shortcut: "Ctrl+Shift+C",
          run: () => {
            copyText(job.output);
            return { type: "stay", toast: "Path copied" };
          },
        },
      ],
    };
  }
  if (job.state === "canceled") {
    return {
      id,
      title: `${input} → ${conversion.title}`,
      subtitle: "Canceled",
      icon: "⏹️",
      actions: [retry("↵"), showIn(job.input, "Ctrl+↵")],
    };
  }
  return {
    id,
    title: `${input} → ${conversion.title}`,
    subtitle: job.error,
    icon: "❌",
    accessory: "Failed",
    actions: [
      {
        id: "error",
        title: "Show Error",
        shortcut: "↵",
        run: () => ({ type: "output", title: "Conversion Failed", text: `${job.input}\n→ ${conversion.title}\n\n${job.error}` }),
      },
      retry("Ctrl+↵"),
      showIn(job.input, "Ctrl+Shift+↵"),
    ],
  };
}

export const convertView: ViewProvider = {
  // A getter, so the view refreshes itself only while something converts.
  get info(): ViewInfo {
    return {
      title: "Convert Files",
      placeholder: "Convert to PNG, JPEG, MP4, MP3, PDF…",
      preview: false,
      grid: false,
      refreshMs: busy() ? 1000 : undefined,
    };
  },
  sections(query: string, hide: () => void): Section[] {
    const copied = pickUpCopiedFiles();
    selection = selection.filter(exists);
    const files = selection;
    const q = query.trim();
    const matches = (entry: Entry) => !q || bestScore(q, [entry.title, ...(entry.keywords ?? [])]) > 0;

    const listed = fileEntries(files, copied, hide);
    // While typing, the list is for picking a format: file names would only get in the way of Enter.
    const fileSection: Section = {
      title: files.length ? `${files.length} ${files.length === 1 ? "File" : "Files"} to Convert` : "Files",
      entries: q ? listed.filter((entry) => !entry.id.startsWith("convert:file:") && entry.id !== "convert:more" && matches(entry)) : listed,
    };
    const conversions = conversionSections(files).map((section) => ({ ...section, entries: section.entries.filter(matches) }));
    const active = [...running, ...queue].map(jobEntry).filter(matches);
    const finished = recent.map(jobEntry).filter(matches);
    return [
      ...(q ? [...conversions, fileSection] : [fileSection, ...conversions]),
      { title: "Converting", entries: active },
      { title: "Recent Conversions", entries: finished },
    ];
  },
};

export function convertCommands(_hide: () => void): Entry[] {
  return [
    {
      id: "cmd:convert-files",
      ref: "cmd:convert-files",
      title: "Convert Files",
      subtitle: "Convert",
      icon: "🔄",
      accessory: "Command",
      keywords: [
        "convert", "converter", "format", "image", "photo", "video", "audio", "document",
        "png", "jpg", "jpeg", "webp", "heic", "avif", "gif", "ico", "favicon", "svg",
        "mp4", "webm", "mov", "mkv", "mp3", "wav", "flac", "pdf", "docx",
        "resize", "compress", "shrink",
      ],
      actions: [{ id: "run", title: "Convert Files", shortcut: "↵", run: () => ({ type: "view", view: "convert" }) }],
    },
  ];
}
