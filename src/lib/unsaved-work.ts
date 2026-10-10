// The window's one answer to "is there unsaved work here?". The beforeunload
// guard in App.tsx and Electron main's question before an update restart
// (`updater.onQueryUnsaved`) both read it, so they can never disagree.
// Drafts held in a component's own state join through `registerUnsavedCheck`.
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

/** For a component that holds drafts in its own state: one check both holds the
 * window's beforeunload and answers main before an update restart. Returns the cleanup. */
export function guardUnsavedWork(check: () => boolean): () => void {
  const warn = holdUnloadWhile(check);
  window.addEventListener("beforeunload", warn);
  const unregister = registerUnsavedCheck(check);
  return () => { window.removeEventListener("beforeunload", warn); unregister(); };
}
