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

function cleanEvidence(items: ReadonlyArray<JobRunEvidence> | undefined, now: number): JobRunEvidence[] {
  if (!items) return [];
  const out: JobRunEvidence[] = [];
  for (const item of items.slice(0, MAX_EVIDENCE)) {
    if (!item || !["observation", "output", "approval", "action", "denied", "asked", "note"].includes(item.kind)) continue;
    const note = cleanText(item.note, MAX_NOTE);
    if (!note) continue;
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

  constructor(options: JobRunStoreOptions = {}) {
    this.file = options.file ?? join(DATA_DIR, "job-runs.json");
    this.now = options.now ?? Date.now;
    this.emit = options.emit;
    this.runs = this.load();
    let recovered = false;
    for (const run of this.runs) {
      if (run.status === "queued" && run.mode === "attended") continue;
      if (run.status !== "queued" && run.status !== "running") continue;
      run.status = "interrupted";
      run.finishedAt = this.now();
      run.detail = "Interrupted on startup — no action was resumed.";
      recovered = true;
    }
    if (recovered) this.persist();
    this.sweepQueuedAttended();
  }

  list(jobId?: string): JobRun[] {
    return this.runs
      .filter((run) => !jobId || run.jobId === jobId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(cloneRun);
  }

  get(id: string): JobRun | undefined {
    const run = this.runs.find((item) => item.id === id);
    return run ? cloneRun(run) : undefined;
  }

  enqueue(recipe: Recipe, input: EnqueueJobRunInput): { run: JobRun; created: boolean } {
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
    this.runs.push(run);
    if (this.runs.length > MAX_RUNS) this.runs.splice(0, this.runs.length - MAX_RUNS);
    this.persist();
    this.emitRun(run);
    return { run: cloneRun(run), created: true };
  }

  start(id: string, detail = "Bud is preparing the job.", extra?: { threadId?: string }): JobRun {
    const run = this.require(id);
    if (run.status !== "queued") {
      throw Object.assign(new Error("Only a queued job run can start."), { status: 409 });
    }
    run.status = "running";
    run.startedAt = this.now();
    run.detail = cleanText(detail, MAX_DETAIL) || "Bud is preparing the job.";
    if (extra?.threadId) run.threadId = extra.threadId;
    this.persist();
    this.emitRun(run);
    return cloneRun(run);
  }

  sweepQueuedAttended(maxAgeMs = QUEUED_ATTENDED_MAX_AGE_MS): JobRun[] {
    const cutoff = this.now() - maxAgeMs;
    const missed: JobRun[] = [];
    for (const run of this.runs) {
      if (run.mode !== "attended" || run.status !== "queued" || run.createdAt > cutoff) continue;
      run.status = "missed";
      run.finishedAt = this.now();
      run.detail = QUEUED_ATTENDED_MISSED;
      this.emitRun(run);
      missed.push(cloneRun(run));
    }
    if (missed.length) this.persist();
    return missed;
  }

  appendEvidence(id: string, items: ReadonlyArray<JobRunEvidence>): JobRun {
    const run = this.require(id);
    if (run.status !== "running") {
      throw Object.assign(new Error("Only a running job can take evidence."), { status: 409 });
    }
    run.evidence = cleanEvidence([...run.evidence, ...items], this.now());
    this.persist();
    this.emitRun(run);
    return cloneRun(run);
  }

  setEmit(emit: JobRunStoreOptions["emit"]): void {
    this.emit = emit;
  }

  settle(id: string, result: SettleJobRunInput): JobRun {
    const run = this.require(id);
    if (run.status !== "running") {
      throw Object.assign(new Error("Only a running job can settle."), { status: 409 });
    }
    if (!SETTLED.has(result.status)) {
      throw Object.assign(new Error("That is not a settled job-run state."), { status: 400 });
    }
    const now = this.now();
    run.status = result.status;
    run.detail = cleanText(result.detail, MAX_DETAIL) || "Job run settled.";
    run.evidence = cleanEvidence(
      result.evidence !== undefined ? [...run.evidence, ...result.evidence] : run.evidence,
      now,
    );
    run.approvalRequests = cleanApprovals(result.approvalRequests);
    run.finishedAt = now;
    if (result.legacySessionId) run.legacySessionId = result.legacySessionId;
    this.persist();
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
    const run = this.require(id);
    if (!IN_FLIGHT.has(run.status)) return cloneRun(run);
    run.status = "cancelled";
    run.finishedAt = this.now();
    run.detail = "Cancelled in RealBud. Nothing pending was resumed.";
    this.persist();
    this.emitRun(run);
    return cloneRun(run);
  }

  markSeen(id: string): JobRun {
    const run = this.require(id);
    if (!run.seenAt) {
      run.seenAt = this.now();
      this.persist();
      this.emitRun(run);
    }
    return cloneRun(run);
  }

  private require(id: string): JobRun {
    const run = this.runs.find((item) => item.id === id);
    if (!run) throw Object.assign(new Error("no such job run"), { status: 404 });
    return run;
  }

  private load(): JobRun[] {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      const list =
        parsed && typeof parsed === "object" && Array.isArray((parsed as { runs?: unknown }).runs)
          ? (parsed as { runs: unknown[] }).runs
          : Array.isArray(parsed)
            ? parsed
            : [];
      return list.map(asRun).filter((run): run is JobRun => Boolean(run)).slice(-MAX_RUNS);
    } catch {
      return [];
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileAtomic(
      this.file,
      `${JSON.stringify({ version: 1, runs: this.runs } satisfies JobRunsFile, null, 2)}\n`,
      0o600,
    );
  }

  private emitRun(run: JobRun): void {
    this.emit?.({ kind: "job.run", run: cloneRun(run) });
  }
}

export const jobRuns = new JobRunStore();
