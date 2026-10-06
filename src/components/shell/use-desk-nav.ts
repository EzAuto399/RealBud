import { useMemo, useSyncExternalStore } from "react";
import { openDeskCase, openDeskQueueFilter, useDeskViewState } from "@/lib/desk-view-state";
import { buildDeskQueue, type DeskQueueItem, type QueueFilter } from "@/lib/desk-queue";
import { useStore } from "@/state/store";

export type DeskTabId = "today" | "properties" | "bills";

// Desk's own tab row hands the shell a place for its tabs, so Desk shows one row of tabs.
let tabSlot: HTMLElement | null = null;
const slotListeners = new Set<() => void>();
export function setDeskTabSlot(node: HTMLElement | null) {
  if (tabSlot === node) return;
  tabSlot = node;
  slotListeners.forEach(listener => listener());
}
export function useDeskTabSlot() {
  return useSyncExternalStore(listener => { slotListeners.add(listener); return () => { slotListeners.delete(listener); }; }, () => tabSlot, () => null);
}

/** Shell navigation into Desk through Desk's own navigation store; no new state. */
export function useDeskNav() {
  const { state, dispatch } = useStore();
  const [mode, setMode] = useDeskViewState("mode");
  const [hermios, setHermios] = useDeskViewState("hermios");
  const [otherWork, setOtherWork] = useDeskViewState("otherWork");
  const [filter, setFilter] = useDeskViewState("filter");
  const [, setQuery] = useDeskViewState("query");
  const [, setCaseKind] = useDeskViewState("caseKind");
  const [taskScope, setTaskScope] = useDeskViewState("taskScope");
  const [selectedId, setSelectedId] = useDeskViewState("selectedId");
  const desk = state.desk;
  const rows = useMemo<DeskQueueItem[]>(() => (desk ? buildDeskQueue(desk) : []), [desk]);
  const onDesk = state.activeView === "desk";
  const show = () => { if (!onDesk) dispatch({ type: "showDesk" }); };
  const tab: DeskTabId | null = !onDesk || hermios ? null : mode === "book" ? "properties" : otherWork === "bills" ? "bills" : mode === "cases" && !otherWork ? "today" : null;
  return {
    rows, tab, filter: onDesk && mode === "cases" && !hermios && !otherWork && !taskScope ? filter : null, scopeIds: onDesk && mode === "cases" ? taskScope?.ids ?? null : null,
    /** The case Desk shows: the chosen row, else the first in Desk's default order. */
    selected: rows.find(row => row.id === selectedId) ?? rows.find(row => row.bucket === "now") ?? null,
    openTab(id: DeskTabId) {
      setHermios(false);
      if (id === "properties") { setOtherWork(null); setMode("book"); }
      else if (id === "bills") { setMode("cases"); setOtherWork("bills"); }
      else { setOtherWork(null); setMode("cases"); }
      show();
    },
    openFilter(next: QueueFilter) {
      openDeskQueueFilter(next);
      show();
    },
    openProperty(id: string, address: string) {
      setHermios(false); setOtherWork(null); setMode("cases"); setFilter("all"); setCaseKind("all"); setQuery("");
      setTaskScope({ label: address, ids: [id] });
      setSelectedId(rows.find(row => row.propertyId === id)?.id ?? null);
      show();
    },
    openCase(id: string) {
      openDeskCase(id);
      show();
      // Move focus to the case so the press visibly lands somewhere, even when it was already selected.
      window.requestAnimationFrame(() => {
        const column = document.getElementById("desk-case-column");
        column?.scrollIntoView({ block: "nearest" });
        column?.focus({ preventScroll: true });
      });
    },
  };
}
