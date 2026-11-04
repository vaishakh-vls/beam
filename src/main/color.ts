// Parses typed colors (#hex, rgb(), hsl()) and formats them as HEX, RGB, HSL and OKLCH.

export interface Rgb {
  /** Channels are whole numbers, 0–255. */
  r: number;
  g: number;
  b: number;
  /** Opacity, 0–1. */
  a: number;
}

export interface SavedColor {
  /** "#RRGGBB", or "#RRGGBBAA" for translucent colors. */
  hex: string;
  savedAt: number;
}

const HEX = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const NUMBER = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))(%|deg|turn|rad|grad)?$/;

/**
 * The color a string names, or null. Hex needs a leading "#" unless
 * `bareHex` is set, and even then only 6 or 8 digits count, so plain
 * numbers like "123" are never taken for colors.
 */
export function parseColor(input: string, options: { bareHex?: boolean } = {}): Rgb | null {
  const text = input.trim().toLowerCase();
  const hex = HEX.exec(text);
  if (hex) {
    const digits = hex[1];
    if (!text.startsWith("#") && !(options.bareHex && (digits.length === 6 || digits.length === 8))) return null;
    return parseHexDigits(digits);
  }
  const fn = /^(rgba?|hsla?)\(\s*(.*?)\s*\)$/.exec(text);
  if (!fn) return null;
  const args = splitArgs(fn[2]);
  if (!args) return null;
  return fn[1].startsWith("rgb") ? fromRgbArgs(args) : fromHslArgs(args);
}

function parseHexDigits(digits: string): Rgb {
  const full = digits.length <= 4 ? [...digits].map((d) => d + d).join("") : digits;
  const channel = (i: number) => parseInt(full.slice(i * 2, i * 2 + 2), 16);
  return { r: channel(0), g: channel(1), b: channel(2), a: full.length === 8 ? round(channel(3) / 255, 3) : 1 };
}

interface Args {
  values: string[];
  alpha?: string;
}

/** "255, 136, 0", "255,136,0,0.5", "255 136 0" and "255 136 0 / 50%". */
function splitArgs(body: string): Args | null {
  const parts = body.split("/");
  if (parts.length > 2) return null;
  const [main, slashAlpha] = parts.map((p) => p.trim());
  if (main.includes(",")) {
    if (slashAlpha !== undefined) return null;
    const values = main.split(",").map((v) => v.trim());
    if (values.length !== 3 && values.length !== 4) return null;
    return { values: values.slice(0, 3), alpha: values[3] };
  }
  const values = main.split(/\s+/).filter(Boolean);
  if (values.length !== 3) return null;
  return { values, alpha: slashAlpha };
}

function parseNumber(token: string): { value: number; unit: string } | null {
  const match = NUMBER.exec(token);
  if (!match) return null;
  return { value: Number(match[1]), unit: match[2] ?? "" };
}

/** A 0–1 opacity from "0.5" or "50%"; 1 when absent. */
function parseAlpha(token: string | undefined): number | null {
  if (token === undefined) return 1;
  const n = parseNumber(token);
  if (!n || (n.unit && n.unit !== "%")) return null;
  const value = n.unit === "%" ? n.value / 100 : n.value;
  return value >= 0 && value <= 1 ? round(value, 3) : null;
}

function fromRgbArgs({ values, alpha }: Args): Rgb | null {
  const channels: number[] = [];
  for (const token of values) {
    const n = parseNumber(token);
    if (!n || (n.unit && n.unit !== "%")) return null;
    const value = n.unit === "%" ? (n.value / 100) * 255 : n.value;
    if (!(value >= 0 && value <= 255)) return null;
    channels.push(Math.round(value));
  }
  const a = parseAlpha(alpha);
  if (a === null) return null;
  return { r: channels[0], g: channels[1], b: channels[2], a };
}

function fromHslArgs({ values, alpha }: Args): Rgb | null {
  const [hueToken, satToken, lightToken] = values.map(parseNumber);
  if (!hueToken || !satToken || !lightToken) return null;
  const hue = toDegrees(hueToken.value, hueToken.unit);
  if (hue === null) return null;
  const percents = [satToken, lightToken].map(({ value, unit }) => (unit === "%" || unit === "" ? value : NaN));
  if (percents.some((p) => !(p >= 0 && p <= 100))) return null;
  const a = parseAlpha(alpha);
  if (a === null) return null;
  return { ...hslToRgb(hue, percents[0], percents[1]), a };
}

