// Picks conversions for files and builds the command lines that run them.
// Every tool gets an argument array, never a shell string, so file names
// with spaces, quotes or "$" need no escaping.

import path from "node:path";
import { pathToFileURL } from "node:url";

export type FileKind = "image" | "video" | "audio" | "document" | "pdf";
export type Tool = "imagemagick" | "ffmpeg" | "libreoffice" | "poppler";

export interface ToolInfo {
  name: string;
  /** The program Beam runs; checking for it tells whether the tool is installed. */
  command: string;
  /** The apt package that provides it. */
  aptPackage: string;
}

export const TOOLS: Record<Tool, ToolInfo> = {
  imagemagick: { name: "ImageMagick", command: "convert", aptPackage: "imagemagick" },
  ffmpeg: { name: "FFmpeg", command: "ffmpeg", aptPackage: "ffmpeg" },
  libreoffice: { name: "LibreOffice", command: "libreoffice", aptPackage: "libreoffice" },
  poppler: { name: "Poppler", command: "pdftoppm", aptPackage: "poppler-utils" },
};

const KIND_TOOL: Record<FileKind, Tool> = {
  image: "imagemagick",
  video: "ffmpeg",
  audio: "ffmpeg",
  document: "libreoffice",
  pdf: "poppler",
};

export function toolFor(kind: FileKind): Tool {
  return KIND_TOOL[kind];
}

const EXTENSIONS: Record<FileKind, string[]> = {
  image: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "heic", "heif", "avif", "svg", "ico"],
  video: ["mp4", "mov", "mkv", "webm", "avi", "m4v"],
  audio: ["mp3", "wav", "ogg", "flac", "m4a", "aac", "opus"],
  document: ["doc", "docx", "odt", "rtf", "ppt", "pptx", "odp", "xls", "xlsx", "ods", "txt"],
  pdf: ["pdf"],
};

export const KINDS: FileKind[] = ["image", "video", "audio", "document", "pdf"];

/** Every extension Beam converts, for the file chooser's filter. */
export const SUPPORTED_EXTENSIONS: string[] = KINDS.flatMap((kind) => EXTENSIONS[kind]);

/** Lowercase extension without the dot: "Photo.JPG" -> "jpg". */
export function extOf(file: string): string {
  return path.extname(file).slice(1).toLowerCase();
}

export function fileKind(file: string): FileKind | null {
  const ext = extOf(file);
  return KINDS.find((kind) => EXTENSIONS[kind].includes(ext)) ?? null;
}

/** Spellings of one format, so a .jpeg is never "converted" to JPEG. */
const ALIASES: Record<string, string> = { jpeg: "jpg", tif: "tiff", heif: "heic" };

function sameFormat(a: string, b: string): boolean {
  return (ALIASES[a] ?? a) === (ALIASES[b] ?? b);
}

/** Image formats ImageMagick can write here; HEIC, SVG and ICO sources are resized into PNG. */
const WRITABLE_IMAGES = new Set(["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff", "avif"]);

export interface Conversion {
  /** Unique within its kind. */
  id: string;
  kind: FileKind;
  title: string;
  hint: string;
  /** Output extension; empty keeps the source's format (resizing). PDF pages go to a folder instead. */
  ext: string;
  /** Added to the name for results that may share the source's format: photo.jpg -> photo-small.jpg. */
  suffix?: string;
  keywords: string[];
}

const image = (id: string, title: string, hint: string, ext: string, keywords: string[], suffix?: string): Conversion => ({
  id, kind: "image", title, hint, ext, suffix, keywords,
});

