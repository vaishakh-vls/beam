import assert from "node:assert/strict";
import { test } from "node:test";
import { footprintReport, lowMemoryMode } from "../src/main/footprint.ts";

const GB = 1024 ** 3;

test("auto turns low-memory mode on at 4 GB of RAM or less", () => {
  assert.equal(lowMemoryMode("auto", 1.9 * GB), true);
  assert.equal(lowMemoryMode("auto", 3.7 * GB), true);
  assert.equal(lowMemoryMode("auto", 7.6 * GB), false);
  assert.equal(lowMemoryMode("auto", 31 * GB), false);
});

test("on and off win over the machine's RAM; anything else counts as auto", () => {
  assert.equal(lowMemoryMode("on", 31 * GB), true);
  assert.equal(lowMemoryMode(true, 31 * GB), true);
  assert.equal(lowMemoryMode("off", 2 * GB), false);
  assert.equal(lowMemoryMode(false, 2 * GB), false);
  assert.equal(lowMemoryMode(undefined, 2 * GB), true);
  assert.equal(lowMemoryMode("sometimes", 16 * GB), false);
});

test("footprintReport totals the processes and lists each kind, largest first", () => {
  const text = footprintReport(
    [
      { type: "Browser", kb: 100 * 1024 },
      { type: "GPU", kb: 45 * 1024 },
      { type: "Tab", kb: 52 * 1024 },
      { type: "Zygote", kb: 12 * 1024 },
      { type: "Zygote", kb: 12 * 1024 },
      { type: "Utility", service: "network.mojom.NetworkService", kb: 20 * 1024 },
    ],
    ["A note."],
  );
  assert.equal(
    text,
    [
      "Beam is using 241 MB of memory in 6 processes.",
      "",
      "  Main process              100 MB",
      "  Window                     52 MB",
      "  Graphics (GPU)             45 MB",
      "  Process launcher (2)       24 MB",
      "  Network service            20 MB",
      "",
      "A note.",
    ].join("\n"),
  );
});
