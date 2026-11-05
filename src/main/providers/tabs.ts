import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app } from "electron";
import { markdownLink } from "../chrome";
import { HIDE, type Entry, type EntryAction, type Section, type ViewProvider } from "../entry";
import { bestScore } from "../fuzzy";
import { copyText, launchDetached, notify, truncate } from "../system";
import {
  EXTENSION_ID,
  FrameDecoder,
  HOST_NAME,
  encodeFrame,
  hostManifest,
  parseReply,
  parseTabList,
  rankTabs,
  tabAccessory,
  tabDomain,
  tabTitle,
  type BrowserTab,
  type Reply,
} from "../tabs";
import type { RunResult } from "../../shared/types";

/** Switching and closing are quick; a slower answer means Chrome is stuck. */
const REQUEST_MS = 3000;
/** The first list after the extension starts reads every favicon; later ones hit its cache. */
const LIST_MS = 2500;
/** Typing filters the same list instead of asking Chrome again on every key. */
const CACHE_MS = 1000;
/** Folders under ~/.config whose NativeMessagingHosts folder Chromium-based browsers read. */
const BROWSER_CONFIG_DIRS = [
  "google-chrome",
  "google-chrome-beta",
  "google-chrome-unstable",
  "chromium",
  "BraveSoftware/Brave-Browser",
  "microsoft-edge",
];

/** One extension instance (one Chrome profile), reached through its own beam-browser-host. */
interface Client {
  id: number;
  socket: net.Socket;
  pending: Map<number, (reply: Reply) => void>;
}

interface ClientTab extends BrowserTab {
  client: Client;
}

interface Snapshot {
  tabs: ClientTab[];
  /** Connected profiles that did not answer, with the reason. */
  errors: string[];
}

const clients = new Set<Client>();
let server: net.Server | null = null;
let nextClientId = 1;
let nextRequestId = 1;
/** Bumped by every change (a tab closed, a profile connected), so a list fetched before it is never reused. */
let generation = 0;
let cache: { at: number; generation: number; snapshot: Snapshot } | null = null;
let loading: { generation: number; promise: Promise<Snapshot> } | null = null;

function socketPath(): string | null {
  const dir = process.env.XDG_RUNTIME_DIR;
  return dir ? path.join(dir, "beam-browser.sock") : null;
}

function hostPath(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "beam-browser-host")
    : path.join(app.getAppPath(), "packaging", "beam-browser-host");
}

function extensionDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "chrome-extension")
    : path.join(app.getAppPath(), "chrome-extension");
}

function invalidate(): void {
  cache = null;
  generation++;
}

const failure = (id: number, error: string): Reply => ({ id, ok: false, error, body: {} });

function request(client: Client, message: Record<string, unknown>, timeoutMs = REQUEST_MS): Promise<Reply> {
  const id = nextRequestId++;
  if (!clients.has(client)) return Promise.resolve(failure(id, "Chrome is no longer connected"));
  return new Promise((resolve) => {
    const finish = (reply: Reply) => {
      clearTimeout(timer);
      client.pending.delete(id);
      resolve(reply);
    };
    const timer = setTimeout(() => finish(failure(id, "Chrome did not answer in time")), timeoutMs);
    client.pending.set(id, finish);
    client.socket.write(encodeFrame({ ...message, id }));
  });
}

function onConnection(socket: net.Socket): void {
  const client: Client = { id: nextClientId++, socket, pending: new Map() };
  const decoder = new FrameDecoder();
  clients.add(client);
  invalidate();
  socket.on("data", (chunk: Buffer) => {
    let messages: unknown[];
    try {
      messages = decoder.push(chunk);
    } catch (error) {
      console.error("beam: browser tabs connection dropped:", error);
      socket.destroy();
      return;
    }
    for (const message of messages) {
      const reply = parseReply(message);
      if (reply) client.pending.get(reply.id)?.(reply);
    }
  });
  socket.on("close", () => {
    clients.delete(client);
    invalidate();
    for (const [id, finish] of [...client.pending]) finish(failure(id, "Chrome disconnected"));
  });
  socket.on("error", () => undefined);
  // Lets the extension notice that Beam installed a newer copy of it and reload itself.
  void request(client, { type: "hello" });
}

/**
 * Chrome finds beam-browser-host through a manifest in each browser's
 * NativeMessagingHosts folder. Written at every start so it follows Beam
 * between the repo and /opt, but only when the content changed.
 */
function installHostManifests(): void {
  const config = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const content = JSON.stringify(hostManifest(hostPath()), null, 2) + "\n";
  for (const browser of BROWSER_CONFIG_DIRS) {
    const parent = path.join(config, browser);
    if (!fs.existsSync(parent)) continue;
    const file = path.join(parent, "NativeMessagingHosts", `${HOST_NAME}.json`);
    try {
      if (fs.existsSync(file) && fs.readFileSync(file, "utf8") === content) continue;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    } catch (error) {
      console.error(`beam: could not write ${file}:`, error);
    }
  }
}