export const CONVERSIONS: Conversion[] = [
  image("png", "PNG", "Lossless, keeps transparency", "png", ["png"]),
  image("jpg", "JPEG", "Quality 90; transparent areas become white", "jpg", ["jpg", "jpeg"]),
  image("webp", "WebP", "Quality 90; smaller than JPEG, keeps animation", "webp", ["webp"]),
  image("avif", "AVIF", "Quality 80; smallest files, slow to encode", "avif", ["avif", "av1"]),
  image("gif", "GIF", "256 colors", "gif", ["gif"]),
  image("ico", "ICO", "Favicon with sizes from 16 to 256 px", "ico", ["ico", "icon", "favicon"]),
  image("bmp", "BMP", "Uncompressed; transparent areas become white", "bmp", ["bmp", "bitmap"]),
  image("tiff", "TIFF", "Lossless, LZW compressed", "tiff", ["tif", "tiff"]),
  image("half", "Resize to 50%", "Same format, half the width and height", "", ["resize", "scale", "half", "smaller", "shrink"], "-half"),
  image("fit-1920", "Fit Within 1920 px", "Same format; only shrinks, keeps the proportions", "", ["resize", "scale", "fit", "1920", "1080p", "smaller", "shrink"], "-1920"),
  image("compress", "Compress", "JPEG quality 75 without metadata", "jpg", ["compress", "smaller", "optimize", "strip", "metadata", "jpeg"], "-small"),

  { id: "mp4", kind: "video", title: "MP4", hint: "H.264 and AAC; plays everywhere", ext: "mp4", keywords: ["mp4", "h264", "x264"] },
  { id: "webm", kind: "video", title: "WebM", hint: "VP9 and Opus", ext: "webm", keywords: ["webm", "vp9"] },
  { id: "gif", kind: "video", title: "GIF", hint: "12 fps, at most 640 px wide, no sound", ext: "gif", keywords: ["gif", "animation", "animated"] },
  { id: "mp3", kind: "video", title: "MP3 (Audio Only)", hint: "Extracts the sound track", ext: "mp3", keywords: ["mp3", "audio", "sound", "extract", "music"] },
  { id: "compress", kind: "video", title: "Compress", hint: "H.264 MP4 at CRF 28; much smaller", ext: "mp4", suffix: "-small", keywords: ["compress", "smaller", "shrink", "mp4"] },

  { id: "mp3", kind: "audio", title: "MP3", hint: "Variable bitrate, about 190 kbit/s", ext: "mp3", keywords: ["mp3"] },
  { id: "wav", kind: "audio", title: "WAV", hint: "Uncompressed 16-bit", ext: "wav", keywords: ["wav", "wave", "pcm"] },
  { id: "ogg", kind: "audio", title: "OGG", hint: "Vorbis, quality 5", ext: "ogg", keywords: ["ogg", "vorbis"] },
  { id: "flac", kind: "audio", title: "FLAC", hint: "Lossless", ext: "flac", keywords: ["flac", "lossless"] },
  { id: "m4a", kind: "audio", title: "M4A", hint: "AAC at 192 kbit/s", ext: "m4a", keywords: ["m4a", "aac", "itunes"] },

  { id: "pdf", kind: "document", title: "PDF", hint: "Exported with LibreOffice", ext: "pdf", keywords: ["pdf", "export"] },

  { id: "png-pages", kind: "pdf", title: "PNG Pages", hint: "One PNG per page at 150 dpi, in a new folder", ext: "png", keywords: ["png", "image", "pages", "export"] },
];

export function conversionsFor(kind: FileKind): Conversion[] {
  return CONVERSIONS.filter((conversion) => conversion.kind === kind);
}

/** A plain format change to the format the file already has, which Beam skips. */
export function isNoop(input: string, conversion: Conversion): boolean {
  return !conversion.suffix && conversion.kind !== "pdf" && sameFormat(extOf(input), conversion.ext);
}

/** The extension the result gets; empty for PDF pages, which go to a folder. */
export function outputExt(input: string, conversion: Conversion): string {
  if (conversion.kind === "pdf") return "";
  if (conversion.ext) return conversion.ext;
  const ext = extOf(input);
  return WRITABLE_IMAGES.has(ext) ? ext : "png";
}

/** `base.ext`, else `base (1).ext`, `base (2).ext`… whichever is free. */
export function freePath(dir: string, base: string, ext: string, exists: (candidate: string) => boolean): string {
  for (let n = 0; n < 10_000; n++) {
    const candidate = path.join(dir, n ? `${base} (${n})${ext}` : `${base}${ext}`);
    if (!exists(candidate)) return candidate;
  }
  return path.join(dir, `${base} (${Date.now()})${ext}`);
}

/** Where a conversion writes: next to its source, never over an existing file. */
export function outputPath(input: string, conversion: Conversion, exists: (candidate: string) => boolean): string {
  const ext = outputExt(input, conversion);
  const base = path.basename(input, path.extname(input)) + (conversion.suffix ?? "");
  return freePath(path.dirname(input), base, ext ? `.${ext}` : "", exists);
}

/** Output formats by extension; naming the format makes ImageMagick ignore the temp file's name. */
const MAGICK_FORMAT: Record<string, string> = {
  png: "PNG",
  jpg: "JPEG",
  jpeg: "JPEG",
  webp: "WEBP",
  avif: "AVIF",
  gif: "GIF",
  ico: "ICO",
  // Version 3 bitmaps open in every program; newer headers do not.
  bmp: "BMP3",
  tif: "TIFF",
  tiff: "TIFF",
};

const ON_WHITE = ["-background", "white", "-alpha", "remove", "-alpha", "off"];

const ANIMATED = new Set(["gif", "webp"]);

/**
 * ImageMagick `convert` arguments. Animations stay animated when the new
 * format can animate; otherwise one frame is kept, `frame` (the largest
 * size of an .ico).
 *
 * Frames are picked with -clone rather than the `file[0]` syntax because
 * that syntax makes ImageMagick read "%" in the file name as a pattern.
 * `output` should be a plain temporary name for the same reason: ImageMagick
 * also expands "%d"-style patterns in output names.
 */
