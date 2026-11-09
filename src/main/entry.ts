import type { ActionDef, ArgDef, ResultItem, RunResult, ViewInfo } from "../shared/types";

export interface EntryAction extends ActionDef {
  /** `args` holds what was typed in the entry's fields; hotkeys and `beam --run` pass none. */
  run: (args?: Record<string, string>) => RunResult | Promise<RunResult>;
}

/** What providers return: a result item plus the code behind its actions. */
export interface Entry {
  id: string;
  title: string;
  subtitle?: string;
  icon?: string;
  accessory?: string;
  preview?: string;
  previewImage?: string;
  args?: ArgDef[];
  /** Extra words that should match in search but are not displayed. */
  keywords?: string[];
  /** Set for launchable commands, enabling aliases, hotkeys and ranking. */
  ref?: string;
  /** The app a command works on, by its name ("Spotify"): the app ranks first when both match. */
  app?: string;
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
    previewImage: entry.previewImage,
    args: entry.args,
    actions: entry.actions.map(({ id, title, shortcut, danger }) => ({
      id,
      title,
      shortcut,
      danger,
    })),
  };
}

export interface Section {
  title: string;
  entries: Entry[];
}

/** A view of its own, such as Wi-Fi or Processes: what to show for each query. */
export interface ViewProvider {
  info: ViewInfo;
  /** `hide` closes Beam, for actions that hand over to another window. */
  sections(query: string, hide: () => void): Section[] | Promise<Section[]>;
}

export const HIDE: RunResult = { type: "hide" };
