import { Fragment, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { NeedsYouArea, NeedsYouSnapshot } from "@shared/needs-you";

/** What a work area's tab says about its Needs you items: none while unread or at zero.
 *  A source that couldn't be read is one problem, as it is in Needs you. The tab's name stays the
 *  area's title (QA and assistive tech find it by that); the count is its description. */
export type AreaBadge = { total: number; problem: number; description: string };
export function areaTabBadge(snapshot: NeedsYouSnapshot | null | undefined, area: NeedsYouArea): AreaBadge | null {
  const counts = snapshot?.counts[area];
  const problem = (counts?.problem ?? 0) + (snapshot?.unavailable.some(source => source.area === area) ? 1 : 0);
  const total = problem + (counts?.review ?? 0);
  if (!total) return null;
  const problems = problem ? `, ${problem} problem${problem === 1 ? "" : "s"}` : "";
  return { total, problem, description: `${total} item${total === 1 ? "" : "s"}${problems}` };
}
/** The count, with a "!" text marker before it when any is a problem (never colour alone). */
export function AreaBadgeMarks({ badge, countClass }: { badge: AreaBadge; countClass: string }) {
  return <>{badge.problem ? <span className="area-tab-problem" aria-hidden>!</span> : null}<span className={countClass} aria-hidden>{badge.total}</span></>;
}
/** The spoken count, beside the tab (inside it, it would join the tab's name). Hidden: read only as the
 *  tab's description through `aria-describedby`, never a second time as loose text. */
export function AreaBadgeDescription({ id, badge }: { id: string; badge: AreaBadge }) {
  return <span id={id} hidden>{badge.description}</span>;
}

export type AreaTab = { id: string; label: string; count?: number; badge?: AreaBadge | null };

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
        <Fragment key={tab.id}>
          <button type="button" role="tab" id={`rb-area-tab-${tab.id}`} aria-selected={tab.id === selected} aria-controls={panelId}
            tabIndex={index === focusIndex ? 0 : -1} className="rb-area-tab" aria-describedby={tab.badge ? `rb-area-tab-${tab.id}-count` : undefined} onClick={() => { keyed = null; onSelect(tab.id); }} onKeyDown={event => onKeyDown(event, index)}>
            <span className="truncate">{tab.label}</span>
            {tab.badge ? <AreaBadgeMarks badge={tab.badge} countClass="rb-area-tab-count" /> : tab.count ? <span className="rb-area-tab-count">{tab.count}</span> : null}
          </button>
          {tab.badge ? <AreaBadgeDescription id={`rb-area-tab-${tab.id}-count`} badge={tab.badge} /> : null}
        </Fragment>
      ))}
      {bar ? <span aria-hidden className="rb-area-tab-highlight" style={{ transform: `translateX(${bar.left}px)`, width: bar.width }} /> : null}
    </div>
  );
}
