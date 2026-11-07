import assert from "node:assert/strict";
import { test } from "node:test";
import { offerNewKeybinds } from "../src/main/config.ts";

const defaults = [
  { keys: "Super+Space", ref: "toggle" },
  { keys: "Super+Shift+C", ref: "cmd:confetti" },
];

test("offerNewKeybinds adds a default not offered before", () => {
  const { keybinds, added } = offerNewKeybinds([{ keys: "Super+Space", ref: "toggle" }], ["toggle"], defaults);
  assert.deepEqual(added, [{ keys: "Super+Shift+C", ref: "cmd:confetti" }]);
  assert.equal(keybinds.length, 2);
});

test("offerNewKeybinds never re-adds a removed default", () => {
  const { added } = offerNewKeybinds([], ["toggle", "cmd:confetti"], defaults);
  assert.deepEqual(added, []);
});

test("offerNewKeybinds skips keys or commands already bound", () => {
  const taken = offerNewKeybinds([{ keys: "super+shift+c", ref: "cmd:lock" }], [], defaults);
  assert.deepEqual(taken.added, [{ keys: "Super+Space", ref: "toggle" }]);
  const bound = offerNewKeybinds([{ keys: "Ctrl+Alt+C", ref: "cmd:confetti" }], [], defaults);
  assert.deepEqual(bound.added, [{ keys: "Super+Space", ref: "toggle" }]);
});
