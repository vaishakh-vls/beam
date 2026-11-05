// Beam's window themes: built-in palettes, user theme files, and the CSS variables the renderer applies. Pure.

/** The CSS variables in src/renderer/styles.css :root that a theme sets. */
export const THEME_VARS = [
  "--glass",
  "--glass-tint",
  "--bg-elevated",
  "--border",
  "--border-strong",
  "--text",
  "--text-dim",
  "--text-faint",
  "--selected",
  "--accent",
  "--danger",
  "--kbd-bg",
  "--radius",
] as const;
export type ThemeVar = (typeof THEME_VARS)[number];

export type Appearance = "dark" | "light";

/** The few colors a theme is made from; everything else is derived. All hex, "#rrggbb" or "#rrggbbaa". */
export interface Palette {
  background: string;
  text: string;
  accent: string;
  /** Action panel and other raised surfaces. */
  elevated?: string;
  /** The selected row. */
  selected?: string;
  /** Secondary text: subtitles, labels. */
  dim?: string;
  /** Placeholders and hints. */
  faint?: string;
  danger?: string;
}
export type PaletteRole = keyof Palette;
const ROLES: PaletteRole[] = ["background", "text", "accent", "elevated", "selected", "dim", "faint", "danger"];

export interface Theme {
  id: string;
  name: string;
  appearance: Appearance;
  palette: Required<Palette>;
  vars: Record<ThemeVar, string>;
  /** Set for themes loaded from ~/.config/beam/themes. */
  file?: string;
}

/** What the renderer receives. */
export interface AppliedTheme {
  id: string;
  name: string;
  scheme: Appearance;
  vars: Record<string, string>;
}

/** What preload exposes to the renderer as window.beamTheme. */
export interface BeamThemeApi {
  current(): Promise<AppliedTheme>;
  onChange(callback: (theme: AppliedTheme) => void): void;
}

export const SYSTEM_THEME_ID = "system";
export const DEFAULT_THEME_ID = "beam-dark";
export const USER_THEME_PREFIX = "user:";

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseHex(hex: string): Rgba | null {
  const m = hex.trim().match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (!m) return null;
  let digits = m[1];
  if (digits.length <= 4) digits = [...digits].map((d) => d + d).join("");
  const n = (i: number) => parseInt(digits.slice(i, i + 2), 16);
  return { r: n(0), g: n(2), b: n(4), a: digits.length === 8 ? Math.round((n(6) / 255) * 1000) / 1000 : 1 };
}

/** A palette color at `alpha` (times its own alpha) as CSS rgba(). */
function rgba(hex: string, alpha = 1): string {
  const c = parseHex(hex)!;
  const a = Math.round(c.a * alpha * 1000) / 1000;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`;
}

/** "#rrggbb", or "#rrggbbaa" when not opaque. */
function hexAt(hex: string, alpha = 1): string {
  const c = parseHex(hex)!;
  const a = Math.round(c.a * alpha * 255);
  return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}${a >= 255 ? "" : a.toString(16).padStart(2, "0")}`;
}

function mix(a: string, b: string, t: number): string {
  const x = parseHex(a)!;
  const y = parseHex(b)!;
  const ch = (p: number, q: number) => Math.round(p + (q - p) * t).toString(16).padStart(2, "0");
  return `#${ch(x.r, y.r)}${ch(x.g, y.g)}${ch(x.b, y.b)}`;
}

/** Fills in the optional roles from the required three. */
export function completePalette(palette: Palette, appearance: Appearance): Required<Palette> {
  const dark = appearance === "dark";
  const given = (color: string | undefined) => (color ? hexAt(color) : undefined);
  return {
    background: hexAt(palette.background),
    text: hexAt(palette.text),
    accent: hexAt(palette.accent),
    elevated: given(palette.elevated) ?? mix(palette.background, palette.text, dark ? 0.1 : 0.04),
    selected: given(palette.selected) ?? hexAt(palette.text, dark ? 0.1 : 0.07),
    dim: given(palette.dim) ?? hexAt(palette.text, 0.62),
    faint: given(palette.faint) ?? hexAt(palette.text, 0.4),
    danger: given(palette.danger) ?? (dark ? "#ff6b6b" : "#d63c3c"),
  };
}

