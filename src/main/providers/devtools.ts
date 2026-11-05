import { randomUUID } from "node:crypto";
import { clipboard } from "electron";
import {
  analyze,
  expiryPhrase,
  formatJson,
  formatLocal,
  generatePassword,
  generateSecret,
  generators,
  inlineEpoch,
  isoLocal,
  jwtHeadline,
  jwtReport,
  parseJwt,
  relativeTime,
  type DevGroup,
  type DevResult,
  type Jwt,
} from "../devtools";
import { HIDE, type Entry, type EntryAction, type Section, type ViewProvider } from "../entry";
import { copyText, notify, pasteText, pasteVerb, truncate } from "../system";
import { copyConcealed } from "./clipboard";
import type { RunResult } from "../../shared/types";

/** Bigger clipboards (logs, dumps) are left alone so the view stays quick. */
const MAX_CLIPBOARD_CHARS = 200_000;
const TITLE_CHARS = 120;
/** The preview pane gets slow with megabytes of text; Copy still gets all of it. */
const PREVIEW_CHARS = 50_000;

function previewText(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text;
  const rest = (text.length - PREVIEW_CHARS).toLocaleString("en-US");
  return `${text.slice(0, PREVIEW_CHARS)}\n\n… ${rest} more characters. Copy to get all of it.`;
}

function copy(text: string, secret: boolean): RunResult {
  if (secret) copyConcealed(text);
  else copyText(text);
  return HIDE;
}

/**
 * pasteText, for text that must stay out of clipboard history and
 * notifications. Copying it concealed first means the history watcher skips
 * the identical text pasteText writes again.
 */
async function paste(text: string, secret: boolean, what: string, hide: () => void): Promise<RunResult> {
  if (!secret) {
    await pasteText(text, hide);
    return HIDE;
  }
  copyConcealed(text);
  if (pasteVerb() === "Copy") {
    hide();
    notify("Copied to clipboard", what);
    return HIDE;
  }
  await pasteText(text, hide);
  return HIDE;
}

function copyActions(text: string, label: string, secret: boolean, hide: () => void, copyTitle = `Copy ${label}`): EntryAction[] {
  return [
    { id: "copy", title: copyTitle, shortcut: "↵", run: () => copy(text, secret) },
    {
      id: "paste",
      title: copyTitle.replace(/^Copy/, pasteVerb()),
      shortcut: "Ctrl+↵",
      run: () => paste(text, secret, label, hide),
    },
  ];
}

function resultEntry(group: DevGroup, result: DevResult, idPrefix: string, hide: () => void): Entry {
  const secret = result.secret ?? group.secret ?? false;
  const extras: EntryAction[] = (group.extras ?? []).map((extra) => ({
    id: extra.id,
    title: extra.title,
    shortcut: extra.shortcut,
    run: () => copy(extra.text, secret),
  }));
  return {
    id: `${idPrefix}${result.id}`,
    title: truncate(result.title ?? result.value, TITLE_CHARS) || "(empty)",
    icon: result.error ? "⚠️" : group.icon,
    // The view has a preview pane, which hides subtitles, so the label goes on the right.
    accessory: result.label,
    preview: previewText(result.preview ?? result.value),
    actions: [...copyActions(result.value, result.label, secret, hide, result.copyTitle), ...extras],
  };
}

function toSections(groups: DevGroup[], titlePrefix: string, idPrefix: string, hide: () => void): Section[] {
  return groups.map((group) => ({
    title: titlePrefix + group.title,
    entries: group.results.map((result) => resultEntry(group, result, idPrefix, hide)),
  }));
}

function generateSection(now: number, query: string, hide: () => void): Section {
  const group: DevGroup = { kind: "generate", title: "Generate", icon: "✨", results: generators(now, query) };
  return toSections([group], "", "", hide)[0];
}

type ClipboardInput = { text: string } | { notice: string; detail: string } | null;

