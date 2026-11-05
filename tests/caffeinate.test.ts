import assert from "node:assert/strict";
import { test } from "node:test";
import { caffeinateStatus, durationFromFields, formatDuration, formatRemaining, parseDuration } from "../src/main/caffeinate.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

test("typed durations", () => {
  assert.equal(parseDuration("45m"), 45 * MIN);
  assert.equal(parseDuration("1.5h"), 90 * MIN);
  assert.equal(parseDuration("90"), 90 * MIN);
  assert.equal(parseDuration("2h30m"), 150 * MIN);
  assert.equal(parseDuration("2h 30m"), 150 * MIN);
  assert.equal(parseDuration("2h30"), 150 * MIN);
  assert.equal(parseDuration("1 hour"), HOUR);
  assert.equal(parseDuration("3 hrs"), 3 * HOUR);
  assert.equal(parseDuration("30 min"), 30 * MIN);
  assert.equal(parseDuration(" 10 MINUTES "), 10 * MIN);
  assert.equal(parseDuration("45s"), 45_000);
  assert.equal(parseDuration("1m30"), 90_000);
  assert.equal(parseDuration("0.5"), 30_000);
  assert.equal(parseDuration("1h 15m 30s"), HOUR + 15 * MIN + 30_000);
});

test("text that is not a duration", () => {
  for (const text of ["", "abc", "m", "h30", "0", "0m", "-5", "1.2.3", "5d", "2h2h", "30m 2h", "45s30", "coffee", "1e5"]) {
    assert.equal(parseDuration(text), null, text);
  }
});

test("formatting durations", () => {
  assert.equal(formatDuration(90 * MIN), "1h 30m");
  assert.equal(formatDuration(2 * HOUR), "2h");
  assert.equal(formatDuration(45 * MIN), "45m");
  assert.equal(formatDuration(90_000), "1m 30s");
  assert.equal(formatDuration(20_000), "20s");
});

test("time left rounds up", () => {
  assert.equal(formatRemaining(42 * MIN), "42m left");
  assert.equal(formatRemaining(41 * MIN + 10_000), "42m left");
  assert.equal(formatRemaining(HOUR + 5 * MIN), "1h 5m left");
  assert.equal(formatRemaining(2 * HOUR), "2h left");
  assert.equal(formatRemaining(30_000), "30s left");
  assert.equal(formatRemaining(200), "1s left");
});

test("status beside the commands", () => {
  assert.equal(caffeinateStatus(null, 0), "On until stopped");
  assert.equal(caffeinateStatus(42 * MIN, 0), "On · 42m left");
});

test("time fields", () => {
  assert.equal(durationFromFields({ hours: "1", minutes: "30" }), 90 * MIN);
  assert.equal(durationFromFields({ minutes: "45" }), 45 * MIN);
  assert.equal(durationFromFields({ hours: "", minutes: "", seconds: "20" }), 20_000);
  assert.equal(durationFromFields({ hours: "2", minutes: "90", seconds: "30" }), 2 * HOUR + 90 * MIN + 30_000);
  // Left empty means no timer; typed zeros are a mistake to point out.
  assert.equal(durationFromFields({}), null);
  assert.equal(durationFromFields({ hours: " ", minutes: "" }), null);
  assert.equal(durationFromFields({ minutes: "0" }), 0);
});
