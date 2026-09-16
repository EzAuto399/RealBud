// Durable execution receipts for jobs taught to Bud. RealBud owns this
// ledger, the clock, idempotency, and approval state; the worker only returns
// a bounded result for one already-authorized attempt.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  JOB_CAPABILITIES,
  type JobCapability,
  type JobRun,
  type JobRunEvidence,
  type JobRunMode,
  type JobRunStatus,
  type JobRunTrigger,
  type JobRunSpecSnapshot,
  type Recipe,
} from "../shared/contracts.ts";
import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { oplog } from "./oplog.ts";
import { redactSecretsInText } from "./redact.ts";
import { JOB_OUTPUT_MAX_CHARS, JOB_OUTPUT_TOTAL_CHARS, JOB_OUTPUT_TOO_LARGE } from "../shared/job-output.ts";

export type {
  JobRun,
  JobRunEvidence,
  JobRunMode,
  JobRunStatus,
  JobRunTrigger,
  JobRunSpecSnapshot,
};

const MAX_RUNS = 1_000;
const MAX_DETAIL = 2_000;
const MAX_NOTE = 500;
const MAX_EVIDENCE = 50;
const MAX_APPROVALS = 20;
// A held approval is a finished receipt, not an executing attempt. Keeping it
// out of this set prevents one safely-held result from deadlocking every later
// occurrence of a recurring job.
const IN_FLIGHT: ReadonlySet<JobRunStatus> = new Set(["queued", "running"]);
const SETTLED: ReadonlySet<JobRunStatus> = new Set([
  "awaiting-approval",
  "completed",
  "partial",
  "failed",
  "interrupted",
  "cancelled",
  "missed",
]);

export const QUEUED_ATTENDED_MAX_AGE_MS = 24 * 60 * 60_000;
export const QUEUED_ATTENDED_MISSED =
  "Not started — the run waited a day for someone at the screen.";
export const READY_BESIDE_YOU =
  "Ready to run beside you — press Start when you are at the screen.";

interface JobRunsFile {
  version: 1;
  runs: JobRun[];
}

export interface JobRunStoreOptions {
  file?: string;
  now?: () => number;
  emit?: (payload: { kind: "job.run"; run: JobRun }) => void;
}

export interface JobRunRecovery {
  active: boolean;
  detail: string | null;
}

const HISTORY_RECOVERY = "Job history needs recovery. The original history has been preserved and new job runs are paused. Restore a known-good history file, then restart RealBud.";
const WRITE_FAILED = "RealBud could not save the job receipt. Check available disk space and file access before trying again.";
const WRITE_UNCERTAIN = "The job receipt changed on disk but its durable save could not be confirmed. Job runs are paused; check disk space and restart RealBud before continuing.";

export interface EnqueueJobRunInput {
  mode: JobRunMode;
  trigger: JobRunTrigger;
  idempotencyKey: string;
  scheduledFor?: number;
  loopRunId?: string;
  threadId?: string;
  detail?: string;
}

export interface SettleJobRunInput {
  status: Exclude<JobRunStatus, "queued" | "running">;
  detail: string;
  evidence?: JobRunEvidence[];
  approvalRequests?: string[];
  legacySessionId?: string;
}

function cloneRun(run: JobRun): JobRun {
  return {
    ...run,
    spec: {
      ...run.spec,
      steps: [...run.spec.steps],
      allowedOrigins: [...run.spec.allowedOrigins],
      capabilities: [...run.spec.capabilities],
      limits: { ...run.spec.limits },
    },
    evidence: run.evidence.map((item) => ({ ...item })),
    approvalRequests: [...run.approvalRequests],
  };
}

function snapshot(recipe: Recipe): JobRunSpecSnapshot {
  return {
    title: recipe.title,
    description: recipe.description,
    steps: [...recipe.steps],
    allowedOrigins: [...recipe.allowedOrigins],
    evidence: recipe.evidence,
    capabilities: [...recipe.capabilities],
    limits: { ...recipe.limits },
  };
}

