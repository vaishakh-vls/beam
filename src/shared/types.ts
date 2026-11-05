// Types shared between the main process and the renderer.

export interface ActionDef {
  id: string;
  title: string;
  /** Display hint such as "↵", "Ctrl+↵", "Ctrl+C". */
  shortcut?: string;
  /** Destructive actions are shown in red. */
  danger?: boolean;
}

/** A value typed beside the search box while this item is selected, like Raycast's command arguments. */
export interface ArgDef {
  name: string;
  placeholder: string;
  /** Accept digits only. */
  numeric?: boolean;
}

export interface ResultItem {
  id: string;
  title: string;
  subtitle?: string;
  /** Emoji/short text, or a beam-icon:// URL for image icons. */
  icon?: string;
  /** Label shown on the right, e.g. "Application" or an alias. */
  accessory?: string;
  /** Full text for the preview pane (clipboard, snippets). */
  preview?: string;
  /** Image shown in the preview pane above the text: a GIF, a color swatch. */
  previewImage?: string;
  /** Fields shown in the search bar while selected; Tab moves between them. */
  args?: ArgDef[];
  /** First action runs on Enter, second on Ctrl+Enter; all appear in Ctrl+K. */
  actions: ActionDef[];
}

export interface ResultSection {
  title: string;
  items: ResultItem[];
}

export type View =
  | "root"
  | "clipboard"
  | "snippets"
  | "quicklinks"
  | "emoji"
  | "scripts"
  | "windows"
  | "processes"
  | "fans"
  | "colors"
  | "media"
  | "chrome"
  | "speedtest"
  | "gifs"
  | "audio"
  | "bluetooth"
  | "wifi"
  | "caffeinate"
  | "clean-keyboard"
  | "devtools"
  | "convert"
  | "open-with"
  | "welcome"
  | "tabs"
  | "fonts"
  | "power"
  | "themes";

export interface ViewInfo {
  /** Shown as a badge beside the search field. */
  title: string;
  placeholder: string;
  /** Show a preview pane beside the list. */
  preview: boolean;
  /** Render items as a grid of large icons (emoji picker). */
  grid: boolean;
  /** Re-run the search this often while the view is open, for live values. */
  refreshMs?: number;
}

export interface SearchResponse {
  sections: ResultSection[];
  info: ViewInfo;
}

export interface FormField {
  name: string;
  label: string;
  /** "hotkey" records the pressed key combination instead of typed text. */
  type: "text" | "textarea" | "password" | "hotkey";
  value?: string;
  placeholder?: string;
  optional?: boolean;
  hint?: string;
}

export interface FormSpec {
  id: string;
  title: string;
  submitLabel: string;
  fields: FormField[];
}

export type RunResult =
  | { type: "hide" }
  | { type: "stay"; toast?: string }
  | { type: "view"; view: View }
  | { type: "form"; form: FormSpec }
  | { type: "output"; title: string; text: string; image?: string }
  /** Go back to the main search with this text typed, e.g. an example from the tour. */
  | { type: "search"; query: string }
  | { type: "error"; message: string };

/** Sent when the window opens: which view to start in, or a result to show. */
export interface ShowPayload {
  view: View;
  result?: RunResult;
}

export interface BeamApi {
  search(query: string, view: View): Promise<SearchResponse>;
  run(itemId: string, actionId: string, args?: Record<string, string>): Promise<RunResult>;
  submitForm(formId: string, values: Record<string, string>): Promise<RunResult>;
  hide(): void;
  onShow(callback: (payload: ShowPayload) => void): void;
}