export function imageArgs(conversion: Conversion, input: string, output: string, frame = 0): string[] {
  const ext = outputExt(input, conversion);
  const args: string[] = [];
  // Set before reading so SVGs keep their transparent background.
  if (extOf(input) === "svg") args.push("-background", "none");
  args.push(input);
  if (ANIMATED.has(ext) && ANIMATED.has(extOf(input))) args.push("-coalesce");
  else args.push("(", "-clone", String(frame), ")", "-delete", "0--2");
  args.push("-auto-orient");

  if (conversion.id === "half") args.push("-resize", "50%");
  else if (conversion.id === "fit-1920") args.push("-resize", "1920x1920>");
  else if (conversion.id === "compress") args.push("-strip");

  if (ext === "jpg" || ext === "jpeg") args.push(...ON_WHITE, "-quality", conversion.id === "compress" ? "75" : "90");
  else if (ext === "bmp") args.push(...ON_WHITE);
  else if (ext === "webp") args.push("-quality", "90");
  else if (ext === "avif") args.push("-quality", "80");
  else if (ext === "tif" || ext === "tiff") args.push("-compress", "LZW");
  else if (ext === "ico") {
    // Pad to a square first so wide images are not squashed.
    args.push(
      "-background", "none", "-resize", "256x256", "-gravity", "center", "-extent", "256x256",
      "-define", "icon:auto-resize=256,128,64,48,32,16",
    );
  }
  args.push(`${MAGICK_FORMAT[ext] ?? ext.toUpperCase()}:${output}`);
  return args;
}

/** `identify` arguments that list an image's frames as "index width height" lines. */
export function frameListArgs(input: string): string[] {
  return ["-format", "%p %w %h\\n", input];
}

/** The index of the largest frame in `identify` output from frameListArgs; .ico files hold several sizes. */
export function largestFrame(text: string): number {
  let best = 0;
  let bestArea = -1;
  for (const line of text.split("\n")) {
    const [index, width, height] = line.trim().split(/\s+/).map(Number);
    if (!Number.isInteger(index) || !(width * height > bestArea)) continue;
    best = index;
    bestArea = width * height;
  }
  return best;
}

/** Even sizes, which H.264 in yuv420p needs. */
const EVEN_SIZE = "scale=trunc(iw/2)*2:trunc(ih/2)*2";
const H264 = ["-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p", "-vf", EVEN_SIZE];

/**
 * ffmpeg arguments. Progress goes to stdout as key=value lines; errors go
 * to stderr. The first video stream that is not cover art and the first
 * audio stream are kept; subtitles are dropped because most do not fit the
 * new container.
 */
