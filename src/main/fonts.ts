// Groups fontconfig's list of installed fonts into families and draws font samples as SVG. Pure.

/**
 * One line per face for `fc-list --format`. fontconfig expands the \t and \n
 * itself. `[0]` picks the first name; later ones are localized or
 * width-specific aliases such as "Noto Sans Telugu Condensed Thin".
 */
export const FC_FORMAT =
  "%{family[0]}\\t%{style[0]}\\t%{spacing}\\t%{fontformat}\\t%{variable}\\t%{weight}\\t%{slant}\\t%{width}\\t%{file}\\t%{charset}\\n";

export type FontLocation = "system" | "user" | "both";

export interface FontFamily {
  name: string;
  /** Named styles, upright before italic, light to heavy. */
  styles: string[];
  /** The regular face's file first. */
  files: string[];
  mono: boolean;
  /** A variable font: one file covers a range of weights or widths. */
  variable: boolean;
  /** "TrueType", "CFF" (OpenType) or "Type 1". */
  format: string;
  location: FontLocation;
  /** What to draw in the preview, from the charset of the family's first face. */
  sample: Sample;
}

interface Face {
  style: string;
  file: string;
  weight: number;
  slant: number;
  width: number;
}

/** fontconfig's spacing: 100 is monospace, 110 charcell; 90 (dual width, CJK) is not. */
const MONO_SPACING = new Set(["100", "110"]);

/** Fonts in the home folder are the user's own; everything else came with the system or a package. */
export function fontLocation(file: string, home: string): "system" | "user" {
  const h = home.replace(/\/+$/, "");
  return file.startsWith(`${h}/.local/share/fonts/`) || file.startsWith(`${h}/.fonts/`) ? "user" : "system";
}

