import assert from "node:assert/strict";
import { test } from "node:test";
import { addCopy, inDisplayOrder, keepNewest, togglePin, withoutUnpinned, type ClipItem } from "../src/main/cliphistory.ts";

const texts = (items: ClipItem[]) => items.map((item) => item.text);

function history(...copies: string[]): ClipItem[] {
  let items: ClipItem[] = [];
  copies.forEach((text, i) => (items = addCopy(items, text, 1000 + i, 100)));
  return items;
}

test("copies go on top and a repeated copy moves up", () => {
  const items = history("a", "b", "c", "a");
  assert.deepEqual(texts(items), ["a", "c", "b"]);
});

test("pinned entries show first, most recently pinned on top", () => {
  let items = history("a", "b", "c", "d");
  items = togglePin(items, "b", 2000);
  items = togglePin(items, "d", 2001);
  assert.deepEqual(texts(inDisplayOrder(items)), ["d", "b", "c", "a"]);
});

test("unpinning puts an entry back among the others by when it was copied", () => {
  let items = togglePin(history("a", "b", "c"), "a", 2000);
  assert.deepEqual(texts(inDisplayOrder(items)), ["a", "c", "b"]);
  items = togglePin(items, "a", 2001);
  assert.equal(items.find((item) => item.text === "a")!.pinnedAt, undefined);
  assert.deepEqual(texts(inDisplayOrder(items)), ["c", "b", "a"]);
});

test("copying a pinned entry again keeps its pin and place", () => {
  let items = togglePin(history("a", "b"), "a", 2000);
  items = addCopy(items, "a", 3000, 100);
  const a = items.find((item) => item.text === "a")!;
  assert.equal(a.pinnedAt, 2000);
  assert.equal(a.copiedAt, 3000);
  assert.equal(items.length, 2);
});

test("the size limit never drops a pinned entry", () => {
  let items = togglePin(history("old"), "old", 2000);
  for (let i = 0; i < 5; i++) items = addCopy(items, `new${i}`, 3000 + i, 3);
  assert.deepEqual(texts(inDisplayOrder(items)), ["old", "new4", "new3", "new2"]);
  assert.deepEqual(texts(keepNewest(items, 1)), ["new4", "old"]);
});

test("clearing the history keeps pinned entries", () => {
  const items = togglePin(history("a", "b", "c"), "b", 2000);
  assert.deepEqual(texts(withoutUnpinned(items)), ["b"]);
});

test("pins survive a save and load as JSON", () => {
  const items = togglePin(history("a", "b"), "a", 2000);
  const loaded: ClipItem[] = JSON.parse(JSON.stringify(items));
  assert.deepEqual(texts(inDisplayOrder(loaded)), ["a", "b"]);
  assert.equal(loaded.find((item) => item.text === "b")!.pinnedAt, undefined);
});
