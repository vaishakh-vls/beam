import { config, saveConfig } from "./config";
import { toResultItem, type Entry, type EntryAction, type Section, type ViewProvider } from "./entry";
import { showForm } from "./forms";
import { bestScore } from "./fuzzy";
import { hotkeyFor, setHotkey } from "./keybinds";
import { appEntries } from "./providers/apps";
import { audioCommands, audioView, volumeEntry } from "./providers/audio";
import { bluetoothCommands, bluetoothView } from "./providers/bluetooth";
import { caffeinateCommands, caffeinateView } from "./providers/caffeinate";
import { calculatorEntry } from "./providers/calculator";
import { chromeCommands, chromeView } from "./providers/chrome";
import { clipboardEntries } from "./providers/clipboard";
import { colorCommands, colorEntry, colorView } from "./providers/color";
import { commandEntries } from "./providers/commands";
import { convertCommands, convertView } from "./providers/convert";
import { currencyEntry } from "./providers/currency";
import { devtoolsCommands, devtoolsInlineEntries, devtoolsView } from "./providers/devtools";
import { emojiSections } from "./providers/emoji";
import { fanCommands, fanView } from "./providers/fans";
import { searchFiles } from "./providers/files";
import { fontsCommands, fontsView } from "./providers/fonts";
import { gifCommands, gifView } from "./providers/gifs";
import { keyboardCommands, keyboardView } from "./providers/keyboard";
import { openWithView } from "./providers/openwith";
import { powerCommands, powerView } from "./providers/power";
import { processCommands, processView } from "./providers/processes";
import { quicklinkEntries, rootQuicklinkEntries } from "./providers/quicklinks";
import { scriptEntries } from "./providers/scripts";
import { speedtestCommands, speedtestView } from "./providers/speedtest";
import { spotifyCommands, spotifyView } from "./providers/spotify";
import { tabsCommands, tabsView } from "./providers/tabs";
import { themesCommands, themesView } from "./providers/themes";
import { welcomeCommands, welcomeView } from "./providers/welcome";
import { wifiCommands, wifiView } from "./providers/wifi";
import { windowEntries } from "./providers/windows";
import { createSnippetAction, snippetEntries, snippetKeywordMatches } from "./providers/snippets";
import { openUrl } from "./system";
import { recentRefs, recordUse, usageBoost } from "./usage";
import type { RunResult, SearchResponse, View, ViewInfo } from "../shared/types";

export interface SearchContext {
  hide: () => void;
  reload: () => void;
  /** Called after hotkeys change so they can be re-registered. */
  hotkeysChanged: () => void;
}

const VIEW_INFO: Partial<Record<View, ViewInfo>> = {
  root: { title: "", placeholder: "Search for apps and commands…", preview: false, grid: false },
  clipboard: { title: "Clipboard History", placeholder: "Type to filter clipboard history…", preview: true, grid: false },
  snippets: { title: "Snippets", placeholder: "Search snippets…", preview: true, grid: false },
  quicklinks: { title: "Quicklinks", placeholder: "Search quicklinks…", preview: false, grid: false },
  emoji: { title: "Emoji & Symbols", placeholder: "Search emoji and symbols…", preview: false, grid: true },
  scripts: { title: "Script Commands", placeholder: "Search script commands…", preview: false, grid: false },
  windows: { title: "Window Management", placeholder: "Move the active window…", preview: false, grid: false },
};

/** Views that live in their own provider module. */
const VIEWS: Partial<Record<View, ViewProvider>> = {
  processes: processView,
  fans: fanView,
  media: spotifyView,
  chrome: chromeView,
  gifs: gifView,
  wifi: wifiView,
  bluetooth: bluetoothView,
  audio: audioView,
  colors: colorView,
  caffeinate: caffeinateView,
  speedtest: speedtestView,
  "clean-keyboard": keyboardView,
  "open-with": openWithView,
  devtools: devtoolsView,
  convert: convertView,
  fonts: fontsView,
  power: powerView,
  themes: themesView,
  tabs: tabsView,
  welcome: welcomeView,
};

/** Entries from the latest search, so run() can find the clicked item. */
let registry = new Map<string, Entry>();
/** Views can be slow (nmcli, bluetoothctl); only the newest search may replace the registry. */
let searchSeq = 0;

export function runAction(itemId: string, actionId: string): RunResult | Promise<RunResult> {
  const entry = registry.get(itemId);
  const action = entry?.actions.find((a) => a.id === actionId);
  if (!entry || !action) return { type: "error", message: "That item is no longer available." };
  return action.run();
}

