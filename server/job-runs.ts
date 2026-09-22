// Durable execution receipts for jobs taught to Bud. RealBud owns this
// ledger, the clock, idempotency, and approval state; the worker only returns
// a bounded result for one already-authorized attempt.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
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
import { cleanText, cleanEvidence, cleanApprovals, parseJobRun } from './job-run-validation.ts';
import { ExecutionHistory, executionDigest } from './execution-history.ts';
import { jobHistoryBinding } from './execution-history-backup.ts';
import type { WorkflowDatabase } from './workflow-database.ts';
import type { ExecutionHistoryQuery } from '../shared/execution-history.ts';

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
  executionHistory?: 1;
  runs: JobRun[];
}

export interface JobRunStoreOptions {
  file?: string;
  database?: WorkflowDatabase;
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

export const jobRunBinding = jobHistoryBinding;

export class JobRunStore {
  private readonly file: string;
  private readonly now: () => number;
  private emit?: JobRunStoreOptions["emit"];
  private runs: JobRun[];
  private ledger?: ExecutionHistory<JobRun>;
  private legacyHash = executionDigest('absent');
  private migratedProjection = false;
  private recoveryDetail: string | null = null;

  constructor(options: JobRunStoreOptions = {}) {
    this.file = options.file ?? join(DATA_DIR, "job-runs.json");
    this.now = options.now ?? Date.now;
    this.emit = options.emit;
    this.runs = this.load();
    if (this.recovery.active) return;
    try {
      this.ledger = new ExecutionHistory({ type: 'job', file: this.file, database: options.database, expectedFileHash: this.legacyHash, requireExisting: this.migratedProjection, parse: parseJobRun,
        binding: jobRunBinding, requestKey: run => run.idempotencyKey, subject: run => run.jobId });
      this.runs = this.ledger.load(this.runs, null).runs;
    } catch { this.recoveryDetail = HISTORY_RECOVERY; return; }
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
    const run = this.readHistory(() => this.ledger?.get(id));
    return run ? cloneRun(run) : undefined;
  }

  getByIdempotencyKey(key: string): JobRun | undefined {
    this.assertWritable();
    return this.readHistory(() => this.ledger?.byRequest(key.trim()));
  }

  history(query: Omit<ExecutionHistoryQuery, 'subjectId'> & { jobId?: string } = {}) {
    this.assertWritable();
    return this.readHistory(() => this.ledger!.page({ ...query, subjectId: query.jobId }));
  }

  close() { this.ledger?.close(); }

  enqueue(recipe: Recipe, input: EnqueueJobRunInput): { run: JobRun; created: boolean } {
    this.assertWritable();
    const key = input.idempotencyKey.trim();
    if (!key || key.length > 300) {
      throw Object.assign(new Error("A bounded idempotency key is required."), { status: 400 });
    }
    const duplicate = this.getByIdempotencyKey(key);
    if (duplicate) {
      if (duplicate.jobId !== recipe.id || duplicate.jobRevision !== recipe.revision || duplicate.mode !== input.mode || duplicate.trigger !== input.trigger ||
        jobRunBinding(duplicate) !== jobRunBinding({ ...duplicate, spec: snapshot(recipe) }) || (input.scheduledFor !== undefined && input.scheduledFor !== duplicate.scheduledFor) ||
        input.loopRunId !== duplicate.loopRunId || (input.threadId !== undefined && input.threadId !== duplicate.threadId)) {
        throw Object.assign(new Error('That request belongs to another job, plan or input. Check its original result.'), { status: 409 });
      }
      return { run: cloneRun(duplicate), created: false };
    }
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
    this.commit(this.trim([...this.runs, run]));
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

  private readHistory<T>(read: () => T): T {
    this.assertWritable();
    try { return read(); }
    catch (error) {
      if ((error as { status?: number }).status === 503) this.recoveryDetail = HISTORY_RECOVERY;
      throw error;
    }
  }

  private assertWritable(): void {
    if (this.recoveryDetail) throw Object.assign(new Error(this.recoveryDetail), { status: 503 });
  }

  private requireWritable(id: string): JobRun {
    this.assertWritable();
    const run = this.readHistory(() => this.ledger?.get(id));
    if (!run) throw Object.assign(new Error("no such job run"), { status: 404 });
    return run;
  }

  private load(): JobRun[] {
    try {
      const contents = readFileSync(this.file, "utf8");
      this.legacyHash = executionDigest(contents);
      const parsed: unknown = JSON.parse(contents);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && 'executionHistory' in parsed) {
        if (parsed.executionHistory !== 1) throw new Error('Unknown execution projection');
        this.migratedProjection = true;
      }
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
      const parsedRuns = list.map(parseJobRun);
      const valid = parsedRuns.filter((run): run is JobRun => Boolean(run));
      const ids = new Set(valid.map((run) => run.id));
      const keys = new Set(valid.map((run) => run.idempotencyKey));
      if (valid.length !== list.length || ids.size !== valid.length || keys.size !== valid.length) {
        this.recoveryDetail = HISTORY_RECOVERY;
      }
      return valid;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.recoveryDetail = HISTORY_RECOVERY;
      return [];
    }
  }

  private replace(run: JobRun): void {
    const found = this.runs.some(item => item.id === run.id);
    this.commit(this.trim(found ? this.runs.map(item => item.id === run.id ? run : item) : [...this.runs, run]));
  }

  private trim(runs: JobRun[]): JobRun[] {
    const next = [...runs];
    while (next.length > MAX_RUNS) {
      const index = next.findIndex(run => !IN_FLIGHT.has(run.status));
      if (index < 0) break;
      next.splice(index, 1);
    }
    return next;
  }

  private commit(next: JobRun[]): void {
    this.assertWritable();
    const contents = `${JSON.stringify({ version: 1, executionHistory: 1, runs: next } satisfies JobRunsFile, null, 2)}\n`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      this.ledger!.save(next, null, contents, () => writeFileAtomic(this.file, contents, 0o600));
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
      this.recoveryDetail ??= WRITE_FAILED + ' Job runs are paused; restart to reconcile the retained execution intent.';
      throw Object.assign(new Error(this.recoveryDetail), { status: 503 });
    }
    this.runs = next;
  }

  private emitRun(run: JobRun): void {
    this.emit?.({ kind: "job.run", run: cloneRun(run) });
  }
}

export const jobRuns = new JobRunStore();
