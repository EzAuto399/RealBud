import { RefreshCw, X } from "lucide-react";

import type { SessionHealCopy } from "@/lib/session-heal";
import { cn } from "@/lib/cn";

export function SessionHealCard({
  copy,
  onRetry,
  onDismiss,
  retrying = false,
}: {
  copy: SessionHealCopy;
  onRetry?: () => void;
  onDismiss?: () => void;
  retrying?: boolean;
}) {
  return (
    <div
      role="status"
      className={cn(
        "animate-pop-in mx-auto mb-2 flex w-full max-w-[900px] items-start gap-3 rounded-lg border border-hold/40 bg-hold/10 px-3 py-2.5",
      )}
    >
      <RefreshCw size={15} className={cn("mt-0.5 shrink-0 text-hold", retrying && "animate-spin")} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-semibold text-ink">{copy.title}</p>
        <p className="mt-0.5 text-[12px] leading-relaxed text-ink-muted">{copy.detail}</p>
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="pm-control pm-tactile shrink-0 rounded border border-line bg-sheet px-2.5 py-1.5 text-[12px] font-semibold text-ink hover:border-agency/55 disabled:opacity-50"
        >
          Retry
        </button>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss connection notice"
          className="shrink-0 rounded p-0.5 text-ink-muted hover:text-ink"
        >
          <X size={13} />
        </button>
      ) : null}
    </div>
  );
}