/** Call once while holding the single-instance lock: any socket file left behind is from a crashed Beam. */
export function startBrowserBridge(): void {
  installHostManifests();
  const file = socketPath();
  if (!file || server) return;
  fs.rmSync(file, { force: true });
  server = net.createServer(onConnection);
  server.on("error", (error) => console.error("beam: browser tabs socket failed:", error));
  server.listen(file, () => fs.chmodSync(file, 0o600));
}

export function stopBrowserBridge(): void {
  server?.close();
  server = null;
  for (const client of clients) client.socket.destroy();
  const file = socketPath();
  if (file) fs.rmSync(file, { force: true });
}

async function fetchSnapshot(): Promise<Snapshot> {
  const connected = [...clients];
  const replies = await Promise.all(connected.map((client) => request(client, { type: "list" }, LIST_MS)));
  const tabs: ClientTab[] = [];
  const errors: string[] = [];
  replies.forEach((reply, i) => {
    if (!reply.ok) errors.push(reply.error ?? "No answer");
    else for (const tab of parseTabList(reply.body)) tabs.push({ ...tab, client: connected[i] });
  });
  return { tabs, errors };
}

function snapshot(): Promise<Snapshot> {
  if (cache && cache.generation === generation && Date.now() - cache.at < CACHE_MS) return Promise.resolve(cache.snapshot);
  if (loading?.generation !== generation) {
    const started = generation;
    const promise = fetchSnapshot().then((snap) => {
      if (started === generation) cache = { at: Date.now(), generation: started, snapshot: snap };
      return snap;
    });
    loading = { generation: started, promise };
    void promise.finally(() => {
      if (loading?.promise === promise) loading = null;
    });
  }
  return loading.promise;
}

async function switchTo(tab: ClientTab, hide: () => void): Promise<RunResult> {
  // Beam steps aside first, so GNOME hands focus to Chrome rather than back to Beam.
  hide();
  const reply = await request(tab.client, { type: "activate", tabId: tab.id, windowId: tab.windowId });
  invalidate();
  if (!reply.ok) notify("Could not switch to the tab", reply.error ?? "");
  return HIDE;
}

async function closeTab(tab: ClientTab): Promise<RunResult> {
  const reply = await request(tab.client, { type: "close", tabId: tab.id });
  invalidate();
  if (!reply.ok) return { type: "error", message: `Could not close the tab: ${reply.error ?? "unknown error"}` };
  return { type: "stay", toast: "Tab closed" };
}

function copyAction(id: string, title: string, shortcut: string, text: string, toast: string): EntryAction {
  return {
    id,
    title,
    shortcut,
    run: () => {
      copyText(text);
      return { type: "stay", toast };
    },
  };
}

function tabEntry(tab: ClientTab, hide: () => void): Entry {
  const title = tabTitle(tab);
  return {
    id: `tabs:${tab.client.id}:${tab.id}`,
    title: truncate(title, 120),
    subtitle: truncate(tabDomain(tab.url), 80),
    icon: tab.favicon ?? (tab.incognito ? "🕶️" : "🌐"),
    accessory: tabAccessory(tab) || undefined,
    actions: [
      { id: "switch", title: "Switch to Tab", shortcut: "↵", run: () => switchTo(tab, hide) },
      copyAction("copy-url", "Copy URL", "Ctrl+↵", tab.url, "URL copied"),
      { id: "close", title: "Close Tab", shortcut: "Ctrl+W", danger: true, run: () => closeTab(tab) },
      copyAction(
        "copy-markdown",
        "Copy Title and URL as Markdown",
        "Ctrl+Shift+C",
        markdownLink(title, tab.url),
        "Markdown link copied",
      ),
    ],
  };
}

/** Put there by the .deb (packaging/after-install.sh); Chrome installs the extension from it when it starts. */
const EXTERNAL_EXTENSION_FILE = `/usr/share/google-chrome/extensions/${EXTENSION_ID}.json`;

/** Chrome drops chrome:// addresses given on its command line, so Beam opens a local page with the steps. */
function openSetupPage(): RunResult {
  copyText("chrome://extensions");
  launchDetached("google-chrome", [pathToFileURL(path.join(extensionDir(), "setup.html")).href]);
  notify("Copied chrome://extensions", "Paste it into Chrome's address bar. The page Beam opened in Chrome lists the steps.");
  return HIDE;
}

/** chrome://restart reopens every window and tab, unlike quitting. */
function copyRestartAddress(): RunResult {
  copyText("chrome://restart");
  notify("Copied chrome://restart", "Paste it into Chrome's address bar. Chrome restarts with your tabs and loads Beam's extension.");
  return HIDE;
}

