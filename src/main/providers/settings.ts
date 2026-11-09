import { applicationDirs, loadSettingsPanels, panelSearchWords, type SettingsPanel } from "../desktopfiles";
import { HIDE, type Entry } from "../entry";
import { iconUrl, resolveIcon } from "../icons";
import { currentDesktop, launchDetached } from "../system";

let cache: SettingsPanel[] | null = null;

/** GNOME Settings' pages (Displays, Power, Sound...); read once, again on Reload Beam. */
export function loadPanels(force = false): SettingsPanel[] {
  if (!cache || force) cache = loadSettingsPanels(applicationDirs(), currentDesktop().split(":"));
  return cache;
}

/**
 * One result per Settings page, found by its name or by what's on it:
 * "night light", "resolution" or "refresh rate" find Displays.
 */
export function settingsEntries(): Entry[] {
  const icon = resolveIcon("org.gnome.Settings");
  return loadPanels().map((panel) => ({
    id: `settings:${panel.id}`,
    ref: `settings:${panel.id}`,
    title: panel.name,
    subtitle: panel.comment,
    icon: icon ? iconUrl(icon) : "⚙️",
    accessory: "Settings",
    keywords: panelSearchWords(panel),
    actions: [
      {
        id: "open",
        title: "Open in Settings",
        shortcut: "↵",
        run: () => {
          launchDetached(panel.command[0], panel.command.slice(1));
          return HIDE;
        },
      },
    ],
  }));
}