function clipboardInput(): ClipboardInput {
  // Password managers mark copied passwords; leave those alone, as clipboard history does.
  if (clipboard.availableFormats().some((format) => format.includes("passwordManagerHint"))) {
    return { notice: "The clipboard holds a password", detail: "Beam does not inspect text a password manager copied." };
  }
  const text = clipboard.readText();
  if (!text.trim()) return null;
  if (text.length > MAX_CLIPBOARD_CHARS) {
    const size = `${(Buffer.byteLength(text, "utf8") / 1_000_000).toFixed(1)} MB`;
    return { notice: "The clipboard text is too large to inspect", detail: `${size}. Paste a part of it into the search field instead.` };
  }
  return { text };
}

export const devtoolsView: ViewProvider = {
  info: {
    title: "Developer Tools",
    placeholder: "Paste a token, JSON, timestamp or any text…",
    preview: true,
    grid: false,
  },
  sections(query, hide) {
    const now = Date.now();
    if (query.trim()) {
      // "uuid" or "password" typed here asks for a fresh one first.
      return [generateSection(now, query, hide), ...toSections(analyze(query, now), "", "", hide)];
    }
    const input = clipboardInput();
    const sections: Section[] = [];
    if (input && "text" in input) {
      sections.push(...toSections(analyze(input.text, now), "From Clipboard · ", "clip:", hide));
    } else if (input) {
      sections.push({
        title: "From Clipboard",
        entries: [
          {
            id: "clip:notice",
            title: input.notice,
            icon: "📋",
            preview: `${input.notice}.\n\n${input.detail}`,
            actions: [],
          },
        ],
      });
    }
    // Last when the clipboard had something, so a fresh UUID is still a scroll away.
    sections.push(generateSection(now, "", hide));
    return sections;
  },
};

// ---------------------------------------------------------------------------
// Root commands

function copyAndNotify(text: string, body: string): RunResult {
  copyText(text);
  notify("Copied to clipboard", body);
  return HIDE;
}

function copySecretAndNotify(text: string, body: string): RunResult {
  copyConcealed(text);
  notify("Copied to clipboard", `${body} Kept out of clipboard history.`);
  return HIDE;
}

function formatClipboardJson(): RunResult {
  const text = clipboard.readText();
  if (!text.trim()) return { type: "error", message: "The clipboard is empty." };
  const result = formatJson(text);
  if (!result.ok) {
    return { type: "error", message: `The clipboard is not valid JSON: ${result.message} (line ${result.line}, column ${result.column}).` };
  }
  copyText(result.text);
  const lines = result.text.split("\n").length;
  notify("Formatted JSON copied", [result.shape, `${lines.toLocaleString("en-US")} lines`].filter(Boolean).join(" · "));
  return HIDE;
}

export function devtoolsCommands(_hide: () => void): Entry[] {
  const command = (
    name: string,
    title: string,
    icon: string,
    keywords: string[],
    run: () => RunResult | Promise<RunResult>,
    more: EntryAction[] = [],
  ): Entry => ({
    id: `cmd:${name}`,
    ref: `cmd:${name}`,
    title,
    subtitle: "Developer Tools",
    icon,
    accessory: "Command",
    keywords: ["developer", ...keywords],
    actions: [{ id: "run", title: "Run Command", shortcut: "↵", run }, ...more],
  });
  const openView = (): RunResult => ({ type: "view", view: "devtools" });
  return [
    command(
      "devtools",
      "Developer Tools",
      "🛠️",
      ["devtools", "dev tools", "decode", "encode", "convert", "jwt", "json", "base64", "hash", "sha256", "md5", "timestamp", "epoch", "uuid", "url decode", "case"],
      openView,
    ),
    // The view reads the clipboard when nothing is typed, which is where a copied token is.
    command("decode-jwt", "Decode JWT", "🔑", ["jwt", "bearer", "token", "decode token", "authorization", "claims", "jwt decoder"], openView),
    command("format-json", "Format JSON in Clipboard", "🧩", ["json", "pretty print", "prettify", "beautify", "format", "indent"], formatClipboardJson),
    command("generate-uuid", "Generate UUID", "🆔", ["uuid", "guid", "uuid v4", "random id", "unique id"], () => {
      const uuid = randomUUID();
      return copyAndNotify(uuid, uuid);
    }),
    command("generate-password", "Generate Password", "🔐", ["password", "random password", "strong password", "pwgen"], () =>
      copySecretAndNotify(generatePassword(), "A new 20-character password."),
    ),
    command(
      "generate-secret",
      "Generate Secret",
      "🗝️",
      ["secret", "random bytes", "api key", "hex", "base64", "hmac", "jwt secret", "openssl rand"],
      () => copySecretAndNotify(generateSecret().hex, "A new 32-byte secret as hex."),
      [
        {
          id: "base64",
          title: "Copy as Base64",
          shortcut: "Ctrl+↵",
          run: () => copySecretAndNotify(generateSecret().base64, "A new 32-byte secret as Base64."),
        },
      ],
    ),
    command("copy-unix-timestamp", "Copy Unix Timestamp", "🕒", ["timestamp", "unix", "epoch", "now", "time", "seconds"], () => {
      const seconds = String(Math.floor(Date.now() / 1000));
      return copyAndNotify(seconds, seconds);
    }),
  ];
}

