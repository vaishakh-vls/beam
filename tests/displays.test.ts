import assert from "node:assert/strict";
import { test } from "node:test";
import { launcherBounds, parsePointerReply } from "../src/main/displays.ts";

test("parsePointerReply reads gdbus's tuple, negative numbers included", () => {
  assert.deepEqual(parsePointerReply("(812, 1460)\n"), { x: 812, y: 1460 });
  assert.deepEqual(parsePointerReply("(-1920, 40)"), { x: -1920, y: 40 });
});

test("parsePointerReply rejects anything else", () => {
  assert.equal(parsePointerReply(""), null);
  assert.equal(parsePointerReply("(true, 'left-half')"), null);
  assert.equal(parsePointerReply("Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod"), null);
});

test("launcherBounds centres the window a fifth of the way down that display", () => {
  // The laptop below a 1080p monitor, as GNOME lays them out.
  const laptop = { x: 0, y: 1080, width: 1920, height: 1168 };
  assert.deepEqual(launcherBounds(laptop, 760, 480), { x: 580, y: 1314, width: 760, height: 480 });
  const monitor = { x: 0, y: 32, width: 1920, height: 1048 };
  assert.deepEqual(launcherBounds(monitor, 760, 480), { x: 580, y: 242, width: 760, height: 480 });
});
