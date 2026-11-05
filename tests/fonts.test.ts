import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cssFontFamily,
  fontDetails,
  fontIconSvg,
  fontLocation,
  fontPreviewSvg,
  genericFamily,
  parseCharset,
  parseFcList,
  sampleFor,
  splitPreviewQuery,
  wrapText,
} from "../src/main/fonts.ts";

const HOME = "/home/vaishakh";
const LATIN = "20-7e a0-24f 268 292 2bc 2c6-2c7 2c9 2d8-2dd 300-304";
const TELUGU = "20-23 25 27-3f 5b-5f 7b-7e a0 ad d7 f7 951-952 964-965 c00-c0c c0e-c10 c12-c28 c2a-c39 c3d-c44 c46-c48 c4a-c4d c55-c56 c58-c5a c60-c63 c66-c6f c77-c7f 1cda 1cf2 200b-200d 2010 2013-2014 2018-2019 201c-201d 2026 20b9 2212 25cc";

// Real `fc-list --format FC_FORMAT` lines from Ubuntu 24.04 (charsets shortened), in fc-list's arbitrary order.
const FC_LIST = [
  `Ubuntu Sans Mono\tBold Italic\t100\tTrueType\tFalse\t200\t100\t100\t/usr/share/fonts/truetype/ubuntu/UbuntuSansMono-Italic[wght].ttf\t${LATIN}`,
  `Noto Sans Telugu\tBold\t\tTrueType\tFalse\t200\t0\t100\t/usr/share/fonts/truetype/noto/NotoSansTelugu-Bold.ttf\t${TELUGU}`,
  `Ubuntu Sans Mono\t\t100\tTrueType\tTrue\t[0 200]\t0\t100\t/usr/share/fonts/truetype/ubuntu/UbuntuSansMono[wght].ttf\t${LATIN}`,
  `Ubuntu Sans Mono\tBold\t100\tTrueType\tFalse\t200\t0\t100\t/usr/share/fonts/truetype/ubuntu/UbuntuSansMono[wght].ttf\t${LATIN}`,
  `JetBrains Mono\tBold Italic\t100\tTrueType\tFalse\t200\t100\t100\t/home/vaishakh/.local/share/fonts/JetBrainsMono/JetBrainsMono-BoldItalic.ttf\t${LATIN}`,
  `Ubuntu Sans Mono\tItalic\t100\tTrueType\tFalse\t80\t100\t100\t/usr/share/fonts/truetype/ubuntu/UbuntuSansMono-Italic[wght].ttf\t${LATIN}`,
  `Noto Sans Telugu\tRegular\t\tTrueType\tFalse\t80\t0\t100\t/usr/share/fonts/truetype/noto/NotoSansTelugu-Regular.ttf\t${TELUGU}`,
  `Ubuntu Sans Mono\tExtraLight\t100\tTrueType\tFalse\t40\t0\t100\t/usr/share/fonts/truetype/ubuntu/UbuntuSansMono[wght].ttf\t${LATIN}`,
  `Noto Music\tRegular\t\tTrueType\tFalse\t80\t0\t100\t/usr/share/fonts/truetype/noto/NotoMusic-Regular.ttf\t20 a0 25cc 2669-266f 1d000-1d0f5 1d100-1d126 1d129-1d1e8 1d200-1d245`,
  `JetBrains Mono\tRegular\t100\tTrueType\tFalse\t80\t0\t100\t/home/vaishakh/.local/share/fonts/JetBrainsMono/JetBrainsMono-Regular.ttf\t${LATIN}`,
  `Ubuntu Sans Mono\tRegular\t100\tTrueType\tFalse\t80\t0\t100\t/usr/share/fonts/truetype/ubuntu/UbuntuSansMono[wght].ttf\t${LATIN}`,
  `.Hidden Font\tRegular\t\tTrueType\tFalse\t80\t0\t100\t/usr/share/fonts/hidden.ttf\t${LATIN}`,
  "",
].join("\n");

