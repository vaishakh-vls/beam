import assert from "node:assert/strict";
import { test } from "node:test";
import {
  METADATA_FORMAT,
  classifyPlayerError,
  formatProgress,
  formatTime,
  nextLoop,
  normalizeArtUrl,
  parseLoop,
  parseMetadata,
  parsePosition,
  parseShuffle,
  parseStatus,
  parseVolume,
  spotifySearchUri,
  spotifyWebSearchUrl,
  trackKey,
} from "../src/main/spotify.ts";

const line = (...fields: string[]) => fields.join("\t") + "\n";

test("the format asks for six tab-separated fields", () => {
  assert.equal(METADATA_FORMAT.split("\t").length, 6);
  assert.ok(METADATA_FORMAT.includes("{{mpris:artUrl}}"));
});

test("parses playerctl metadata", () => {
  const track = parseMetadata(
    line("Song Title", "Some Artist, Other Artist", "An Album", "https://i.scdn.co/image/ab67616d0000b273abc", "215000000", "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC"),
  );
  assert.deepEqual(track, {
    title: "Song Title",
    artist: "Some Artist, Other Artist",
    album: "An Album",
    artUrl: "https://i.scdn.co/image/ab67616d0000b273abc",
    length: 215,
    url: "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
  });
});

test("missing fields stay empty or undefined", () => {
  const track = parseMetadata(line("Podcast Episode", "", "", "", "", ""));
  assert.deepEqual(track, { title: "Podcast Episode", artist: "", album: "", artUrl: undefined, length: undefined, url: undefined });
});

test("a tab inside the title does not shift the other fields", () => {
  const track = parseMetadata(line("Left\tRight", "Artist", "Album", "https://i.scdn.co/image/x", "1000000", ""));
  assert.equal(track?.title, "Left\tRight");
  assert.equal(track?.artist, "Artist");
  assert.equal(track?.album, "Album");
  assert.equal(track?.length, 1);
});

test("no title or malformed output means nothing is playing", () => {
  assert.equal(parseMetadata(""), null);
  assert.equal(parseMetadata("\n"), null);
  assert.equal(parseMetadata(line("", "", "", "", "", "")), null);
  assert.equal(parseMetadata("No metadata\n"), null);
});

test("art URLs: legacy open.spotify.com images move to i.scdn.co; others are dropped", () => {
  assert.equal(normalizeArtUrl("https://open.spotify.com/image/ab67616d0000b273abc"), "https://i.scdn.co/image/ab67616d0000b273abc");
  assert.equal(normalizeArtUrl("https://i.scdn.co/image/abc"), "https://i.scdn.co/image/abc");
  assert.equal(normalizeArtUrl("http://i.scdn.co/image/abc"), undefined);
  assert.equal(normalizeArtUrl("file:///tmp/cover.png"), undefined);
  assert.equal(normalizeArtUrl(""), undefined);
});

test("status, position, volume, shuffle and loop", () => {
  assert.equal(parseStatus("Playing\n"), "Playing");
  assert.equal(parseStatus("Paused\n"), "Paused");
  assert.equal(parseStatus("No players found\n"), null);
  assert.equal(parsePosition("83.512000\n"), 83.512);
  assert.equal(parsePosition(""), null);
  assert.equal(parseVolume("0.650000\n"), 65);
  assert.equal(parseVolume("garbage"), null);
  assert.equal(parseShuffle("On\n"), true);
  assert.equal(parseShuffle("Off\n"), false);
  assert.equal(parseShuffle(""), null);
  assert.equal(parseLoop("Playlist\n"), "Playlist");
  assert.equal(parseLoop("weird"), null);
});

test("repeat cycles off, playlist, track", () => {
  assert.equal(nextLoop("None"), "Playlist");
  assert.equal(nextLoop("Playlist"), "Track");
  assert.equal(nextLoop("Track"), "None");
  assert.equal(nextLoop(null), "Playlist");
});

test("classifies playerctl failures", () => {
  assert.equal(classifyPlayerError("spawn playerctl ENOENT"), "missing");
  assert.equal(classifyPlayerError("No players found"), "not-running");
  assert.equal(classifyPlayerError("No player could handle this command"), "not-running");
  assert.equal(classifyPlayerError("GDBus.Error:org.freedesktop.DBus.Error.NoReply"), "other");
});

test("formats times and progress", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(7.9), "0:07");
  assert.equal(formatTime(187), "3:07");
  assert.equal(formatTime(3729), "1:02:09");
  assert.equal(formatTime(-5), "0:00");
  assert.equal(formatProgress(83.5, 225), "1:23 / 3:45");
  assert.equal(formatProgress(300, 225), "3:45 / 3:45");
  assert.equal(formatProgress(null, 225), "3:45");
  assert.equal(formatProgress(65, undefined), "1:05");
  assert.equal(formatProgress(null, undefined), "");
});

test("track keys tell tracks apart", () => {
  const a = parseMetadata(line("A", "X", "Y", "", "1", "https://open.spotify.com/track/a"));
  const b = parseMetadata(line("A", "X", "Y", "", "1", "https://open.spotify.com/track/b"));
  assert.notEqual(trackKey(a), trackKey(b));
  assert.equal(trackKey(null), "");
});

test("search links encode the query", () => {
  assert.equal(spotifySearchUri("  daft punk & friends "), "spotify:search:daft%20punk%20%26%20friends");
  assert.equal(spotifyWebSearchUrl("AC/DC"), "https://open.spotify.com/search/AC%2FDC");
});
