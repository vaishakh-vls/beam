import { clipboard } from "electron";
import { HIDE, type Entry, type EntryAction } from "../entry";
import { showForm } from "../forms";
import { bestScore } from "../fuzzy";
import { JsonStore, newId } from "../store";
import { copyText, pasteText, truncate, pasteVerb } from "../system";

interface Snippet {
  id: string;
  name: string;
  keyword: string;
  text: string;
}

const store = new JsonStore<{ snippets: Snippet[] }>("snippets.json", () => ({
  snippets: [
    {
      id: "welcome",
      name: "Today's Date",
      keyword: ";date",
      text: "{date}",
    },
  ],
}));

const PLACEHOLDER_HELP =
  "Placeholders: {clipboard} {date} {time} {datetime} {day} {uuid}";

/** Expands Raycast-style dynamic placeholders. */
export function expandPlaceholders(text: string): string {
  const now = new Date();
  const values: Record<string, () => string> = {
    clipboard: () => clipboard.readText(),
    date: () => now.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }),
    time: () => now.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    datetime: () => now.toLocaleString(),
    day: () => now.toLocaleDateString(undefined, { weekday: "long" }),
    uuid: () => crypto.randomUUID(),
  };
  return text.replace(/\{(\w+)\}/g, (match, name: string) => values[name]?.() ?? match);
}

function snippetForm(existing: Snippet | null, initialText = ""): ReturnType<typeof showForm> {
  return showForm(
    {
      title: existing ? "Edit Snippet" : "Create Snippet",
      submitLabel: existing ? "Save Snippet" : "Create Snippet",
      fields: [
        { name: "name", label: "Name", type: "text", value: existing?.name ?? "", placeholder: "Email signature" },
        {
          name: "text",
          label: "Snippet",
          type: "textarea",
          value: existing?.text ?? initialText,
          hint: PLACEHOLDER_HELP,
        },
        {
          name: "keyword",
          label: "Keyword",
          type: "text",
          value: existing?.keyword ?? "",
          placeholder: ";sig",
          optional: true,
          hint: "Type the keyword in Beam to find this snippet instantly.",
        },
      ],
    },
    (values) => {
      if (!values.name.trim() || !values.text) {
        return { type: "error", message: "Name and snippet text are required." };
      }
      if (existing) {
        Object.assign(existing, { name: values.name.trim(), text: values.text, keyword: values.keyword.trim() });
      } else {
        store.data.snippets.push({
          id: newId(),
          name: values.name.trim(),
          text: values.text,
          keyword: values.keyword.trim(),
        });
      }
      store.save();
      return { type: "view", view: "snippets" };
    },
  );
}

export function createSnippetAction(text: string): EntryAction["run"] {
  return () => snippetForm(null, text);
}

export function openCreateSnippetForm(): ReturnType<typeof showForm> {
  return snippetForm(null);
}

export function snippetEntries(query: string, hide: () => void): Entry[] {
  const q = query.trim();
  return store.data.snippets
    .map((snippet) => ({
      snippet,
      score: q ? bestScore(q, [snippet.name, snippet.keyword, snippet.text]) : 1,
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ snippet }) => snippetEntry(snippet, hide));
}

/** Snippets whose keyword exactly matches the query, for the root search. */
export function snippetKeywordMatches(query: string, hide: () => void): Entry[] {
  const q = query.trim();
  if (!q) return [];
  return store.data.snippets.filter((s) => s.keyword && s.keyword === q).map((s) => snippetEntry(s, hide));
}

function snippetEntry(snippet: Snippet, hide: () => void): Entry {
  return {
    id: `snippet:${snippet.id}`,
    ref: `snippet:${snippet.id}`,
    title: snippet.name,
    subtitle: truncate(snippet.text, 60),
    icon: "✂️",
    accessory: snippet.keyword || "Snippet",
    preview: snippet.text,
    actions: [
      {
        id: "paste",
        title: `${pasteVerb()} Snippet`,
        shortcut: "↵",
        run: async () => {
          await pasteText(expandPlaceholders(snippet.text), hide);
          return HIDE;
        },
      },
      {
        id: "copy",
        title: "Copy Snippet",
        shortcut: "Ctrl+↵",
        run: () => {
          copyText(expandPlaceholders(snippet.text));
          return HIDE;
        },
      },
      { id: "edit", title: "Edit Snippet", shortcut: "Ctrl+E", run: () => snippetForm(snippet) },
      { id: "create", title: "Create Snippet", shortcut: "Ctrl+N", run: () => snippetForm(null) },
      {
        id: "delete",
        title: "Delete Snippet",
        shortcut: "Ctrl+D",
        danger: true,
        run: () => {
          store.data.snippets = store.data.snippets.filter((s) => s.id !== snippet.id);
          store.save();
          return { type: "stay", toast: "Snippet deleted" };
        },
      },
    ],
  };
}

export function runSnippet(id: string, hide: () => void): boolean {
  const snippet = store.data.snippets.find((s) => s.id === id);
  if (!snippet) return false;
  void pasteText(expandPlaceholders(snippet.text), hide);
  return true;
}
