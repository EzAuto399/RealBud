const KEY = "realbud.first-run-done";

export function firstRunDone(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function markFirstRunDone(): void {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* private mode */
  }
}

/**
 * Person names RealBud writes for itself while someone explores the sample
 * book. They identify a fixture, not the office, so they never count as a
 * recorded contact. Keep in step with SAMPLE_PROFILE_NAME in
 * src/components/Onboarding.tsx.
 */
const TRAINING_PERSON = new Set(["sample pm", "demo pm"]);

/**
 * Just the one saved field first run would otherwise write over. `agency` is
 * declared because a real snapshot and the cases below carry it, and is
 * deliberately never read: the agency name is not what the write touches.
 */
export interface OfficeContactSnapshot {
  book?: { office?: { pmUser?: string }; agency?: { name?: string } } | null;
}

/**
 * True when the saved book already records a real person as the office contact.
 *
 * The flag above lives in browser storage, which a cleared profile, a private
 * window or a fresh renderer profile loses while the book on disk survives, so
 * first run can replay over a restored book. This reads exactly the field that
 * replay would write — `office.pmUser`, and nothing else. A named agency with no
 * contact yet is a blank to fill, not a value to protect: skipping the write
 * there would drop the name the person just typed instead of saving it.
 */
export function officeContactNamed(snapshot: OfficeContactSnapshot | null | undefined): boolean {
  const person = String(snapshot?.book?.office?.pmUser ?? "").trim();
  return person.length > 0 && !TRAINING_PERSON.has(person.toLowerCase());
}
