import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Card } from "../SettingsPrimitives";

/** Share of the limit as 0–100. A missing, zero or negative limit reads as 0, never full. */
export function meterPercent(used: number, limit: number) {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return 0;
  return Math.min(100, Math.max(0, (used / limit) * 100));
}

export type Meter = { used: number; limit: number; /** Spoken value, e.g. "A$120 of A$400". */ valueText: string };

export function MetricCard({ label, value, hint, delta, meter, className }: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  delta?: { text: string; tone?: "good" | "bad" | "neutral" };
  meter?: Meter;
  className?: string;
}) {
  const percent = meter ? meterPercent(meter.used, meter.limit) : 0;
  const over = meter ? meter.limit > 0 && meter.used > meter.limit : false;
  return (
    <Card className={className}>
      <div className="text-[13px] text-ink-secondary">{label}</div>
      <div className="mt-1 flex items-baseline gap-2">
        <span className="text-[22px] font-medium tabular-nums text-ink">{value}</span>
        {delta && <span className={cn("text-[13px] tabular-nums", delta.tone === "good" ? "text-agency" : delta.tone === "bad" ? "text-danger" : "text-ink-muted")}>{delta.text}</span>}
      </div>
      {meter && (
        <div
          role="meter"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
          aria-valuetext={meter.valueText}
          className="mt-3 h-1.5 overflow-hidden rounded-full bg-inset"
        >
          <div
            className={cn("h-full origin-left rounded-full transition-transform duration-300 motion-reduce:transition-none", over ? "bg-danger" : percent >= 80 ? "bg-hold" : "bg-agency")}
            style={{ transform: `scaleX(${percent / 100})` }}
          />
        </div>
      )}
      {hint && <div className="mt-2 text-[13px] leading-relaxed text-ink-muted">{hint}</div>}
    </Card>
  );
}
