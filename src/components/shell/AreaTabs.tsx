import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

export type AreaTab = { id: string; label: string; count?: number };

/** Next tab index for an arrow/Home/End key, wrapping; null for other keys. */
export function tabKeyTarget(key: string, index: number, length: number): number | null {
  if (!length) return null;
  if (key === "ArrowRight") return (index + 1) % length;
  if (key === "ArrowLeft") return (index - 1 + length) % length;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  return null;
}

/** The tab last chosen by key. The row remounts when it moves between Desk's own
 *  row and the shell bar, so the row that shows next keeps focus on that tab. */
let keyed: string | null = null;

/** Views within the current area. Arrow keys move and select (roving tabindex);
 *  a highlight slides under the selected tab, without motion when reduced. */
export function AreaTabs({ label, tabs, selected, onSelect, panelId }: { label: string; tabs: AreaTab[]; selected: string | null; onSelect: (id: string) => void; panelId: string }) {
  const list = useRef<HTMLDivElement | null>(null);
  const [bar, setBar] = useState<{ left: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const node = list.current;
    if (!node) return;
    const measure = () => {
      const active = node.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      setBar(active ? { left: active.offsetLeft, width: active.offsetWidth } : null);
    };
    measure();
    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    observer?.observe(node);
    return () => observer?.disconnect();
  }, [selected, tabs]);
  useLayoutEffect(() => {
    if (keyed === null || keyed !== selected) return;
    keyed = null;
    list.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
  }, [selected]);
  const focusIndex = Math.max(0, tabs.findIndex(tab => tab.id === selected));
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const target = tabKeyTarget(event.key, index, tabs.length);
    if (target === null) return;
    event.preventDefault();
    keyed = tabs[target]!.id;
    onSelect(tabs[target]!.id);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[target]?.focus();
  };
  return (
    <div ref={list} role="tablist" aria-label={label} className="rb-area-tabs">
      {tabs.map((tab, index) => (
        <button key={tab.id} type="button" role="tab" id={`rb-area-tab-${tab.id}`} aria-selected={tab.id === selected} aria-controls={panelId}
          tabIndex={index === focusIndex ? 0 : -1} className="rb-area-tab" onClick={() => { keyed = null; onSelect(tab.id); }} onKeyDown={event => onKeyDown(event, index)}>
          <span className="truncate">{tab.label}</span>
          {tab.count ? <span className="rb-area-tab-count">{tab.count}</span> : null}
        </button>
      ))}
      {bar ? <span aria-hidden className="rb-area-tab-highlight" style={{ transform: `translateX(${bar.left}px)`, width: bar.width }} /> : null}
    </div>
  );
}
