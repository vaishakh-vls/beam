import assert from "node:assert/strict";
import { test } from "node:test";
import { bestScore } from "../src/main/fuzzy.ts";
import {
  EXTENSION_ID,
  FrameDecoder,
  HOST_NAME,
  encodeFrame,
  hostManifest,
  parseHello,
  parseReply,
  parseTabList,
  rankTabs,
  tabAccessory,
  tabDomain,
  tabTitle,
  type BrowserTab,
} from "../src/main/tabs.ts";

const ICON = "data:image/png;base64,iVBORw0KGgo=";

function tab(overrides: Partial<BrowserTab>): BrowserTab {
  return {
    id: 1,
    windowId: 1,
    index: 0,
    title: "",
    url: "https://example.com/",
    active: false,
    audible: false,
    muted: false,
    pinned: false,
    incognito: false,
    discarded: false,
    lastAccessed: 0,
    ...overrides,
  };
}

test("frames round-trip, split across chunks and several per chunk", () => {
  const first = encodeFrame({ id: 1, ok: true, text: "héllo" });
  const second = encodeFrame({ id: 2, ok: false, error: "No tab with id: 9." });
  assert.equal(first.readUInt32LE(0), first.length - 4);

  const decoder = new FrameDecoder();
  const all = Buffer.concat([first, second]);
  assert.deepEqual(decoder.push(all.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(all.subarray(3, first.length + 5)), [{ id: 1, ok: true, text: "héllo" }]);
  assert.deepEqual(decoder.push(all.subarray(first.length + 5)), [{ id: 2, ok: false, error: "No tab with id: 9." }]);
});

test("a frame that isn't JSON is skipped and the next one still parses", () => {
  const junk = Buffer.from("{nope");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(junk.length);
  const decoder = new FrameDecoder();
  assert.deepEqual(decoder.push(Buffer.concat([header, junk, encodeFrame({ id: 3, ok: true })])), [{ id: 3, ok: true }]);
});

test("an oversized length throws instead of buffering forever", () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(2048);
  assert.throws(() => new FrameDecoder(1024).push(header), /too large/);
});

test("replies need a numeric id and an ok flag", () => {
  assert.deepEqual(parseReply({ id: 4, ok: false, error: "boom" }), {
    id: 4,
    ok: false,
    error: "boom",
    body: { id: 4, ok: false, error: "boom" },
  });
  assert.equal(parseReply({ id: "4", ok: true }), null);
  assert.equal(parseReply({ id: 4 }), null);
  assert.equal(parseReply([1, 2]), null);
  assert.equal(parseReply(null), null);
});

test("hello carries the extension version", () => {
  assert.deepEqual(parseHello({ version: "1.0.0", startedAt: 5, userAgent: "Chrome/155" }), {
    version: "1.0.0",
    startedAt: 5,
    userAgent: "Chrome/155",
  });
  assert.equal(parseHello({}), null);
});

test("tab lists resolve shared favicons by index and drop malformed tabs", () => {
  const tabs = parseTabList({
    icons: [ICON, "https://evil.example/icon.png"],
    tabs: [
      { id: 10, windowId: 2, index: 3, title: "Inbox", url: "https://mail.google.com/", icon: 0, audible: true, lastAccessed: 99 },
      { id: 11, windowId: 2, title: "Docs", url: "https://docs.google.com/", icon: 0, pinned: true },
      { id: 12, windowId: 2, title: "Remote icon", url: "https://a.example/", icon: 1 },
      { id: 13, windowId: 2, title: "No icon", url: "chrome://newtab/", icon: -1, incognito: true },
      { id: "14", windowId: 2, title: "Bad id" },
      { id: 15, title: "No window" },
      "junk",
    ],
  });
  assert.deepEqual(
    tabs.map((t) => [t.id, t.favicon ?? null]),
    [
      [10, ICON],
      [11, ICON],
      [12, null],
      [13, null],
    ],
  );
  assert.deepEqual(tabs[0], {
    id: 10,
    windowId: 2,
    index: 3,
    title: "Inbox",
    url: "https://mail.google.com/",
    favicon: ICON,
    active: false,
    audible: true,
    muted: false,
    pinned: false,
    incognito: false,
    discarded: false,
    lastAccessed: 99,
  });
  assert.equal(tabs[3].incognito, true);
  assert.deepEqual(parseTabList({}), []);
});

