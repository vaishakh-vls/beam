import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionDef,
  BeamApi,
  FormSpec,
  ResultItem,
  RunResult,
  SearchResponse,
  ShowPayload,
  View,
} from "../shared/types";
import { ActionPanel } from "./components/ActionPanel";
import { FormView } from "./components/FormView";
import { Kbd } from "./components/Kbd";
import { GRID_COLUMNS, ResultList } from "./components/ResultList";
import { comboFromEvent } from "./keys";

declare global {
  interface Window {
    beam: BeamApi;
  }
}

type Screen =
  | { kind: "list"; view: View }
  | { kind: "form"; form: FormSpec }
  | { kind: "output"; title: string; text: string };

const VIEW_TITLES: Record<View, string> = {
  root: "",
  clipboard: "Clipboard History",
  snippets: "Snippets",
  quicklinks: "Quicklinks",
  emoji: "Emoji & Symbols",
  scripts: "Script Commands",
  windows: "Window Management",
};

const EMPTY: SearchResponse = { sections: [], info: { placeholder: "", preview: false, grid: false } };
const ROOT: Screen = { kind: "list", view: "root" };

export function App() {
  const [stack, setStack] = useState<Screen[]>([ROOT]);
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<SearchResponse>(EMPTY);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchSeq = useRef(0);

  const screen = stack[stack.length - 1];
  const view = screen.kind === "list" ? screen.view : null;
  const items = useMemo(() => response.sections.flatMap((s) => s.items), [response]);
  const selected = items.find((i) => i.id === selectedId) ?? items[0] ?? null;

  const refresh = useCallback(async (q: string, v: View, keepSelection = false) => {
    const seq = ++searchSeq.current;
    const result = await window.beam.search(q, v);
    if (seq !== searchSeq.current) return;
    setResponse(result);
    setSelectedId((current) => {
      const all = result.sections.flatMap((s) => s.items);
      if (keepSelection && all.some((i) => i.id === current)) return current;
      return all[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    if (view) void refresh(query, view);
  }, [query, view, refresh]);

  const showToast = useCallback((text: string, error = false) => {
    setToast({ text, error });
    window.setTimeout(() => setToast((t) => (t?.text === text ? null : t)), 2200);
  }, []);

  const goTo = useCallback((next: Screen, replace = false) => {
    setActionsOpen(false);
    setFormError(null);
    setStack((s) => (replace ? [...s.slice(0, -1), next] : [...s, next]));
    if (next.kind === "list") setQuery("");
  }, []);

  const applyResult = useCallback(
    (result: RunResult, fromForm = false) => {
      switch (result.type) {
        case "hide":
          window.beam.hide();
          break;
        case "stay":
          if (result.toast) showToast(result.toast);
          if (view) void refresh(query, view, true);
          break;
        case "view":
          if (result.view === "root") {
            setStack([ROOT]);
            setQuery("");
          } else {
            goTo({ kind: "list", view: result.view }, fromForm);
          }
          break;
        case "form":
          goTo({ kind: "form", form: result.form });
          break;
        case "output":
          goTo({ kind: "output", title: result.title, text: result.text }, fromForm);
          break;
        case "error":
          if (fromForm) setFormError(result.message);
          else showToast(result.message, true);
          break;
      }
    },
    [goTo, query, refresh, showToast, view],
  );

  const runAction = useCallback(
    async (item: ResultItem | null, action: ActionDef | undefined) => {
      if (!item || !action) return;
      setActionsOpen(false);
      applyResult(await window.beam.run(item.id, action.id));
    },
    [applyResult],
  );

  // onShow is registered once, so it reads the latest applyResult via a ref.
  const applyResultRef = useRef(applyResult);
  applyResultRef.current = applyResult;

  useEffect(() => {
    window.beam.onShow((payload: ShowPayload) => {
      setActionsOpen(false);
      setToast(null);
      setFormError(null);
      setQuery("");
      setStack([payload.view === "root" ? ROOT : { kind: "list", view: payload.view }]);
      if (payload.result) applyResultRef.current(payload.result);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    });
  }, []);

  function back() {
    if (stack.length <= 1) return;
    setStack((s) => s.slice(0, -1));
    setQuery("");
    setFormError(null);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  function moveSelection(delta: number) {
    if (!items.length) return;
    const index = Math.max(0, items.findIndex((i) => i.id === selected?.id));
    const next = Math.min(Math.max(index + delta, 0), items.length - 1);
    setSelectedId(items[next].id);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (actionsOpen) return;
    // Esc steps back one screen at a time and closes Beam from the home screen.
    // Backspace on an empty search also goes back.
    if (event.key === "Escape") {
      event.preventDefault();
      if (stack.length > 1) back();
      else window.beam.hide();
      return;
    }
    if (event.key === "Backspace" && stack.length > 1 && (screen.kind === "output" || (screen.kind === "list" && !query))) {
      event.preventDefault();
      back();
      return;
    }
    if (screen.kind !== "list") return;
    const combo = comboFromEvent(event);
    const grid = response.info.grid;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(grid ? GRID_COLUMNS : 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(grid ? -GRID_COLUMNS : -1);
    } else if (grid && (event.key === "ArrowRight" || event.key === "ArrowLeft")) {
      event.preventDefault();
      moveSelection(event.key === "ArrowRight" ? 1 : -1);
    } else if (combo === "↵") {
      event.preventDefault();
      void runAction(selected, selected?.actions[0]);
    } else if (combo === "Ctrl+↵") {
      event.preventDefault();
      void runAction(selected, selected?.actions[1]);
    } else if (combo === "Ctrl+K") {
      event.preventDefault();
      if (selected) setActionsOpen(true);
    } else if (combo && selected) {
      const action = selected.actions.find((a) => a.shortcut === combo);
      if (action) {
        event.preventDefault();
        void runAction(selected, action);
      }
    }
  }

  const title =
    screen.kind === "form" ? screen.form.title : screen.kind === "output" ? screen.title : VIEW_TITLES[screen.view];
  const primary = screen.kind === "list" ? selected?.actions[0] : undefined;

  return (
    <div className="shell" onKeyDown={onKeyDown}>
      <header className="search-bar">
        {stack.length > 1 && (
          <button className="back" onClick={back} title="Back (Esc)">
            ←
          </button>
        )}
        {screen.kind === "list" ? (
          <input
            ref={inputRef}
            className="search-input"
            autoFocus
            spellCheck={false}
            placeholder={response.info.placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : (
          <div className="screen-title">{title}</div>
        )}
        {screen.kind === "list" && title && <span className="view-badge">{title}</span>}
      </header>

      <main className="content">
        {screen.kind === "list" && (
          <div className={response.info.preview ? "split" : "single"}>
            <ResultList
              sections={response.sections}
              selectedId={selected?.id ?? null}
              grid={response.info.grid}
              onSelect={(item) => setSelectedId(item.id)}
              onRun={(item) => void runAction(item, item.actions[0])}
            />
            {response.info.preview && (
              <pre className="preview">{selected?.preview ?? ""}</pre>
            )}
          </div>
        )}
        {screen.kind === "form" && (
          <FormView
            key={screen.form.id}
            form={screen.form}
            onSubmit={async (values) => {
              setFormError(null);
              applyResult(await window.beam.submitForm(screen.form.id, values), true);
            }}
          />
        )}
        {screen.kind === "output" && <pre className="output">{screen.text}</pre>}
      </main>

      <footer className="footer">
        <span className={`footer-status${toast?.error || formError ? " error" : ""}`}>
          {formError ?? toast?.text ?? (screen.kind === "list" ? "Beam" : "")}
        </span>
        <span className="footer-actions">
          {screen.kind === "form" && (
            <>
              <span>{screen.form.submitLabel}</span>
              <Kbd shortcut="↵" />
            </>
          )}
          {screen.kind === "output" && (
            <>
              <span>Back</span>
              <Kbd shortcut="Esc" />
            </>
          )}
          {primary && (
            <>
              <span className="footer-primary">{primary.title}</span>
              <Kbd shortcut="↵" />
              <span className="footer-divider" />
              <span>Actions</span>
              <Kbd shortcut="Ctrl+K" />
            </>
          )}
        </span>
      </footer>

      {actionsOpen && selected && (
        <ActionPanel
          title={selected.title}
          actions={selected.actions}
          onRun={(action) => void runAction(selected, action)}
          onClose={() => {
            setActionsOpen(false);
            window.setTimeout(() => inputRef.current?.focus(), 0);
          }}
        />
      )}
    </div>
  );
}
