import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadSettingsPanels, panelSearchWords, parseDesktopFile, runsOn } from "../src/main/desktopfiles.ts";
import { bestScore } from "../src/main/fuzzy.ts";

function desktopDirs(files: Record<string, Record<string, string>>): string[] {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "beam-desktop-"));
  const dirs = new Set<string>();
  for (const [rel, fields] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join("\n");
    fs.writeFileSync(file, `[Desktop Entry]\n${body}\n[Desktop Action other]\nName=Ignored\n`);
    dirs.add(path.dirname(file));
  }
  return [...dirs].sort();
}

const display = {
  Type: "Application",
  Name: "Displays",
  Comment: "Use Night Light and choose how to use connected monitors and projectors",
  Exec: "gnome-control-center display",
  NoDisplay: "true",
  OnlyShowIn: "GNOME;Unity;",
  Categories: "GNOME;GTK;Settings;HardwareSettings;X-GNOME-Settings-Panel;",
  Keywords: "Panel;Projector;xrandr;Screen;Resolution;Refresh;Monitor;Night;Light;",
};

test("finds GNOME Settings pages even though they are hidden from the app list", () => {
  const dirs = desktopDirs({
    "a/gnome-display-panel.desktop": display,
    "a/gnome-power-panel.desktop": { ...display, Name: "Power", Exec: "gnome-control-center power", Keywords: "Battery;" },
    "a/org.gnome.Nautilus.desktop": { Type: "Application", Name: "Files", Exec: "nautilus", Categories: "GNOME;Utility;" },
    "a/kde-only-panel.desktop": { ...display, Name: "KDE Page", OnlyShowIn: "KDE;" },
    "a/deleted-panel.desktop": { ...display, Name: "Deleted", Hidden: "true" },
  });
  const panels = loadSettingsPanels(dirs, ["ubuntu", "GNOME"]);
  assert.deepEqual(panels.map((p) => p.name), ["Displays", "Power"]);
  assert.deepEqual(panels[0].command, ["gnome-control-center", "display"]);
  assert.equal(panels[0].id, "gnome-display-panel.desktop");
});

test("the user's own copy of a page wins over the system one", () => {
  const dirs = desktopDirs({
    "a-user/gnome-display-panel.desktop": { ...display, Name: "My Displays" },
    "b-system/gnome-display-panel.desktop": display,
  });
  assert.deepEqual(loadSettingsPanels(dirs, ["GNOME"]).map((p) => p.name), ["My Displays"]);
});

test("night light, resolution and display settings all find Displays", () => {
  const [panel] = loadSettingsPanels(desktopDirs({ "a/gnome-display-panel.desktop": display }), ["GNOME"]);
  const words = [panel.name, ...panelSearchWords(panel)];
  for (const query of ["night light", "resolution", "display", "display settings", "monitor"]) {
    assert.ok(bestScore(query, words) > 0, query);
  }
  assert.ok(bestScore("night light", words) >= 300, "a phrase from the description is a strong match");
  assert.equal(bestScore("spotify", words), 0);
});

test("a page's own name beats another page's keyword", () => {
  const color = { ...display, Name: "Color", Comment: "Calibrate the color", Exec: "gnome-control-center color", Keywords: "Display;Profile;" };
  const panels = loadSettingsPanels(desktopDirs({ "a/gnome-display-panel.desktop": display, "a/gnome-color-panel.desktop": color }), ["GNOME"]);
  const score = (name: string) => {
    const panel = panels.find((p) => p.name === name)!;
    return bestScore("display", [panel.name, ...panelSearchWords(panel)]);
  };
  assert.ok(score("Displays") > score("Color"));
  assert.deepEqual(panels.find((p) => p.name === "Color")!.keywords, ["Profile"]);
});

test("parses only the [Desktop Entry] group and drops field codes from Exec", () => {
  const [dir] = desktopDirs({ "a/x-panel.desktop": { ...display, Exec: "gnome-control-center sound %U" } });
  const fields = parseDesktopFile(path.join(dir, "x-panel.desktop"))!;
  assert.equal(fields.Name, "Displays");
  assert.deepEqual(loadSettingsPanels([dir], ["GNOME"])[0].command, ["gnome-control-center", "sound"]);
});

test("runsOn honours OnlyShowIn and NotShowIn", () => {
  const app = { Type: "Application", Name: "X", Exec: "x" };
  assert.equal(runsOn(app, ["GNOME"]), true);
  assert.equal(runsOn({ ...app, OnlyShowIn: "KDE;" }, ["GNOME"]), false);
  assert.equal(runsOn({ ...app, NotShowIn: "GNOME;" }, ["ubuntu", "GNOME"]), false);
  assert.equal(runsOn({ ...app, Type: "Link" }, ["GNOME"]), false);
});