test("domains: www dropped, ports kept, browser pages and files readable", () => {
  assert.equal(tabDomain("https://www.github.com/user/repo?tab=1"), "github.com");
  assert.equal(tabDomain("http://localhost:5183/index.html"), "localhost:5183");
  assert.equal(tabDomain("chrome://extensions/?id=abc"), "chrome://extensions");
  assert.equal(tabDomain("file:///home/me/My%20Notes.pdf"), "/home/me/My Notes.pdf");
  assert.equal(tabDomain("about:blank"), "about:blank");
  assert.equal(tabDomain("data:text/html,<h1>a very long page</h1>"), "data");
  assert.equal(tabDomain(""), "");
  assert.equal(tabDomain("not a url"), "not a url");
});

test("titles collapse whitespace and fall back to the address", () => {
  assert.equal(tabTitle({ title: "  Pull request\n #12 ", url: "https://github.com/" }), "Pull request #12");
  assert.equal(tabTitle({ title: "", url: "https://www.example.com/page" }), "example.com");
  assert.equal(tabTitle({ title: " ", url: "" }), "Untitled");
});

test("accessory lists audio, pinned and incognito state", () => {
  assert.equal(tabAccessory(tab({})), "");
  assert.equal(tabAccessory(tab({ audible: true })), "Playing");
  assert.equal(tabAccessory(tab({ audible: true, muted: true, pinned: true })), "Muted · Pinned");
  assert.equal(tabAccessory(tab({ incognito: true })), "Incognito");
  // Muted but silent tabs say nothing.
  assert.equal(tabAccessory(tab({ muted: true })), "");
});

const TABS = [
  tab({ id: 1, title: "GitHub - beam", url: "https://github.com/virallens/beam", lastAccessed: 100 }),
  tab({ id: 2, title: "Inbox (3) - Gmail", url: "https://mail.google.com/mail/u/0/#inbox", lastAccessed: 300 }),
  tab({ id: 3, title: "Pull requests", url: "https://github.com/pulls", lastAccessed: 200 }),
  tab({ id: 4, title: "Tracking", url: "https://shop.example/track?ref=github", lastAccessed: 400 }),
];

test("no query lists the most recently used tabs first", () => {
  assert.deepEqual(rankTabs(TABS, "  ", bestScore).map((t) => t.id), [4, 2, 3, 1]);
});

test("equal matches rank by recency, and query strings don't match", () => {
  // Both github.com tabs match the domain equally, so the more recent one leads; id 4 has "github" only after "?".
  assert.deepEqual(rankTabs(TABS, "github", bestScore).map((t) => t.id), [3, 1]);
  assert.deepEqual(rankTabs(TABS, "inbox", bestScore).map((t) => t.id), [2]);
  assert.deepEqual(rankTabs(TABS, "zzz", bestScore), []);
});

test("a better match beats a more recent tab", () => {
  const tabs = [
    tab({ id: 1, title: "Release notes", url: "https://example.com/", lastAccessed: 1 }),
    tab({ id: 2, title: "Unreleased drafts", url: "https://example.org/", lastAccessed: 2 }),
  ];
  assert.deepEqual(rankTabs(tabs, "release", bestScore).map((t) => t.id), [1, 2]);
});

test("equal recency falls back to window and position", () => {
  const tabs = [tab({ id: 1, windowId: 2, index: 0 }), tab({ id: 2, windowId: 1, index: 5 }), tab({ id: 3, windowId: 1, index: 1 })];
  assert.deepEqual(rankTabs(tabs, "", bestScore).map((t) => t.id), [3, 2, 1]);
});

test("the host manifest only lets Beam's extension start the host", () => {
  assert.deepEqual(hostManifest("/opt/Beam/resources/beam-browser-host"), {
    name: HOST_NAME,
    description: "Beam launcher: Browser Tabs",
    path: "/opt/Beam/resources/beam-browser-host",
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  });
  assert.match(EXTENSION_ID, /^[a-p]{32}$/);
});
