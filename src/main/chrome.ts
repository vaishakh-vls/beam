// Reads Chrome's profile files: bookmarks JSON, history rows and Local State. No Electron here, so it can be tested.

export interface Bookmark {
  /** Chrome's guid for the node, stable across edits. */
  id: string;
  title: string;
  url: string;
  /** "Bookmarks bar / Work", the folders above the bookmark. */
  folder: string;
}

export interface HistoryItem {
  /** The row id in Chrome's `urls` table. */
  id: number;
  url: string;
  title: string;
  visitCount: number;
  /** Unix time in ms. */
  lastVisit: number;
}

/** The profile folder Chrome used last, e.g. "Default" or "Profile 2". */
export function lastUsedProfile(localState: string): string {
  try {
    const value = (JSON.parse(localState) as { profile?: { last_used?: unknown } }).profile?.last_used;
    // A folder name, never a path: it is joined onto the Chrome config folder.
    if (typeof value === "string" && value && !/[/\\]|^\.\.?$/.test(value)) return value;
  } catch {
    // Unreadable Local State: Chrome falls back to Default too.
  }
  return "Default";
}

interface BookmarkNode {
  type?: string;
  name?: string;
  url?: string;
  guid?: string;
  id?: string;
  children?: BookmarkNode[];
}

/** Flattens Chrome's Bookmarks file into a list, in the order Chrome shows them. */
export function flattenBookmarks(json: string): Bookmark[] {
  const roots = (JSON.parse(json) as { roots?: Record<string, unknown> }).roots ?? {};
  const out: Bookmark[] = [];
  const seen = new Set<string>();
  const walk = (node: BookmarkNode, path: string[]): void => {
    if (node.type === "url" && typeof node.url === "string") {
      let id = node.guid || node.id || node.url;
      // Ids must be unique within a response; a copied profile can repeat guids.
      while (seen.has(id)) id += "+";
      seen.add(id);
      out.push({ id, title: node.name?.trim() || node.url, url: node.url, folder: path.join(" / ") });
      return;
    }
    if (!Array.isArray(node.children)) return;
    const next = node.name ? [...path, node.name] : path;
    for (const child of node.children) walk(child, next);
  };
  // bookmark_bar, other and synced; "sync_transaction_version" and the like are not folders.
  for (const root of Object.values(roots)) {
    if (root && typeof root === "object") walk(root as BookmarkNode, []);
  }
  return out;
}

/** Every word of the query must appear in the title, URL or folder; title matches rank first. */
export function searchBookmarks(bookmarks: Bookmark[], query: string, limit: number): Bookmark[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return bookmarks.slice(0, limit);
  const q = terms.join(" ");
  const scored: Array<{ bookmark: Bookmark; score: number }> = [];
  for (const bookmark of bookmarks) {
    const title = bookmark.title.toLowerCase();
    const url = bookmark.url.toLowerCase().replace(/^[a-z]+:\/\/(www\.)?/, "");
    const haystack = `${title} ${url} ${bookmark.folder.toLowerCase()}`;
    if (!terms.every((term) => haystack.includes(term))) continue;
    let score = 1;
    if (title.startsWith(q)) score = 4;
    else if (url.startsWith(q)) score = 3;
    else if (title.includes(q)) score = 2;
    scored.push({ bookmark, score });
  }
  // Array.sort is stable, so equal scores keep Chrome's order.
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ bookmark }) => bookmark);
}

/** Chrome stores times as microseconds since 1601-01-01 UTC. */
export function chromeTimeToMs(value: number): number {
  return value ? Math.round(value / 1000 - 11_644_473_600_000) : 0;
}

/** Rows printed by HISTORY_SCRIPT: [id, url, title, visit_count, last_visit_time]. */
export function parseHistoryRows(stdout: string): HistoryItem[] {
  const rows = JSON.parse(stdout) as unknown;
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is [number, string, string | null, number, number] => Array.isArray(row) && typeof row[1] === "string")
    .map(([id, url, title, visitCount, lastVisit]) => ({
      id,
      url,
      title: title?.trim() || url,
      visitCount: visitCount ?? 0,
      lastVisit: chromeTimeToMs(lastVisit ?? 0),
    }));
}

/**
 * Searches a copy of Chrome's History database. Run as
 * `python3 -I -c HISTORY_SCRIPT <db> <query> <limit>`. Every word must
 * appear in the title or URL; the words are bound as parameters, never
 * spliced into the SQL. Prints the rows as JSON.
 */
export const HISTORY_SCRIPT = `
import json, sqlite3, sys
db, query, limit = sys.argv[1], sys.argv[2], int(sys.argv[3])
con = sqlite3.connect(db)
con.execute("PRAGMA query_only = 1")
where, params = ["hidden = 0"], []
for term in query.split():
    like = "%" + term.replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%"
    where.append("(title LIKE ? ESCAPE '!' OR url LIKE ? ESCAPE '!')")
    params += [like, like]
sql = ("SELECT id, url, title, visit_count, last_visit_time FROM urls WHERE "
       + " AND ".join(where) + " ORDER BY last_visit_time DESC LIMIT ?")
print(json.dumps(con.execute(sql, params + [limit]).fetchall()))
`;

/**
 * Whether Chrome can open the URL from its command line. Bookmarklets
 * (javascript:) only run inside a page, and anything without a scheme could
 * be read as a command-line switch.
 */
export function isOpenableUrl(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) && !/^javascript:/i.test(url);
}

/** "[Title](url)", with the brackets that would end the link text escaped. */
export function markdownLink(title: string, url: string): string {
  const text = title.replace(/\s+/g, " ").trim().replace(/([\\[\]])/g, "\\$1");
  // Parentheses would end the link target early; encodeURIComponent leaves them alone.
  const target = url.replace(/[()\s]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  return `[${text || target}](${target})`;
}

/** "github.com/user/repo", for subtitles. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");
}

export function relativeTime(ms: number, now = Date.now()): string {
  const minutes = Math.round((now - ms) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ms).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}
