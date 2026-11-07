// Light and dark variants of the current themes, for Toggle System Appearance. Pure apart from the link swap.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The same theme's other variant: "Yaru" <-> "Yaru-dark", "MacTahoe-Dark-solid"
 * <-> "MacTahoe-Light-solid". Null when the name has no light/dark part.
 */
export function themeVariant(theme: string, dark: boolean): string | null {
  if (/^Yaru(-dark)?$/.test(theme)) return dark ? "Yaru-dark" : "Yaru";
  if (theme.includes("Dark")) return dark ? theme : theme.replace("Dark", "Light");
  if (theme.includes("Light")) return dark ? theme.replace("Light", "Dark") : theme;
  if (theme.endsWith("-dark")) return dark ? theme : theme.slice(0, -"-dark".length);
  return null;
}

/**
 * Themes such as MacTahoe and WhiteSur style libadwaita apps through
 * ~/.config/gtk-4.0, with gtk.css linking to gtk-Dark.css or gtk-Light.css.
 * Points the link at the matching one; does nothing for other setups.
 * Apps pick it up when they next start.
 */
export function setLibadwaitaVariant(dark: boolean): void {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "gtk-4.0");
  const link = path.join(dir, "gtk.css");
  const target = path.join(dir, dark ? "gtk-Dark.css" : "gtk-Light.css");
  try {
    if (!fs.existsSync(target) || !fs.lstatSync(link).isSymbolicLink()) return;
    fs.unlinkSync(link);
    fs.symlinkSync(target, link);
  } catch (error) {
    console.error("beam: could not switch the libadwaita theme:", error);
  }
}
