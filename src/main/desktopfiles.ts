// Reading .desktop files: where they live, their [Desktop Entry] fields, and
// the GNOME Settings pages among them. Pure apart from reading files.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function applicationDirs(): string[] {
  const home = os.homedir();
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, ".local/share");
  const dataDirs = (process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":");
  const dirs = [
    path.join(dataHome, "applications"),
    ...dataDirs.map((d) => path.join(d, "applications")),
    "/var/lib/flatpak/exports/share/applications",
    path.join(home, ".local/share/flatpak/exports/share/applications"),
    "/var/lib/snapd/desktop/applications",
  ];
  return [...new Set(dirs)];
}

/** Parses the [Desktop Entry] group, preferring unlocalised keys. */
export function parseDesktopFile(file: string): Record<string, string> | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const fields: Record<string, string> = {};
  let inEntry = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      inEntry = trimmed === "[Desktop Entry]";
      continue;
    }
    if (!inEntry || !trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!(key in fields)) fields[key] = trimmed.slice(eq + 1).trim();
  }
  return fields;
}

/** The ;-separated values of a field, e.g. Keywords or Categories. */
export function listField(value: string | undefined): string[] {
  return (value || "").split(";").map((v) => v.trim()).filter(Boolean);
}

/**
 * An application that isn't deleted (Hidden) and is meant for one of
 * `desktops` (XDG_CURRENT_DESKTOP split on ":"). NoDisplay isn't checked here.
 */
export function runsOn(fields: Record<string, string>, desktops: string[]): boolean {
  if (fields.Type !== "Application" || fields.Hidden === "true") return false;
  const allowed = listField(fields.OnlyShowIn);
  if (allowed.length && !allowed.some((d) => desktops.includes(d))) return false;
  if (listField(fields.NotShowIn).some((d) => desktops.includes(d))) return false;
  return Boolean(fields.Name && fields.Exec);
}

/** Calls fn once per .desktop file name, with the first directory's copy (the user's own wins). */
export function eachDesktopFile(dirs: string[], fn: (id: string, file: string) => void): void {
  const seen = new Set<string>();
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".desktop"));
    } catch {
      continue;
    }
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      fn(name, path.join(dir, name));
    }
  }
}

/** A page of GNOME Settings, such as Displays or Power. */
export interface SettingsPanel {
  /** The .desktop file name, e.g. "gnome-display-panel.desktop". */
  id: string;
  name: string;
  comment: string;
  keywords: string[];
  /** What opens it, e.g. ["gnome-control-center", "display"]. */
  command: string[];
}

/**
 * GNOME Settings ships one hidden (NoDisplay) .desktop file per page, with
 * the words GNOME's own search uses to find it: "night light" and
 * "resolution" find Displays, "battery" finds Power. Sorted by name.
 *
 * A keyword that starts another page's name is dropped, so that page comes
 * first: Color lists "Display" and Accessibility lists "Mouse", but "display"
 * should open Displays and "mouse" Mouse & Touchpad.
 */
export function loadSettingsPanels(dirs: string[], desktops: string[]): SettingsPanel[] {
  const panels: SettingsPanel[] = [];
  eachDesktopFile(dirs, (id, file) => {
    const fields = parseDesktopFile(file);
    if (!fields || !listField(fields.Categories).includes("X-GNOME-Settings-Panel")) return;
    if (!runsOn(fields, desktops)) return;
    // Exec field codes (%U, %f...) never appear on these pages; drop any anyway.
    const command = fields.Exec.split(/\s+/).filter((part) => part && !part.startsWith("%"));
    if (!command.length) return;
    panels.push({
      id,
      name: fields.Name,
      comment: fields.Comment || "",
      keywords: listField(fields.Keywords),
      command,
    });
  });
  const names = panels.map((p) => p.name.toLowerCase());
  for (const panel of panels) {
    const own = panel.name.toLowerCase();
    panel.keywords = panel.keywords.filter((k) => !names.some((n) => n !== own && n.startsWith(k.toLowerCase())));
  }
  return panels.sort((a, b) => a.name.localeCompare(b.name));
}

/** Words that find a page besides its name: its keywords, its description ("night light"), "<name> settings". */
export function panelSearchWords(panel: SettingsPanel): string[] {
  return [...panel.keywords, panel.comment, `${panel.name} settings`];
}
