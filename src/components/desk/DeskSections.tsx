import { Fragment, useState, type MouseEvent, type ReactNode } from "react";
import { deskSectionsOrDefault, type DeskSectionId } from "@shared/workspace-tabs";
import type { DeskOtherWork } from "@/lib/desk-view-state";
import { StatusLabel } from "../pm";

/** Renders Desk content sections in the saved order, skipping hidden ones.
 * An absent or invalid layout renders today's order. Needs you always shows. */
export function DeskSections({ sections, render }: { sections: unknown; render: Record<DeskSectionId, ReactNode> }) {
  return (
    <>
      {deskSectionsOrDefault(sections).map(section =>
        section.visible || section.id === "queue" ? <Fragment key={section.id}>{render[section.id]}</Fragment> : null,
      )}
    </>
  );
}

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

export const OTHER_WORK_LABELS: Record<DeskOtherWork, string> = {
  mail: "Mail priorities",
  bills: "Bills and calendar",
  "shared-work": "Shared work",
};

/** The task area and any opened Other work surface. Only one shows at a time;
 *  the rest stay mounted but hidden so unsaved drafts and in-flight request
 *  identities survive switching back and forth. */
export function DeskWorkArea({
  active,
  opened,
  tasks,
  panels,
  onBack,
}: {
  active: DeskOtherWork | null;
  opened: ReadonlySet<DeskOtherWork>;
  tasks: ReactNode;
  panels: Record<DeskOtherWork, ReactNode>;
  onBack: () => void;
}) {
  return (
    <>
      <div className="desk-work-tasks" hidden={active !== null}>{tasks}</div>
      {(Object.keys(OTHER_WORK_LABELS) as DeskOtherWork[]).map(id =>
        opened.has(id) || active === id ? (
          <section key={id} className="desk-other-work-surface" data-other-work={id} hidden={active !== id} aria-label={OTHER_WORK_LABELS[id]}>
            <button type="button" className="desk-back-to-tasks pm-control" onClick={onBack}>Back to tasks</button>
            {panels[id]}
          </section>
        ) : null,
      )}
    </>
  );
}