function toDegrees(value: number, unit: string): number | null {
  const factor: Record<string, number> = { "": 1, deg: 1, turn: 360, rad: 180 / Math.PI, grad: 0.9 };
  if (!(unit in factor)) return null;
  return (((value * factor[unit]) % 360) + 360) % 360;
}

/** Hue in degrees, saturation and lightness in percent. */
export function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const sat = s / 100;
  const light = l / 100;
  const amount = sat * Math.min(light, 1 - light);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round((light - amount * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return { r: channel(0), g: channel(8), b: channel(4) };
}

export function rgbToHsl({ r, g, b }: Rgb): { h: number; s: number; l: number } {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l: l * 100 };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = max === rn ? ((gn - bn) / d) % 6 : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s: s * 100, l: l * 100 };
}

/** OKLCH: perceptual lightness (0–1), chroma and hue in degrees. */
export function rgbToOklch({ r, g, b }: Rgb): { l: number; c: number; h: number } {
  const linear = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [lr, lg, lb] = [linear(r), linear(g), linear(b)];
  const l_ = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m_ = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s_ = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_;
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_;
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_;
  const c = Math.hypot(A, B);
  const h = ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360;
  return { l: L, c, h };
}

function round(value: number, digits: number): number {
  return Number(value.toFixed(digits));
}

function hex2(value: number): string {
  return value.toString(16).padStart(2, "0");
}

export function toHex(color: Rgb): string {
  const alpha = color.a < 1 ? hex2(Math.round(color.a * 255)) : "";
  return `#${hex2(color.r)}${hex2(color.g)}${hex2(color.b)}${alpha}`.toUpperCase();
}

export function toRgbString({ r, g, b, a }: Rgb): string {
  return a < 1 ? `rgba(${r}, ${g}, ${b}, ${round(a, 2)})` : `rgb(${r}, ${g}, ${b})`;
}

export function toHslString(color: Rgb): string {
  const { h, s, l } = rgbToHsl(color);
  const body = `${Math.round(h) % 360}, ${Math.round(s)}%, ${Math.round(l)}%`;
  return color.a < 1 ? `hsla(${body}, ${round(color.a, 2)})` : `hsl(${body})`;
}

export function toOklchString(color: Rgb): string {
  const { l, c, h } = rgbToOklch(color);
  // Greys have no meaningful hue.
  const grey = c < 0.0005;
  const body = `${round(l * 100, 1)}% ${grey ? 0 : round(c, 3)} ${grey ? 0 : round(h, 1)}`;
  return color.a < 1 ? `oklch(${body} / ${round(color.a, 2)})` : `oklch(${body})`;
}

/** The lines shown in the preview pane. */
export function colorDetails(color: Rgb): string {
  return [
    `HEX    ${toHex(color)}`,
    `RGB    ${toRgbString(color)}`,
    `HSL    ${toHslString(color)}`,
    `OKLCH  ${toOklchString(color)}`,
  ].join("\n");
}

/** An SVG swatch as a data: URL, for icons and the preview pane. */
export function swatchUrl(color: Rgb, width: number, height: number, radius: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="${radius}" fill="${toHex(color)}" stroke="#8888" stroke-width="1"/>` +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * The picker helper prints "r g b" as 0–1 floats (the portal's format) or a
 * hex color. Tiny overshoots from float rounding are clamped.
 */
export function parsePickerOutput(output: string): Rgb | null {
  const text = output.trim();
  const floats = text.split(/\s+/);
  if (floats.length === 3) {
    const values = floats.map(Number);
    if (!values.every((v) => Number.isFinite(v) && v >= -0.01 && v <= 1.01)) return null;
    const [r, g, b] = values.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
    return { r, g, b, a: 1 };
  }
  return parseColor(text, { bareHex: true });
}

/** History with `hex` moved to the front, without duplicates, at most `max` long. */
export function addToHistory(history: SavedColor[], hex: string, now: number, max: number): SavedColor[] {
  return [{ hex, savedAt: now }, ...history.filter((c) => c.hex !== hex)].slice(0, max);
}

export function ageLabel(then: number, now: number): string {
  const seconds = Math.round((now - then) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
