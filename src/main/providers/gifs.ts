import { config, saveConfig } from "../config";
import { HIDE, type Entry, type EntryAction, type Section, type ViewProvider } from "../entry";
import { showForm } from "../forms";
import {
  GIPHY_KEY_URL,
  formatBytes,
  gifMarkdown,
  giphyRequestUrl,
  parseGiphyResponse,
  queryKey,
  type Gif,
  type GiphyError,
} from "../gifs";
import { copyText, notify, openUrl } from "../system";
import type { RunResult } from "../../shared/types";

/** Free keys allow about 100 requests an hour, so wait for typing to pause. */
const DEBOUNCE_MS = 350;
const RATE_LIMIT_PAUSE_MS = 60_000;
const MAX_CACHED_QUERIES = 200;

// Results by query for this session, for the key they were fetched with.
const cache = new Map<string, Gif[]>();
let cacheApiKey = "";
let latestSearch = 0;
let lastSections: Section[] = [];
let pausedUntil = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Fetched = { ok: true; gifs: Gif[] } | { ok: false; error: GiphyError | "network"; detail: string };

async function fetchGifs(apiKey: string, query: string): Promise<Fetched> {
  try {
    const response = await fetch(giphyRequestUrl(apiKey, query), { signal: AbortSignal.timeout(8000) });
    const body: unknown = await response.json().catch(() => null);
    const result = parseGiphyResponse(response.status, body);
    return result.ok ? result : { ok: false, error: result.error, detail: `HTTP ${result.status}` };
  } catch (error) {
    return { ok: false, error: "network", detail: (error as Error).message };
  }
}

function apiKeyForm(): RunResult {
  return showForm(
    {
      title: "GIPHY API Key",
      submitLabel: "Save API Key",
      fields: [
        {
          name: "key",
          label: "API Key",
          type: "password",
          placeholder: "Paste your GIPHY API key",
          hint: "Free from developers.giphy.com: create an app, choose API, and copy its key.",
        },
      ],
    },
    (values) => {
      const key = values.key.trim();
      if (!key || /\s/.test(key)) return { type: "error", message: "Paste the API key exactly as GIPHY shows it." };
      config().giphyApiKey = key;
      saveConfig();
      cache.clear();
      pausedUntil = 0;
      return { type: "view", view: "gifs" };
    },
  );
}

const addKeyAction: EntryAction = {
  id: "add-key",
  title: "Add GIPHY API Key",
  shortcut: "↵",
  run: apiKeyForm,
};

const getKeyAction: EntryAction = {
  id: "get-key",
  title: "Get a Free API Key",
  shortcut: "Ctrl+↵",
  run: () => {
    openUrl(GIPHY_KEY_URL);
    return HIDE;
  },
};

function setupSections(): Section[] {
  return [
    {
      title: "Set Up GIF Search",
      entries: [
        {
          id: "gifs:add-key",
          title: "Add GIPHY API Key",
          subtitle: "GIF search needs a free GIPHY API key",
          icon: "🔑",
          preview: "GIF search uses GIPHY.\n\nGet a free API key from the GIPHY developer dashboard, then add it here.",
          actions: [addKeyAction, getKeyAction],
        },
        {
          id: "gifs:get-key",
          title: "Get a Free API Key",
          subtitle: "developers.giphy.com",
          icon: "🌐",
          preview: "Opens the GIPHY developer dashboard.\n\nCreate an app, choose API, and copy its key.",
          actions: [{ ...getKeyAction, shortcut: "↵" }, { ...addKeyAction, shortcut: "Ctrl+↵" }],
        },
      ],
    },
  ];
}

function errorSections(error: GiphyError | "network", detail: string): Section[] {
  const retry: EntryAction = {
    id: "retry",
    title: "Try Again",
    shortcut: "↵",
    run: () => {
      pausedUntil = 0;
      return { type: "stay" };
    },
  };
  const changeKey: EntryAction = { ...addKeyAction, title: "Change GIPHY API Key" };
  const notice = (title: string, subtitle: string, actions: EntryAction[]): Section[] => [
    {
      title: "GIPHY",
      entries: [{ id: `gifs:error:${error}`, title, subtitle, icon: "⚠️", preview: `${title}\n\n${subtitle}\n\n${detail}`, actions }],
    },
  ];
  switch (error) {
    case "auth":
      return notice("GIPHY Rejected the API Key", "Check the key in your GIPHY dashboard, or add a new one.", [
        { ...changeKey, shortcut: "↵" },
        getKeyAction,
      ]);
    case "rate-limit":
      return notice("GIPHY Rate Limit Reached", "Free keys allow about 100 searches an hour. Try again in a few minutes.", [retry]);
    case "network":
      return notice("Couldn't Reach GIPHY", "Check your internet connection.", [retry]);
    default:
      return notice("GIPHY Isn't Responding", "Something went wrong on GIPHY's side. Try again shortly.", [
        retry,
        { ...changeKey, shortcut: "Ctrl+↵" },
      ]);
  }
}

