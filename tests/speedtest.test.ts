import assert from "node:assert/strict";
import { test } from "node:test";
import {
  formatMbps,
  formatMs,
  jitter,
  mbps,
  median,
  nextChunkBytes,
  recentMbps,
  resultsLine,
  serverTimeMs,
  steadyMbps,
  type Sample,
} from "../src/main/speedtest.ts";

test("median of odd and even counts", () => {
  assert.equal(median([30, 10, 20]), 20);
  assert.equal(median([40, 10, 30, 20]), 25);
  assert.equal(median([7]), 7);
  assert.ok(Number.isNaN(median([])));
});

test("jitter is the mean difference between consecutive pings", () => {
  assert.equal(jitter([10, 12, 11, 15]), (2 + 1 + 4) / 3);
  assert.equal(jitter([10, 10, 10]), 0);
  assert.equal(jitter([10]), 0);
  assert.equal(jitter([]), 0);
});

test("megabits per second", () => {
  // 125,000 bytes in one second is one megabit per second.
  assert.equal(mbps(125_000, 1000), 1);
  assert.equal(mbps(25_000_000, 800), 250);
  assert.equal(mbps(100, 0), 0);
});

test("server time comes out of Server-Timing", () => {
  assert.equal(serverTimeMs('cfSpeedEdge;dur=3, cfSpeedWorker;dur=17, cfL4;desc="?proto=TCP&rtt=13008"'), 20);
  assert.equal(serverTimeMs("cfRequestDuration;dur=4.5"), 4.5);
  assert.equal(serverTimeMs(null), 0);
  assert.equal(serverTimeMs("cfL4;desc=x"), 0);
});

/** Samples every 100 ms for a link that ramps up over its first `rampMs`. */
function linkSamples(totalMs: number, rampMs: number, mbpsSteady: number): Sample[] {
  const bytesPerMs = (mbpsSteady * 1000) / 8;
  const samples: Sample[] = [];
  let bytes = 0;
  for (let t = 100; t <= totalMs; t += 100) {
    bytes += bytesPerMs * 100 * Math.min(1, t / rampMs);
    samples.push({ t, bytes });
  }
  return samples;
}

test("steady rate skips the ramp-up", () => {
  const samples = linkSamples(7000, 1000, 200);
  assert.ok(Math.abs(steadyMbps(samples) - 200) < 0.001);
  // The plain average is dragged down by slow start.
  assert.ok(mbps(samples.at(-1)!.bytes, 7000) < 195);
});

test("steady rate on short phases and edge cases", () => {
  // A capped phase on a fast link lasts under two seconds.
  const short = linkSamples(1500, 300, 900);
  assert.ok(Math.abs(steadyMbps(short) - 900) < 0.001);
  assert.equal(steadyMbps([]), 0);
  assert.equal(steadyMbps([{ t: 500, bytes: 625_000 }]), 10);
  assert.equal(steadyMbps([{ t: 2000, bytes: 0 }]), 0);
});

test("recent rate covers the last window", () => {
  const samples: Sample[] = [
    { t: 0, bytes: 0 },
    { t: 1000, bytes: 125_000 },
    { t: 2000, bytes: 1_375_000 },
    { t: 3000, bytes: 2_625_000 },
  ];
  assert.equal(recentMbps(samples, 2000), 10);
  assert.equal(recentMbps(samples, 10_000), 7);
  assert.equal(recentMbps(samples.slice(0, 1), 1000), 0);
});

test("chunk sizes follow the link speed", () => {
  const MB = 1_000_000;
  // 1 MB took 100 ms: aim for 500 ms but grow at most fourfold.
  assert.equal(nextChunkBytes(MB, 100, 500, 64_000, 16 * MB), 4 * MB);
  assert.equal(nextChunkBytes(4 * MB, 400, 500, 64_000, 16 * MB), 5 * MB);
  // Slow requests shrink the next one, down to the minimum.
  assert.equal(nextChunkBytes(MB, 4000, 500, 64_000, 16 * MB), 125_000);
  assert.equal(nextChunkBytes(100_000, 10_000, 500, 64_000, 16 * MB), 64_000);
  assert.equal(nextChunkBytes(16 * MB, 100, 500, 64_000, 16 * MB), 16 * MB);
});

test("formatting and the copied line", () => {
  assert.equal(formatMbps(245.4), "245 Mbps");
  assert.equal(formatMbps(24.46), "24.5 Mbps");
  assert.equal(formatMbps(2.456), "2.46 Mbps");
  assert.equal(formatMbps(0), "0 Mbps");
  assert.equal(formatMs(12.4), "12 ms");
  assert.equal(formatMs(8.44), "8.4 ms");
  assert.equal(
    resultsLine({ downMbps: 245.2, upMbps: 80, pingMs: 12.2, jitterMs: 2.14 }),
    "Download 245 Mbps · Upload 80.0 Mbps · Ping 12 ms · Jitter 2.1 ms",
  );
  assert.equal(resultsLine({ pingMs: 12 }), "Ping 12 ms");
});
