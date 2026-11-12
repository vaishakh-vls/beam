// Clipboard history as a list, newest copy first. Pinned entries show above
// the rest, most recently pinned first, and stay until unpinned or deleted:
// the history size limit, new copies and Clear Entire History leave them.
// No Electron here, so it can be tested.

export interface ClipItem {
  text: string;
  copiedAt: number;
  /** When it was pinned; absent while not pinned. */
  pinnedAt?: number;
}

/**
 * Records a copy: a new entry goes on top; copying an existing entry again
 * moves it to the top, or, when pinned, keeps its place and pin. Keeps every
 * pinned entry and the newest `limit` others.
 */
export function addCopy(items: ClipItem[], text: string, now: number, limit: number): ClipItem[] {
  const existing = items.find((item) => item.text === text);
  if (existing?.pinnedAt !== undefined) {
    return items.map((item) => (item === existing ? { ...item, copiedAt: now } : item));
  }
  return keepNewest([{ text, copiedAt: now }, ...items.filter((item) => item.text !== text)], limit);
}

/** Every pinned entry, and the first `limit` of the others. */
export function keepNewest(items: ClipItem[], limit: number): ClipItem[] {
  let kept = 0;
  return items.filter((item) => item.pinnedAt !== undefined || kept++ < limit);
}

/** Pins the entry with this text, or unpins it if it is pinned. */
export function togglePin(items: ClipItem[], text: string, now: number): ClipItem[] {
  return items.map((item) => {
    if (item.text !== text) return item;
    if (item.pinnedAt === undefined) return { ...item, pinnedAt: now };
    const { pinnedAt: _unpinned, ...rest } = item;
    return rest;
  });
}

/** Pinned entries first, most recently pinned on top, then the rest newest first. */
export function inDisplayOrder(items: ClipItem[]): ClipItem[] {
  const pinned = items.filter((item) => item.pinnedAt !== undefined).sort((a, b) => b.pinnedAt! - a.pinnedAt!);
  return [...pinned, ...items.filter((item) => item.pinnedAt === undefined)];
}

/** What Clear Entire History leaves: the pinned entries. */
export function withoutUnpinned(items: ClipItem[]): ClipItem[] {
  return items.filter((item) => item.pinnedAt !== undefined);
}
