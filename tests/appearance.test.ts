import assert from "node:assert/strict";
import { test } from "node:test";
import { themeVariant } from "../src/main/appearance.ts";

test("themeVariant swaps Yaru", () => {
  assert.equal(themeVariant("Yaru", true), "Yaru-dark");
  assert.equal(themeVariant("Yaru-dark", false), "Yaru");
});

test("themeVariant swaps Dark and Light in names", () => {
  assert.equal(themeVariant("MacTahoe-Dark-solid", false), "MacTahoe-Light-solid");
  assert.equal(themeVariant("MacTahoe-Light-solid", true), "MacTahoe-Dark-solid");
  assert.equal(themeVariant("MacTahoe-Dark", true), "MacTahoe-Dark");
  assert.equal(themeVariant("Adwaita-dark", false), "Adwaita");
});

test("themeVariant leaves single-variant themes alone", () => {
  assert.equal(themeVariant("Adwaita", true), null);
});