/** Every launchable command, used by root search and `beam --run`. */
export function launchableEntries(ctx: SearchContext): Entry[] {
  return [
    ...commandEntries(ctx.reload),
    ...welcomeCommands(),
    ...processCommands(),
    ...fanCommands(),
    ...spotifyCommands(ctx.hide),
    ...chromeCommands(ctx.hide),
    ...gifCommands(ctx.hide),
    ...wifiCommands(ctx.hide),
    ...bluetoothCommands(ctx.hide),
    ...audioCommands(ctx.hide),
    ...colorCommands(ctx.hide),
    ...caffeinateCommands(ctx.hide),
    ...speedtestCommands(ctx.hide),
    ...keyboardCommands(ctx.hide),
    ...devtoolsCommands(ctx.hide),
    ...convertCommands(ctx.hide),
    ...fontsCommands(ctx.hide),
    ...powerCommands(ctx.hide),
    ...themesCommands(ctx.hide),
    ...tabsCommands(ctx.hide),
    ...windowEntries(ctx.hide),
    ...appEntries(),
    ...scriptEntries(),
    ...quicklinkEntries(""),
  ];
}

export async function search(query: string, view: View, ctx: SearchContext): Promise<SearchResponse> {
  const seq = ++searchSeq;
  const provider = VIEWS[view];
  const sections = view === "root"
    ? rootSearch(query, ctx)
    : provider
      ? await provider.sections(query, ctx.hide)
      : viewSearch(query, view, ctx);
  if (seq === searchSeq) {
    registry = new Map();
    for (const section of sections) for (const entry of section.entries) registry.set(entry.id, entry);
  }
  return {
    info: provider?.info ?? VIEW_INFO[view] ?? VIEW_INFO.root!,
    sections: sections
      .filter((s) => s.entries.length)
      .map((s) => ({ title: s.title, items: s.entries.map(toResultItem) })),
  };
}

function viewSearch(query: string, view: View, ctx: SearchContext): Section[] {
  switch (view) {
    case "clipboard":
      return [{ title: "Clipboard History", entries: clipboardEntries(query, ctx.hide, createSnippetAction) }];
    case "snippets":
      return [{ title: "Snippets", entries: snippetEntries(query, ctx.hide) }];
    case "quicklinks":
      return [{ title: "Quicklinks", entries: quicklinkEntries(query).map((e) => withCommandActions(e, ctx)) }];
    case "emoji":
      return emojiSections(query, ctx.hide);
    case "scripts":
      return [
        {
          title: "Script Commands",
          entries: scriptEntries()
            .filter((e) => !query.trim() || bestScore(query, [e.title, ...(e.keywords ?? [])]) > 0)
            .map((e) => withCommandActions(e, ctx)),
        },
      ];
    case "windows":
      return [
        {
          title: "Window Management",
          entries: windowEntries(ctx.hide)
            .filter((e) => !query.trim() || bestScore(query, [e.title, ...(e.keywords ?? [])]) > 0)
            .map((e) => withCommandActions(e, ctx)),
        },
      ];
    default:
      return [];
  }
}

function rootSearch(query: string, ctx: SearchContext): Section[] {
  const q = query.trim();
  const commands = launchableEntries(ctx);
  const aliases = config().aliases;

  if (!q) {
    const byRef = new Map(commands.map((e) => [e.ref, e]));
    const recent = recentRefs(8)
      .map((ref) => byRef.get(ref))
      .filter((e): e is Entry => Boolean(e));
    const beamCommands = commands.filter((e) => e.ref?.startsWith("cmd:") && e.subtitle === "Beam");
    return [
      { title: "Recent", entries: recent.map((e) => withCommandActions(e, ctx)) },
      { title: "Commands", entries: beamCommands.map((e) => withCommandActions(e, ctx)) },
    ];
  }

  const scored: Array<{ entry: Entry; score: number }> = [];
  for (const entry of commands) {
    if (entry.ref?.startsWith("quicklink:")) continue;
    const alias = entry.ref ? aliases[entry.ref] : undefined;
    let score = bestScore(q, [entry.title, ...(entry.keywords ?? [])]);
    // Beam's own commands win ties with apps, e.g. "emoji" -> Search Emoji.
    if (score > 0 && (entry.ref?.startsWith("cmd:") || entry.ref?.startsWith("window:"))) score += 50;
    if (alias && alias.toLowerCase() === q.toLowerCase()) score += 2000;
    else if (alias && alias.toLowerCase().startsWith(q.toLowerCase())) score = Math.max(score, 900);
    if (score > 0) scored.push({ entry, score: score + usageBoost(entry.ref) });
  }
  for (const { entry, score } of rootQuicklinkEntries(q)) {
    scored.push({ entry, score: score + usageBoost(entry.ref) });
  }
  for (const entry of snippetKeywordMatches(q, ctx.hide)) scored.push({ entry, score: 3000 });
  scored.sort((a, b) => b.score - a.score);
  // Loose subsequence matches are only worth showing when nothing better exists.
  const strong = scored.filter(({ score }) => score >= 300);
  const ranked = strong.length >= 3 ? strong : scored;

  const sections: Section[] = [];
  const calc = calculatorEntry(q, ctx.hide);
  if (calc) sections.push({ title: "Calculator", entries: [calc] });
  const money = currencyEntry(q, ctx.hide);
  if (money) sections.push({ title: "Currency", entries: [money] });
  const volume = volumeEntry(q);
  if (volume) sections.push({ title: "Volume", entries: [volume] });
  const color = colorEntry(q);
  if (color) sections.push({ title: "Color", entries: [color] });
  const dev = devtoolsInlineEntries(q, ctx.hide);
  if (dev.length) sections.push({ title: "Developer Tools", entries: dev });
  sections.push({
    title: "Results",
    entries: ranked.slice(0, 12).map(({ entry }) => withCommandActions(entry, ctx)),
  });
  sections.push({ title: "Files", entries: searchFiles(q, 6) });
  sections.push({ title: `Use "${q}" with…`, entries: fallbackEntries(q) });
  return sections;
}