/** Copies, closes Beam and confirms with a notification, like a paste on Wayland. */
function copyAndClose(text: string, what: string): RunResult {
  copyText(text);
  notify("Copied to clipboard", what);
  return HIDE;
}

function gifEntry(gif: Gif): Entry {
  const size = gif.width && gif.height ? `${gif.width} × ${gif.height}` : "";
  const details = [size, gif.bytes ? formatBytes(gif.bytes) : "", gif.rating ? `Rated ${gif.rating.toUpperCase()}` : ""];
  return {
    id: `gif:${gif.id}`,
    title: gif.title,
    icon: gif.iconUrl ?? "🎞️",
    accessory: size.replace(/ /g, ""),
    previewImage: gif.previewUrl,
    preview: `${gif.title}\n\n${details.filter(Boolean).join(" · ")}\n\nPowered by GIPHY`,
    actions: [
      { id: "copy-gif", title: "Copy GIF URL", shortcut: "↵", run: () => copyAndClose(gif.gifUrl, gif.title) },
      { id: "copy-markdown", title: "Copy as Markdown", shortcut: "Ctrl+↵", run: () => copyAndClose(gifMarkdown(gif), gif.title) },
      {
        id: "open",
        title: "Open in Browser",
        shortcut: "Ctrl+O",
        run: () => {
          openUrl(gif.pageUrl);
          return HIDE;
        },
      },
      {
        id: "copy-page",
        title: "Copy Page Link",
        shortcut: "Ctrl+Shift+C",
        run: () => {
          copyText(gif.pageUrl);
          return { type: "stay", toast: "Page link copied" };
        },
      },
    ],
  };
}

function resultSections(query: string, gifs: Gif[]): Section[] {
  return [{ title: query ? "GIPHY" : "Trending on GIPHY", entries: gifs.map(gifEntry) }];
}

function remember(sections: Section[]): Section[] {
  lastSections = sections;
  return sections;
}

export function gifCommands(_hide: () => void): Entry[] {
  return [
    {
      id: "cmd:gifs",
      ref: "cmd:gifs",
      title: "Search GIFs",
      subtitle: "GIPHY",
      icon: "🎞️",
      accessory: "Command",
      keywords: ["giphy", "gif", "meme", "reaction", "animated"],
      actions: [{ id: "run", title: "Run Command", shortcut: "↵", run: () => ({ type: "view", view: "gifs" }) }],
    },
  ];
}

export const gifView: ViewProvider = {
  info: {
    title: "GIFs",
    placeholder: "Search GIPHY…",
    preview: true,
    grid: false,
  },
  async sections(query) {
    const apiKey = config().giphyApiKey.trim();
    if (!apiKey) return remember(setupSections());
    if (apiKey !== cacheApiKey) {
      cache.clear();
      cacheApiKey = apiKey;
    }

    const q = query.trim();
    const key = queryKey(q);
    const search = ++latestSearch;
    const cached = cache.get(key);
    if (cached) return remember(resultSections(q, cached));
    if (Date.now() < pausedUntil) return remember(errorSections("rate-limit", "Paused after GIPHY's limit"));

    // Every keystroke lands here; only the query typing stopped at is sent.
    await sleep(DEBOUNCE_MS);
    if (search !== latestSearch) return lastSections;

    const result = await fetchGifs(apiKey, q);
    if (!result.ok) {
      if (result.error === "rate-limit") pausedUntil = Date.now() + RATE_LIMIT_PAUSE_MS;
      return search === latestSearch ? remember(errorSections(result.error, result.detail)) : lastSections;
    }
    if (cache.size >= MAX_CACHED_QUERIES) cache.delete(cache.keys().next().value!);
    cache.set(key, result.gifs);
    return search === latestSearch ? remember(resultSections(q, result.gifs)) : lastSections;
  },
};
