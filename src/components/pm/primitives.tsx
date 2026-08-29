import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export type SurfaceState = "loading" | "empty" | "partial" | "success" | "failure" | "stale" | "recovery";
export type StatusTone = "agency" | "hold" | "danger" | "portal" | "muted";

const SOURCE_STATE_LABELS: Record<SurfaceState, string> = {
  loading: "Checking",
  empty: "No evidence yet",
  partial: "Needs matching",
  success: "Current",
  failure: "Unavailable",
  stale: "Out of date",
  recovery: "Recovery",
};

const EVIDENCE_STATE_LABELS: Record<SurfaceState, string> = {
  ...SOURCE_STATE_LABELS,
  empty: "No case selected",
  partial: "Needs attention",
};

export function SplitView({
  nav,
  queue,
  canvas,
  rail,
  queueOpen,
  navOpen,
  railOpen,
  className,
}: {
  nav?: ReactNode;
  queue?: ReactNode;
  canvas: ReactNode;
  rail?: ReactNode;
  queueOpen?: boolean;
  navOpen?: boolean;
  railOpen?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("pm-split relative", className)}
      data-queue-open={queueOpen ? "true" : undefined}
      data-nav-open={navOpen ? "true" : undefined}
      data-rail-open={railOpen ? "true" : undefined}
    >
      {nav ? <div className="pm-split-nav flex flex-col">{nav}</div> : null}
      {queue ? <div className="pm-split-queue flex flex-col">{queue}</div> : null}
      <div className="pm-split-canvas flex flex-col">{canvas}</div>
      {rail ? <div className="pm-split-rail flex flex-col">{rail}</div> : null}
    </div>
  );
}

export function StatusLabel({ tone, children, className }: { tone: StatusTone; children: ReactNode; className?: string }) {
  const cls =
    tone === "agency"
      ? "border-agency/25 bg-agency/10 text-agency"
      : tone === "hold"
        ? "border-hold/25 bg-hold/10 text-hold"
        : tone === "danger"
          ? "border-danger/25 bg-danger/10 text-danger"
          : tone === "portal"
            ? "border-portal/25 bg-portal/10 text-portal"
            : "border-line bg-sheet text-ink-muted";
  return (
    <span className={cn("inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[12px]", cls, className)}>
      {children}
    </span>
  );
}

