import assert from "node:assert/strict";
import { test } from "node:test";
import { toGnomeAccelerator } from "../src/main/accelerators.ts";

test("converts modifiers and letters", () => {
  assert.equal(toGnomeAccelerator("Ctrl+Alt+V"), "<Control><Alt>v");
  assert.equal(toGnomeAccelerator("Super+Shift+E"), "<Super><Shift>e");
});

test("converts named keys", () => {
  assert.equal(toGnomeAccelerator("Alt+Space"), "<Alt>space");
  assert.equal(toGnomeAccelerator("Ctrl+Enter"), "<Control>Return");
  assert.equal(toGnomeAccelerator("Ctrl+/"), "<Control>slash");
  assert.equal(toGnomeAccelerator("Alt+F4"), "<Alt>F4");
});

test("rejects hotkeys without a modifier or with unknown parts", () => {
  assert.equal(toGnomeAccelerator("V"), null);
  assert.equal(toGnomeAccelerator("Hyper+V"), null);
  assert.equal(toGnomeAccelerator("Ctrl+Banana"), null);
  assert.equal(toGnomeAccelerator(""), null);
});
