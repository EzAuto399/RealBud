// The window's one answer to "is there unsaved work here?". The beforeunload
// guard in App.tsx and Electron main's question before an update restart
// (`updater.onQueryUnsaved`) both read it, so they can never disagree.
// A component holding typed text joins through `useUnsavedGuard(dirty)`.
import { useEffect, useRef } from "react";
import { hasPropertyEdits } from "@/lib/property-edits";
import { hasUnsavedMailReviews } from "@/lib/mail-review-drafts";
import { hasUnsavedOfficeDrafts } from "@/lib/office-draft-journal";
import { hasUnsavedDepartmentConfigurationDrafts } from "@/lib/department-configuration-draft-journal";
import { hasUnpersistedBillDrafts } from "@/lib/bill-review-drafts";

const checks = new Set<() => boolean>();

/** Adds a mounted owner's own unsaved state to the answer. Returns the unregister. */
export function registerUnsavedCheck(check: () => boolean): () => void {
  // A wrapper per registration, so the same function registered twice unregisters independently.
  const entry = () => check();
  checks.add(entry);
  return () => { checks.delete(entry); };
}

/** A check that cannot answer keeps the work. */
const holds = (check: () => boolean) => { try { return check(); } catch { return true; } };

export function hasUnsavedWork(): boolean {
  return hasPropertyEdits() || hasUnpersistedBillDrafts() || hasUnsavedMailReviews() || hasUnsavedOfficeDrafts()
    || hasUnsavedDepartmentConfigurationDrafts() || [...checks].some(holds);
}

/** A beforeunload listener that holds the window exactly while `unsaved()` says so. */
export function holdUnloadWhile(unsaved: () => boolean): (event: BeforeUnloadEvent) => void {
  return (event) => {
    if (!unsaved()) return;
    event.preventDefault(); event.returnValue = "";
  };
}

/** Under `useUnsavedGuard`: one check both holds the window's beforeunload and
 * answers main before an update restart. Returns the cleanup. Components use the hook. */
export function guardUnsavedWork(check: () => boolean): () => void {
  const warn = holdUnloadWhile(check);
  window.addEventListener("beforeunload", warn);
  const unregister = registerUnsavedCheck(check);
  return () => { window.removeEventListener("beforeunload", warn); unregister(); };
}

/** The one way a component joins: while it is mounted, its latest `dirty` holds the window's
 * beforeunload and answers main before an update restart. Pass true only while the person's
 * edits (typed text, or choices in the same form) differ from what is saved, and false again
 * after save, cancel or reset. State kept in refs, which change without a render, uses
 * `guardUnsavedWork` with a function instead (BankReferenceReview). */
export function useUnsavedGuard(dirty: boolean): void {
  const latest = useRef(dirty);
  latest.current = dirty;
  useEffect(() => guardUnsavedWork(() => latest.current), []);
}
