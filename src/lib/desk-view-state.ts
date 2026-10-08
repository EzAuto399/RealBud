import { useSyncExternalStore, type SetStateAction } from "react";
import type { PropertyScope } from "./book-groups";
import type { QueueFilter } from "./desk-queue";

/** Secondary work opened from "Other work". While one is open it replaces the
 *  task area; null means the queue and case are showing. */
export type DeskOtherWork = "mail" | "bills" | "shared-work";
interface DeskViewState {
  mode: "cases" | "book" | "batch";
  /** The Hermios tab is open over the task area. Shell navigation closes it. */
  hermios: boolean;
  otherWork: DeskOtherWork | null;
  filter: QueueFilter;
  selectedId: string | null;
  query: string;
  caseKind: string;
  taskScope: PropertyScope | null;
  batchScope: PropertyScope | null;
  bookExpanded: string | null;
  bookFilter: string;
  bookGroup: string | null;
  bookPage: number;
  bookNonce: number;
}
// Navigation only, scoped to the open app. No background jobs or writes.
const view: DeskViewState = { mode: "cases", hermios: false, otherWork: null, filter: "now", selectedId: null, query: "", caseKind: "all", taskScope: null, batchScope: null, bookExpanded: null, bookFilter: "", bookGroup: null, bookPage: 0, bookNonce: 0 };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** Shell queue shortcuts: show the task queue with one status filter, whatever
 *  Desk tab (Hermios, Properties, Bills, a property scope) was open. */
export function openDeskQueueFilter(filter: QueueFilter) {
  Object.assign(view, { mode: "cases", hermios: false, otherWork: null, filter, query: "", caseKind: "all", taskScope: null });
  emit();
}
/** Explicit task links must open the queue even if the last view was Properties. */
export function openDeskTasks() {
  Object.assign(view, { mode: "cases", hermios: false, otherWork: null, filter: "now", selectedId: null, query: "", caseKind: "all", taskScope: null });
  emit();
}
/** Return to the queue with one case selected, so leaving Ask lands back on the
 *  case the operator was working rather than on an arbitrary row. Filter and
 *  search are cleared because the case may sit outside the current filter. */
export function openDeskCase(caseId: string) {
  Object.assign(view, { mode: "cases", hermios: false, otherWork: null, filter: "all", selectedId: caseId, query: "", caseKind: "all", taskScope: null });
  emit();
}
export function useDeskViewState<K extends keyof DeskViewState>(key: K): [DeskViewState[K], (next: SetStateAction<DeskViewState[K]>) => void] {  const value = useSyncExternalStore(subscribe, () => view[key], () => view[key]);
  return [value, next => {
    const resolved = typeof next === "function" ? (next as (old: DeskViewState[K]) => DeskViewState[K])(view[key]) : next;
    view[key] = resolved; emit();
  }];
}

/** Opens the property book filtered to one property (⌘K search). */
export function openDeskProperty(address: string) {
  Object.assign(view, { mode: "book", hermios: false, otherWork: null, bookFilter: address, bookExpanded: null, bookGroup: null, bookPage: 0, bookNonce: view.bookNonce + 1 });
  emit();
}
