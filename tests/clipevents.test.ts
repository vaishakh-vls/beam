import assert from "node:assert/strict";
import { test } from "node:test";
import { ClipboardEventOrder, parseClipboardEvent } from "../src/main/clipevents.ts";

test("events parse with and without the helper's clock", () => {
  assert.deepEqual(parseClipboardEvent("watching:1234567"), { event: "watching", at: 1234567 });
  assert.deepEqual(parseClipboardEvent("changed"), { event: "changed", at: null });
  assert.deepEqual(parseClipboardEvent("stopped:"), { event: "stopped", at: null });
  assert.deepEqual(parseClipboardEvent("stopped:soon"), { event: "stopped", at: null });
});

test("a stopped that arrives after a later watching is dropped", () => {
  const order = new ClipboardEventOrder();
  // Sent as stopped@100 then watching@105, received the other way round.
  assert.equal(order.accept(parseClipboardEvent("watching:105")), true);
  assert.equal(order.accept(parseClipboardEvent("stopped:100")), false);
  assert.equal(order.accept(parseClipboardEvent("changed:110")), true);
  assert.equal(order.accept(parseClipboardEvent("stopped:200")), true);
});

test("untimed events count only until the helper sends a timed one", () => {
  const order = new ClipboardEventOrder();
  assert.equal(order.heardFromHelper, false);
  // An older helper, or Beam's own check at startup.
  assert.equal(order.accept(parseClipboardEvent("watching")), true);
  assert.equal(order.accept(parseClipboardEvent("changed")), true);
  assert.equal(order.accept(parseClipboardEvent("stopped:50")), true);
  assert.equal(order.heardFromHelper, true);
  // A late answer to the startup check can't undo what the helper said.
  assert.equal(order.accept(parseClipboardEvent("watching")), false);
});
