import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addToHistory,
  ageLabel,
  colorDetails,
  parseColor,
  parsePickerOutput,
  swatchUrl,
  toHex,
  toHslString,
  toOklchString,
  toRgbString,
} from "../src/main/color.ts";

const ORANGE = { r: 255, g: 136, b: 0, a: 1 };

test("hex colors need a # unless bare hex is allowed", () => {
  assert.deepEqual(parseColor("#f80"), ORANGE);
  assert.deepEqual(parseColor("#FF8800"), ORANGE);
  assert.deepEqual(parseColor("  #ff8800 "), ORANGE);
  assert.deepEqual(parseColor("#ff880080"), { r: 255, g: 136, b: 0, a: 0.502 });
  assert.deepEqual(parseColor("#f808"), { r: 255, g: 136, b: 0, a: 0.533 });
  assert.equal(parseColor("ff8800"), null);
  assert.deepEqual(parseColor("ff8800", { bareHex: true }), ORANGE);
  // Short bare hex is a plain number or word, never a color.
  assert.equal(parseColor("123", { bareHex: true }), null);
  assert.equal(parseColor("bad", { bareHex: true }), null);
  assert.deepEqual(parseColor("#ff88"), { r: 255, g: 255, b: 136, a: 0.533 });
  assert.equal(parseColor("#ff88000"), null);
  assert.equal(parseColor("#gg8800"), null);
});

test("rgb() in comma, space and percent forms", () => {
  assert.deepEqual(parseColor("rgb(255, 136, 0)"), ORANGE);
  assert.deepEqual(parseColor("RGB(255,136,0)"), ORANGE);
  assert.deepEqual(parseColor("rgb(255 136 0)"), ORANGE);
  assert.deepEqual(parseColor("rgba(255, 136, 0, 0.5)"), { ...ORANGE, a: 0.5 });
  assert.deepEqual(parseColor("rgb(255 136 0 / 25%)"), { ...ORANGE, a: 0.25 });
  assert.deepEqual(parseColor("rgb(100%, 50%, 0%)"), { r: 255, g: 128, b: 0, a: 1 });
  assert.equal(parseColor("rgb(256, 0, 0)"), null);
  assert.equal(parseColor("rgb(255, 136)"), null);
  assert.equal(parseColor("rgb(255, 136, 0 / 0.5)"), null);
  assert.equal(parseColor("rgb(a, b, c)"), null);
  assert.equal(parseColor("rgb(255, 136, 0, 2)"), null);
});

test("hsl() with units", () => {
  assert.deepEqual(parseColor("hsl(32, 100%, 50%)"), { r: 255, g: 136, b: 0, a: 1 });
  assert.deepEqual(parseColor("hsl(32deg 100% 50%)"), { r: 255, g: 136, b: 0, a: 1 });
  assert.deepEqual(parseColor("hsl(0.5turn, 100%, 50%)"), { r: 0, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor("hsla(120, 100%, 25%, 0.5)"), { r: 0, g: 128, b: 0, a: 0.5 });
  assert.deepEqual(parseColor("hsl(-120, 100%, 50%)"), { r: 0, g: 0, b: 255, a: 1 });
  assert.equal(parseColor("hsl(32, 120%, 50%)"), null);
  assert.equal(parseColor("hsl(32px, 100%, 50%)"), null);
});

test("words, numbers and other text are not colors", () => {
  for (const text of ["", "red", "123", "123456", "#", "rgb", "rgb()", "hsl(1, 2)", "10 usd", "#hashtag"]) {
    assert.equal(parseColor(text), null, text);
  }
});

test("formats", () => {
  assert.equal(toHex(ORANGE), "#FF8800");
  assert.equal(toHex({ ...ORANGE, a: 0.5 }), "#FF880080");
  assert.equal(toRgbString(ORANGE), "rgb(255, 136, 0)");
  assert.equal(toRgbString({ ...ORANGE, a: 0.5 }), "rgba(255, 136, 0, 0.5)");
  assert.equal(toHslString(ORANGE), "hsl(32, 100%, 50%)");
  assert.equal(toHslString({ r: 128, g: 128, b: 128, a: 1 }), "hsl(0, 0%, 50%)");
  assert.equal(toHslString({ ...ORANGE, a: 0.5 }), "hsla(32, 100%, 50%, 0.5)");
});

test("OKLCH matches reference values", () => {
  assert.equal(toOklchString({ r: 255, g: 0, b: 0, a: 1 }), "oklch(62.8% 0.258 29.2)");
  assert.equal(toOklchString({ r: 255, g: 255, b: 255, a: 1 }), "oklch(100% 0 0)");
  assert.equal(toOklchString({ r: 0, g: 0, b: 0, a: 1 }), "oklch(0% 0 0)");
  assert.equal(toOklchString({ r: 0, g: 0, b: 255, a: 0.5 }), "oklch(45.2% 0.313 264.1 / 0.5)");
});

test("round trips through every format", () => {
  for (const hex of ["#000000", "#FFFFFF", "#FF8800", "#1E90FF", "#7F7F7F", "#336699"]) {
    const color = parseColor(hex)!;
    assert.equal(toHex(parseColor(toRgbString(color))!), hex);
    // HSL is rounded to whole numbers, so allow one step per channel.
    const back = parseColor(toHslString(color))!;
    for (const key of ["r", "g", "b"] as const) assert.ok(Math.abs(back[key] - color[key]) <= 3, `${hex} ${key}`);
  }
});

test("picker output as portal floats or hex", () => {
  assert.deepEqual(parsePickerOutput("1.000000 0.533333 0.000000\n"), ORANGE);
  assert.deepEqual(parsePickerOutput("1.0000001 0.533333 -0.0000001"), ORANGE);
  assert.deepEqual(parsePickerOutput("#ff8800"), ORANGE);
  assert.equal(parsePickerOutput("2 0 0"), null);
  assert.equal(parsePickerOutput(""), null);
  assert.equal(parsePickerOutput("cancelled"), null);
});

test("history keeps the newest first without duplicates", () => {
  let history = addToHistory([], "#FF8800", 1, 3);
  history = addToHistory(history, "#000000", 2, 3);
  history = addToHistory(history, "#FF8800", 3, 3);
  assert.deepEqual(history, [
    { hex: "#FF8800", savedAt: 3 },
    { hex: "#000000", savedAt: 2 },
  ]);
  history = addToHistory(history, "#111111", 4, 3);
  history = addToHistory(history, "#222222", 5, 3);
  assert.deepEqual(history.map((c) => c.hex), ["#222222", "#111111", "#FF8800"]);
});

test("swatches and details", () => {
  const url = swatchUrl(ORANGE, 22, 22, 5);
  assert.ok(url.startsWith("data:image/svg+xml,"));
  assert.ok(decodeURIComponent(url).includes('fill="#FF8800"'));
  assert.equal(
    colorDetails(ORANGE),
    "HEX    #FF8800\nRGB    rgb(255, 136, 0)\nHSL    hsl(32, 100%, 50%)\nOKLCH  oklch(74.4% 0.181 56.5)",
  );
  assert.equal(ageLabel(0, 30_000), "Just now");
  assert.equal(ageLabel(0, 5 * 60_000), "5m ago");
  assert.equal(ageLabel(0, 3 * 3_600_000), "3h ago");
});