function isStatus(value: unknown): value is JobRunStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "awaiting-approval" ||
    value === "completed" ||
    value === "partial" ||
    value === "failed" ||
    value === "interrupted" ||
    value === "cancelled" ||
    value === "missed"
  );
}

function isMode(value: unknown): value is JobRunMode {
  return value === "shadow" || value === "prepare" || value === "attended";
}

function isTrigger(value: unknown): value is JobRunTrigger {
  return value === "manual" || value === "schedule";
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function cleanText(value: unknown, max: number): string {
  return redactSecretsInText(typeof value === "string" ? value : "").trim().slice(0, max);
}

function cleanEvidence(items: ReadonlyArray<JobRunEvidence> | undefined, now: number, requireComplete = false): JobRunEvidence[] {
  if (!items) return [];
  const out: JobRunEvidence[] = [];
  let outputChars = 0;
  for (const item of items.slice(0, MAX_EVIDENCE)) {
    if (!item || !["observation", "output", "approval", "action", "denied", "asked", "note"].includes(item.kind)) continue;
    const limit = item.kind === "output" ? Math.min(JOB_OUTPUT_MAX_CHARS, JOB_OUTPUT_TOTAL_CHARS - outputChars) : MAX_NOTE;
    const cleaned = redactSecretsInText(typeof item.note === "string" ? item.note : "").trim();
    if (requireComplete && item.kind === "output" && cleaned.length > limit) throw new Error(JOB_OUTPUT_TOO_LARGE);
    const note = cleaned.length > limit && item.kind === "output"
      ? "[Saved output exceeds the supported size. Review the original receipt before using it.]"
      : cleaned.slice(0, limit);
    if (!note) continue;
    if (item.kind === "output") outputChars += note.length;
    out.push({ at: finite(item.at) ? item.at : now, note, kind: item.kind });
  }
  return out;
}

function cleanApprovals(items: ReadonlyArray<string> | undefined): string[] {
  if (!items) return [];
  return items
    .slice(0, MAX_APPROVALS)
    .map((item) => cleanText(item, MAX_NOTE))
    .filter(Boolean);
}

function asSnapshot(value: unknown): JobRunSpecSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.title !== "string" || typeof row.description !== "string" || typeof row.evidence !== "string") return null;
  if (!Array.isArray(row.steps) || !row.steps.every((item) => typeof item === "string")) return null;
  if (!Array.isArray(row.allowedOrigins) || !row.allowedOrigins.every((item) => typeof item === "string")) return null;
  if (
    !Array.isArray(row.capabilities) ||
    row.capabilities.length < 1 ||
    row.capabilities.length > JOB_CAPABILITIES.length ||
    !row.capabilities.every(
      (item) => typeof item === "string" && (JOB_CAPABILITIES as readonly string[]).includes(item),
    )
  ) return null;
  if (!row.limits || typeof row.limits !== "object" || Array.isArray(row.limits)) return null;
  const limits = row.limits as Record<string, unknown>;
  if (
    !Number.isInteger(limits.maxRuntimeMinutes) ||
    Number(limits.maxRuntimeMinutes) < 1 ||
    Number(limits.maxRuntimeMinutes) > 5 ||
    !Number.isInteger(limits.maxTurns) ||
    Number(limits.maxTurns) < 1 ||
    Number(limits.maxTurns) > 12
  ) return null;
  return {
    title: row.title,
    description: row.description,
    steps: [...row.steps],
    allowedOrigins: [...row.allowedOrigins],
    evidence: row.evidence,
    capabilities: [...row.capabilities] as JobCapability[],
    limits: { maxRuntimeMinutes: Number(limits.maxRuntimeMinutes), maxTurns: Number(limits.maxTurns) },
  };
}

