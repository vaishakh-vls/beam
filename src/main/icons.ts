import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ICON_SCHEME = "beam-icon";

const SIZES = ["scalable", "256x256", "128x128", "96x96", "64x64", "48x48", "512x512", "32x32"];
const EXTENSIONS = [".svg", ".png", ".xpm"];

function iconRoots(): string[] {
  const home = os.homedir();
  const dataDirs = (process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":");
  return [
    path.join(home, ".local/share/icons"),
    path.join(home, ".icons"),
    ...dataDirs.map((d) => path.join(d, "icons")),
    "/var/lib/flatpak/exports/share/icons",
    path.join(home, ".local/share/flatpak/exports/share/icons"),
  ];
}

function themeNames(): string[] {
  // Ubuntu's default theme first, then the fallbacks every app ships into.
  return ["Yaru", "hicolor", "Adwaita", "gnome"];
}

const cache = new Map<string, string | null>();

/** Finds an icon file for a .desktop Icon= value (a name or a full path). */
export function resolveIcon(name: string): string | null {
  if (cache.has(name)) return cache.get(name)!;
  let found: string | null = null;
  if (path.isAbsolute(name)) {
    found = fs.existsSync(name) ? name : null;
  } else {
    found = searchThemes(name) ?? searchPixmaps(name);
  }
  cache.set(name, found);
  return found;
}

function searchThemes(name: string): string | null {
  for (const root of iconRoots()) {
    for (const theme of themeNames()) {
      const themeDir = path.join(root, theme);
      if (!fs.existsSync(themeDir)) continue;
      for (const size of SIZES) {
        for (const ext of EXTENSIONS) {
          const candidate = path.join(themeDir, size, "apps", name + ext);
          if (fs.existsSync(candidate)) return candidate;
        }
      }
    }
  }
  return null;
}

function searchPixmaps(name: string): string | null {
  for (const ext of EXTENSIONS) {
    const candidate = path.join("/usr/share/pixmaps", name + ext);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export function iconUrl(file: string): string {
  return `${ICON_SCHEME}://icon/${encodeURIComponent(file)}`;
}

/** Maps a beam-icon:// URL back to a file path, only for real icon files. */
export function iconFileFromUrl(url: string): string | null {
  const prefix = `${ICON_SCHEME}://icon/`;
  if (!url.startsWith(prefix)) return null;
  const file = decodeURIComponent(url.slice(prefix.length));
  const ext = path.extname(file).toLowerCase();
  if (![".svg", ".png", ".xpm", ".jpg", ".jpeg", ".ico"].includes(ext)) return null;
  return path.isAbsolute(file) ? file : null;
}
