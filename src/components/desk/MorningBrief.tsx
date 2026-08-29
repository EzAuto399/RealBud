import { Loader2 } from "lucide-react";

import { fmtDateTime } from "@/lib/au";
import { shortStreet, type MorningBrief as MorningBriefModel } from "@/lib/morning-brief";
import { StatusLabel } from "../pm";

export function MorningBrief({
  brief,
  timezone,
  interactive = false,
  onOpenAddress,
}: {
  brief: MorningBriefModel;
  timezone?: string;
  interactive?: boolean;
  onOpenAddress?: (propertyId: string) => void;
}) {
  const when = brief.lastRunAt
    ? `Last check ${fmtDateTime(brief.lastRunAt, timezone)}`
    : "Recheck has not run";

  return (
    <section className="mt-3 border border-line bg-sheet px-3.5 py-3" aria-label="This morning">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-[13px] font-medium text-ink">This morning</div>
          <p className="mt-0.5 text-[12px] text-ink-muted">{brief.headline}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusLabel tone="muted">{when}</StatusLabel>
          <StatusLabel tone="hold">{brief.inboxLabel}</StatusLabel>
        </div>
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-1.5">
        {brief.addresses.map((row) => {
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
        {brief.addresses.length === 0 ? <li className="text-[12px] text-ink-muted">No addresses on the book.</li> : null}
      </ul>
      <p className="mt-2 text-[11.5px] text-ink-muted">{brief.inboxDetail}</p>
    </section>
  );
}

export function MorningEmpty({
  brief,
  onRecheck,
  busy,
}: {
  brief: MorningBriefModel;
  onRecheck?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center">
      <p className="max-w-[28rem] text-[15px] text-ink">{brief.headline}</p>
      {brief.lastRunAt == null && brief.addresses.length > 0 ? (
        <ul className="mt-3 max-w-[28rem] space-y-1 text-[13px] text-ink-muted">
          {brief.addresses.map((row) => (
            <li key={row.propertyId}>{row.address}</li>
          ))}
        </ul>
      ) : null}
      {onRecheck && brief.lastRunAt == null ? (
        <button
          type="button"
          onClick={onRecheck}
          disabled={busy}
          className="pm-control mt-4 flex items-center gap-2 rounded bg-agency px-3.5 text-[14px] font-medium text-white hover:bg-agency-hover disabled:opacity-40"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : null}
          Recheck this morning
        </button>
      ) : null}
      <p className="mt-3 max-w-[28rem] text-[12.5px] text-hold">{brief.inboxLabel}. {brief.inboxDetail}</p>
    </div>
  );
}
