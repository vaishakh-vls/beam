// Parses gio's answers about file types and formats Quick Look text. Pure, so it can be tested.

export interface MimeApps {
  /** Desktop id of the app the file opens with today, e.g. "org.gnome.eog.desktop". */
  defaultApp: string | null;
  /** Apps that say they handle the type, recommended ones first, without duplicates. */
  apps: string[];
}

/**
 * `gio mime <type>`. The headings are translated, so only their shape is
 * relied on: the default is the desktop id at the end of the first line and
 * the apps are the indented lines.
 */
export function parseGioMime(text: string): MimeApps {
  const lines = text.split("\n");
  const defaultApp = /(\S+\.desktop)\s*$/.exec(lines[0] ?? "")?.[1] ?? null;
  const registered: string[] = [];
  const recommended: string[] = [];
  // Two headings follow: registered apps (or "No registered applications"), then recommended ones.
  let headings = 0;
  for (const line of lines.slice(1)) {
    if (/^\s+\S/.test(line)) (headings >= 2 ? recommended : registered).push(line.trim());
    else if (line.trim()) headings++;
  }
  const apps = [...new Set([...recommended, ...registered])].filter((id) => id !== defaultApp);
  return { defaultApp, apps };
}

/** The type from `gio info -a standard::content-type <file>`, e.g. "application/json". */
export function parseContentType(text: string): string | null {
  return /standard::content-type:\s*(\S+)/.exec(text)?.[1] ?? null;
}

/** Text files have no NUL bytes; a NUL in the first few KB means binary, as `grep` decides. */
export function looksBinary(bytes: Uint8Array): boolean {
  return bytes.subarray(0, 8192).includes(0);
}

const JSON_TYPES = new Set(["application/json", "application/ld+json", "application/geo+json", "application/manifest+json"]);

export function isJsonFile(name: string, mime: string | null): boolean {
  return (mime !== null && JSON_TYPES.has(mime)) || /\.(json|jsonc|geojson|webmanifest)$/i.test(name);
}

/** Pretty JSON with two-space indent, or null when the text isn't valid JSON (a truncated file, JSONC). */
export function prettyJson(text: string): string | null {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return null;
  }
}

/** Image types Chromium can show from a data: URL. */
const IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "image/avif",
]);

export function isPreviewableImage(mime: string | null): boolean {
  return mime !== null && IMAGE_TYPES.has(mime);
}

const TYPE_NAMES: Record<string, string> = {
  "inode/directory": "Folder",
  "application/json": "JSON",
  "application/pdf": "PDF",
  "application/xml": "XML",
  "application/yaml": "YAML",
  "application/zip": "ZIP",
  "text/plain": "Text",
  "text/markdown": "Markdown",
  "text/html": "HTML",
  "text/csv": "CSV",
};

/** "Folder" for inode/directory, "PNG image" for image/png, the raw type when it has no plain name. */
export function describeType(mime: string | null): string {
  if (!mime) return "Unknown type";
  if (TYPE_NAMES[mime]) return TYPE_NAMES[mime];
  const [kind, sub = ""] = mime.split("/");
  const name = sub.replace(/^(x-|vnd\.)/, "").replace(/\+xml$/, "").toUpperCase();
  if (kind === "image") return `${name} image`;
  if (kind === "video") return `${name} video`;
  if (kind === "audio") return `${name} audio`;
  return mime;
}
