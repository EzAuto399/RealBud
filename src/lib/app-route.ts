/** Browser-addressable app locations.
 *
 * The four doors were previously component state only, so a refresh dropped the
 * operator back on Desk and Back left the app entirely. One scheme keeps the
 * existing You deep links untouched: they live at the root (`#you-recovery`,
 * `#connected-apps`), while door routes are prefixed with `#/`.
 */
import { youHashTarget } from "./you-navigation";
import { validWorkspaceTabId } from '@shared/workspace-tabs';

export function workspaceViewFromHash(hash: string): { id: string | null } | null {
  if (hash === '#/views') return { id: null };
  const match = /^#\/views\/(.+)$/.exec(hash);
  return match && validWorkspaceTabId(match[1]) ? { id: match[1] } : null;
}
export const workspaceViewHash = (id: string | null): string => id && validWorkspaceTabId(id) ? `#/views/${id}` : '#/views';

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

/** Schedule deep links: a saved job (`#job-<id>`), a section (`#schedule-week`,
 *  `#schedule-packs`) or the job builder. Schedule reads them once it has
 *  mounted, then clears them itself. */
export function scheduleHashTarget(hash: string): string | null {
  const target = hash.replace(/^#/, "");
  return /^(?:job-[\w-]+|schedule-[\w-]+|bud-job-builder)$/.test(target) ? target : null;
}

/** Hash to write when the active door changes. While staying on You, never
 *  overwrite a You deep link (`#you-recovery`, `#connected-apps`, …) with `#/you`;
 *  likewise a Schedule deep link is left for Schedule to consume, because it is
 *  read only after that lazy screen mounts. Leaving a door for another must
 *  still write the new door's hash. */
export function doorHashToWrite(hash: string, view: DeskView | "chat"): string | null {
  if (view === "you" && youHashTarget(hash)) return null;
  if (view === "schedule" && scheduleHashTarget(hash)) return null;
  const next = hashForView(view);
  if (!next || hash === next) return null;
  return next;
}