/** The CSS variables for a palette; the glass stays slightly see-through like Beam's own. */
export function deriveVars(p: Required<Palette>, appearance: Appearance): Record<ThemeVar, string> {
  const dark = appearance === "dark";
  const highlight = "#ffffff";
  return {
    "--glass": rgba(p.background, dark ? 0.96 : 0.97),
    "--glass-tint": `linear-gradient(160deg, ${rgba(highlight, dark ? 0.05 : 0.5)} 0%, ${rgba(highlight, dark ? 0.012 : 0.12)} 38%, ${rgba(p.accent, 0.045)} 100%)`,
    "--bg-elevated": rgba(p.elevated, 0.97),
    "--border": rgba(p.text, dark ? 0.08 : 0.1),
    "--border-strong": rgba(p.text, dark ? 0.16 : 0.18),
    "--text": p.text,
    "--text-dim": rgba(p.dim),
    "--text-faint": rgba(p.faint),
    "--selected": rgba(p.selected),
    "--accent": p.accent,
    "--danger": p.danger,
    "--kbd-bg": rgba(p.text, dark ? 0.09 : 0.07),
    "--radius": "16px",
  };
}

function theme(id: string, name: string, appearance: Appearance, palette: Palette, overrides: Partial<Record<ThemeVar, string>> = {}): Theme {
  const full = completePalette(palette, appearance);
  return { id, name, appearance, palette: full, vars: { ...deriveVars(full, appearance), ...overrides } };
}

/**
 * Beam Dark is styles.css as shipped; the others use their projects'
 * published palettes (catppuccin.com, nordtheme.com, tokyonight, gruvbox,
 * draculatheme.com/spec, rosepinetheme.com).
 */
export const BUILTIN_THEMES: Theme[] = [
  theme(
    "beam-dark",
    "Beam Dark",
    "dark",
    { background: "#0c0c11", elevated: "#24242d", selected: "#ffffff1a", text: "#f4f4f7", dim: "#ebebf59e", faint: "#ebebf566", accent: "#8b7bff", danger: "#ff6b6b" },
    {
      "--glass": "rgba(12, 12, 17, 0.96)",
      "--glass-tint": "linear-gradient(160deg, rgba(255, 255, 255, 0.06) 0%, rgba(255, 255, 255, 0.015) 38%, rgba(120, 110, 255, 0.035) 100%)",
      "--bg-elevated": "rgba(36, 36, 45, 0.96)",
      "--border": "rgba(255, 255, 255, 0.08)",
      "--border-strong": "rgba(255, 255, 255, 0.16)",
      "--text-dim": "rgba(235, 235, 245, 0.62)",
      "--text-faint": "rgba(235, 235, 245, 0.4)",
      "--selected": "rgba(255, 255, 255, 0.10)",
      "--kbd-bg": "rgba(255, 255, 255, 0.09)",
    },
  ),
  theme("beam-light", "Beam Light", "light", {
    background: "#f6f6f9", elevated: "#ffffff", text: "#1d1d24", dim: "#1d1d249e", faint: "#1d1d246b", accent: "#6a5af9", danger: "#d63c3c",
  }),
  theme("catppuccin-mocha", "Catppuccin Mocha", "dark", {
    background: "#1e1e2e", elevated: "#313244", selected: "#45475acc", text: "#cdd6f4", dim: "#a6adc8", faint: "#7f849c", accent: "#cba6f7", danger: "#f38ba8",
  }),
  theme("catppuccin-latte", "Catppuccin Latte", "light", {
    background: "#eff1f5", elevated: "#e6e9ef", selected: "#bcc0cc99", text: "#4c4f69", dim: "#6c6f85", faint: "#8c8fa1", accent: "#8839ef", danger: "#d20f39",
  }),
  theme("nord", "Nord", "dark", {
    background: "#2e3440", elevated: "#3b4252", selected: "#434c5ecc", text: "#eceff4", dim: "#d8dee9b3", faint: "#d8dee973", accent: "#88c0d0", danger: "#bf616a",
  }),
  theme("tokyo-night", "Tokyo Night", "dark", {
    background: "#1a1b26", elevated: "#24283b", selected: "#283457", text: "#c0caf5", dim: "#a9b1d6", faint: "#565f89", accent: "#7aa2f7", danger: "#f7768e",
  }),
  theme("gruvbox-dark", "Gruvbox Dark", "dark", {
    background: "#282828", elevated: "#3c3836", selected: "#504945cc", text: "#ebdbb2", dim: "#bdae93", faint: "#928374", accent: "#fabd2f", danger: "#fb4934",
  }),
  theme("dracula", "Dracula", "dark", {
    background: "#282a36", elevated: "#343746", selected: "#44475a", text: "#f8f8f2", dim: "#f8f8f2a6", faint: "#6272a4", accent: "#bd93f9", danger: "#ff5555",
  }),
  theme("rose-pine", "Rosé Pine", "dark", {
    background: "#191724", elevated: "#26233a", selected: "#403d52", text: "#e0def4", dim: "#908caa", faint: "#6e6a86", accent: "#c4a7e7", danger: "#eb6f92",
  }),
  theme("rose-pine-dawn", "Rosé Pine Dawn", "light", {
    background: "#faf4ed", elevated: "#fffaf3", selected: "#dfdad9", text: "#575279", dim: "#797593", faint: "#9893a5", accent: "#907aa9", danger: "#b4637a",
  }),
];

