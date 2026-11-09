import os from "node:os";
import { applicationDirs, eachDesktopFile, listField, parseDesktopFile, runsOn } from "../desktopfiles";
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

function isVisible(fields: Record<string, string>): boolean {
  return fields.NoDisplay !== "true" && runsOn(fields, currentDesktop().split(":"));
}

let cache: DesktopApp[] | null = null;

export function loadApps(force = false): DesktopApp[] {
  if (cache && !force) return cache;
  const apps: DesktopApp[] = [];
  eachDesktopFile(applicationDirs(), (id, file) => {
    const fields = parseDesktopFile(file);
    if (!fields || !isVisible(fields)) return;
    apps.push({
      id,
      name: fields.Name,
      comment: fields.Comment || fields.GenericName || "",
      keywords: listField(fields.Keywords),
      file,
      icon: fields.Icon,
    });
  });
  apps.sort((a, b) => a.name.localeCompare(b.name));
  cache = apps;
  return apps;
}

/** The icon of the installed app with this name ("Spotify"), as a beam-icon:// URL. */
export function appIconUrl(name: string): string | null {
  const app = loadApps().find((a) => a.icon && a.name === name);
  const file = app?.icon ? resolveIcon(app.icon) : null;
  return file ? iconUrl(file) : null;
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
