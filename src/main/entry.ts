import type { ActionDef, ResultItem, RunResult } from "../shared/types";

export interface EntryAction extends ActionDef {
  run: () => RunResult | Promise<RunResult>;
}

/** What providers return: a result item plus the code behind its actions. */
export interface Entry {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;
  accessory?: string;
  preview?: string;
  /** Extra words that should match in search but are not displayed. */
  keywords?: string[];
  /** Set for launchable commands, enabling aliases, hotkeys and ranking. */
  ref?: string;
  actions: EntryAction[];
}

export function toResultItem(entry: Entry): ResultItem {
  return {
    id: entry.id,
    title: entry.title,
    subtitle: entry.subtitle,
    icon: entry.icon,
    accessory: entry.accessory,
    preview: entry.preview,
    actions: entry.actions.map(({ id, title, shortcut, danger }) => ({
      id,
      title,
      shortcut,
      danger,
    })),
  };
}

export const HIDE: RunResult = { type: "hide" };