function asRun(value: unknown): JobRun | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const spec = asSnapshot(row.spec);
  if (!spec) return null;
  if (
    typeof row.id !== "string" ||
    typeof row.jobId !== "string" ||
    typeof row.jobTitle !== "string" ||
    !finite(row.jobRevision) ||
    !isMode(row.mode) ||
    !isStatus(row.status) ||
    !isTrigger(row.trigger) ||
    !finite(row.scheduledFor) ||
    typeof row.idempotencyKey !== "string" ||
    !finite(row.attempt) ||
    typeof row.detail !== "string" ||
    !finite(row.createdAt) ||
    !Array.isArray(row.evidence) ||
    !Array.isArray(row.approvalRequests)
  ) {
    return null;
  }
  const evidence = cleanEvidence(row.evidence as JobRunEvidence[], row.createdAt);
  const approvalRequests = cleanApprovals(row.approvalRequests.filter((item) => typeof item === "string") as string[]);
  return {
    id: row.id,
    jobId: row.jobId,
    jobTitle: row.jobTitle,
    jobRevision: row.jobRevision,
    mode: row.mode,
    status: row.status,
    trigger: row.trigger,
    scheduledFor: row.scheduledFor,
    ...(typeof row.loopRunId === "string" ? { loopRunId: row.loopRunId } : {}),
    idempotencyKey: row.idempotencyKey,
    attempt: row.attempt,
    spec,
    evidence,
    approvalRequests,
    detail: cleanText(row.detail, MAX_DETAIL),
    createdAt: row.createdAt,
    ...(finite(row.startedAt) ? { startedAt: row.startedAt } : {}),
    ...(finite(row.finishedAt) ? { finishedAt: row.finishedAt } : {}),
    ...(finite(row.seenAt) ? { seenAt: row.seenAt } : {}),
    ...(typeof row.legacySessionId === "string" ? { legacySessionId: row.legacySessionId } : {}),
    ...(typeof row.threadId === "string" && row.threadId ? { threadId: row.threadId } : {}),
  };
}

export class JobRunStore {
  private readonly file: string;
  private readonly now: () => number;
  private emit?: JobRunStoreOptions["emit"];
  private runs: JobRun[];
  private recoveryDetail: string | null = null;

  constructor(options: JobRunStoreOptions = {}) {
    this.file = options.file ?? join(DATA_DIR, "job-runs.json");
    this.now = options.now ?? Date.now;
    this.emit = options.emit;
    this.runs = this.load();
    if (this.recovery.active) return;
    const recovered = this.runs.map(cloneRun);
    const now = this.now();
    let changed = false;
    for (const run of recovered) {
      if (run.status === "queued" && run.mode === "attended" && run.createdAt <= now - QUEUED_ATTENDED_MAX_AGE_MS) {
        run.status = "missed";
        run.finishedAt = now;
        run.detail = QUEUED_ATTENDED_MISSED;
        changed = true;
      }
      if (run.status === "queued" && run.mode === "attended") continue;
      if (run.status !== "queued" && run.status !== "running") continue;
      run.status = "interrupted";
      run.finishedAt = now;
      run.detail = "Interrupted on startup — no action was resumed.";
      changed = true;
    }
    if (changed) {
      try {
        this.commit(recovered);
      } catch {
        // Keep the app available for recovery, but never start work from an
        // uncommitted restart transition.
        this.recoveryDetail ??= "RealBud could not save interrupted job history. Job runs are paused; check disk space and file access, then restart RealBud.";
      }
    }
  }

  get recovery(): JobRunRecovery {
    return { active: this.recoveryDetail !== null, detail: this.recoveryDetail };
  }

