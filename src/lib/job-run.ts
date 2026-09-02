import type { JobRun, JobRunMode, JobRunStatus } from "./desk";
import type { LoopRunStatus } from "./routines";
import { relativeAgo } from "./au";

export type LoopRunChipTone = "agency" | "hold" | "danger" | "muted";

export function loopRunStatusLabel(status: LoopRunStatus): { label: string; tone: LoopRunChipTone } {
  switch (status) {
    case "queued":
      return { label: "Queued", tone: "agency" };
    case "running":
      return { label: "Running", tone: "agency" };
    case "completed":
      return { label: "Finished", tone: "muted" };
    case "partial":
      return { label: "Partly done", tone: "hold" };
    case "failed":
      return { label: "Failed", tone: "danger" };
    case "missed":
      return { label: "Missed", tone: "danger" };
    case "interrupted":
      return { label: "Interrupted", tone: "danger" };
  }
}

export function isAttendedMode(mode: string): boolean {
  return mode === "attended";
}

export function jobRunModeLabel(mode: JobRunMode | string): string {
  if (mode === "shadow") return "Shadow rehearsal";
  if (isAttendedMode(mode)) return "Beside you";
  return "Prepared by Bud";
}

export function jobRunStatusChip(status: JobRunStatus | string): { label: string; className: string } {
  switch (status) {
    case "queued":
      return { label: "Queued", className: "bg-raised text-ink-muted" };
    case "running":
      return { label: "Running", className: "bg-accent/10 text-accent" };
    case "awaiting-approval":
      return { label: "Needs you", className: "bg-hold/10 text-hold" };
    case "completed":
      return { label: "Finished", className: "bg-agency/10 text-agency" };
    case "partial":
      return { label: "Partly done", className: "bg-hold/10 text-hold" };
    case "failed":
      return { label: "Failed", className: "bg-danger/10 text-danger" };
    case "interrupted":
      return { label: "Interrupted", className: "bg-danger/10 text-danger" };
    case "cancelled":
      return { label: "Cancelled", className: "bg-raised text-ink-muted" };
    default:
      return { label: "Unknown", className: "bg-hold/10 text-hold" };
  }
}

export function attendedRunLabel(run: {
  mode: string;
  status: string;
  spec?: { allowedOrigins?: readonly string[] };
}): { label: string; tone: LoopRunChipTone } | null {
  if (!isAttendedMode(run.mode)) return null;
  if (run.status === "queued") return { label: "Ready beside you", tone: "hold" };
  if (run.status === "missed") return { label: "Not started — waited a day", tone: "hold" };
  if (run.status === "running") return { label: "Running beside you", tone: "agency" };
  if (run.status === "completed") {
    const site = run.spec?.allowedOrigins?.filter(Boolean).join(", ") || "the site";
    return { label: `Done · read back from ${site}`, tone: "agency" };
  }
  if (run.status === "partial" || run.status === "unknown") {
    return { label: "Unknown — check the site yourself", tone: "hold" };
  }
  if (run.status === "failed") return { label: "Stopped", tone: "danger" };
  // The person pressed Stop (or the turn stalled): not a failure, but the
  // site was left wherever Bud was — say so rather than showing nothing.
  if (run.status === "interrupted") return { label: "Stopped by you — check the site yourself", tone: "hold" };
  return null;
}

export function attendedHeaderLabel(jobTitle: string): string {
  return `Running ${jobTitle} beside you`;
}

type AttendedRunRef = Pick<JobRun, "id" | "jobId" | "startedAt" | "createdAt"> & {
  mode: string;
  status: string;
};

export function latestAttendedFor<T extends AttendedRunRef>(runs: ReadonlyArray<T>, jobId: string): T | undefined {
  let best: T | undefined;
  for (const run of runs) {
    if (!isAttendedMode(run.mode) || run.jobId !== jobId) continue;
    const at = run.startedAt ?? run.createdAt;
    if (!best || at >= (best.startedAt ?? best.createdAt)) best = run;
  }
  return best;
}

export function runningAttended<T extends AttendedRunRef>(runs: ReadonlyArray<T>, jobId?: string): T | undefined {
  return runs.find(
    (run) => isAttendedMode(run.mode) && run.status === "running" && (jobId == null || run.jobId === jobId),
  );
}

export function queuedAttended<T extends AttendedRunRef>(runs: ReadonlyArray<T>, jobId?: string): T | undefined {
  return runs.find(
    (run) => isAttendedMode(run.mode) && run.status === "queued" && (jobId == null || run.jobId === jobId),
  );
}

export function jobActionLabel(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  if (!text) return "action";
  const token = text
    .split(/[\s·:,]+/)
    .find((part) => part.length > 0)
    ?.toLowerCase() ?? "";
  const haystack = `${token} ${text}`.toLowerCase();
  if (/(^|[^a-z])(open|navigate|goto)([^a-z]|$)/.test(haystack)) return "open";
  if (/(^|[^a-z])(read|extract|observe|screenshot)([^a-z]|$)/.test(haystack)) return "read";
  if (/(^|[^a-z])(fill|type|prefill|input)([^a-z]|$)/.test(haystack)) return "fill";
  if (/(^|[^a-z])click([^a-z]|$)/.test(haystack)) return "click";
  if (/^[a-z0-9_:-]+$/i.test(text)) return "action";
  return text;
}

export function attendedEvidenceLine(item: { note: string; kind?: string }): {
  label: string;
  denied: boolean;
  rule: boolean;
  submitApproved: boolean;
} {
  const kind = (item.kind ?? "").toLowerCase();
  const note = item.note;
  const denied = kind === "denied" || /\bdenied\b/i.test(note) || /\bfence\b/i.test(note);
  const rule = /allowed by rule/i.test(note);
  const submitApproved = !denied && /\bsubmit\b/i.test(note) && /\b(allowed|approved|pressed)\b/i.test(note);
  return {
    label: submitApproved ? "Submit pressed with your approval" : jobActionLabel(note),
    denied,
    rule,
    submitApproved,
  };
}

export function jobRunEvidenceCount(run: Pick<JobRun, "evidence">): string {
  const count = run.evidence.length;
  return count === 1 ? "1 receipt" : `${count} receipts`;
}

export function safeJobRunDetail(detail: string, max = 280): string {
  const clean = detail.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, Math.max(1, max - 1)).trimEnd()}…`;
}

export function jobRunSummaryLine(run: JobRun, now = Date.now()): string {
  return `${jobRunModeLabel(run.mode)} · ${jobRunEvidenceCount(run)} · v${run.jobRevision} · ${relativeAgo(
    run.finishedAt ?? run.startedAt ?? run.createdAt,
    now,
  )}`;
}
