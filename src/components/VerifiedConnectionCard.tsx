import type { ReactNode } from "react";
import { AlertCircle, CheckCircle2, Loader2, PauseCircle } from "lucide-react";

import { cn } from "@/lib/cn";

export type VerifiedConnectionState = "ready" | "attention" | "off" | "checking";

export function VerifiedConnectionCard({
  icon,
  title,
  description,
  meta,
  state,
  status,
  action,
  details,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  meta?: string;
  state: VerifiedConnectionState;
  status: string;
  action?: {
    label: string;
    onClick: () => void;
    disabled?: boolean;
    expanded?: boolean;
    controls?: string;
  };
  details?: ReactNode;
}) {
  const StatusIcon =
    state === "ready" ? CheckCircle2 : state === "attention" ? AlertCircle : state === "checking" ? Loader2 : PauseCircle;
  return (
    <article
      aria-busy={state === "checking" || undefined}
      className={cn(
        "border bg-sheet",
        state === "attention" ? "border-hold/45" : "border-line",
      )}
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <div className="flex size-10 shrink-0 items-center justify-center rounded border border-line bg-paper text-agency">
          {icon}
        </div>
        <div className="min-w-[14rem] flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h3 className="text-[14px] font-semibold text-ink">{title}</h3>
            <span
              role="status"
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
                state === "ready"
                  ? "border-agency/30 bg-selected text-agency"
                  : state === "attention"
                    ? "border-hold/35 bg-hold/10 text-hold"
                    : "border-line bg-paper text-ink-muted",
              )}
            >
              <StatusIcon size={12} className={state === "checking" ? "animate-spin" : undefined} />
              {status}
            </span>
          </div>
          <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-muted">{description}</p>
          {meta ? <p className="mt-1 text-[11.5px] text-ink-muted">{meta}</p> : null}
        </div>
        {action ? (
          <button
            type="button"
            onClick={action.onClick}
            disabled={action.disabled}
            aria-expanded={action.expanded}
            aria-controls={action.controls}
            className="pm-control pm-tactile rounded border border-line bg-sheet px-3 text-[12.5px] font-semibold text-ink hover:border-agency/60 hover:bg-selected/45 disabled:opacity-45"
          >
            {action.label}
          </button>
        ) : null}
      </div>
      {details ? <div className="border-t border-line px-4 py-3.5">{details}</div> : null}
    </article>
  );
}
