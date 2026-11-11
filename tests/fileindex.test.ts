import assert from "node:assert/strict";
import { test } from "node:test";
import { FileIndex, FileIndexBuilder } from "../src/main/fileindex.ts";

function sample(): FileIndex {
  const b = new FileIndexBuilder();
  const home = b.addFolder("/home/me");
  b.add(home, "Documents", true);
  b.add(home, "README.md", false);
  const docs = b.addFolder("/home/me/Documents");
  b.add(docs, "Read me later.txt", false);
  b.add(docs, "budget.xlsx", false);
  const root = b.addFolder("/");
  b.add(root, "etc", true);
  return b.build();
}

const ids = (index: FileIndex, q: string) => [...index.containing(q)];

test("names and full paths come back as they were added", () => {
  const index = sample();
  assert.equal(index.size, 5);
  assert.deepEqual(index.hit(0), { name: "Documents", path: "/home/me/Documents", isDir: true });
  assert.deepEqual(index.hit(2), { name: "Read me later.txt", path: "/home/me/Documents/Read me later.txt", isDir: false });
  assert.deepEqual(index.hit(4), { name: "etc", path: "/etc", isDir: true });
  assert.equal(index.name(3), "budget.xlsx");
});

test("containing finds every name with the lowercase query, once each", () => {
  const index = sample();
  assert.deepEqual(ids(index, "read"), [1, 2]);
  // "e" appears several times in some names; each name is listed once.
  assert.deepEqual(ids(index, "e"), [0, 1, 2, 3, 4]);
  assert.deepEqual(ids(index, "budget.xlsx"), [3]);
  assert.deepEqual(ids(index, "etc"), [4]);
  assert.deepEqual(ids(index, "zzz"), []);
});

test("a query never matches across two names", () => {
  const index = sample();
  // "documents" ends one name and "readme" starts the next.
  assert.deepEqual(ids(index, "sreadme"), []);
  assert.deepEqual(ids(index, "\n"), []);
  assert.deepEqual(ids(index, ""), []);
});

test("names whose lowercase is longer keep their offsets", () => {
  const b = new FileIndexBuilder();
  const dir = b.addFolder("/x");
  b.add(dir, "İstanbul.jpg", false);
  b.add(dir, "notes.md", false);
  const index = b.build();
  assert.deepEqual(ids(index, "notes"), [1]);
  assert.equal(index.name(1), "notes.md");
  assert.equal(index.name(0), "İstanbul.jpg");
});

test("an empty index finds nothing", () => {
  assert.deepEqual(ids(FileIndex.empty(), "a"), []);
  assert.equal(FileIndex.empty().size, 0);
});

test("names outside Latin-1 and emoji are found and read back whole", () => {
  const b = new FileIndexBuilder();
  const dir = b.addFolder("/x");
  b.add(dir, "日本語メモ.txt", false);
  b.add(dir, "🎉 party.png", false);
  b.add(dir, "Café.md", false);
  const index = b.build();
  assert.deepEqual(ids(index, "メモ"), [0]);
  assert.deepEqual(ids(index, "party"), [1]);
  assert.deepEqual(ids(index, "café"), [2]);
  assert.equal(index.name(1), "🎉 party.png");
  assert.equal(index.hit(2).path, "/x/Café.md");
});
