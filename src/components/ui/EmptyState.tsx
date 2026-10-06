import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export function EmptyState({ title, body, icon, action, className }: { title: string; body?: ReactNode; icon?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center px-6 py-10 text-center", className)}>
      {icon && <div className="mb-3 flex size-10 items-center justify-center rounded-full bg-inset text-ink-muted" aria-hidden>{icon}</div>}
      <h3 className="text-[15px] font-medium text-ink">{title}</h3>
      {body && <div className="mt-1 max-w-sm text-[13px] leading-relaxed text-ink-secondary">{body}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Placeholder lines while something loads. `label` is what a screen reader hears. */
export function Skeleton({ lines = 3, label = "Loading", className }: { lines?: number; label?: string; className?: string }) {
  const count = Math.max(1, lines);
  return (
    <div role="status" aria-label={label} className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} aria-hidden className={cn("h-3 animate-pulse rounded bg-raised motion-reduce:animate-none", i === count - 1 && count > 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}