function manualActions(): EntryAction[] {
  return [
    { id: "connect", title: "Open Setup Steps in Chrome", shortcut: "↵", run: openSetupPage },
    copyAction("copy-path", "Copy Extension Folder Path", "Ctrl+↵", extensionDir(), "Folder path copied"),
  ];
}

const SETUP_KEYWORDS = ["setup", "install", "extension", "connect", "profile", "chrome"];

/** Shown until an extension connects. */
function setupEntries(): Entry[] {
  const entries: Entry[] = [];
  const installed = fs.existsSync(EXTERNAL_EXTENSION_FILE);
  if (installed) {
    entries.push({
      id: "tabs:restart",
      title: "Restart Chrome to Finish Setup",
      subtitle: "Beam added its Chrome extension; Chrome loads it the next time it starts",
      icon: "🔄",
      keywords: SETUP_KEYWORDS,
      actions: [
        { id: "restart", title: "Copy chrome://restart", shortcut: "↵", run: copyRestartAddress },
        { id: "connect", title: "Open Setup Steps in Chrome", shortcut: "Ctrl+↵", run: openSetupPage },
      ],
    });
  }
  const steps: Array<[string, string]> = [
    ["Open chrome://extensions", "Enter copies the address; paste it into Chrome's address bar"],
    ["Turn on Developer mode", "The switch at the top right; keep it on"],
    ["Click Load unpacked and pick Beam's folder", `Press Ctrl+L, paste ${extensionDir()}, press Enter, then click Select`],
    ["Come back to Beam", "Your tabs appear here within a few seconds"],
  ];
  entries.push(
    {
      id: "tabs:setup",
      title: installed ? "Or Load the Extension by Hand" : "Connect Chrome",
      subtitle: "One-time setup per Chrome profile: Beam reads your tabs through its small Chrome extension",
      icon: "🔌",
      keywords: SETUP_KEYWORDS,
      actions: manualActions(),
    },
    ...steps.map(([title, subtitle], i) => ({
      id: `tabs:setup:${i + 1}`,
      title: `${i + 1}. ${title}`,
      subtitle,
      icon: ["1️⃣", "2️⃣", "3️⃣", "4️⃣"][i],
      keywords: SETUP_KEYWORDS,
      actions: manualActions(),
    })),
  );
  return entries;
}

/** Profiles without the extension stay invisible; installed by the .deb, every profile already has it. */
function connectAnotherEntries(query: string): Entry[] {
  if (fs.existsSync(EXTERNAL_EXTENSION_FILE)) return [];
  const entry: Entry = {
    id: "tabs:setup",
    title: "Connect Another Chrome Profile",
    subtitle: "Load Beam's extension in that profile too: Developer mode, Load unpacked, Beam's folder",
    icon: "🔌",
    keywords: SETUP_KEYWORDS,
    actions: manualActions(),
  };
  return !query || bestScore(query, [entry.title, ...SETUP_KEYWORDS]) > 0 ? [entry] : [];
}

function noticeEntry(title: string, subtitle: string): Entry {
  return {
    id: "tabs:notice",
    title,
    subtitle,
    icon: "⚠️",
    actions: [
      {
        id: "retry",
        title: "Try Again",
        shortcut: "↵",
        run: () => {
          invalidate();
          return { type: "stay" };
        },
      },
    ],
  };
}

export function tabsCommands(_hide: () => void): Entry[] {
  return [
    {
      id: "cmd:tabs",
      ref: "cmd:tabs",
      title: "Search Browser Tabs",
      subtitle: "Google Chrome",
      icon: "📑",
      accessory: "Command",
      keywords: ["chrome", "tab", "tabs", "browser", "switch", "open tabs"],
      actions: [{ id: "run", title: "Search Browser Tabs", shortcut: "↵", run: () => ({ type: "view", view: "tabs" }) }],
    },
  ];
}

export const tabsView: ViewProvider = {
  info: { title: "Browser Tabs", placeholder: "Search open tabs…", preview: false, grid: false, refreshMs: 2000 },
  async sections(query: string, hide: () => void): Promise<Section[]> {
    if (!clients.size) return [{ title: "Browser Tabs", entries: setupEntries() }];
    const snap = await snapshot();
    const q = query.trim();
    const notices =
      snap.errors.length && !snap.tabs.length ? [noticeEntry("Chrome Is Not Answering", snap.errors[0])] : [];
    return [
      { title: "Open Tabs", entries: [...notices, ...rankTabs(snap.tabs, q, bestScore).map((tab) => tabEntry(tab, hide))] },
      { title: "Setup", entries: connectAnotherEntries(q) },
    ];
  },
};
