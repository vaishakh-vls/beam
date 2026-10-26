import { HIDE, type Entry } from "../entry";
import { showForm } from "../forms";
import { bestScore } from "../fuzzy";
import { JsonStore, newId } from "../store";
import { copyText, openPath, openUrl } from "../system";
import { expandPlaceholders } from "./snippets";
import type { RunResult } from "../../shared/types";

interface Quicklink {
  id: string;
  name: string;
  /** A URL or a local path. "{query}" asks for text when opened. */
  link: string;
  icon?: string;
}

const store = new JsonStore<{ quicklinks: Quicklink[] }>("quicklinks.json", () => ({
  quicklinks: [
    { id: "google", name: "Search Google", link: "https://www.google.com/search?q={query}", icon: "🔎" },
    { id: "youtube", name: "Search YouTube", link: "https://www.youtube.com/results?search_query={query}", icon: "▶️" },
    { id: "github", name: "Search GitHub", link: "https://github.com/search?q={query}", icon: "🐙" },
    { id: "claude", name: "Ask Claude", link: "https://claude.ai/new?q={query}", icon: "✳️" },
    { id: "maps", name: "Search Google Maps", link: "https://www.google.com/maps/search/{query}", icon: "🗺️" },
  ],
}));

function needsQuery(link: Quicklink): boolean {
  return link.link.includes("{query}");
}

function openLink(link: Quicklink, query: string): RunResult {
  const target = expandPlaceholders(link.link.replaceAll("{query}", encodeURIComponent(query)));
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) openUrl(target);
  else openPath(target.replace(/^~(?=\/|$)/, process.env.HOME ?? "~"));
  return HIDE;
}

function askQuery(link: Quicklink, initial = ""): RunResult {
  return showForm(
    {
      title: link.name,
      submitLabel: "Open",
      fields: [{ name: "query", label: "Query", type: "text", value: initial, placeholder: "Type and press Enter" }],
    },
    (values) => openLink(link, values.query),
  );
}

function quicklinkForm(existing: Quicklink | null): RunResult {
  return showForm(
    {
      title: existing ? "Edit Quicklink" : "Create Quicklink",
      submitLabel: existing ? "Save Quicklink" : "Create Quicklink",
      fields: [
        { name: "name", label: "Name", type: "text", value: existing?.name ?? "", placeholder: "Jira ticket" },
        {
          name: "link",
          label: "Link",
          type: "text",
          value: existing?.link ?? "",
          placeholder: "https://example.atlassian.net/browse/{query}",
          hint: "A URL or folder path. Use {query} to type text when opening it.",
        },
        { name: "icon", label: "Icon", type: "text", value: existing?.icon ?? "", placeholder: "🔗", optional: true },
      ],
    },
    (values) => {
      if (!values.name.trim() || !values.link.trim()) {
        return { type: "error", message: "Name and link are required." };
      }
      const data = { name: values.name.trim(), link: values.link.trim(), icon: values.icon.trim() || undefined };
      if (existing) Object.assign(existing, data);
      else store.data.quicklinks.push({ id: newId(), ...data });
      store.save();
      return { type: "view", view: "quicklinks" };
    },
  );
}

export function openCreateQuicklinkForm(): RunResult {
  return quicklinkForm(null);
}

export function quicklinkEntries(query: string): Entry[] {
  const q = query.trim();
  return store.data.quicklinks
    .map((link) => ({ link, score: q ? bestScore(q, [link.name, link.link]) : 1 }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ link }) => quicklinkEntry(link));
}

/** Quicklinks matching the root search, with their match scores. */
export function rootQuicklinkEntries(query: string): Array<{ entry: Entry; score: number }> {
  const q = query.trim();
  const results: Array<{ entry: Entry; score: number }> = [];
  for (const link of store.data.quicklinks) {
    const score = q ? bestScore(q, [link.name]) : 0;
    if (score > 0) results.push({ entry: quicklinkEntry(link), score });
  }
  return results;
}

function quicklinkEntry(link: Quicklink): Entry {
  return {
    id: `quicklink:${link.id}`,
    ref: `quicklink:${link.id}`,
    title: link.name,
    subtitle: link.link,
    icon: link.icon || "🔗",
    accessory: "Quicklink",
    actions: [
      {
        id: "open",
        title: needsQuery(link) ? "Open with Query…" : "Open Quicklink",
        shortcut: "↵",
        run: () => (needsQuery(link) ? askQuery(link) : openLink(link, "")),
      },
      {
        id: "copy",
        title: "Copy Link",
        shortcut: "Ctrl+Shift+C",
        run: () => {
          copyText(link.link);
          return { type: "stay", toast: "Link copied" };
        },
      },
      { id: "edit", title: "Edit Quicklink", shortcut: "Ctrl+E", run: () => quicklinkForm(link) },
      { id: "create", title: "Create Quicklink", shortcut: "Ctrl+N", run: () => quicklinkForm(null) },
      {
        id: "delete",
        title: "Delete Quicklink",
        shortcut: "Ctrl+D",
        danger: true,
        run: () => {
          store.data.quicklinks = store.data.quicklinks.filter((l) => l.id !== link.id);
          store.save();
          return { type: "stay", toast: "Quicklink deleted" };
        },
      },
    ],
  };
}

export function runQuicklink(id: string): RunResult | null {
  const link = store.data.quicklinks.find((l) => l.id === id);
  if (!link) return null;
  return needsQuery(link) ? askQuery(link) : openLink(link, "");
}
