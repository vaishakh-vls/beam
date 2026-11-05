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
  | { kind: "output"; title: string; text: string; image?: string };

const EMPTY: SearchResponse = { sections: [], info: { title: "", placeholder: "", preview: false, grid: false } };
const ROOT: Screen = { kind: "list", view: "root" };

export function App() {
  const [stack, setStack] = useState<Screen[]>([ROOT]);
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<SearchResponse>(EMPTY);
  // By position, not id: one item can appear in two sections (Recent and Commands).
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; error: boolean } | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [argValues, setArgValues] = useState<Record<string, string>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const argRefs = useRef<Array<HTMLInputElement | null>>([]);
  const searchSeq = useRef(0);

  const screen = stack[stack.length - 1];
  const view = screen.kind === "list" ? screen.view : null;
  const items = useMemo(() => response.sections.flatMap((s) => s.items), [response]);
  const selected = items[selectedIndex] ?? items[0] ?? null;
  const selectedId = useRef<string | undefined>(undefined);
  selectedId.current = selected?.id;
  const args = screen.kind === "list" ? selected?.args : undefined;

  // Field values belong to the selected item, and focus can't stay on a field that has gone.
  useEffect(() => {
    setArgValues({});
    const focused = document.activeElement;
    if (!focused || focused === document.body || focused.classList.contains("arg-input")) inputRef.current?.focus();
  }, [selected?.id]);

  const refresh = useCallback(async (q: string, v: View, keepSelection = false) => {
    const seq = ++searchSeq.current;
    const result = await window.beam.search(q, v);
    if (seq !== searchSeq.current) return;
    setResponse(result);
    const next = result.sections.flatMap((s) => s.items);
    const id = selectedId.current;
    setSelectedIndex((current) => {
      if (!keepSelection) return 0;
      // Live views re-sort (processes by CPU): stay on the same item, not the same row.
      if (next[current]?.id === id) return current;
      const moved = next.findIndex((item) => item.id === id);
      return moved >= 0 ? moved : Math.min(current, Math.max(next.length - 1, 0));
    });
  }, []);

  useEffect(() => {
    if (view) void refresh(query, view);
  }, [query, view, refresh]);

  // Live views (processes, fans, speed test) refresh themselves while visible,
  // but not while the action panel is open, so its target can't change underneath it.
  const refreshMs = screen.kind === "list" ? response.info.refreshMs : undefined;
  useEffect(() => {
    if (!view || !refreshMs || actionsOpen) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(query, view, true);
    }, refreshMs);
    return () => window.clearInterval(timer);
  }, [view, query, refreshMs, actionsOpen, refresh]);

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
        case "search":
          setStack([ROOT]);
          setQuery(result.query);
          break;
        case "form":
          goTo({ kind: "form", form: result.form });
          break;
        case "output":
          goTo({ kind: "output", title: result.title, text: result.text, image: result.image }, fromForm);
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
      const fields = item.args?.length && item.id === selectedId.current ? argValues : undefined;
      const result = await window.beam.run(item.id, action.id, fields);
      // After an error the values stay, so a typo can be corrected.
      if (result.type !== "error") setArgValues({});
      applyResult(result);
    },
    [applyResult, argValues],
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
      setArgValues({});
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
    setSelectedIndex((index) => Math.min(Math.max(index + delta, 0), items.length - 1));
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (actionsOpen) return;
    const fields = args?.length ? [inputRef.current, ...argRefs.current.slice(0, args.length)] : [];
    const field = fields.indexOf(event.target as HTMLInputElement);
    if (event.key === "Tab" && fields.length) {
      event.preventDefault();
      fields[(field + (event.shiftKey ? -1 : 1) + fields.length) % fields.length]?.focus();
      return;
    }
    // In a field Backspace edits, and an empty field steps back to the previous one.
    if (event.key === "Backspace" && field > 0) {
      if (!fields[field]?.value) {
        event.preventDefault();
        fields[field - 1]?.focus();
      }
      return;
    }
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
    screen.kind === "form" ? screen.form.title : screen.kind === "output" ? screen.title : response.info.title;
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
        {args?.map((arg, i) => (
          <input
            key={`${selected?.id}:${arg.name}`}
            ref={(element) => {
              argRefs.current[i] = element;
            }}
            className="arg-input"
            spellCheck={false}
            inputMode={arg.numeric ? "numeric" : undefined}
            placeholder={arg.placeholder}
            value={argValues[arg.name] ?? ""}
            onChange={(e) => {
              const value = arg.numeric ? e.target.value.replace(/\D/g, "") : e.target.value;
              setArgValues((values) => ({ ...values, [arg.name]: value }));
            }}
          />
        ))}
        {screen.kind === "list" && title && <span className="view-badge">{title}</span>}
      </header>

      <main className="content">
        {screen.kind === "list" && (
          <div className={response.info.preview ? "split" : "single"}>
            <ResultList
              sections={response.sections}
              selectedIndex={selectedIndex}
              grid={response.info.grid}
              onSelect={(index) => {
                // A nudged mouse mustn't move the selection away from fields being filled in.
                if (!document.activeElement?.classList.contains("arg-input")) setSelectedIndex(index);
              }}
              onRun={(item) => void runAction(item, item.actions[0])}
            />
            {response.info.preview && (
              <div className="preview">
                {selected?.previewImage && (
                  <img className="preview-image" src={selected.previewImage} alt="" draggable={false} />
                )}
                <pre className="preview-text">{selected?.preview ?? ""}</pre>
              </div>
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
        {screen.kind === "output" && (
          <pre className="output">
            {screen.image && <img className="output-image" src={screen.image} alt="" />}
            {screen.text}
          </pre>
        )}
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
          {primary && Boolean(args?.length) && (
            <>
              <span>Next Field</span>
              <Kbd shortcut="Tab" />
              <span className="footer-divider" />
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
