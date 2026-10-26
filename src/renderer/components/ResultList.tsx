import { useEffect, useRef } from "react";
import type { ResultItem, ResultSection } from "../../shared/types";
import { Icon } from "./Icon";

export const GRID_COLUMNS = 8;

interface Props {
  sections: ResultSection[];
  selectedId: string | null;
  grid: boolean;
  onSelect: (item: ResultItem) => void;
  onRun: (item: ResultItem) => void;
}

export function ResultList({ sections, selectedId, grid, onSelect, onRun }: Props) {
  const selectedRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  if (!sections.length) {
    return <div className="empty">No results</div>;
  }

  return (
    <div className="list">
      {sections.map((section) => (
        <div key={section.title} className="section">
          <div className="section-title">{section.title}</div>
          <div className={grid ? "grid" : undefined}>
            {section.items.map((item) => {
              const selected = item.id === selectedId;
              return (
                <div
                  key={item.id}
                  ref={selected ? selectedRef : undefined}
                  className={`${grid ? "cell" : "row"}${selected ? " selected" : ""}`}
                  title={grid ? item.title : undefined}
                  onMouseMove={() => !selected && onSelect(item)}
                  onClick={() => onRun(item)}
                >
                  {grid ? (
                    <span className="cell-emoji">{item.icon}</span>
                  ) : (
                    <>
                      <Icon icon={item.icon} />
                      <span className="row-title">{item.title}</span>
                      {item.subtitle && <span className="row-subtitle">{item.subtitle}</span>}
                      {item.accessory && <span className="row-accessory">{item.accessory}</span>}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
