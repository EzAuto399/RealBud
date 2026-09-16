import { useSyncExternalStore } from "react";
import type { NotifyChannel, RentSource } from "./desk";

export interface PropertyOptionEdits {
  graceDays?: string; courtesyUntilDay?: string; levyOn?: boolean;
  levyAmount?: string; rentSource?: RentSource; notifyChannel?: NotifyChannel;
}
interface PropertyEdits { notes?: string; options?: PropertyOptionEdits; pending?: boolean; error?: string; notice?: string }
const drafts = new Map<string, PropertyEdits>();
const empty: PropertyEdits = Object.freeze({});
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
export const propertyEdits = (id: string): PropertyEdits => drafts.get(id) ?? empty;
export const hasPropertyEdits = () => [...drafts.values()].some(draft => draft.notes !== undefined || draft.options !== undefined || draft.pending);
export function changePropertyEdits(id: string, patch: Pick<PropertyEdits, "notes" | "options">) {
  const previous = propertyEdits(id);
  if (previous.pending) return;
  drafts.set(id, { ...previous, ...patch, ...(patch.options ? { options: { ...previous.options, ...patch.options } } : {}), error: "", notice: "" });
  emit();
}
export function discardPropertyEdits(id: string, field: "notes" | "options") {
  if (propertyEdits(id).pending) return;
  const next = { ...propertyEdits(id), error: "", notice: "" }; delete next[field];
  if (next.notes === undefined && !next.options) drafts.delete(id); else drafts.set(id, next);
  emit();
}
/** The promise and draft outlive the card, including navigation during a save. */
export async function savePropertyEdits(id: string, field: "notes" | "options", save: () => Promise<boolean>): Promise<boolean> {
  const before = propertyEdits(id);
  if (before.pending || before[field] === undefined) return false;
  drafts.set(id, { ...before, pending: true, error: "", notice: "" }); emit();
  let ok = false;
  try { ok = await save(); } catch { /* Keep a sanitized, actionable error at the editor. */ }
  const next = { ...propertyEdits(id), pending: false, error: ok ? "" : `Could not save ${field}. Your edits are kept; try again.`, notice: ok ? `${field === "notes" ? "Notes" : "Options"} saved` : "" };
  if (ok && next[field] === before[field]) delete next[field];
  drafts.set(id, next); emit();
  return ok;
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function usePropertyEdits(id: string) { return useSyncExternalStore(subscribe, () => propertyEdits(id)); }
