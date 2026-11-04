import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  HISTORY_SCRIPT,
  chromeTimeToMs,
  displayUrl,
  flattenBookmarks,
  isOpenableUrl,
  lastUsedProfile,
  markdownLink,
  parseHistoryRows,
  relativeTime,
  searchBookmarks,
} from "../src/main/chrome.ts";

// Synthetic data only, shaped like Chrome's files.
const BOOKMARKS = JSON.stringify({
  checksum: "0",
  version: 1,
  roots: {
    bookmark_bar: {
      type: "folder",
      name: "Bookmarks bar",
      id: "1",
      guid: "root-bar",
      children: [
        { type: "url", name: "Example Docs", url: "https://docs.example.com/", id: "5", guid: "g-docs" },
        {
          type: "folder",
          name: "Work",
          id: "6",
          children: [
            { type: "url", name: "Team Board", url: "https://board.example.org/team", id: "7", guid: "g-board" },
            { type: "url", name: "", url: "https://untitled.example.net/", id: "8", guid: "g-untitled" },
            { type: "url", name: "Bookmarklet", url: "javascript:alert(1)", id: "9", guid: "g-js" },
          ],
        },
      ],
    },
    other: {
      type: "folder",
      name: "Other bookmarks",
      id: "2",
      children: [{ type: "url", name: "Recipes", url: "https://food.example.com/recipes", id: "10", guid: "g-food" }],
    },
    synced: { type: "folder", name: "Mobile bookmarks", id: "3", children: [] },
  },
  sync_metadata: "ignored",
});

test("last-used profile from Local State, falling back to Default", () => {
  assert.equal(lastUsedProfile(JSON.stringify({ profile: { last_used: "Profile 2" } })), "Profile 2");
  assert.equal(lastUsedProfile(JSON.stringify({ profile: {} })), "Default");
  assert.equal(lastUsedProfile("{not json"), "Default");
  // Never a path: it is joined onto the Chrome folder.
  assert.equal(lastUsedProfile(JSON.stringify({ profile: { last_used: "../../etc" } })), "Default");
  assert.equal(lastUsedProfile(JSON.stringify({ profile: { last_used: ".." } })), "Default");
});

test("flattens bookmarks with their folder paths", () => {
  const list = flattenBookmarks(BOOKMARKS);
  assert.deepEqual(
    list.map((b) => [b.id, b.title, b.folder]),
    [
      ["g-docs", "Example Docs", "Bookmarks bar"],
      ["g-board", "Team Board", "Bookmarks bar / Work"],
      ["g-untitled", "https://untitled.example.net/", "Bookmarks bar / Work"],
      ["g-js", "Bookmarklet", "Bookmarks bar / Work"],
      ["g-food", "Recipes", "Other bookmarks"],
    ],
  );
});

test("duplicate guids still get unique ids", () => {
  const twice = JSON.stringify({
    roots: {
      other: {
        type: "folder",
        name: "Other",
        children: [
          { type: "url", name: "A", url: "https://a.example/", guid: "same" },
          { type: "url", name: "B", url: "https://b.example/", guid: "same" },
        ],
      },
    },
  });
  const ids = flattenBookmarks(twice).map((b) => b.id);
  assert.equal(new Set(ids).size, 2);
});

test("bookmark search needs every word and ranks title matches first", () => {
  const list = flattenBookmarks(BOOKMARKS);
  assert.deepEqual(searchBookmarks(list, "team", 10).map((b) => b.id), ["g-board"]);
  assert.deepEqual(searchBookmarks(list, "work board", 10).map((b) => b.id), ["g-board"]);
  assert.deepEqual(searchBookmarks(list, "example.com", 10).map((b) => b.id), ["g-docs", "g-food"]);
  assert.deepEqual(searchBookmarks(list, "recipes", 10).map((b) => b.id), ["g-food"]);
  assert.deepEqual(searchBookmarks(list, "nothing here", 10), []);
  assert.equal(searchBookmarks(list, "", 2).length, 2);
});

test("only URLs Chrome can open from its command line", () => {
  assert.equal(isOpenableUrl("https://example.com"), true);
  assert.equal(isOpenableUrl("chrome://settings"), true);
  assert.equal(isOpenableUrl("javascript:alert(1)"), false);
  assert.equal(isOpenableUrl("--incognito"), false);
});

