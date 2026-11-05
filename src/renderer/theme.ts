import type { AppliedTheme, BeamThemeApi } from "../main/themes";

declare global {
  interface Window {
    beamTheme?: BeamThemeApi;
  }
}

let applied: string[] = [];

/** Sets the theme's variables on <html>; inline values win over styles.css :root, which stays the fallback. */
function apply(theme: AppliedTheme): void {
  const root = document.documentElement;
  for (const name of applied) if (!(name in theme.vars)) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(theme.vars)) root.style.setProperty(name, value);
  root.style.colorScheme = theme.scheme;
  root.dataset.theme = theme.id;
  applied = Object.keys(theme.vars);
}

/** Applies Beam's theme now and whenever the main process sends a new one. */
export function startTheme(): void {
  const api = window.beamTheme;
  if (!api) return;
  let pushed = false;
  api.onChange((theme) => {
    pushed = true;
    apply(theme);
  });
  // A push that arrives first is newer than this answer.
  void api.current().then((theme) => {
    if (!pushed) apply(theme);
  });
}
