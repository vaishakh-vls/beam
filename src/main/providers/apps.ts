import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HIDE, type Entry } from "../entry";
import { currentDesktop, launchDetached, revealInFolder } from "../system";
import { iconUrl, resolveIcon } from "../icons";

interface DesktopApp {
  id: string;
  name: string;
  comment: string;
  keywords: string[];
  file: string;
  icon?: string;
}

function applicationDirs(): string[] {
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
function parseDesktopFile(file: string): Record<string, string> | null {
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

function isVisible(fields: Record<string, string>): boolean {
  if (fields.Type !== "Application") return false;
  if (fields.NoDisplay === "true" || fields.Hidden === "true") return false;
  const desktops = currentDesktop().split(":");
  if (fields.OnlyShowIn) {
    const allowed = fields.OnlyShowIn.split(";").filter(Boolean);
    if (!allowed.some((d) => desktops.includes(d))) return false;
  }
  if (fields.NotShowIn) {
    const denied = fields.NotShowIn.split(";").filter(Boolean);
    if (denied.some((d) => desktops.includes(d))) return false;
  }
  return Boolean(fields.Name && fields.Exec);
}

let cache: DesktopApp[] | null = null;

export function loadApps(force = false): DesktopApp[] {
  if (cache && !force) return cache;
  const seen = new Set<string>();
  const apps: DesktopApp[] = [];
  for (const dir of applicationDirs()) {
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".desktop"));
    } catch {
      continue;
    }
    for (const name of names) {
      // Earlier directories (the user's own) override later ones.
      if (seen.has(name)) continue;
      seen.add(name);
      const file = path.join(dir, name);
      const fields = parseDesktopFile(file);
      if (!fields || !isVisible(fields)) continue;
      apps.push({
        id: name,
        name: fields.Name,
        comment: fields.Comment || fields.GenericName || "",
        keywords: (fields.Keywords || "").split(";").filter(Boolean),
        file,
        icon: fields.Icon,
      });
    }
  }
  apps.sort((a, b) => a.name.localeCompare(b.name));
  cache = apps;
  return apps;
}

export function launchApp(desktopId: string): boolean {
  const app = loadApps().find((a) => a.id === desktopId);
  if (!app) return false;
  // gtk-launch resolves Exec field codes and startup notification for us.
  launchDetached("gtk-launch", [desktopId.replace(/\.desktop$/, "")], os.homedir());
  return true;
}

export function appEntries(): Entry[] {
  return loadApps().map((app) => {
    const iconPath = app.icon ? resolveIcon(app.icon) : null;
    return {
      id: `app:${app.id}`,
      ref: `app:${app.id}`,
      title: app.name,
      subtitle: app.comment,
      icon: iconPath ? iconUrl(iconPath) : "🧩",
      accessory: "Application",
      keywords: [...app.keywords, app.id.replace(/\.desktop$/, "")],
      actions: [
        {
          id: "open",
          title: "Open Application",
          shortcut: "↵",
          run: () => {
            launchApp(app.id);
            return HIDE;
          },
        },
        {
          id: "reveal",
          title: "Show Desktop File in Folder",
          shortcut: "Ctrl+↵",
          run: () => {
            revealInFolder(app.file);
            return HIDE;
          },
        },
      ],
    };
  });
}
