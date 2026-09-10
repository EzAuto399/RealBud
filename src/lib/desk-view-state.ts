import { useSyncExternalStore, type SetStateAction } from "react";
import type { PropertyScope } from "./book-groups";
import type { QueueFilter } from "./desk-queue";

interface DeskViewState {
  mode: "cases" | "book" | "batch";
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
const view: DeskViewState = { mode: "cases", filter: "now", selectedId: null, query: "", caseKind: "all", taskScope: null, batchScope: null, bookExpanded: null, bookFilter: "", bookGroup: null, bookPage: 0, bookNonce: 0 };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
/** Explicit task links must open the queue even if the last view was Properties. */
export function openDeskTasks() {
  Object.assign(view, { mode: "cases", filter: "now", selectedId: null, query: "", caseKind: "all", taskScope: null });
  emit();
}
export function useDeskViewState<K extends keyof DeskViewState>(key: K): [DeskViewState[K], (next: SetStateAction<DeskViewState[K]>) => void] {
  const value = useSyncExternalStore(subscribe, () => view[key]);
  return [value, next => {
    const resolved = typeof next === "function" ? (next as (old: DeskViewState[K]) => DeskViewState[K])(view[key]) : next;
    view[key] = resolved; emit();
  }];
}
