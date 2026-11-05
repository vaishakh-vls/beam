import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import {
  appliedTheme,
  BUILTIN_THEMES,
  completePalette,
  isSafeCssValue,
  parseColorScheme,
  parseHex,
  parseUserTheme,
  resolveTheme,
  SYSTEM_THEME_ID,
  THEME_VARS,
  themeDetails,
  themeFileText,
  themeIconSvg,
  themePreviewSvg,
  themeSlug,
  type Theme,
} from "../src/main/themes.ts";

const css = fs.readFileSync(new URL("../src/renderer/styles.css", import.meta.url), "utf8");

test("Beam Dark is exactly the :root of styles.css", () => {
  const root = css.match(/:root\s*{([\s\S]*?)\n}/)![1];
  const dark = BUILTIN_THEMES.find((t) => t.id === "beam-dark")!;
  for (const name of THEME_VARS) {
    const match = root.match(new RegExp(`${name}:\\s*([\\s\\S]*?);`));
    assert.ok(match, `styles.css has no ${name}`);
    assert.equal(dark.vars[name].replace(/\s+/g, " "), match[1].replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim(), name);
  }
});

test("every built-in theme sets every variable to a usable value", () => {
  assert.ok(BUILTIN_THEMES.length >= 8);
  assert.equal(new Set(BUILTIN_THEMES.map((t) => t.id)).size, BUILTIN_THEMES.length);
  for (const theme of BUILTIN_THEMES) {
    assert.deepEqual(Object.keys(theme.vars).sort(), [...THEME_VARS].sort(), theme.id);
    for (const value of Object.values(theme.vars)) assert.ok(isSafeCssValue(value), `${theme.id}: ${value}`);
    for (const color of Object.values(theme.palette)) assert.ok(parseHex(color), `${theme.id}: ${color}`);
  }
  assert.ok(BUILTIN_THEMES.some((t) => t.appearance === "light"));
});

