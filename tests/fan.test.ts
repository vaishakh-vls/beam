import assert from "node:assert/strict";
import { test } from "node:test";
import { isFanLevel, levelTitle, parseFanFile, shouldRevertToAuto } from "../src/main/fan.ts";

test("read-only fan file, as thinkpad_acpi shows it without fan_control", () => {
  assert.deepEqual(parseFanFile("status:\t\tenabled\nspeed:\t\t2519\nlevel:\t\tauto\n"), {
    speed: 2519,
    level: "auto",
    controllable: false,
  });
});

test("controllable fan file lists its commands", () => {
  const text = [
    "status:\t\tenabled",
    "speed:\t\t3100",
    "level:\t\t3",
    "commands:\tlevel <level> (<level> is 0-7, auto, disengaged, full-speed)",
    "commands:\tenable, disable",
    "commands:\twatchdog <timeout> (<timeout> is 0 (off), 1-120 (seconds))",
  ].join("\n");
  assert.deepEqual(parseFanFile(text), { speed: 3100, level: "3", controllable: true });
});

test("levels Beam offers; fan off is not one of them", () => {
  assert.ok(isFanLevel("auto"));
  assert.ok(isFanLevel("7"));
  assert.ok(isFanLevel("full-speed"));
  assert.ok(!isFanLevel("0"));
  assert.ok(!isFanLevel("disengaged"));
  assert.equal(levelTitle("disengaged"), "Full Speed");
  assert.equal(levelTitle("4"), "Level 4");
});

test("a quiet manual level goes back to auto when the CPU is hot", () => {
  assert.ok(shouldRevertToAuto("2", 91));
  assert.ok(!shouldRevertToAuto("2", 70));
  assert.ok(!shouldRevertToAuto("7", 95));
  assert.ok(!shouldRevertToAuto("auto", 99));
  assert.ok(!shouldRevertToAuto("full-speed", 99));
  assert.ok(!shouldRevertToAuto("3", null));
});
