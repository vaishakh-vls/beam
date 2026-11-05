import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeType,
  isJsonFile,
  isPreviewableImage,
  looksBinary,
  parseContentType,
  parseGioMime,
  prettyJson,
} from "../src/main/openwith.ts";

// Real output of `gio mime` from GLib 2.80 on Ubuntu 24.04.
const JSON_APPS = [
  "Default application for “application/json”: dev.zed.Zed.desktop",
  "Registered applications:",
  "\tfirefox_firefox.desktop",
  "\tlibreoffice-writer.desktop",
  "\torg.gnome.TextEditor.desktop",
  "Recommended applications:",
  "\tfirefox_firefox.desktop",
  "",
].join("\n");

test("parseGioMime puts recommended apps first and leaves out the default", () => {
  assert.deepEqual(parseGioMime(JSON_APPS), {
    defaultApp: "dev.zed.Zed.desktop",
    apps: ["firefox_firefox.desktop", "libreoffice-writer.desktop", "org.gnome.TextEditor.desktop"],
  });
});

test("parseGioMime copes with no default and no apps, in any language", () => {
  const none = "Keine Standardanwendung für „x/y“\nKeine registrierten Anwendungen\nKeine empfohlenen Anwendungen\n";
  assert.deepEqual(parseGioMime(none), { defaultApp: null, apps: [] });
  const onlyRecommended = "No default application for “a/b”\nNo registered applications\nRecommended applications:\n\tfoo.desktop\n";
  assert.deepEqual(parseGioMime(onlyRecommended), { defaultApp: null, apps: ["foo.desktop"] });
});

test("parseContentType", () => {
  assert.equal(parseContentType("attributes:\n  standard::content-type: text/markdown\n"), "text/markdown");
  assert.equal(parseContentType("gio: file not found"), null);
});

test("looksBinary checks for NUL bytes near the start", () => {
  assert.equal(looksBinary(new TextEncoder().encode("plain text\nmore")), false);
  assert.equal(looksBinary(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a])), true);
});

test("JSON files are recognised by type or name and formatted", () => {
  assert.equal(isJsonFile("data.txt", "application/json"), true);
  assert.equal(isJsonFile("tsconfig.json", "text/plain"), true);
  assert.equal(isJsonFile("notes.md", "text/markdown"), false);
  assert.equal(prettyJson('{"a":[1,2],"b":{"c":null}}'), '{\n  "a": [\n    1,\n    2\n  ],\n  "b": {\n    "c": null\n  }\n}');
  assert.equal(prettyJson("{ broken"), null);
});

test("describeType and image previews", () => {
  assert.equal(describeType("inode/directory"), "Folder");
  assert.equal(describeType("image/png"), "PNG image");
  assert.equal(describeType("image/svg+xml"), "SVG image");
  assert.equal(describeType("video/x-matroska"), "MATROSKA video");
  assert.equal(describeType("application/pdf"), "PDF");
  assert.equal(describeType("application/x-unknown"), "application/x-unknown");
  assert.equal(describeType(null), "Unknown type");
  assert.equal(isPreviewableImage("image/webp"), true);
  assert.equal(isPreviewableImage("image/heic"), false);
});