  list(jobId?: string): JobRun[] {
    this.assertWritable();
    return this.runs
      .filter((run) => !jobId || run.jobId === jobId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(cloneRun);
  }

  get(id: string): JobRun | undefined {
    this.assertWritable();
    const run = this.runs.find((item) => item.id === id);
    return run ? cloneRun(run) : undefined;
  }

  enqueue(recipe: Recipe, input: EnqueueJobRunInput): { run: JobRun; created: boolean } {
    this.assertWritable();
    const key = input.idempotencyKey.trim();
    if (!key || key.length > 300) {
      throw Object.assign(new Error("A bounded idempotency key is required."), { status: 400 });
    }
    const duplicate = this.runs.find((run) => run.idempotencyKey === key);
    if (duplicate) return { run: cloneRun(duplicate), created: false };
    const active = this.runs.find((run) => run.jobId === recipe.id && IN_FLIGHT.has(run.status));
    if (active) {
      throw Object.assign(new Error("This job already has work waiting or running."), {
        status: 409,
        runId: active.id,
      });
    }
    const now = this.now();
    const run: JobRun = {
      id: randomUUID(),
      jobId: recipe.id,
      jobTitle: recipe.title,
      jobRevision: recipe.revision,
      mode: input.mode,
      status: "queued",
      trigger: input.trigger,
      scheduledFor: input.scheduledFor ?? now,
      ...(input.loopRunId ? { loopRunId: input.loopRunId } : {}),
      ...(input.threadId ? { threadId: input.threadId } : {}),
      idempotencyKey: key,
      attempt: 1,
      spec: snapshot(recipe),
      evidence: [],
      approvalRequests: [],
      detail: cleanText(input.detail ?? "Queued by RealBud.", MAX_DETAIL) || "Queued by RealBud.",
      createdAt: now,
    };
    this.commit([...this.runs, run].slice(-MAX_RUNS));
    this.emitRun(run);
    return { run: cloneRun(run), created: true };
  }

  start(id: string, detail = "Bud is preparing the job.", extra?: { threadId?: string }): JobRun {
    const run = cloneRun(this.requireWritable(id));
    if (run.status !== "queued") {
      throw Object.assign(new Error("Only a queued job run can start."), { status: 409 });
    }
    run.status = "running";
    run.startedAt = this.now();
    run.detail = cleanText(detail, MAX_DETAIL) || "Bud is preparing the job.";
    if (extra?.threadId) run.threadId = extra.threadId;
    this.replace(run);
    this.emitRun(run);
    return cloneRun(run);
  }

  sweepQueuedAttended(maxAgeMs = QUEUED_ATTENDED_MAX_AGE_MS): JobRun[] {
    this.assertWritable();
    const cutoff = this.now() - maxAgeMs;
    const missed: JobRun[] = [];
    const next = this.runs.map(cloneRun);
    for (const run of next) {
      if (run.mode !== "attended" || run.status !== "queued" || run.createdAt > cutoff) continue;
      run.status = "missed";
      run.finishedAt = this.now();
      run.detail = QUEUED_ATTENDED_MISSED;
      missed.push(cloneRun(run));
    }
    if (missed.length) {
      this.commit(next);
      for (const run of missed) this.emitRun(run);
    }
    return missed;
  }

  appendEvidence(id: string, items: ReadonlyArray<JobRunEvidence>): JobRun {
    const run = cloneRun(this.requireWritable(id));
    if (run.status !== "running") {
      throw Object.assign(new Error("Only a running job can take evidence."), { status: 409 });
    }
    run.evidence = cleanEvidence([...run.evidence, ...items], this.now(), true);
    this.replace(run);
    this.emitRun(run);
    return cloneRun(run);
  }

  setEmit(emit: JobRunStoreOptions["emit"]): void {
    this.emit = emit;
  }

  settle(id: string, result: SettleJobRunInput): JobRun {
    const run = cloneRun(this.requireWritable(id));
    if (run.status !== "running") {
      throw Object.assign(new Error("Only a running job can settle."), { status: 409 });
    }
    if (!SETTLED.has(result.status)) {
      throw Object.assign(new Error("That is not a settled job-run state."), { status: 400 });
    }
    const now = this.now();
    // Validate before changing status: an oversized result must not leave a
    // half-settled in-memory run that the failure path cannot finish.
    const evidence = cleanEvidence(
      result.evidence !== undefined ? [...run.evidence, ...result.evidence] : run.evidence,
      now,
      true,
    );
    run.status = result.status;
    run.detail = cleanText(result.detail, MAX_DETAIL) || "Job run settled.";
    run.evidence = evidence;
    run.approvalRequests = cleanApprovals(result.approvalRequests);
    run.finishedAt = now;
    if (result.legacySessionId) run.legacySessionId = result.legacySessionId;
    this.replace(run);
    this.emitRun(run);
    oplog("routine", run.detail, {
      jobId: run.jobId,
      jobRunId: run.id,
      jobRevision: run.jobRevision,
      mode: run.mode,
      status: run.status,
      approvalCount: run.approvalRequests.length,
    });
    return cloneRun(run);
  }

  cancel(id: string): JobRun {
    const run = cloneRun(this.requireWritable(id));
    if (!IN_FLIGHT.has(run.status)) return cloneRun(run);
    run.status = "cancelled";
    run.finishedAt = this.now();
    run.detail = "Cancelled in RealBud. Nothing pending was resumed.";
    this.replace(run);
    this.emitRun(run);
    return cloneRun(run);
  }

  markSeen(id: string): JobRun {
    const run = cloneRun(this.requireWritable(id));
    if (!run.seenAt) {
      run.seenAt = this.now();
      this.replace(run);
      this.emitRun(run);
    }
    return cloneRun(run);
  }

  private assertWritable(): void {
    if (this.recoveryDetail) throw Object.assign(new Error(this.recoveryDetail), { status: 503 });
  }

  private requireWritable(id: string): JobRun {
    this.assertWritable();
    const run = this.runs.find((item) => item.id === id);
    if (!run) throw Object.assign(new Error("no such job run"), { status: 404 });
    return run;
  }

  private load(): JobRun[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      const list =
        parsed && typeof parsed === "object" &&
          ((parsed as { version?: unknown }).version === undefined || (parsed as { version?: unknown }).version === 1) &&
          Array.isArray((parsed as { runs?: unknown }).runs)
          ? (parsed as { runs: unknown[] }).runs
          : Array.isArray(parsed)
            ? parsed
            : null;
      if (!list) {
        this.recoveryDetail = HISTORY_RECOVERY;
        return [];
      }
      const parsedRuns = list.map(asRun);
      const valid = parsedRuns.filter((run): run is JobRun => Boolean(run));
      const ids = new Set(valid.map((run) => run.id));
      const keys = new Set(valid.map((run) => run.idempotencyKey));
      if (valid.length !== list.length || ids.size !== valid.length || keys.size !== valid.length) {
        this.recoveryDetail = HISTORY_RECOVERY;
      }
      return valid.slice(-MAX_RUNS);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.recoveryDetail = HISTORY_RECOVERY;
      return [];
    }
  }

  private replace(run: JobRun): void {
    this.commit(this.runs.map((item) => item.id === run.id ? run : item));
  }

  private commit(next: JobRun[]): void {
    this.assertWritable();
    const contents = `${JSON.stringify({ version: 1, runs: next } satisfies JobRunsFile, null, 2)}\n`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileAtomic(this.file, contents, 0o600);
    } catch {
      // writeFileAtomic can fail during the directory fsync after rename.
      // Preserve the actual receipt in that case and stop further work until
      // restart, rather than reporting an old state or retrying its actions.
      try {
        if (readFileSync(this.file, "utf8") === contents) {
          this.runs = next;
          this.recoveryDetail = WRITE_UNCERTAIN;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.recoveryDetail = HISTORY_RECOVERY;
      }
      throw Object.assign(new Error(this.recoveryDetail ?? WRITE_FAILED), { status: 503 });
    }
    this.runs = next;
  }

  private emitRun(run: JobRun): void {
    this.emit?.({ kind: "job.run", run: cloneRun(run) });
  }
}

export const jobRuns = new JobRunStore();