// ---------------------------------------------------------------------------
// Root search

function jwtInlineEntry(jwt: Jwt, now: number, hide: () => void): Entry {
  const payload = JSON.stringify(jwt.claims, null, 2);
  return {
    id: "devtools:jwt",
    title: `JWT · ${expiryPhrase(jwt.claims, now)}`,
    subtitle: jwtHeadline(jwt),
    icon: "🔑",
    accessory: "Developer Tools",
    actions: [
      { id: "copy-payload", title: "Copy Payload JSON", shortcut: "↵", run: () => copy(payload, true) },
      {
        id: "show",
        title: "Show Decoded Token",
        shortcut: "Ctrl+↵",
        run: () => ({ type: "output", title: "Decoded JWT", text: jwtReport(jwt, now) }),
      },
      { id: "copy-token", title: "Copy Token", shortcut: "Ctrl+Shift+T", run: () => copy(jwt.token, true) },
      {
        id: "copy-auth-header",
        title: "Copy Authorization Header",
        shortcut: "Ctrl+Shift+A",
        run: () => copy(`Authorization: Bearer ${jwt.token}`, true),
      },
    ],
  };
}

function epochInlineEntry(ms: number, now: number, hide: () => void): Entry {
  const local = formatLocal(ms);
  const iso = new Date(ms).toISOString();
  return {
    id: "devtools:epoch",
    title: local,
    subtitle: `${relativeTime(ms, now)} · ${iso}`,
    icon: "🕒",
    accessory: "Timestamp",
    actions: [
      ...copyActions(local, "Date", false, hide),
      { id: "copy-iso", title: "Copy ISO 8601 (UTC)", shortcut: "Ctrl+Shift+C", run: () => copy(iso, false) },
      { id: "copy-iso-local", title: "Copy ISO 8601 (Local)", shortcut: "Ctrl+Shift+L", run: () => copy(isoLocal(ms), false) },
    ],
  };
}

function uuidInlineEntry(hide: () => void): Entry {
  const uuid = randomUUID();
  return {
    id: "devtools:uuid",
    title: uuid,
    subtitle: "A new random UUID (v4)",
    icon: "🆔",
    accessory: "UUID",
    actions: copyActions(uuid, "UUID", false, hide),
  };
}

/**
 * Root search results for text that is unmistakably a developer value: a
 * JWT or Bearer token, a 10- or 13-digit epoch, or the word "uuid". Anything
 * looser would crowd ordinary searches.
 */
export function devtoolsInlineEntries(query: string, hide: () => void): Entry[] {
  const q = query.trim();
  if (!q) return [];
  if (q.toLowerCase() === "uuid") return [uuidInlineEntry(hide)];
  const now = Date.now();
  const jwt = parseJwt(q);
  if (jwt && !("error" in jwt) && !jwt.encrypted && jwt.claims && jwt.token.startsWith("eyJ")) {
    return [jwtInlineEntry(jwt, now, hide)];
  }
  const epoch = inlineEpoch(q);
  if (epoch !== null) return [epochInlineEntry(epoch, now, hide)];
  return [];
}