/** fontconfig prints ranges such as "[0 205]" for variable fonts; the start stands in for sorting. */
const firstNumber = (text: string, fallback: number) => {
  const n = Number(text.replace(/^\[/, "").split(/\s+/)[0]);
  return Number.isFinite(n) && text !== "" ? n : fallback;
};

export function parseFcList(text: string, home: string): FontFamily[] {
  const families = new Map<string, Omit<FontFamily, "sample"> & { charset: string; faces: Map<string, Face>; locations: Set<string> }>();
  for (const line of text.split("\n")) {
    const [name, style, spacing, format, variable, weight, slant, width, file, charset] = line.split("\t");
    // Names starting with a dot are hidden system fonts by convention.
    if (!name || !file || name.startsWith(".")) continue;
    let family = families.get(name);
    if (!family) {
      family = {
        name,
        styles: [],
        files: [],
        mono: false,
        variable: false,
        format: format ?? "",
        location: "system",
        charset: charset ?? "",
        faces: new Map(),
        locations: new Set(),
      };
      families.set(name, family);
    }
    if (!family.files.includes(file)) family.files.push(file);
    family.locations.add(fontLocation(file, home));
    if (MONO_SPACING.has(spacing)) family.mono = true;
    // A variable font lists its whole range once, without a style, then each named instance.
    if (variable === "True") {
      family.variable = true;
      if (!style) continue;
    }
    const label = style || "Regular";
    if (!family.faces.has(label)) {
      family.faces.set(label, {
        style: label,
        file,
        weight: firstNumber(weight ?? "", 80),
        slant: firstNumber(slant ?? "", 0),
        width: firstNumber(width ?? "", 100),
      });
    }
  }
  const normalWidth = (face: Face) => Number(face.width !== 100);
  return [...families.values()]
    .map(({ faces, locations, charset, ...family }) => {
      const list = [...faces.values()];
      // fontconfig's weight 80 is Regular.
      const regular = [...list].sort(
        (a, b) => normalWidth(a) - normalWidth(b) || a.slant - b.slant || Math.abs(a.weight - 80) - Math.abs(b.weight - 80),
      )[0];
      const files = regular ? [regular.file, ...family.files.filter((f) => f !== regular.file)] : family.files;
      return {
        ...family,
        styles: list
          .sort((a, b) => normalWidth(a) - normalWidth(b) || a.width - b.width || a.slant - b.slant || a.weight - b.weight)
          .map((face) => face.style),
        files,
        location: (locations.size > 1 ? "both" : [...locations][0]) as FontLocation,
        sample: sampleFor(charset),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function parseCharset(charset: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (const token of charset.trim().split(/\s+/)) {
    const [lo, hi] = token.split("-").map((part) => parseInt(part, 16));
    if (Number.isFinite(lo)) ranges.push([lo, Number.isFinite(hi) ? hi : lo]);
  }
  return ranges;
}

function covers(ranges: Array<[number, number]>, from: number, to: number): boolean {
  for (let cp = from; cp <= to; cp++) {
    if (!ranges.some(([lo, hi]) => cp >= lo && cp <= hi)) return false;
  }
  return true;
}

export const PANGRAM = "The quick brown fox jumps over the lazy dog";

/** Punctuation, currency and helper glyphs (dotted circle, joiners) that nearly every font carries. */
const COMMON = [
  [0x2000, 0x20cf],
  [0x2212, 0x2212],
  [0x25cc, 0x25cc],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
];
const VISIBLE = /^[\p{L}\p{N}\p{S}\p{Co}]$/u;
const SAMPLE_GLYPHS = 18;

export type Sample = { kind: "latin"; uppercaseOnly: boolean } | { kind: "glyphs"; text: string };

/**
 * What a font can actually draw. Latin fonts get the pangram; fonts for other
 * scripts (most Noto families) or symbols get glyphs from the 128-character
 * block they cover most, so the preview never shows a fallback font's letters.
 */
export function sampleFor(charset: string): Sample {
  const ranges = parseCharset(charset);
  if (covers(ranges, 0x41, 0x5a)) return { kind: "latin", uppercaseOnly: !covers(ranges, 0x61, 0x7a) };
  const counts = new Map<number, number>();
  for (const [lo, hi] of ranges) {
    const start = Math.max(lo, 0x100);
    for (let block = start >> 7; block <= hi >> 7; block++) {
      const from = Math.max(start, block << 7);
      const to = Math.min(hi, (block << 7) + 127);
      if (to < from || COMMON.some(([a, b]) => from >= a && to <= b)) continue;
      counts.set(block, (counts.get(block) ?? 0) + to - from + 1);
    }
  }
  // Among equally full blocks, CJK fonts show the everyday ideographs at U+4E00 rather than Extension A.
  const common = 0x4e00 >> 7;
  const blocks = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || Number(b[0] === common) - Number(a[0] === common))
    .map(([block]) => block);
  for (const block of blocks.slice(0, 4)) {
    const glyphs: string[] = [];
    for (const [lo, hi] of ranges) {
      for (let cp = Math.max(lo, block << 7); cp <= Math.min(hi, (block << 7) + 127) && glyphs.length < SAMPLE_GLYPHS; cp++) {
        const ch = String.fromCodePoint(cp);
        if (VISIBLE.test(ch)) glyphs.push(ch);
      }
    }
    if (glyphs.length >= 3) return { kind: "glyphs", text: glyphs.join(" ") };
  }
  return { kind: "glyphs", text: "" };
}

/** A generic family for CSS fallbacks, guessed from the name and spacing. */
export function genericFamily(family: FontFamily): string {
  if (/emoji/i.test(family.name)) return "emoji";
  if (family.mono) return "monospace";
  if (/\bserif\b|roman|libertine|charter|bookman|gentium|caladea|\bc059\b|\bp052\b/i.test(family.name)) return "serif";
  if (/script|hand|chancery|\bz003\b/i.test(family.name)) return "cursive";
  return "sans-serif";
}

export function cssFontFamily(family: FontFamily): string {
  return `font-family: "${family.name.replace(/(["\\])/g, "\\$1")}", ${genericFamily(family)};`;
}

/**
 * Text typed after a quote is previewed instead of the pangram. After a
 * closing quote the rest filters the list: `"Hello world" mono`.
 */
export function splitPreviewQuery(query: string): { text: string | null; filter: string } {
  const match = query.match(/^\s*["'“‘]([^"'”’]*)(?:["'”’]\s*(.*))?$/);
  if (!match) return { text: null, filter: query.trim() };
  return { text: match[1].trim() ? match[1] : null, filter: (match[2] ?? "").trim() };
}

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Greedy word wrap by an estimated glyph width; long words are broken. */
export function wrapText(text: string, maxChars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    let rest = word;
    while ([...rest].length > maxChars) {
      if (line) lines.push(line), (line = "");
      const chars = [...rest];
      lines.push(chars.slice(0, maxChars).join(""));
      rest = chars.slice(maxChars).join("");
    }
    if (!line) line = rest;
    else if ([...`${line} ${rest}`].length <= maxChars) line = `${line} ${rest}`;
    else lines.push(line), (line = rest);
  }
  if (line) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    const last = [...kept[maxLines - 1]];
    kept[maxLines - 1] = `${(last.length < maxChars ? last : last.slice(0, -1)).join("")}…`;
    return kept;
  }
  return lines;
}

export interface PreviewColors {
  text: string;
  dim: string;
}

const WIDTH = 340;
/** Average advance as a share of the font size; generous so wide faces still fit. */
const AVG_ADVANCE = 0.6;

interface Span {
  text: string;
  weight?: number;
  italic?: boolean;
}

interface Row {
  spans: Span[];
  size: number;
  dim?: boolean;
  /** Extra space above the row. */
  gap?: number;
}

/**
 * The preview pane's sample, drawn by Chromium with the installed font
 * itself: an SVG in an <img> may use system fonts by family name.
 */
export function fontPreviewSvg(family: FontFamily, colors: PreviewColors, custom: string | null = null): string {
  const rows: Row[] = [];
  const add = (text: string, size: number, maxLines: number, dim = false, gap = 0) => {
    wrapText(text, Math.floor(WIDTH / (size * AVG_ADVANCE)), maxLines).forEach((line, i) =>
      rows.push({ spans: [{ text: line }], size, dim, gap: i ? 0 : gap }),
    );
  };
  const sample = family.sample;
  if (custom) {
    add(custom, 30, 5);
  } else if (sample.kind === "glyphs") {
    add(sample.text || "No visible characters", 30, 4);
  } else {
    const upper = sample.uppercaseOnly;
    add(upper ? PANGRAM.toUpperCase() : PANGRAM, 24, 2);
    add("ABCDEFGHIJKLMNOPQRSTUVWXYZ", 17, 2, true, 10);
    if (!upper) add("abcdefghijklmnopqrstuvwxyz", 17, 2, true);
    add("0123456789 &@?!%#(){}", 17, 1, true);
    const spans: Span[] = [{ text: "Regular" }];
    if (family.styles.some((s) => /bold|black|heavy/i.test(s))) spans.push({ text: "Bold", weight: 700 });
    if (family.styles.some((s) => /italic|oblique/i.test(s))) spans.push({ text: "Italic", italic: true });
    if (spans.length > 1) rows.push({ spans, size: 16, gap: 10 });
  }

  let y = 4;
  const lines = rows.map((row) => {
    y += (row.gap ?? 0) + Math.round(row.size * 1.3);
    const spans = row.spans
      .map((span, i) => {
        const attrs = [
          i ? `dx="14"` : "",
          span.weight ? `font-weight="${span.weight}"` : "",
          span.italic ? `font-style="italic"` : "",
        ].filter(Boolean).join(" ");
        return `<tspan${attrs ? ` ${attrs}` : ""}>${xml(span.text)}</tspan>`;
      })
      .join("");
    return `<text x="0" y="${y}" font-size="${row.size}" fill="${xml(row.dim ? colors.dim : colors.text)}">${spans}</text>`;
  });
  const height = y + 12;
  const face = `'${family.name.replace(/['\\]/g, "")}'`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">` +
    `<g font-family="${xml(face)}">${lines.join("")}</g></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** The list icon: "Aa" (or the font's first sample glyph) drawn in the font itself. */
export function fontIconSvg(family: FontFamily, color: string): string {
  const sample = family.sample;
  const text = sample.kind === "latin" ? (sample.uppercaseOnly ? "AA" : "Aa") : [...sample.text][0] ?? "?";
  const face = `'${family.name.replace(/['\\]/g, "")}'`;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">` +
    `<text x="11" y="16" text-anchor="middle" font-size="14" font-family="${xml(face)}" fill="${xml(color)}">${xml(text)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** The preview pane's text under the sample. */
export function fontDetails(family: FontFamily): string {
  const where = { system: "System", user: "Your fonts (~/.local/share/fonts)", both: "System and your fonts" }[family.location];
  const kind = [family.mono ? "Monospace" : "", family.variable ? "Variable" : "", family.format].filter(Boolean).join(" · ");
  return [
    family.name,
    "",
    `Styles     ${family.styles.length}${family.variable ? " named" : ""}`,
    `Type       ${kind || "—"}`,
    `Installed  ${where}`,
    `Files      ${family.files.length}`,
    "",
    family.styles.join(", "),
    "",
    ...family.files.slice(0, 6),
    ...(family.files.length > 6 ? [`… and ${family.files.length - 6} more`] : []),
  ].join("\n");
}
