import { useEffect, useId, useRef } from "react";
import { CalendarDays, X } from "lucide-react";
import { useDialogKeyboard } from "@/lib/use-dialog-keyboard";

/**
 * Composer-anchored Schedule entry from Ask.
 * Never embeds the full Schedule map here — that lives on the Schedule tab.
 */
export function AskScheduleCard({
  open,
  onClose,
  onOpenSchedule,
  chatHint,
}: {
  open: boolean;
  onClose: () => void;
  onOpenSchedule: (intent: "map" | "job-from-chat") => void;
  /** Short snippet when this ask can become a saved job. */
  chatHint?: string | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogKeyboard(ref, onClose, false, open);
  useEffect(() => {
    if (!open) return;
    ref.current?.focus();
  }, [open]);
  if (!open) return null;

  const hint = chatHint?.trim();

  return (
    <div
      className="ask-phone-continue"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="ask-phone-continue-card"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-2.5">
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-agency/10 text-agency" aria-hidden>
              <CalendarDays size={16} />
            </span>
            <div className="min-w-0">
              <h2 id={titleId} className="text-[15px] font-semibold text-ink">
                Schedule work
              </h2>
              <p className="mt-0.5 text-[12px] text-ink-muted">
                Jobs run on the RealBud clock. Review timing and results on Schedule — not inside this chat.
              </p>
            </div>
          </div>
          <button type="button" aria-label="Close" className="pm-control flex size-9 shrink-0 items-center justify-center rounded" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {hint ? (
          <div className="mt-3 rounded-lg border border-line bg-raised/60 px-3 py-2.5">
            <p className="text-[11px] font-medium uppercase tracking-wide text-ink-muted">From this ask</p>
            <p className="mt-1 line-clamp-3 text-[13px] leading-5 text-ink">{hint}</p>
          </div>
        ) : null}

        <ul className="mt-3 space-y-2 text-[13px] leading-5 text-ink">
          <li>
            <span className="font-medium">Open Schedule</span>
            <span className="text-ink-muted"> — this week’s jobs, timing, and results.</span>
          </li>
          <li>
            <span className="font-medium">Teach Bud a job</span>
            <span className="text-ink-muted">
              {hint ? " — turn this ask into a saved plan on Schedule." : " — describe work once, then set when it runs."}
            </span>
          </li>
        </ul>

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
          <button type="button" className="pm-control min-h-10 px-3 text-[13px] text-ink-secondary" onClick={onClose}>
            Not now
          </button>
          <button
            type="button"
            className="pm-control min-h-10 px-3 text-[13px] text-agency"
            onClick={() => {
              onClose();
              onOpenSchedule("job-from-chat");
            }}
          >
            Teach Bud a job
          </button>
          <button
            type="button"
            className="ask-button min-h-10 px-4 text-[13px]"
            onClick={() => {
              onClose();
              onOpenSchedule("map");
            }}
          >
            Open Schedule
          </button>
        </div>
      </div>
    </div>
  );
}
