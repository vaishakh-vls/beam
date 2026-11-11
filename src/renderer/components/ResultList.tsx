import { useEffect, useRef, useState } from "react";
import type { ResultItem, ResultSection } from "../../shared/types";
import { Icon } from "./Icon";

export const GRID_COLUMNS = 8;

/**
 * Items drawn at first; more are drawn as the list scrolls or the selection
 * moves down. The emoji grid alone has about 3,800 cells, and drawing them
 * all at once took 25 MB.
 */
const PAGE = 200;
/** How close to the bottom, in pixels, scrolling draws the next page. */
const PAGE_MARGIN = 600;

interface Props {
  sections: ResultSection[];
  /** Position in all sections' items, in order. */
  selectedIndex: number;
  grid: boolean;
  /** Changes when a different list is shown (another view or query); it starts short again. */
  resetKey: string;
  onSelect: (index: number) => void;
  onRun: (item: ResultItem) => void;
}

export function ResultList({ sections, selectedIndex, grid, resetKey, onSelect, onRun }: Props) {
  const selectedRef = useRef<HTMLDivElement | null>(null);
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => setLimit(PAGE), [resetKey]);

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!sections.length) {
    return <div className="empty">No results</div>;
  }

  const total = sections.reduce((sum, section) => sum + section.items.length, 0);
  // Keyboard moves can go past what is drawn; draw far enough to show the selection.
  const shown = Math.max(limit, selectedIndex + PAGE / 2);
  let offset = 0;
  return (
    <div
      className="list"
      onScroll={(event) => {
        const list = event.currentTarget;
        if (shown < total && list.scrollTop + list.clientHeight > list.scrollHeight - PAGE_MARGIN) setLimit(shown + PAGE);
      }}
    >
      {sections.map((section) => {
        const start = offset;
        offset += section.items.length;
        if (start >= shown) return null;
        return (
          <div key={section.title} className="section">
            <div className="section-title">{section.title}</div>
            <div className={grid ? "grid" : undefined}>
              {section.items.slice(0, shown - start).map((item, i) => {
                const index = start + i;
                const selected = index === selectedIndex;
                return (
                  <div
                    key={item.id}
                    ref={selected ? selectedRef : undefined}
                    className={`${grid ? "cell" : "row"}${selected ? " selected" : ""}`}
                    title={grid ? item.title : undefined}
                    onMouseMove={() => !selected && onSelect(index)}
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
        );
      })}
    </div>
  );
}