test("parseHex handles short, long and alpha forms", () => {
  assert.deepEqual(parseHex("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseHex("#1e1e2e"), { r: 30, g: 30, b: 46, a: 1 });
  assert.deepEqual(parseHex("#ffffff1a"), { r: 255, g: 255, b: 255, a: 0.102 });
  assert.equal(parseHex("red"), null);
  assert.equal(parseHex("#12345"), null);
});

test("completePalette derives the optional roles and normalises hex", () => {
  const palette = completePalette({ background: "#000", text: "#fff", accent: "#f80" }, "dark");
  assert.equal(palette.background, "#000000");
  assert.equal(palette.accent, "#ff8800");
  assert.equal(palette.dim, "#ffffff9e");
  assert.equal(palette.faint, "#ffffff66");
  assert.equal(palette.selected, "#ffffff1a");
  assert.equal(palette.elevated, "#1a1a1a");
  assert.equal(palette.danger, "#ff6b6b");
});

test("parseColorScheme reads gsettings output", () => {
  assert.equal(parseColorScheme("'prefer-dark'\n"), "dark");
  assert.equal(parseColorScheme("'prefer-light'\n"), "light");
  assert.equal(parseColorScheme("'default'\n"), "light");
});

test("resolveTheme follows the system and falls back to Beam Dark", () => {
  assert.equal(resolveTheme(SYSTEM_THEME_ID, [], "dark").id, "beam-dark");
  assert.equal(resolveTheme(SYSTEM_THEME_ID, [], "light").id, "beam-light");
  assert.equal(resolveTheme("nord", [], "light").id, "nord");
  assert.equal(resolveTheme("user:gone", [], "dark").id, "beam-dark");
  const mine = parseUserTheme('{"name":"Mine","colors":{"accent":"#ff8800"}}', "mine") as Theme;
  assert.equal(resolveTheme("user:mine", [mine], "dark").name, "Mine");
});

test("a user theme only needs the colors it changes", () => {
  const theme = parseUserTheme('{"name":"Orange","colors":{"accent":"#ff8800"}}', "orange", "/x/orange.json") as Theme;
  const dark = BUILTIN_THEMES[0];
  assert.equal(theme.id, "user:orange");
  assert.equal(theme.file, "/x/orange.json");
  assert.equal(theme.appearance, "dark");
  assert.equal(theme.vars["--accent"], "#ff8800");
  assert.equal(theme.palette.dim, dark.palette.dim);
  assert.equal(theme.vars["--text"], dark.vars["--text"]);

  const light = parseUserTheme('{"appearance":"light","colors":{"background":"#fdf6e3","text":"#586e75","accent":"#268bd2"},"vars":{"radius":"10px"}}', "solarized") as Theme;
  assert.equal(light.name, "solarized");
  assert.equal(light.appearance, "light");
  assert.equal(light.vars["--glass"], "rgba(253, 246, 227, 0.97)");
  // Shades come from the new text color, not Beam Light's.
  assert.equal(light.vars["--text-dim"], "rgba(88, 110, 117, 0.62)");
  assert.equal(light.vars["--radius"], "10px");
});

test("parseUserTheme explains what's wrong with a file", () => {
  const error = (text: string) => (parseUserTheme(text, "x") as { error: string }).error;
  assert.match(error("{"), /Not valid JSON/);
  assert.match(error("[]"), /JSON object/);
  assert.match(error('{"appearance":"dim"}'), /"dark" or "light"/);
  assert.match(error('{"colors":{"accent":"orange"}}'), /hex color/);
  assert.match(error('{"colors":{"shadow":"#000"}}'), /Unknown color "shadow"/);
  assert.match(error('{"vars":{"--font":"Comic Sans"}}'), /Unknown variable/);
  assert.match(error('{"vars":{"--glass":"url(https://example.com/x.png)"}}'), /won't apply/);
  assert.match(error('{"vars":{"--accent":"red; background: red"}}'), /won't apply/);
  assert.match(error('{"vars":{"--radius":"999px"}}'), /0px–40px/);
});

test("isSafeCssValue refuses anything that loads or escapes", () => {
  assert.ok(isSafeCssValue("rgba(1, 2, 3, 0.5)"));
  assert.ok(isSafeCssValue("linear-gradient(160deg, #fff 0%, #000 100%)"));
  for (const bad of ["", " ", "url(x)", "image-set(x)", "red;", "}", "a\\62", "@import", "red !important", 5, null]) {
    assert.equal(isSafeCssValue(bad), false, String(bad));
  }
});

test("themeFileText round-trips through parseUserTheme", () => {
  for (const source of BUILTIN_THEMES) {
    const copy = parseUserTheme(themeFileText(source, `My ${source.name}`), "copy") as Theme;
    assert.equal(copy.name, `My ${source.name}`);
    assert.deepEqual(copy.palette, source.palette, source.id);
  }
});

test("themeSlug makes file-friendly names", () => {
  assert.equal(themeSlug("My Rosé Pine!"), "my-rose-pine");
  assert.equal(themeSlug("  Tokyo   Night  "), "tokyo-night");
  assert.equal(themeSlug("../../etc"), "etc");
  assert.equal(themeSlug("✨"), "theme");
});

test("previews are SVG data URLs in the theme's colors", () => {
  const nord = BUILTIN_THEMES.find((t) => t.id === "nord")!;
  const preview = decodeURIComponent(themePreviewSvg(nord));
  assert.match(preview, /^data:image\/svg\+xml,<svg /);
  assert.match(preview, /fill="#2e3440"/);
  assert.match(preview, /fill="#88c0d0"/);
  assert.doesNotMatch(preview, /NaN|undefined/);
  assert.match(decodeURIComponent(themeIconSvg(nord)), /fill="#88c0d0"/);
  for (const theme of BUILTIN_THEMES) assert.doesNotMatch(decodeURIComponent(themePreviewSvg(theme)), /NaN|undefined/, theme.id);
  assert.match(themeDetails(nord), /^Nord\n\nAppearance  Dark/);
});

test("appliedTheme is what the renderer needs", () => {
  const applied = appliedTheme(BUILTIN_THEMES[1]);
  assert.equal(applied.scheme, "light");
  assert.equal(applied.vars["--text"], "#1d1d24");
  assert.equal(Object.keys(applied.vars).length, THEME_VARS.length);
});
