// Beam Browser Tabs. Beam asks for this profile's tabs through the
// beam-browser-host native messaging host; this worker answers.
//
// Requests: { id, type: "hello" | "list" | "activate" | "close", ... }
// Replies:  { id, ok: true, ...result } or { id, ok: false, error }

const HOST = "com.virallens.beam";
const startedAt = Date.now();
/** _favicon images as data: URLs, by favicon URL (or page URL when a tab has none). */
const iconCache = new Map();
const ICON_CACHE_LIMIT = 500;

let port = null;
let retryTimer = null;
let failures = 0;

/**
 * An open native port keeps an MV3 service worker alive (Chrome 105+), and
 * the host stays up while Chrome runs, so this normally connects once.
 */
function connect() {
  if (port) return;
  clearTimeout(retryTimer);
  retryTimer = null;
  const current = chrome.runtime.connectNative(HOST);
  port = current;
  current.onMessage.addListener((message) => {
    failures = 0;
    void answer(current, message);
  });
  current.onDisconnect.addListener(() => {
    // Reading lastError marks it handled: "host not found" when Beam is not installed.
    void chrome.runtime.lastError;
    if (port === current) port = null;
    failures += 1;
    // Timers don't keep the worker alive; if it is stopped first, the alarm or a tab event reconnects.
    retryTimer = setTimeout(connect, Math.min(60_000, 1000 * 2 ** Math.min(failures, 6)));
  });
}

async function answer(from, message) {
  if (!message || typeof message !== "object") return;
  let reply;
  try {
    reply = { id: message.id, ok: true, ...(await run(message)) };
  } catch (error) {
    reply = { id: message.id, ok: false, error: String(error?.message ?? error) };
  }
  try {
    from.postMessage(reply);
  } catch {
    // The port closed while answering.
  }
  if (reply.updating) setTimeout(() => chrome.runtime.reload(), 100);
}

async function run(message) {
  switch (message.type) {
    case "hello": {
      // Beam says hello on every connect, e.g. after an upgrade replaced this folder on disk.
      const version = chrome.runtime.getManifest().version;
      const onDisk = await diskVersion();
      return { version, startedAt, userAgent: navigator.userAgent, updating: Boolean(onDisk && onDisk !== version) };
    }
    case "list":
      return listTabs();
    case "activate": {
      const tab = await chrome.tabs.update(message.tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      return {};
    }
    case "close":
      await chrome.tabs.remove(message.tabId);
      return {};
    default:
      throw new Error(`Unknown request: ${message.type}`);
  }
}

/** The version in manifest.json as it is on disk now; an unpacked extension only rereads it on reload. */
async function diskVersion() {
  try {
    const response = await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" });
    return (await response.json()).version ?? null;
  } catch {
    return null;
  }
}

/** Every tab in every window; favicons are sent once per reply and referenced by index. */
async function listTabs() {
  const tabs = await chrome.tabs.query({});
  const icons = [];
  const indexByKey = new Map();
  const iconOf = await Promise.all(tabs.map((tab) => favicon(tab)));
  const list = tabs.map((tab, i) => {
    const data = iconOf[i];
    let icon = -1;
    if (data) {
      if (!indexByKey.has(data)) {
        indexByKey.set(data, icons.length);
        icons.push(data);
      }
      icon = indexByKey.get(data);
    }
    return {
      id: tab.id,
      windowId: tab.windowId,
      index: tab.index,
      title: tab.title ?? "",
      url: tab.url || tab.pendingUrl || "",
      icon,
      active: tab.active,
      audible: Boolean(tab.audible),
      muted: Boolean(tab.mutedInfo?.muted),
      pinned: tab.pinned,
      incognito: tab.incognito,
      discarded: Boolean(tab.discarded),
      lastAccessed: tab.lastAccessed ?? 0,
    };
  });
  return { tabs: list, icons };
}

/**
 * Chrome's own copy of the tab's icon, through the _favicon endpoint. Beam
 * would otherwise fetch every site's icon itself, which fails for sign-in
 * pages, chrome:// pages and http sites.
 */
async function favicon(tab) {
  const page = tab.url || tab.pendingUrl;
  if (!page) return null;
  const key = tab.favIconUrl || page;
  if (iconCache.has(key)) return iconCache.get(key);
  let data = null;
  try {
    const url = new URL(chrome.runtime.getURL("/_favicon/"));
    url.searchParams.set("pageUrl", page);
    url.searchParams.set("size", "32");
    const response = await fetch(url);
    if (response.ok) data = toDataUrl(new Uint8Array(await response.arrayBuffer()), response.headers.get("content-type"));
  } catch {
    // Fall through to the tab's own data: icon, if any.
  }
  if (!data && tab.favIconUrl?.startsWith("data:image/")) data = tab.favIconUrl;
  // While a page loads, Chrome may not have stored its icon yet and answers with the default globe.
  if (tab.status === "complete") {
    if (iconCache.size >= ICON_CACHE_LIMIT) iconCache.delete(iconCache.keys().next().value);
    iconCache.set(key, data);
  }
  return data;
}

/** FileReader is not available in service workers. */
function toDataUrl(bytes, type) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type || "image/png"};base64,${btoa(binary)}`;
}

// Any of these wakes a stopped worker, which reconnects at the top level below.
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.tabs.onActivated.addListener(connect);
chrome.tabs.onCreated.addListener(connect);
chrome.windows.onFocusChanged.addListener(connect);
chrome.alarms.onAlarm.addListener(connect);
// The open port keeps this worker busy, so Chrome would hold back an update to the packed extension until it restarts.
chrome.runtime.onUpdateAvailable.addListener(() => chrome.runtime.reload());
// Retries while Beam is not installed or its host is missing; alarms may be cleared on browser restart.
chrome.alarms.get("reconnect").then((alarm) => alarm || chrome.alarms.create("reconnect", { periodInMinutes: 1 }));

connect();