test("Chrome timestamps are microseconds since 1601", () => {
  // 2024-01-01T00:00:00Z
  assert.equal(chromeTimeToMs(13348540800000000), Date.UTC(2024, 0, 1));
  assert.equal(chromeTimeToMs(0), 0);
});

test("parses history rows", () => {
  const rows = parseHistoryRows(JSON.stringify([[42, "https://example.com/a", "Page A", 3, 13348540800000000], [43, "https://example.com/b", null, 1, 0]]));
  assert.deepEqual(rows, [
    { id: 42, url: "https://example.com/a", title: "Page A", visitCount: 3, lastVisit: Date.UTC(2024, 0, 1) },
    { id: 43, url: "https://example.com/b", title: "https://example.com/b", visitCount: 1, lastVisit: 0 },
  ]);
  assert.deepEqual(parseHistoryRows("{}"), []);
});

test("Markdown links escape brackets and parentheses", () => {
  assert.equal(markdownLink("Docs", "https://example.com"), "[Docs](https://example.com)");
  assert.equal(markdownLink("[draft] Plan", "https://example.com/a_(b)"), "[\\[draft\\] Plan](https://example.com/a_%28b%29)");
  assert.equal(markdownLink("  ", "https://example.com"), "[https://example.com](https://example.com)");
});

test("display URLs and relative times", () => {
  assert.equal(displayUrl("https://www.example.com/path/"), "example.com/path");
  const now = Date.UTC(2024, 5, 1, 12);
  assert.equal(relativeTime(now - 20_000, now), "Just now");
  assert.equal(relativeTime(now - 5 * 60_000, now), "5m ago");
  assert.equal(relativeTime(now - 3 * 3_600_000, now), "3h ago");
  assert.equal(relativeTime(now - 2 * 86_400_000, now), "2d ago");
});

function hasPython(): boolean {
  try {
    execFileSync("python3", ["-I", "-c", "import sqlite3"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("history script: parameterized LIKE search, newest first", { skip: !hasPython() && "python3 with sqlite3 is not available" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "beam-chrome-test-"));
  const db = path.join(dir, "History");
  try {
    // A synthetic History file with Chrome's urls schema.
    execFileSync("python3", [
      "-I",
      "-c",
      `
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("CREATE TABLE urls(id INTEGER PRIMARY KEY AUTOINCREMENT,url LONGVARCHAR,title LONGVARCHAR,visit_count INTEGER DEFAULT 0 NOT NULL,typed_count INTEGER DEFAULT 0 NOT NULL,last_visit_time INTEGER NOT NULL,hidden INTEGER DEFAULT 0 NOT NULL)")
rows = [
  (1, "https://alpha.example.com/", "Alpha Home", 5, 300, 0),
  (2, "https://beta.example.com/docs", "Beta Docs", 2, 500, 0),
  (3, "https://alpha.example.com/docs", "Alpha Docs", 1, 400, 0),
  (4, "https://hidden.example.com/", "Alpha Hidden", 1, 900, 1),
  (5, "https://pct.example.com/100%", "Half_done 50% sale", 1, 100, 0),
]
con.executemany("INSERT INTO urls(id,url,title,visit_count,last_visit_time,hidden) VALUES (?,?,?,?,?,?)", rows)
con.commit()
`,
      db,
    ]);
    const run = (query: string, limit = 30) =>
      parseHistoryRows(execFileSync("python3", ["-I", "-c", HISTORY_SCRIPT, db, query, String(limit)], { encoding: "utf8" })).map(
        (row) => row.id,
      );
    assert.deepEqual(run(""), [2, 3, 1, 5]);
    assert.deepEqual(run("", 2), [2, 3]);
    assert.deepEqual(run("alpha"), [3, 1]);
    assert.deepEqual(run("ALPHA docs"), [3]);
    assert.deepEqual(run("docs"), [2, 3]);
    // LIKE wildcards in the query are literal characters.
    assert.deepEqual(run("50%"), [5]);
    assert.deepEqual(run("%"), [5]);
    assert.deepEqual(run("_"), [5]);
    // Quotes and SQL in the query are just text.
    assert.deepEqual(run("' OR 1=1 --"), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
