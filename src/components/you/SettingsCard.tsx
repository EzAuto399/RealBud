import type { ReactNode } from "react";
import { StatusLabel, type StatusTone } from "../pm";
import { Card } from "../SettingsPrimitives";

/** Compact settings card: title, one status pill (text, never colour alone), the
 * actions, and the explanatory copy folded under Details. */
export function SettingsCard({ title, status, details, children }: {
  title: string;
  status?: { tone: StatusTone; label: string } | null;
  details?: ReactNode;
  children?: ReactNode;
}) {
  return <Card>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-[15px] font-medium text-ink">{title}</h3>
      {status ? <StatusLabel tone={status.tone}>{status.label}</StatusLabel> : null}
    </div>
    {children ? <div className="mt-3">{children}</div> : null}
    {details ? <details className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
      <summary className="pm-control flex cursor-pointer items-center rounded focus-visible:outline-2 focus-visible:outline-agency">Details</summary>
      <div className="space-y-2 pb-1">{details}</div>
    </details> : null}
  </Card>;
}
