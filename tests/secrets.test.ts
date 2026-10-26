import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeSecret } from "../src/main/secrets.ts";

test("flags common token formats", () => {
  const samples = [
    "xoxb-1234567890-abcdefghijk",
    "xapp-1-A0CBL5A8YQZ-1234567890",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "AKIAABCDEFGHIJKLMNOP",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnop",
  ];
  for (const sample of samples) assert.ok(looksLikeSecret(sample), sample);
});

test("leaves ordinary text alone", () => {
  const samples = [
    "https://github.com/Perssonify/DropAnalysis",
    "SELECT * FROM traces WHERE project = 42",
    "sk-short",
    "Meeting at 3pm about the skeleton-key design",
  ];
  for (const sample of samples) assert.ok(!looksLikeSecret(sample), sample);
});
