import { config, saveConfig } from "./config";
import { toResultItem, type Entry, type EntryAction } from "./entry";
import { showForm } from "./forms";
import { bestScore } from "./fuzzy";
import { hotkeyFor, setHotkey } from "./keybinds";
import { appEntries } from "./providers/apps";
import { calculatorEntry } from "./providers/calculator";
import { clipboardEntries } from "./providers/clipboard";
import { commandEntries } from "./providers/commands";
import { emojiSections } from "./providers/emoji";
import { searchFiles } from "./providers/files";
import { quicklinkEntries, rootQuicklinkEntries } from "./providers/quicklinks";
import { scriptEntries } from "./providers/scripts";
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

const VIEW_INFO: Record<View, ViewInfo> = {
  root: { placeholder: "Search for apps and commands…", preview: false, grid: false },
  clipboard: { placeholder: "Type to filter clipboard history…", preview: true, grid: false },
  snippets: { placeholder: "Search snippets…", preview: true, grid: false },
  quicklinks: { placeholder: "Search quicklinks…", preview: false, grid: false },
  emoji: { placeholder: "Search emoji and symbols…", preview: false, grid: true },
  scripts: { placeholder: "Search script commands…", preview: false, grid: false },
  windows: { placeholder: "Move the active window…", preview: false, grid: false },
};

/** Entries from the latest search, so run() can find the clicked item. */
let registry = new Map<string, Entry>();

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
    ...windowEntries(ctx.hide),
    ...appEntries(),
    ...scriptEntries(),
    ...quicklinkEntries(""),
  ];
}

export function search(query: string, view: View, ctx: SearchContext): SearchResponse {
  const sections = view === "root" ? rootSearch(query, ctx) : viewSearch(query, view, ctx);
  registry = new Map();
  for (const section of sections) for (const entry of section.entries) registry.set(entry.id, entry);
  return {
    info: VIEW_INFO[view],
    sections: sections
      .filter((s) => s.entries.length)
      .map((s) => ({ title: s.title, items: s.entries.map(toResultItem) })),
  };
}

type Section = { title: string; entries: Entry[] };

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
