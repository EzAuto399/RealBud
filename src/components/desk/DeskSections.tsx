import { useState, type MouseEvent, type ReactNode } from "react";
import { DESK_AREAS, type DeskOtherWork } from "@/lib/desk-view-state";
import { StatusLabel } from "../pm";

export const LICENSEE_BADGE = "Needs licensee review";
export const LICENSEE_EXPLANATION =
  "Your licensee must decide what happens next. RealBud will not prepare or send a legal notice, or determine its legal deadline.";
export const DESK_RECOVERY_LEAD =
  "Desk needs recovery. Changes, scheduled jobs and browser work are paused. Your saved book has been kept.";

/** A licensee case is decided by a licensed person; the badge marks it in the
 *  queue and on the case so it is never mistaken for ordinary wording review. */
export function LicenseeBadge() {
  return <StatusLabel tone="danger" title={LICENSEE_EXPLANATION}>{LICENSEE_BADGE}</StatusLabel>;
}

/** Recovery sits outside the configurable sections and above every Desk surface. */
export function DeskRecoveryNotice({ onOpenWorkspace }: { onOpenWorkspace: () => void }) {
  const open = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onOpenWorkspace();
  };
  return (
    <div role="status" className="desk-recovery border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
      {DESK_RECOVERY_LEAD}{" "}
      <a href="#you-recovery" className="font-medium underline underline-offset-2" onClick={open}>Open Workspace</a>
      {" "}and use your recovery key.
    </div>
  );
}

/** Reminders as a compact disclosure above the queue. The panel stays mounted
 *  while collapsed, so an unsaved reminder survives; CSS hides everything but
 *  its heading (with the due count) and its alerts, so errors stay visible. */
export function DeskRemindersDisclosure({ children, initialOpen = false }: { children: (toggle: ReactNode) => ReactNode; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const toggle = (
    <button
      type="button"
      className="desk-reminders-toggle"
      aria-label={open ? "Hide reminders" : "Show reminders"}
      aria-expanded={open}
      aria-controls="desk-reminders-body"
      onClick={() => setOpen(value => !value)}
    >
      {open ? "Hide" : "Show"}
    </button>
  );
  return (
    <div className="desk-reminders-disclosure" data-open={open ? "true" : "false"}>
      <div id="desk-reminders-body">{children(toggle)}</div>
    </div>
  );
}

/** The task area and any opened work-area surface. Only one shows at a time;
 *  the rest stay mounted but hidden so unsaved drafts and in-flight request
 *  identities survive switching back and forth. The Tasks tab is the way back. */
export function DeskWorkArea({
  active,
  opened,
  title,
  tasks,
  panels,
}: {
  active: DeskOtherWork | null;
  opened: ReadonlySet<DeskOtherWork>;
  /** The area's name as this office calls it. */
  title: (id: DeskOtherWork) => string;
  tasks: ReactNode;
  panels: Record<DeskOtherWork, ReactNode>;
}) {
  return (
    <>
      <div className="desk-work-tasks" hidden={active !== null}>{tasks}</div>
      {DESK_AREAS.map(id =>
        opened.has(id) || active === id ? (
          <section key={id} className="desk-area-surface" data-other-work={id} hidden={active !== id} aria-label={title(id)}>
            {panels[id]}
          </section>
        ) : null,
      )}
    </>
  );
}