/** Follow System picks these by GNOME's dark style setting. */
export const SYSTEM_PAIR: Record<Appearance, string> = { dark: "beam-dark", light: "beam-light" };

/** `gsettings get org.gnome.desktop.interface color-scheme` prints 'prefer-dark', 'prefer-light' or 'default' (light). */
export function parseColorScheme(output: string): Appearance {
  return output.includes("prefer-dark") ? "dark" : "light";
}

/**
 * Values are set with style.setProperty, which can't escape into other
 * rules; refusing url() and friends also keeps theme files from loading
 * anything from outside.
 */
export function isSafeCssValue(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 300 &&
    !/[;{}<>\\@]|url\s*\(|image(-set)?\s*\(|expression\s*\(|!important/i.test(value)
  );
}

/**
 * A theme file in ~/.config/beam/themes. Only `name` and one color are
 * needed; missing colors come from Beam Dark or Beam Light:
 *
 *   { "name": "Ocean", "appearance": "dark",
 *     "colors": { "background": "#0f1c2e", "text": "#e6edf3", "accent": "#4fb3ff" },
 *     "vars": { "--radius": "10px" } }
 */
export function parseUserTheme(text: string, fileId: string, file?: string): Theme | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return { error: `Not valid JSON: ${(error as Error).message}` };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Expected a JSON object." };
  const data = raw as Record<string, unknown>;
  const appearance: Appearance = data.appearance === "light" ? "light" : "dark";
  if (data.appearance !== undefined && data.appearance !== "dark" && data.appearance !== "light") {
    return { error: `"appearance" must be "dark" or "light".` };
  }
  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim().slice(0, 60) : fileId;
  const base = BUILTIN_THEMES.find((t) => t.id === SYSTEM_PAIR[appearance])!;

  const colors = (data.colors ?? {}) as Record<string, unknown>;
  if (typeof colors !== "object" || Array.isArray(colors)) return { error: `"colors" must be an object.` };
  const palette: Palette = { background: base.palette.background, text: base.palette.text, accent: base.palette.accent };
  for (const [role, value] of Object.entries(colors)) {
    if (!ROLES.includes(role as PaletteRole)) return { error: `Unknown color "${role}". Use: ${ROLES.join(", ")}.` };
    if (typeof value !== "string" || !parseHex(value)) return { error: `"${role}" must be a hex color such as "#1e1e2e".` };
    palette[role as PaletteRole] = value;
  }
  // A theme that changes the background or text but not the shades derived from them gets fresh shades.
  const changesBase = colors.background !== undefined || colors.text !== undefined;
  for (const role of ["elevated", "selected", "dim", "faint", "danger"] as const) {
    if (palette[role] === undefined && !changesBase) palette[role] = base.palette[role];
  }

  const vars = (data.vars ?? {}) as Record<string, unknown>;
  if (typeof vars !== "object" || Array.isArray(vars)) return { error: `"vars" must be an object.` };
  const overrides: Partial<Record<ThemeVar, string>> = {};
  for (const [key, value] of Object.entries(vars)) {
    const varName = (key.startsWith("--") ? key : `--${key}`) as ThemeVar;
    if (!THEME_VARS.includes(varName)) return { error: `Unknown variable "${key}". Use: ${THEME_VARS.join(", ")}.` };
    if (!isSafeCssValue(value)) return { error: `"${key}" has a value Beam won't apply.` };
    if (varName === "--radius" && !/^(\d|[1-3]\d|40)(\.\d+)?px$/.test(value.trim())) return { error: `"--radius" must be 0px–40px.` };
    overrides[varName] = value.trim();
  }
  return { ...theme(`${USER_THEME_PREFIX}${fileId}`, name, appearance, palette, overrides), file };
}

/** The theme for a saved choice; unknown ids (a deleted file) fall back to Beam Dark. */
export function resolveTheme(id: string, userThemes: Theme[], systemScheme: Appearance): Theme {
  const wanted = id === SYSTEM_THEME_ID ? SYSTEM_PAIR[systemScheme] : id;
  return (
    BUILTIN_THEMES.find((t) => t.id === wanted) ??
    userThemes.find((t) => t.id === wanted) ??
    BUILTIN_THEMES.find((t) => t.id === DEFAULT_THEME_ID)!
  );
}

export function appliedTheme(theme: Theme): AppliedTheme {
  return { id: theme.id, name: theme.name, scheme: theme.appearance, vars: { ...theme.vars } };
}

/** A theme file with every color spelled out, as a starting point for "New Theme from This". */
export function themeFileText(source: Theme, name: string): string {
  const { background, text, accent, elevated, selected, dim, faint, danger } = source.palette;
  return JSON.stringify(
    { name, appearance: source.appearance, colors: { background, text, accent, elevated, selected, dim, faint, danger }, vars: { "--radius": source.vars["--radius"] } },
    null,
    2,
  ) + "\n";
}

/** A file name for a new theme: lowercase words joined by dashes. */
export function themeSlug(name: string): string {
  return name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-").slice(0, 40) || "theme";
}

function svgUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** An opaque color for drawing: a palette color flattened onto the background. */
function solid(color: string, background: string, alpha = 1): string {
  const c = parseHex(color)!;
  const rgb = `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  return mix(background, rgb, c.a * alpha);
}

/** A miniature Beam window in the theme's colors, for the preview pane. */
export function themePreviewSvg(t: Theme): string {
  const p = t.palette;
  const bg = p.background;
  const fg = solid(p.text, bg);
  const dim = solid(p.dim, bg);
  const faint = solid(p.faint, bg);
  const sel = solid(p.selected, bg);
  const line = solid(p.text, bg, t.appearance === "dark" ? 0.16 : 0.18);
  const kbd = solid(p.text, bg, 0.09);
  const row = (y: number, selected: boolean, w1: number, w2: number) =>
    (selected ? `<rect x="10" y="${y - 4}" width="320" height="30" rx="8" fill="${sel}"/>` : "") +
    `<rect x="22" y="${y + 3}" width="16" height="16" rx="5" fill="${selected ? p.accent : dim}"/>` +
    `<rect x="48" y="${y + 6}" width="${w1}" height="9" rx="4.5" fill="${fg}"/>` +
    `<rect x="${56 + w1}" y="${y + 6}" width="${w2}" height="9" rx="4.5" fill="${dim}"/>` +
    `<rect x="${282}" y="${y + 6}" width="36" height="9" rx="4.5" fill="${faint}"/>`;
  const swatches = [p.background, p.elevated, p.text, p.dim, p.accent, p.danger]
    .map((c, i) => `<circle cx="${30 + i * 22}" cy="214" r="8" fill="${solid(c, bg)}" stroke="${line}" stroke-width="1"/>`)
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="340" height="230" viewBox="0 0 340 230">` +
    `<rect x="0.5" y="0.5" width="339" height="195" rx="14" fill="${bg}" stroke="${line}"/>` +
    `<rect x="22" y="20" width="110" height="12" rx="6" fill="${faint}"/>` +
    `<rect x="276" y="17" width="44" height="18" rx="5" fill="${kbd}"/>` +
    `<rect x="0" y="50" width="340" height="1" fill="${line}"/>` +
    row(66, true, 92, 60) +
    row(98, false, 120, 48) +
    row(130, false, 76, 84) +
    `<rect x="0" y="162" width="340" height="1" fill="${line}"/>` +
    `<rect x="22" y="174" width="40" height="8" rx="4" fill="${faint}"/>` +
    `<rect x="236" y="172" width="58" height="12" rx="4" fill="${dim}"/>` +
    `<rect x="300" y="170" width="22" height="16" rx="4" fill="${kbd}"/>` +
    swatches +
    `</svg>`;
  return svgUrl(svg);
}

/** A small icon for the list: the background with the accent and text colors. */
export function themeIconSvg(t: Theme): string {
  const p = t.palette;
  const edge = solid(p.text, p.background, 0.25);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">` +
    `<rect x="0.5" y="0.5" width="21" height="21" rx="6" fill="${p.background}" stroke="${edge}"/>` +
    `<circle cx="8" cy="11" r="4" fill="${p.accent}"/>` +
    `<rect x="13" y="7.5" width="5" height="2.5" rx="1.25" fill="${solid(p.text, p.background)}"/>` +
    `<rect x="13" y="12" width="4" height="2.5" rx="1.25" fill="${solid(p.dim, p.background)}"/>` +
    `</svg>`;
  return svgUrl(svg);
}

/** The preview pane's text under the miniature. */
export function themeDetails(t: Theme, note = ""): string {
  const p = t.palette;
  return [
    t.name,
    note,
    "",
    `Appearance  ${t.appearance === "dark" ? "Dark" : "Light"}`,
    `Background  ${p.background}`,
    `Text        ${p.text}`,
    `Accent      ${p.accent}`,
    `Selection   ${p.selected}`,
    `Danger      ${p.danger}`,
    ...(t.file ? ["", t.file] : []),
  ].filter((line, i) => i !== 1 || line).join("\n");
}