export function ffmpegArgs(conversion: Conversion, input: string, output: string): string[] {
  const args = ["-hide_banner", "-nostdin", "-loglevel", "error", "-progress", "pipe:1", "-nostats", "-n", "-i", input];
  const video = ["-map", "0:V:0", "-map", "0:a:0?"];
  const audio = ["-map", "0:a:0"];
  switch (`${conversion.kind}:${conversion.id}`) {
    case "video:mp4":
      args.push(...video, ...H264, "-crf", "23", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart");
      break;
    case "video:compress":
      args.push(...video, ...H264, "-crf", "28", "-c:a", "aac", "-b:a", "128k", "-movflags", "+faststart");
      break;
    case "video:webm":
      args.push(
        ...video, "-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-deadline", "good", "-cpu-used", "4",
        "-row-mt", "1", "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "128k",
      );
      break;
    case "video:gif":
      // One pass with a palette made from the clip itself looks far better than GIF's default palette.
      args.push(
        "-map", "0:V:0", "-an",
        "-vf", "fps=12,scale='min(640,iw)':-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
        "-loop", "0",
      );
      break;
    case "video:mp3":
    case "audio:mp3":
      args.push(...audio, "-c:a", "libmp3lame", "-q:a", "2");
      break;
    case "audio:wav":
      args.push(...audio, "-c:a", "pcm_s16le");
      break;
    case "audio:ogg":
      args.push(...audio, "-c:a", "libvorbis", "-q:a", "5");
      break;
    case "audio:flac":
      args.push(...audio, "-c:a", "flac");
      break;
    case "audio:m4a":
      args.push(...audio, "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart");
      break;
    default:
      throw new Error(`No ffmpeg conversion for ${conversion.kind} ${conversion.id}`);
  }
  args.push(output);
  return args;
}

/** `ffprobe` arguments that print the duration in seconds, for progress. */
export function durationArgs(input: string): string[] {
  return ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", input];
}

export function parseDuration(text: string): number | null {
  const seconds = Number.parseFloat(text.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

/** Seconds converted so far, from the latest `out_time_us=` line of ffmpeg's -progress output. */
export function progressSeconds(text: string): number | null {
  const matches = [...text.matchAll(/^out_time_us=(\d+)$/gm)];
  return matches.length ? Number(matches[matches.length - 1][1]) / 1e6 : null;
}

/**
 * LibreOffice arguments. Its own profile lets this run while the user has
 * LibreOffice open; otherwise the request goes to that window and nothing
 * is written. The PDF lands in `outDir`, named after the source.
 */
export function libreOfficeArgs(input: string, outDir: string, profileDir: string): string[] {
  return [
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    "--headless", "--norestore", "--nolockcheck",
    "--convert-to", "pdf", "--outdir", outDir, input,
  ];
}

/** Where libreOfficeArgs leaves the PDF. */
export function libreOfficeOutput(input: string, outDir: string): string {
  return path.join(outDir, `${path.basename(input, path.extname(input))}.pdf`);
}

/** `pdftoppm` arguments: pages become `<folder>/<name>-1.png`, `-2.png`… (zero-padded for long PDFs). */
export function pdfPagesArgs(input: string, folder: string): string[] {
  return ["-png", "-r", "150", input, path.join(folder, path.basename(input, path.extname(input)))];
}

/** Video can take a long time; the rest is quick unless something hangs. */
export const TIMEOUT_MS: Record<FileKind, number> = {
  image: 5 * 60_000,
  video: 30 * 60_000,
  audio: 10 * 60_000,
  document: 5 * 60_000,
  pdf: 10 * 60_000,
};

export interface CopiedFiles {
  paths: string[];
  /** Cut in the file manager: the files move when pasted. */
  cut: boolean;
}

/** A local path from a file:// URI, or null for other URIs (sftp://, trash://…). */
export function fileUriToPath(uri: string): string | null {
  const match = /^file:\/\/(localhost)?(\/[^?#]*)$/i.exec(uri.trim());
  if (!match) return null;
  try {
    return decodeURIComponent(match[2]);
  } catch {
    return null;
  }
}

/**
 * Files copied in a file manager. Reads `x-special/gnome-copied-files`
 * ("copy" or "cut", then one URI per line) and `text/uri-list` (one URI per
 * line, "#" comments). Old Nautilus put the first format in plain text,
 * with an "x-special/nautilus-clipboard" line in front.
 */
export function parseCopiedFiles(text: string): CopiedFiles {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  if (lines[0] === "x-special/nautilus-clipboard") lines.shift();
  let cut = false;
  if (lines[0] === "copy" || lines[0] === "cut") cut = lines.shift() === "cut";
  const paths: string[] = [];
  for (const line of lines) {
    const file = fileUriToPath(line);
    if (file && !paths.includes(file)) paths.push(file);
  }
  return { paths, cut };
}

/** Like GNOME Files: 1000-based units. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} bytes`;
  const units = ["kB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const KIND_NOUN: Record<FileKind, [string, string]> = {
  image: ["Image", "Images"],
  video: ["Video", "Videos"],
  audio: ["Audio File", "Audio Files"],
  document: ["Document", "Documents"],
  pdf: ["PDF", "PDFs"],
};

export function kindNoun(kind: FileKind, count: number): string {
  return KIND_NOUN[kind][count === 1 ? 0 : 1];
}

/** "PNG Image", "MKV Video", "PDF". */
export function typeLabel(file: string): string {
  const kind = fileKind(file);
  const ext = extOf(file).toUpperCase() || "File";
  if (!kind) return `${ext} File`;
  if (kind === "pdf") return "PDF";
  return `${ext} ${kind === "audio" ? "Audio" : KIND_NOUN[kind][0]}`;
}

/** "0:42", "12:05", "1:02:03". */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = String(total % 60).padStart(2, "0");
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${seconds}` : `${minutes}:${seconds}`;
}

/**
 * The line of a tool's stderr worth showing. ImageMagick prefixes its name
 * and appends a source location; ffmpeg prefixes the stream; both follow
 * the real error with consequences such as "no images defined".
 */
export function toolError(stderr: string): string {
  // Beam maps the first audio stream for sound-only results.
  if (/Stream map '0:a:0' matches no streams/.test(stderr)) return "The file has no sound";
  const lines = stderr
    .split("\n")
    .map((line) =>
      line
        .replace(/^(convert|identify)(-im6(\.q\d+)?)?:\s*/, "")
        .replace(/\s+@ (error|warning)\/\S+\.c\/\w+\/\d+\.?$/, "")
        .replace(/^\[[^\]]+ @ 0x[0-9a-f]+\]\s*/, "")
        .trim(),
    )
    .filter((line) => line && !/^no images defined|^Error opening output files?/i.test(line));
  const line = lines[lines.length - 1] ?? "";
  return line.length > 300 ? line.slice(0, 299) + "…" : line;
}