test("parseFcList groups faces into sorted families", () => {
  const families = parseFcList(FC_LIST, HOME);
  assert.deepEqual(families.map((f) => f.name), ["JetBrains Mono", "Noto Music", "Noto Sans Telugu", "Ubuntu Sans Mono"]);
  const ubuntu = families.find((f) => f.name === "Ubuntu Sans Mono")!;
  // Upright before italic, light to heavy; the variable font's unnamed range isn't a style.
  assert.deepEqual(ubuntu.styles, ["ExtraLight", "Regular", "Bold", "Italic", "Bold Italic"]);
  assert.equal(ubuntu.variable, true);
  assert.equal(ubuntu.mono, true);
  assert.equal(ubuntu.location, "system");
  assert.deepEqual(ubuntu.files, [
    "/usr/share/fonts/truetype/ubuntu/UbuntuSansMono[wght].ttf",
    "/usr/share/fonts/truetype/ubuntu/UbuntuSansMono-Italic[wght].ttf",
  ]);
});

test("parseFcList puts the regular face's file first and marks user fonts", () => {
  const families = parseFcList(FC_LIST, HOME);
  const jetbrains = families.find((f) => f.name === "JetBrains Mono")!;
  assert.equal(jetbrains.location, "user");
  assert.equal(jetbrains.files[0], "/home/vaishakh/.local/share/fonts/JetBrainsMono/JetBrainsMono-Regular.ttf");
  const telugu = families.find((f) => f.name === "Noto Sans Telugu")!;
  assert.equal(telugu.files[0], "/usr/share/fonts/truetype/noto/NotoSansTelugu-Regular.ttf");
  assert.equal(telugu.mono, false);
  const both = parseFcList(FC_LIST.replace("/usr/share/fonts/truetype/ubuntu/UbuntuSansMono[wght].ttf\t", `${HOME}/.fonts/UbuntuSansMono.ttf\t`), HOME);
  assert.equal(both.find((f) => f.name === "Ubuntu Sans Mono")!.location, "both");
});

test("fontLocation", () => {
  assert.equal(fontLocation("/home/vaishakh/.local/share/fonts/a.ttf", "/home/vaishakh/"), "user");
  assert.equal(fontLocation("/home/vaishakh/.fonts/a.ttf", HOME), "user");
  assert.equal(fontLocation("/home/vaishakh/Downloads/a.ttf", HOME), "system");
  assert.equal(fontLocation("/usr/local/share/fonts/a.ttf", HOME), "system");
});

test("parseCharset reads single code points and ranges", () => {
  assert.deepEqual(parseCharset("20-7e a0 1d000-1d0f5"), [[0x20, 0x7e], [0xa0, 0xa0], [0x1d000, 0x1d0f5]]);
  assert.deepEqual(parseCharset(""), []);
});

test("sampleFor draws what the font actually has", () => {
  assert.deepEqual(sampleFor(LATIN), { kind: "latin", uppercaseOnly: false });
  assert.deepEqual(sampleFor("20 30-39 41-5a"), { kind: "latin", uppercaseOnly: true });
  const telugu = sampleFor(TELUGU);
  assert.equal(telugu.kind, "glyphs");
  assert.ok(telugu.kind === "glyphs" && telugu.text.startsWith("అ ఆ ఇ ఈ"), JSON.stringify(telugu));
  const music = sampleFor("20 a0 25cc 2669-266f 1d000-1d0f5 1d100-1d126 1d129-1d1e8 1d200-1d245");
  assert.ok(music.kind === "glyphs" && [...music.text.replace(/ /g, "")].every((c) => c.codePointAt(0)! >= 0x1d000));
  // CJK fonts: the everyday ideographs, not Extension A.
  const cjk = sampleFor("20-7e 3400-4dbf 4e00-9fff");
  assert.equal(cjk.kind, "latin");
  const cjkOnly = sampleFor("3400-4dbf 4e00-9fff");
  assert.ok(cjkOnly.kind === "glyphs" && cjkOnly.text.startsWith("一 丁"));
  assert.deepEqual(sampleFor("20 2010 2026"), { kind: "glyphs", text: "" });
});

