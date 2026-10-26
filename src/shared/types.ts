// Types shared between the main process and the renderer.

export interface ActionDef {
  id: string;
  title: string;
  /** Display hint such as "↵", "Ctrl+↵", "Ctrl+C". */
  shortcut?: string;
  /** Destructive actions are shown in red. */
  danger?: boolean;
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
  | "windows";

export interface ViewInfo {
  placeholder: string;
  /** Show a preview pane beside the list. */
  preview: boolean;
  /** Render items as a grid of large icons (emoji picker). */
  grid: boolean;
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
  | { type: "output"; title: string; text: string }
  | { type: "error"; message: string };

/** Sent when the window opens: which view to start in, or a result to show. */
export interface ShowPayload {
  view: View;
  result?: RunResult;
}

export interface BeamApi {
  search(query: string, view: View): Promise<SearchResponse>;
  run(itemId: string, actionId: string): Promise<RunResult>;
  submitForm(formId: string, values: Record<string, string>): Promise<RunResult>;
  hide(): void;
  onShow(callback: (payload: ShowPayload) => void): void;
}
