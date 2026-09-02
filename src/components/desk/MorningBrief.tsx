import { fmtDateTime } from "@/lib/au";
import { collapseBriefRows, shortStreet, type MorningBrief as MorningBriefModel } from "@/lib/morning-brief";
import { StatusLabel } from "../pm";

export function MorningBrief({
  brief,
  timezone,
  interactive = false,
  onOpenAddress,
  collapsed = false,
  onToggle,
}: {
  brief: MorningBriefModel;
  timezone?: string;
  interactive?: boolean;
  onOpenAddress?: (propertyId: string) => void;
  /** Compact windows keep the case above the fold: one line, expand on demand. */
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const when = brief.lastRunAt
    ? `Last check ${fmtDateTime(brief.lastRunAt, timezone)}`
    : "Recheck has not run";
  const { expanded, collapsedSummary } = collapseBriefRows(brief.addresses);
  const toggle = onToggle ? (
    <button
      type="button"
      aria-expanded={!collapsed}
      onClick={onToggle}
      className="min-h-8 rounded px-1.5 text-[12px] font-medium text-agency hover:underline"
    >
      {collapsed ? "Show addresses" : "Hide addresses"}
    </button>
  ) : null;

  if (collapsed) {
    return (
      <section className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border border-line bg-sheet px-3.5 py-1.5" aria-label="This morning">
        <p className="min-w-0 text-[12.5px] text-ink">
          <span className="font-medium">This morning</span>
          <span className="text-ink-muted"> · {brief.headline}</span>
        </p>
        <div className="flex items-center gap-1.5">
          <StatusLabel tone="muted">{when}</StatusLabel>
          {toggle}
        </div>
      </section>
    );
  }

  return (
    <section className="mt-3 border border-line bg-sheet px-3.5 py-3" aria-label="This morning">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-[13px] font-medium text-ink">This morning</div>
          <p className="mt-0.5 text-[12px] text-ink-muted">{brief.headline}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusLabel tone="muted">{when}</StatusLabel>
          <StatusLabel tone="muted">{brief.inboxLabel}</StatusLabel>
          {toggle}
        </div>
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-1.5">
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
      <p className="mt-2 text-[11.5px] text-ink-muted">{brief.inboxDetail}</p>
    </section>
  );
}

export function MorningEmpty({ brief }: { brief: MorningBriefModel }) {
  const clearWin =
    brief.lastRunAt != null &&
    brief.needsYou === 0 &&
    brief.held === 0 &&
    brief.licensee === 0 &&
    !brief.headline.startsWith("Recheck missed");

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      {clearWin ? (
        <>
          <p className="max-w-[28rem] text-[17px] font-medium text-ink">Nothing needs you</p>
          <p className="mt-1.5 max-w-[28rem] text-[13px] text-ink-muted">{brief.headline}</p>
        </>
      ) : (
        <p className="max-w-[28rem] text-[15px] text-ink">{brief.headline}</p>
      )}
      {brief.lastRunAt == null && brief.addresses.length > 0 ? (
        <ul className="morning-empty-addresses mt-3 max-w-[28rem] space-y-1 text-[13px] text-ink-muted">
          {brief.addresses.map((row) => (
            <li key={row.propertyId}>{row.address}</li>
          ))}
        </ul>
      ) : null}
      <p className="mt-3 max-w-[28rem] text-[12.5px] text-ink-muted">{brief.inboxLabel}. {brief.inboxDetail}</p>
    </div>
  );
}
