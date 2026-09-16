/** Browser-addressable app locations.
 *
 * The four doors were previously component state only, so a refresh dropped the
 * operator back on Desk and Back left the app entirely. One scheme keeps the
 * existing You deep links untouched: they live at the root (`#you-recovery`,
 * `#connected-apps`), while door routes are prefixed with `#/`.
 */
import { youHashTarget } from "./you-navigation";

export type DeskView = "desk" | "ask" | "schedule" | "you";

export function viewFromHash(hash: string): DeskView | null {
  switch (hash.replace(/^#\/?/, "")) {
    case "desk": return "desk";
    case "ask": return "ask";
    case "schedule": return "schedule";
    case "you": return "you";
    default: return null;
  }
}

export function hashForView(view: DeskView | "chat"): string | null {
  // "chat" is the fallback before Bud has loaded; it is not a door, so it leaves
  // whatever the address bar already says alone.
  return view === "chat" ? null : `#/${view}`;
}

/** Hash to write when the active door changes. While staying on You, never
 *  overwrite a You deep link (`#you-recovery`, `#connected-apps`, …) with `#/you`.
 *  Leaving You for another door must still write that door's hash. */
export function doorHashToWrite(hash: string, view: DeskView | "chat"): string | null {
  if (view === "you" && youHashTarget(hash)) return null;
  const next = hashForView(view);
  if (!next || hash === next) return null;
  return next;
}
