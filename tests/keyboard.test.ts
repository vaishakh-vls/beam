import assert from "node:assert/strict";
import { test } from "node:test";
import { lockFailure, lockLabel, parseLockReply, parseLockSeconds } from "../src/main/keyboard.ts";

test("typed lock durations", () => {
  assert.equal(parseLockSeconds("45"), 45);
  assert.equal(parseLockSeconds("45s"), 45);
  assert.equal(parseLockSeconds("45 sec"), 45);
  assert.equal(parseLockSeconds("1m"), 60);
  assert.equal(parseLockSeconds("1.5 min"), 90);
  assert.equal(parseLockSeconds("2 minutes"), 120);
  for (const text of ["", "0", "abc", "-5", "1h", "5 days", "m"]) assert.equal(parseLockSeconds(text), null, text);
});

test("labels", () => {
  assert.equal(lockLabel(1), "1 second");
  assert.equal(lockLabel(45), "45 seconds");
  assert.equal(lockLabel(60), "1 minute");
  assert.equal(lockLabel(90), "1 minute 30 s");
  assert.equal(lockLabel(300), "5 minutes");
});

test("gdbus replies", () => {
  assert.deepEqual(parseLockReply("(true, 'Keyboard locked for 30 seconds')\n"), {
    ok: true,
    message: "Keyboard locked for 30 seconds",
  });
  assert.deepEqual(parseLockReply("(false, 'The keyboard is already locked')"), {
    ok: false,
    message: "The keyboard is already locked",
  });
  assert.equal(parseLockReply(""), null);
  assert.equal(parseLockReply("()"), null);
});

test("failures that a log out fixes", () => {
  // Real gdbus output for an extension loaded before LockKeyboard existed.
  assert.equal(lockFailure("Error: GDBus.Error:org.freedesktop.DBus.Error.UnknownMethod: No such method “LockKeyboard”"), "needs-login");
  // And for no extension at all.
  assert.equal(
    lockFailure("Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown: The name org.virallens.BeamWindows was not provided by any .service files"),
    "needs-login",
  );
  assert.equal(lockFailure("Error: Timeout was reached"), "other");
});
