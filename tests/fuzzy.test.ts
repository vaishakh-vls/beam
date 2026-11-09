import assert from "node:assert/strict";
import { test } from "node:test";
import { bestScore, fuzzyScore, rankResults } from "../src/main/fuzzy.ts";

test("exact beats prefix beats word start beats substring beats subsequence", () => {
  const exact = fuzzyScore("code", "code");
  const prefix = fuzzyScore("code", "codelite");
  const wordStart = fuzzyScore("code", "visual studio code");
  const substring = fuzzyScore("code", "xcode");
  const subsequence = fuzzyScore("vsc", "visual studio code");
  assert.ok(exact > prefix, "exact > prefix");
  assert.ok(prefix > wordStart, "prefix > word start");
  assert.ok(wordStart > substring, "word start > substring");
  assert.ok(substring > subsequence, "substring > subsequence");
  assert.ok(subsequence > 0, "subsequence matches");
});

test("is case-insensitive and ignores surrounding spaces", () => {
  assert.equal(fuzzyScore("  FIREFOX ", "Firefox"), 1000);
});

test("finds a later word-start occurrence after an earlier mid-word one", () => {
  // "port" appears inside "support" first, then at the start of "port-forward".
  assert.ok(fuzzyScore("port", "support port-forward") >= 500);
});

test("returns 0 when characters are missing", () => {
  assert.equal(fuzzyScore("xyz", "firefox"), 0);
});

test("empty query matches everything", () => {
  assert.equal(fuzzyScore("", "anything"), 1);
});

test("bestScore takes the best field and skips undefined", () => {
  assert.equal(bestScore("term", [undefined, "Terminal", "shell"]), fuzzyScore("term", "Terminal"));
  assert.equal(bestScore("zzz", ["a", undefined]), 0);
});

test("rankResults puts an app above its own commands, which follow it", () => {
  const app = (title: string) => ({ ref: `app:${title}`, title });
  const cmd = (title: string, appName?: string) => ({ ref: `cmd:${title}`, title, app: appName });
  const q = "spo";
  const entries = [cmd("Spotify Play/Pause", "Spotify"), cmd("Spotify Next Track", "Spotify"), app("Spotify"), cmd("Search Spotify", "Spotify"), cmd("Display Options")];
  const ranked = rankResults(entries.map((entry) => ({ entry, score: bestScore(q, [entry.title]) + (entry.ref.startsWith("cmd:") ? 50 : 0) })));
  assert.deepEqual(
    ranked.map(({ entry }) => entry.title),
    ["Spotify", "Spotify Play/Pause", "Spotify Next Track", "Search Spotify", "Display Options"],
  );
});

test("rankResults leaves commands alone when their app is missing or only loosely matched", () => {
  const ranked = rankResults([
    { entry: { ref: "app:Spotify", title: "Spotify" }, score: 120 },
    { entry: { ref: "cmd:play", title: "Spotify Play/Pause", app: "Spotify" }, score: 1050 },
    { entry: { ref: "cmd:chrome-tab", title: "New Chrome Tab", app: "Google Chrome" }, score: 600 },
  ]);
  assert.deepEqual(
    ranked.map(({ entry }) => entry.ref),
    ["cmd:play", "cmd:chrome-tab", "app:Spotify"],
  );
});
