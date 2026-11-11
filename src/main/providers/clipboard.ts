import { clipboard } from "electron";
import { config } from "../config";
import { HIDE, type Entry } from "../entry";
import { fuzzyScore } from "../fuzzy";
import { JsonStore } from "../store";
import { looksLikeSecret } from "../secrets";
import { copyText, pasteText, pasteVerb, truncate } from "../system";

interface ClipItem {
  text: string;
  copiedAt: number;
}

const POLL_MS = 600;
/** Very large copies (logs, files) are skipped to keep history fast. */
const MAX_ITEM_CHARS = 200_000;

const store = new JsonStore<{ items: ClipItem[] }>("clipboard-history.json", () => ({ items: [] }));
let lastSeen = "";
let poller: NodeJS.Timeout | null = null;

/**
 * Watches the clipboard for new text. Beam's GNOME helper says each time
 * something is copied (clipboardEvent); without it, Beam asks every 600 ms.
 * Electron runs under XWayland on GNOME, where Mutter shares the clipboard
 * with X11 apps, so reading works on both X11 and Wayland sessions.
 */
export function startClipboardWatcher(): void {
  lastSeen = clipboard.readText();
  startPolling();
}

/**
 * A clipboard event from Beam's GNOME helper: "changed" after each copy,
 * "watching" when it starts and "stopped" when it is disabled, as it is
 * while the screen is locked. Polling wakes Beam, XWayland and the app that
 * owns the clipboard 100 times a minute, so it only runs while the helper
 * isn't watching.
 */
export function clipboardEvent(event: string): void {
  if (event === "stopped") return startPolling();
  stopPolling();
  if (event === "changed") checkClipboard();
}

/** Whether Beam is asking for the clipboard every 600 ms, rather than told of copies by its GNOME helper. */
export function clipboardPolling(): boolean {
  return poller !== null;
}

function startPolling(): void {
  poller ??= setInterval(checkClipboard, POLL_MS).unref();
}

function stopPolling(): void {
  if (poller) clearInterval(poller);
  poller = null;
}

function checkClipboard(): void {
  const text = clipboard.readText();
  if (!text || text === lastSeen) return;
  lastSeen = text;
  if (isConcealed(text)) return;
  record(text);
}

/** Copies text that must stay out of clipboard history, such as a Wi-Fi password or a generated secret. */
export function copyConcealed(text: string): void {
  lastSeen = text;
  clipboard.writeText(text);
}

/**
 * Password managers mark copied passwords with this hint (KeePassXC,
 * Bitwarden, KDE apps). Tokens and keys are also skipped unless the user
 * turns `clipboardIgnoreSecrets` off.
 */
function isConcealed(text: string): boolean {
  if (clipboard.availableFormats().some((f) => f.includes("passwordManagerHint"))) return true;
  return config().clipboardIgnoreSecrets && looksLikeSecret(text);
}

function record(text: string): void {
  if (!text.trim() || text.length > MAX_ITEM_CHARS) return;
  const items = store.data.items.filter((item) => item.text !== text);
  items.unshift({ text, copiedAt: Date.now() });
  store.data.items = items.slice(0, config().clipboardHistorySize);
  store.save();
}

function remove(text: string): void {
  store.data.items = store.data.items.filter((item) => item.text !== text);
  store.save();
}

function relativeTime(ms: number): string {
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function kindIcon(text: string): string {
  const t = text.trim();
  if (/^https?:\/\/\S+$/.test(t)) return "🔗";
  if (/^#[0-9a-f]{3,8}$/i.test(t)) return "🎨";
  if (/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(t)) return "✉️";
  if (t.includes("\n")) return "📃";
  return "📋";
}

export function clipboardEntries(
  query: string,
  hide: () => void,
  saveAsSnippet: (text: string) => Entry["actions"][number]["run"],
): Entry[] {
  const q = query.trim();
  const items = store.data.items.filter((item) => !q || fuzzyScore(q, item.text) >= 300);
  return items.map((item, index) => ({
    id: `clip:${index}:${item.copiedAt}`,
    title: truncate(item.text, 120),
    icon: kindIcon(item.text),
    accessory: relativeTime(item.copiedAt),
    preview: item.text,
    actions: [
      {
        id: "paste",
        title: `${pasteVerb()} to Active App`,
        shortcut: "↵",
        run: async () => {
          lastSeen = item.text;
          await pasteText(item.text, hide);
          return HIDE;
        },
      },
      {
        id: "copy",
        title: "Copy to Clipboard",
        shortcut: "Ctrl+↵",
        run: () => {
          lastSeen = item.text;
          copyText(item.text);
          record(item.text);
          return HIDE;
        },
      },
      {
        id: "save-snippet",
        title: "Save as Snippet",
        shortcut: "Ctrl+S",
        run: saveAsSnippet(item.text),
      },
      {
        id: "delete",
        title: "Delete Entry",
        shortcut: "Ctrl+D",
        danger: true,
        run: () => {
          remove(item.text);
          return { type: "stay", toast: "Entry deleted" };
        },
      },
      {
        id: "clear",
        title: "Clear Entire History",
        shortcut: "Ctrl+Shift+D",
        danger: true,
        run: () => {
          store.data.items = [];
          store.saveNow();
          return { type: "stay", toast: "Clipboard history cleared" };
        },
      },
    ],
  }));
}
