import { useEffect, useMemo, useRef, useState } from "react";
import type { ActionDef } from "../../shared/types";
import { Kbd } from "./Kbd";

interface Props {
  title: string;
  actions: ActionDef[];
  onRun: (action: ActionDef) => void;
  onClose: () => void;
}

/** Raycast's Ctrl+K menu: every action for the selected item, searchable. */
export function ActionPanel({ title, actions, onRun, onClose }: Props) {
  const [filter, setFilter] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(
    () => actions.filter((a) => a.title.toLowerCase().includes(filter.trim().toLowerCase())),
    [actions, filter],
  );

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => setIndex(0), [filter]);

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setIndex((i) => Math.min(i + 1, visible.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (visible[index]) onRun(visible[index]);
    } else if (event.key === "Escape" || (event.ctrlKey && event.key.toLowerCase() === "k")) {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }

  return (
    <div className="action-backdrop" onMouseDown={onClose}>
      <div className="action-panel" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="action-title">{title}</div>
        <div className="action-list">
          {visible.map((action, i) => (
            <div
              key={action.id}
              className={`action-row${i === index ? " selected" : ""}${action.danger ? " danger" : ""}`}
              onMouseMove={() => setIndex(i)}
              onClick={() => onRun(action)}
            >
              <span>{action.title}</span>
              <Kbd shortcut={action.shortcut} />
            </div>
          ))}
          {!visible.length && <div className="action-empty">No matching actions</div>}
        </div>
        <input
          ref={inputRef}
          className="action-search"
          placeholder="Search for actions…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
    </div>
  );
}
