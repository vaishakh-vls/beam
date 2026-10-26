import assert from "node:assert/strict";
import { test } from "node:test";
import { bestScore, fuzzyScore } from "../src/main/fuzzy.ts";

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