test("genericFamily and cssFontFamily", () => {
  const [jetbrains, music, telugu] = parseFcList(FC_LIST, HOME);
  assert.equal(genericFamily(jetbrains), "monospace");
  assert.equal(genericFamily(telugu), "sans-serif");
  assert.equal(genericFamily({ ...music, name: "DejaVu Serif" }), "serif");
  assert.equal(genericFamily({ ...jetbrains, name: "Noto Color Emoji" }), "emoji");
  assert.equal(cssFontFamily(jetbrains), 'font-family: "JetBrains Mono", monospace;');
  assert.equal(cssFontFamily({ ...telugu, name: 'Odd "Quoted" Name' }), 'font-family: "Odd \\"Quoted\\" Name", sans-serif;');
});

test("splitPreviewQuery takes quoted text to preview and the rest as a filter", () => {
  assert.deepEqual(splitPreviewQuery("jet"), { text: null, filter: "jet" });
  assert.deepEqual(splitPreviewQuery('"Hello world'), { text: "Hello world", filter: "" });
  assert.deepEqual(splitPreviewQuery('"Hello world" mono'), { text: "Hello world", filter: "mono" });
  assert.deepEqual(splitPreviewQuery("'Café'"), { text: "Café", filter: "" });
  assert.deepEqual(splitPreviewQuery("“0O 1lI”"), { text: "0O 1lI", filter: "" });
  assert.deepEqual(splitPreviewQuery('"'), { text: null, filter: "" });
});

test("wrapText wraps by words, breaks long words and ends cut text with an ellipsis", () => {
  assert.deepEqual(wrapText("The quick brown fox jumps over the lazy dog", 20, 3), ["The quick brown fox", "jumps over the lazy", "dog"]);
  assert.deepEqual(wrapText("abcdefghij", 4, 5), ["abcd", "efgh", "ij"]);
  assert.deepEqual(wrapText("one two three four", 9, 1), ["one two…"]);
  assert.deepEqual(wrapText("abcdefghij", 4, 2), ["abcd", "efg…"]);
});

test("fontPreviewSvg draws in the family's own font, escaped", () => {
  const [jetbrains, , telugu] = parseFcList(FC_LIST, HOME);
  const colors = { text: "#f4f4f7", dim: "rgba(235, 235, 245, 0.62)" };
  const svg = decodeURIComponent(fontPreviewSvg(jetbrains, colors).replace("data:image/svg+xml,", ""));
  assert.match(svg, /font-family="&apos;JetBrains Mono&apos;"/);
  assert.match(svg, /<tspan>The quick brown fox<\/tspan>.*<tspan>jumps over the lazy dog<\/tspan>/);
  assert.match(svg, /font-weight="700">Bold/);
  assert.match(svg, /font-style="italic">Italic/);
  const custom = decodeURIComponent(fontPreviewSvg({ ...jetbrains, name: "A'B<C" }, colors, "<b>&").slice(19));
  assert.match(custom, /font-family="&apos;AB&lt;C&apos;"/);
  assert.match(custom, /&lt;b&gt;&amp;/);
  assert.doesNotMatch(custom, /quick brown/);
  const glyphs = decodeURIComponent(fontPreviewSvg(telugu, colors).slice(19));
  assert.match(glyphs, /అ ఆ/);
  assert.doesNotMatch(glyphs, /quick brown/);
  assert.match(decodeURIComponent(fontIconSvg(telugu, "#fff")), />అ</);
  assert.match(decodeURIComponent(fontIconSvg(jetbrains, "#fff")), />Aa</);
});

test("fontDetails summarises the family", () => {
  const families = parseFcList(FC_LIST, HOME);
  const details = fontDetails(families.find((f) => f.name === "Ubuntu Sans Mono")!);
  assert.match(details, /Styles +5 named/);
  assert.match(details, /Type +Monospace · Variable · TrueType/);
  assert.match(details, /Installed +System/);
  assert.match(details, /Files +2/);
});
