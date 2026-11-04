import assert from "node:assert/strict";
import { test } from "node:test";
import { cpuPercent, displayName, formatBytes, formatDuration, parseStat, splitCmdline } from "../src/main/procinfo.ts";

const STAT =
  "4242 (Web Content (1)) S 1000 4242 4242 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 31 0 98765 1000000 2560 18446744073709551615";

test("stat fields count from the last parenthesis", () => {
  assert.deepEqual(parseStat(STAT), {
    comm: "Web Content (1)",
    state: "S",
    ppid: 1000,
    ticks: 300,
    threads: 31,
    start: 98765,
    rssPages: 2560,
  });
  assert.equal(parseStat("garbage"), null);
});

test("command lines, including rewritten Chrome titles", () => {
  assert.deepEqual(splitCmdline("/usr/bin/python3\0/usr/bin/networkd-dispatcher\0--run-startup-triggers\0"), [
    "/usr/bin/python3",
    "/usr/bin/networkd-dispatcher",
    "--run-startup-triggers",
  ]);
  assert.deepEqual(splitCmdline("/opt/google/chrome/chrome --type=renderer --lang=en-US"), [
    "/opt/google/chrome/chrome",
    "--type=renderer",
    "--lang=en-US",
  ]);
  assert.deepEqual(splitCmdline(""), []);
});

test("full names where the kernel cut them at 15 characters", () => {
  assert.equal(displayName("networkd-dispat", ["/usr/bin/python3", "/usr/bin/networkd-dispatcher"]), "networkd-dispatcher");
  assert.equal(displayName("gnome-shell", ["/usr/bin/gnome-shell"]), "gnome-shell");
  assert.equal(displayName("Web Content", ["/usr/lib/firefox/firefox", "-contentproc"]), "Web Content");
  assert.equal(displayName("MainThread", ["/usr/bin/node", "server.js"]), "node");
  assert.equal(displayName("next-server (v1", ["next-server", "(v14.2.3)"]), "next-server (v14.2.3)");
});

test("formatting", () => {
  assert.equal(formatBytes(512 * 1024), "512 KB");
  assert.equal(formatBytes(300 * 1024 * 1024), "300 MB");
  assert.equal(formatBytes(3.5 * 1024 ** 3), "3.5 GB");
  assert.equal(formatDuration(42), "42s");
  assert.equal(formatDuration(3 * 3600 + 7 * 60), "3h 7m");
  assert.equal(formatDuration(2 * 86400 + 5 * 3600), "2d 5h");
});

test("CPU use as a share of one core", () => {
  assert.equal(cpuPercent(1000, 1150, 1.5), 100);
  assert.equal(cpuPercent(1000, 1030, 1.5), 20);
  assert.equal(cpuPercent(1000, 1000, 0), 0);
});
