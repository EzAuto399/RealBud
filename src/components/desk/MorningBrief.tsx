import type { ReactNode } from "react";
import { fmtDateTime } from "@/lib/au";
import { collapseBriefRows, shortStreet, type MorningBrief as MorningBriefModel } from "@/lib/morning-brief";
import { StatusLabel } from "../pm";

const AU = "en-AU";
function checkedAt(at: number, timeZone?: string): string {
  const format = (zone?: string) => {
    const options = zone ? { timeZone: zone } : {};
    const day = new Intl.DateTimeFormat(AU, { day: "numeric", month: "short", ...options }).format(at);
    const time = new Intl.DateTimeFormat(AU, { hour: "numeric", minute: "2-digit", hour12: true, ...options }).format(at).toLowerCase();
    return `${day}, ${time}`;
  };
  try {
    return format(timeZone);
  } catch {
    return format();
  }
}

export const TASK_CHECK_FAILED = "The check didn't finish. The last saved results are shown.";
export const TASK_CHECK_NEVER = "These tasks haven't been checked yet.";
/** Empty queue after a failed check: points at the status line, never "nothing needs you". */
export const TASK_CHECK_FAILED_EMPTY = "No saved tasks need you yet. See the check status above.";

/** One sentence about the last task check. A failed check never reads as a clean one. */
export function taskCheckLine(brief: Pick<MorningBriefModel, "lastRunAt">, failed: boolean, timezone?: string): string {
  if (failed) return TASK_CHECK_FAILED;
  if (brief.lastRunAt == null) return TASK_CHECK_NEVER;
  return `Tasks checked ${checkedAt(brief.lastRunAt, timezone)}.`;
}

/** The compact task-check status above the queue. "Check details" expands the
 *  evidence of that check in place, inside Desk's one scroll region. */
export function MorningBrief({
  brief,
  timezone,
  failed = false,
  failedLine,
  failedAction,
  interactive = false,
  onOpenAddress,
  collapsed = true,
  onToggle,
  children,
}: {
  brief: MorningBriefModel;
  timezone?: string;
  failed?: boolean;
  /** The one sentence for a check that did not run, when the cause is known. */
  failedLine?: string;
  /** The single recovery action for that cause (Install Bud, Open model connection…). */
  failedAction?: ReactNode;
  interactive?: boolean;
  onOpenAddress?: (propertyId: string) => void;
  collapsed?: boolean;
  onToggle?: () => void;
  /** Extra detail shown only while expanded (setup progress, keyboard hint). */
  children?: ReactNode;
}) {
  const { expanded, collapsedSummary } = collapseBriefRows(brief.addresses);
  return (
    <section className="desk-check-status" aria-label="This morning">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
        <span role={failed ? "alert" : undefined} className={failed ? "font-medium text-hold" : "text-ink-secondary"}>
          {failed && failedLine ? failedLine : taskCheckLine(brief, failed, timezone)}
        </span>
        {failed ? failedAction : null}
        {onToggle ? (
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls="desk-check-details"
            onClick={onToggle}
            className="min-h-8 rounded px-1 text-[12.5px] font-medium text-agency hover:underline"
          >
            {collapsed ? "Check details" : "Hide check details"}
          </button>
        ) : null}
      </p>
      {collapsed ? null : (
        <div id="desk-check-details" className="desk-check-details">
          <p className="text-[12.5px] text-ink">{brief.headline}</p>
          <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Addresses in this check">
            {expanded.map((row) => {
              const canOpen = interactive && (row.attention === "needs-you" || row.attention === "held" || row.attention === "licensee");
              const chip = (
                <StatusLabel tone={row.tone}>
                  {shortStreet(row.address)} · {row.label}
                </StatusLabel>
              );
              return (
                <li key={row.propertyId}>
                  {canOpen ? (
                    <button
                      type="button"
                      onClick={() => onOpenAddress?.(row.propertyId)}
                      className="rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-agency"
                    >
                      {chip}
                    </button>
                  ) : (
                    chip
                  )}
                </li>
              );
            })}
            {collapsedSummary ? <li className="self-center text-[12px] text-ink-muted">{collapsedSummary}</li> : null}
            {brief.addresses.length === 0 ? <li className="text-[12px] text-ink-muted">No addresses on the book.</li> : null}
          </ul>
          <p className="mt-2 text-[11.5px] text-ink-muted">
            {brief.lastRunAt != null ? `Last check ${fmtDateTime(brief.lastRunAt, timezone)} · ` : ""}{brief.inboxLabel}. {brief.inboxDetail}
          </p>
          {children}
        </div>
      )}
    </section>
  );
}

export function MorningEmpty({ brief, checkLabel = "Check tasks", onAction, actionLabel, busy = false, failed = false }: { brief: MorningBriefModel; checkLabel?: string; onAction?: () => void; actionLabel?: string; busy?: boolean; failed?: boolean }) {
  // A check that did not finish must never read as "Nothing needs you".
  const clearWin =
    !onAction &&
    !failed &&
    brief.lastRunAt != null &&
    brief.needsYou === 0 &&
    brief.held === 0 &&
    brief.licensee === 0 &&
    !brief.headline.startsWith("Recheck missed");

  const nextStep =
    brief.headline.startsWith("Recheck missed")
      ? "Open Bud setup here, then check the task again."
      : brief.lastRunAt == null && brief.addresses.length > 0
        ? `Press ${checkLabel} in the header when you're ready.`
        : brief.lastRunAt == null && brief.addresses.length === 0
          ? "Add an address under More → Properties and imports, or drop an export there."
          : null;

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 py-8 text-center">
      {clearWin ? (
        <>
          <p className="max-w-[28rem] text-[17px] font-medium text-ink">Nothing needs you</p>
          <p className="mt-1.5 max-w-[28rem] text-[13px] text-ink-muted">{brief.headline}</p>
        </>
      ) : (
        <p className="max-w-[28rem] text-[15px] text-ink">{failed ? TASK_CHECK_FAILED_EMPTY : brief.headline}</p>
      )}
      {brief.lastRunAt == null && brief.addresses.length > 0 ? (
        <ul className="morning-empty-addresses mt-3 max-w-[28rem] space-y-1 text-[13px] text-ink-muted">
          {brief.addresses.map((row) => (
            <li key={row.propertyId}>{row.address}</li>
          ))}
        </ul>
      ) : null}
      {onAction ? <button type="button" className="desk-primary-button mt-4" disabled={busy} onClick={onAction}>{busy ? "Checking…" : actionLabel || checkLabel}</button> : nextStep ? <p className="mt-3 max-w-[28rem] text-[13px] font-medium text-ink">{nextStep}</p> : null}
      <details className="mt-3 max-w-[28rem] text-[12.5px] text-ink-muted"><summary className="pm-control cursor-pointer">About this morning’s checks</summary><p>{brief.inboxDetail}</p></details>
    </div>
  );
}
