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
    case "awaiting-approval":
      return { label: "Needs you", tone: "hold" };
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
  if (mode === "shadow") return "Rehearsal";
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
  // Older attended receipts were marked completed from assistant prose alone.
  // Preserve the historical record, but never turn that flag into read proof.
  if (run.status === "completed" || run.status === "partial" || run.status === "unknown") {
    return { label: "Result unverified — check the site", tone: "hold" };
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

type RunAtRef = Pick<JobRun, "id" | "jobId" | "startedAt" | "createdAt">;

function runAt(run: RunAtRef): number {
  return run.startedAt ?? run.createdAt;
}

export function runsForJob<T extends RunAtRef>(runs: ReadonlyArray<T>, jobId: string): T[] {
  return runs.filter((run) => run.jobId === jobId);
}

export function latestRunForJob<T extends RunAtRef>(runs: ReadonlyArray<T>, jobId: string): T | undefined {
  let best: T | undefined;
  for (const run of runs) {
    if (run.jobId !== jobId) continue;
    const at = runAt(run);
    if (!best || at >= runAt(best)) best = run;
  }
  return best;
}

export function activeAttendedRun<T extends AttendedRunRef>(runs: ReadonlyArray<T>): T | undefined {
  let best: T | undefined;
  for (const run of runs) {
    if (!isAttendedMode(run.mode) || run.status !== "running") continue;
    const at = runAt(run);
    if (!best || at >= runAt(best)) best = run;
  }
  return best;
}

export function queuedAttendedRuns<T extends AttendedRunRef>(runs: ReadonlyArray<T>): T[] {
  return runs.filter((run) => isAttendedMode(run.mode) && run.status === "queued");
}

export function runStatusSuffix(connected: boolean): string {
  return connected ? "" : " (last seen)";
}

export function latestAttendedFor<T extends AttendedRunRef>(runs: ReadonlyArray<T>, jobId: string): T | undefined {
  let best: T | undefined;
  for (const run of runs) {
    if (!isAttendedMode(run.mode) || run.jobId !== jobId) continue;
    const at = runAt(run);
    if (!best || at >= runAt(best)) best = run;
  }
  return best;
}

export function runningAttended<T extends AttendedRunRef>(runs: ReadonlyArray<T>, jobId?: string): T | undefined {
  if (jobId == null) return activeAttendedRun(runs);
  return runsForJob(runs, jobId).find((run) => isAttendedMode(run.mode) && run.status === "running");
}

export function queuedAttended<T extends AttendedRunRef>(runs: ReadonlyArray<T>, jobId?: string): T | undefined {
  const queued = queuedAttendedRuns(runs);
  if (jobId == null) return queued[0];
  return queued.find((run) => run.jobId === jobId);
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
    // Denials keep the full note so the attempted action and next step stay visible.
    label: submitApproved ? "Submit pressed with your approval" : denied ? note : jobActionLabel(note),
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

/** Only a settled preparation produces reusable work. A rehearsal's narrated
 * output must not be presented or copied as a live prepared result. */
export function preparedJobText(run: Pick<JobRun, "mode" | "status" | "evidence">): string {
  if (run.mode !== "prepare" || !["completed", "awaiting-approval", "partial"].includes(run.status)) return "";
  return run.evidence.filter((item) => item.kind === "output").map((item) => item.note.trim()).filter(Boolean).join("\n\n");
}

export function jobRunSummaryLine(run: JobRun, now = Date.now()): string {
  return `${jobRunModeLabel(run.mode)} · ${jobRunEvidenceCount(run)} · v${run.jobRevision} · ${relativeAgo(
    run.finishedAt ?? run.startedAt ?? run.createdAt,
    now,
  )}`;
}