export function SourceStamp({
  label,
  observedAt,
  authority,
  state = "success",
}: {
  label: string;
  observedAt?: number;
  authority?: string;
  state?: SurfaceState;
}) {
  const tone: StatusTone =
    state === "failure" || state === "recovery" ? "danger" : state === "stale" || state === "partial" ? "hold" : state === "success" ? "agency" : "muted";
  const stateLabel = SOURCE_STATE_LABELS[state];
  return (
    <div className="rounded-lg border border-line bg-sheet px-3 py-3 text-[12px]">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="text-[13px] font-medium text-ink">{label}</span>
        <StatusLabel tone={tone}>{stateLabel}</StatusLabel>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-muted">
        {authority ? <span>{authority}</span> : null}
        {observedAt != null ? (
          <>
            {authority ? <span aria-hidden="true">·</span> : null}
            <span className="tabular-nums">Observed {new Date(observedAt).toLocaleString("en-AU")}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}

export function RecoveryNotice({ children }: { children: ReactNode }) {
  return (
    <div role="status" className="border border-danger/30 bg-danger/10 px-3 py-2.5 text-[13px] text-danger">
      {children}
    </div>
  );
}

export function CaseQueueRow({
  title,
  meta,
  action,
  selected,
  shareAddress,
  onSelect,
}: {
  title: string;
  meta: string;
  action: string;
  selected?: boolean;
  shareAddress?: boolean;
  onSelect?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      role="option"
      aria-selected={selected ? true : false}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "group flex w-full flex-col items-start gap-1.5 border-b border-l-2 border-b-line px-3.5 py-3.5 text-left transition-colors",
        selected ? "border-l-agency bg-selected/80" : "border-l-transparent bg-transparent hover:bg-raised/60",
      )}
    >
      <span className={cn("text-[14px] font-semibold leading-snug text-ink", shareAddress && "desk-shared-address inline-block")}>{title}</span>
      <span className="line-clamp-2 text-[12px] leading-relaxed text-ink-muted">{meta}</span>
      <span className="inline-flex items-center gap-1 text-[12px] font-medium text-agency">
        {action}
        <span aria-hidden="true" className="transition-transform group-hover:translate-x-0.5">
          →
        </span>
      </span>
    </button>
  );
}

export function CaseHeader({ title, status, shareAddress, children }: { title: string; status?: ReactNode; shareAddress?: boolean; children?: ReactNode }) {
  return (
    <header className="border-b border-line px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className={cn("pm-case-title text-ink", shareAddress && "desk-shared-address")}>{title}</h2>
        {status}
      </div>
      {children ? <div className="mt-2 text-[14px] text-ink-muted">{children}</div> : null}
    </header>
  );
}

export function FactSummary({ label, value, observedAt }: { label: string; value: string; observedAt?: number }) {
  return (
    <div className="flex flex-col gap-1 py-2">
      <span className="pm-label text-ink-muted">{label}</span>
      <span className="tabular-nums text-[15px] text-ink">{value}</span>
      {observedAt != null ? (
        <span className="tabular-nums text-[12px] text-ink-muted">{new Date(observedAt).toLocaleString()}</span>
      ) : null}
    </div>
  );
}

export function SafeguardStatus({ label, active, detail }: { label: string; active: boolean; detail?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-line py-2 last:border-b-0">
      <div>
        <div className="text-[14px] text-ink">{label}</div>
        {detail ? <div className="text-[12px] text-ink-muted">{detail}</div> : null}
      </div>
      <StatusLabel tone={active ? "hold" : "muted"}>{active ? "In force" : "None"}</StatusLabel>
    </div>
  );
}

export function EvidenceRail({ title = "Evidence", children, state }: { title?: string; children?: ReactNode; state?: SurfaceState }) {
  return (
    <aside className="flex h-full min-h-0 flex-col">
      <div className="border-b border-line px-4 py-3">
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        {state && state !== "success" ? (
          <div className="mt-1 text-[12px] text-ink-muted">{EVIDENCE_STATE_LABELS[state]}</div>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-[14px] text-ink">{children}</div>
    </aside>
  );
}

export function DecisionBar({
  onAllow,
  onEdit,
  onDeny,
  onCopy,
  busy,
  note = "Allow applies to this exact version once. A future exact match may be quicker to review, but it still needs Allow. Nothing is sent.",
}: {
  onAllow?: () => void;
  onEdit?: () => void;
  onDeny?: () => void;
  onCopy?: () => void;
  busy?: boolean;
  note?: ReactNode;
}) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-t border-line bg-sheet px-4 py-3"
      aria-label="Decision actions"
    >
      <div className="flex flex-wrap items-center gap-2">
        {onAllow ? (
          <button type="button" disabled={busy} onClick={onAllow} className="pm-decision rounded bg-agency px-4 text-[14px] font-medium text-white hover:bg-agency-hover disabled:opacity-40">
            Allow wording once
          </button>
        ) : null}
        {onEdit ? (
          <button type="button" disabled={busy} onClick={onEdit} className="pm-control rounded border border-line bg-sheet px-3 text-[14px] text-ink hover:bg-raised disabled:opacity-40">
            Edit
          </button>
        ) : null}
        {onDeny ? (
          <button type="button" disabled={busy} onClick={onDeny} className="pm-control rounded border border-line bg-sheet px-3 text-[14px] text-ink hover:bg-raised disabled:opacity-40">
            Deny
          </button>
        ) : null}
        {onCopy ? (
          <button type="button" disabled={busy} onClick={onCopy} className="pm-control rounded border border-line bg-sheet px-3 text-[14px] text-ink hover:bg-raised disabled:opacity-40">
            Copy
          </button>
        ) : null}
      </div>
      {note ? <p className="max-w-[27rem] text-[12px] leading-relaxed text-ink-muted">{note}</p> : null}
    </div>
  );
}

export function HandoffPanel({
  caseLabel,
  origin,
  expiry,
  submitter = "You submit in the PMS",
  children,
}: {
  caseLabel: string;
  origin: string;
  expiry?: string;
  submitter?: string;
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-2 border-t border-line px-4 py-3">
      <h3 className="text-[15px] font-semibold text-ink">Bounded handoff</h3>
      <p className="text-[13px] text-ink-muted">
        {caseLabel} · {origin}
        {expiry ? ` · ends ${expiry}` : ""} · {submitter}
      </p>
      {children}
    </section>
  );
}

export function AdvancedDiagnostics({ children }: { children: ReactNode }) {
  return (
    <details className="border border-line bg-sheet">
      <summary className="cursor-pointer px-4 py-3 text-[14px] font-medium text-ink">Advanced diagnostics</summary>
      <div className="border-t border-line px-4 py-3 font-mono text-[12px] text-ink-muted">{children}</div>
    </details>
  );
}
