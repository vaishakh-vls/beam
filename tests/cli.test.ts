import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRunArg, runArgs } from "../src/main/cli.ts";

test("reads --run=<ref>", () => {
  assert.equal(parseRunArg(["/opt/Beam/beam", "--run=toggle"]), "toggle");
  assert.equal(parseRunArg(["/opt/Beam/beam", "--allow-file-access-from-files", "--run=window:left-half"]), "window:left-half");
});

test("reads --run <ref> when Chromium inserts switches before the ref", () => {
  assert.equal(parseRunArg(["/opt/Beam/beam", "--run", "toggle"]), "toggle");
  assert.equal(parseRunArg(["/opt/Beam/beam", "--run", "--allow-file-access-from-files", "toggle"]), "toggle");
});

test("returns null without a ref", () => {
  assert.equal(parseRunArg(["/opt/Beam/beam", "--hidden"]), null);
  assert.equal(parseRunArg(["/opt/Beam/beam", "--run"]), null);
  assert.equal(parseRunArg(["/opt/Beam/beam", "--run="]), null);
});

test("round-trips through runArgs", () => {
  assert.equal(parseRunArg(["/opt/Beam/beam", ...runArgs("view:clipboard")]), "view:clipboard");
});
