/**
 * Scores how well `query` matches `text`; 0 means no match.
 * Prefix matches beat word-start matches, which beat substrings,
 * which beat loose subsequence matches ("vsc" -> "Visual Studio Code").
 */
export function fuzzyScore(query: string, text: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();

  if (t === q) return 1000;
  if (t.startsWith(q)) return 800 - Math.min(t.length, 100);

  const index = t.indexOf(q);
  if (index >= 0) {
    const wordStart = findWordStart(t, q, index);
    return wordStart >= 0 ? 600 - wordStart : 400 - index;
  }

  return subsequenceScore(q, t);
}

const SEPARATORS = " \t-_./";

/** First occurrence of q (at or after `from`) that starts a word, or -1. */
function findWordStart(t: string, q: string, from: number): number {
  for (let i = from; i >= 0; i = t.indexOf(q, i + 1)) {
    if (i === 0 || SEPARATORS.includes(t[i - 1])) return i;
  }
  return -1;
}

function subsequenceScore(q: string, t: string): number {
  let ti = 0;
  let score = 200;
  let previous = -1;
  for (const ch of q) {
    if (ch === " ") continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return 0;
    const atWordStart = found === 0 || SEPARATORS.includes(t[found - 1]);
    if (atWordStart) score += 10;
    if (previous >= 0 && found !== previous + 1) score -= Math.min(found - previous, 10);
    previous = found;
    ti = found + 1;
  }
  return Math.max(score, 1);
}

/** Best score across several fields (title, keywords, alias...). */
export function bestScore(query: string, fields: Array<string | undefined>): number {
  let best = 0;
  for (const field of fields) {
    if (field) best = Math.max(best, fuzzyScore(query, field));
  }
  return best;
}

/** Scores at or above this are real matches; below it, loose subsequence matches. */
export const STRONG_MATCH = 300;

export interface Scored<E> {
  entry: E;
  score: number;
}

/**
 * Sorts best first, keeping each app above its own commands: "spo" lists
 * Spotify before "Spotify Play/Pause", and "chrome" lists Google Chrome before
 * "New Incognito Window". A command names its app in `app`; when that app
 * matches well too, the command ranks just under it, still in its own order.
 */
export function rankResults<E extends { ref?: string; title: string; app?: string }>(scored: Array<Scored<E>>): Array<Scored<E>> {
  const apps = new Map<string, number>();
  for (const { entry, score } of scored) {
    if (entry.ref?.startsWith("app:") && score >= STRONG_MATCH) apps.set(entry.title, Math.max(score, apps.get(entry.title) ?? 0));
  }
  return scored
    .map((item) => {
      const app = item.entry.app === undefined ? undefined : apps.get(item.entry.app);
      return { item, rank: app === undefined ? item.score : Math.min(item.score, app - 1) };
    })
    .sort((a, b) => b.rank - a.rank || b.item.score - a.item.score)
    .map(({ item }) => item);
}