function fallbackEntries(query: string): Entry[] {
  const make = (id: string, title: string, icon: string, url: string): Entry => ({
    id: `fallback:${id}`,
    title,
    icon,
    accessory: "Fallback",
    actions: [
      {
        id: "open",
        title,
        shortcut: "↵",
        run: () => {
          openUrl(url);
          return { type: "hide" };
        },
      },
    ],
  });
  const q = encodeURIComponent(query);
  return [
    make("web", `Search Google for "${query}"`, "🔎", config().webSearchUrl.replace("%s", q)),
    make("claude", `Ask Claude "${query}"`, "✳️", `https://claude.ai/new?q=${q}`),
  ];
}

/**
 * Adds Raycast's per-command actions (alias and hotkey) and records usage
 * whenever the primary action runs.
 */
function withCommandActions(entry: Entry, ctx: SearchContext): Entry {
  const ref = entry.ref;
  if (!ref) return entry;
  const alias = config().aliases[ref];
  const hotkey = hotkeyFor(ref);
  const tracked: EntryAction[] = entry.actions.map((action) => ({
    ...action,
    run: () => {
      recordUse(ref);
      return action.run();
    },
  }));
  return {
    ...entry,
    accessory: [alias, hotkey, entry.accessory].filter(Boolean).join("  ·  "),
    actions: [
      ...tracked,
      {
        id: "alias",
        title: alias ? "Change Alias…" : "Add Alias…",
        shortcut: "Ctrl+Shift+A",
        run: () => aliasForm(ref, entry.title, alias),
      },
      {
        id: "hotkey",
        title: hotkey ? "Change Hotkey…" : "Record Hotkey…",
        shortcut: "Ctrl+Shift+H",
        run: () => hotkeyForm(ref, entry.title, hotkey, ctx),
      },
    ],
  };
}

function aliasForm(ref: string, title: string, current?: string): RunResult {
  return showForm(
    {
      title: `Alias for ${title}`,
      submitLabel: "Save Alias",
      fields: [
        {
          name: "alias",
          label: "Alias",
          type: "text",
          value: current ?? "",
          placeholder: "e.g. vs",
          optional: true,
          hint: "Typing the alias puts this command first. Leave empty to remove.",
        },
      ],
    },
    (values) => {
      const alias = values.alias.trim();
      if (alias) config().aliases[ref] = alias;
      else delete config().aliases[ref];
      saveConfig();
      return { type: "view", view: "root" };
    },
  );
}

function hotkeyForm(ref: string, title: string, current: string | undefined, ctx: SearchContext): RunResult {
  return showForm(
    {
      title: `Hotkey for ${title}`,
      submitLabel: "Save Hotkey",
      fields: [
        {
          name: "keys",
          label: "Hotkey",
          type: "hotkey",
          value: current ?? "",
          placeholder: "Press a key combination",
          optional: true,
          hint: "Press the keys, e.g. Ctrl+Alt+J. Backspace clears it, which removes the hotkey.",
        },
      ],
    },
    (values) => {
      const error = setHotkey(ref, values.keys);
      if (error) return { type: "error", message: error };
      saveConfig();
      ctx.hotkeysChanged();
      return { type: "view", view: "root" };
    },
  );
}
