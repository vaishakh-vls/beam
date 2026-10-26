import { JsonStore } from "./store";

interface Usage {
  count: number;
  last: number;
}

const store = new JsonStore<Record<string, Usage>>("usage.json", () => ({}));

export function recordUse(ref: string): void {
  const usage = store.data[ref] ?? { count: 0, last: 0 };
  usage.count += 1;
  usage.last = Date.now();
  store.data[ref] = usage;
  store.save();
}

/** Frecency: frequent and recent commands rank higher. */
export function usageBoost(ref: string | undefined): number {
  if (!ref) return 0;
  const usage = store.data[ref];
  if (!usage) return 0;
  const days = (Date.now() - usage.last) / 86_400_000;
  const recency = days < 1 ? 1 : days < 7 ? 0.7 : days < 30 ? 0.4 : 0.2;
  return Math.min(usage.count * 20, 200) * recency;
}

export function recentRefs(limit: number): string[] {
  return Object.entries(store.data)
    .sort((a, b) => b[1].last - a[1].last)
    .slice(0, limit)
    .map(([ref]) => ref);
}
