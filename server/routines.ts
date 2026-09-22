// Named product loops on the RealBud clock. The injected executor resolves
// a code-owned evaluator and writes proposals through Desk. A loop never
// launches Cua, waits for approval, or performs a background handoff.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { parseLoopsFile, validTimezone, type LoopsFile } from "./routine-persistence.ts";
import { ExecutionHistory, executionDigest } from './execution-history.ts';
import { loopHistoryBinding, parseHistoryLoopRun } from './execution-history-backup.ts';
import type { WorkflowDatabase } from './workflow-database.ts';
import type { ExecutionHistoryQuery } from '../shared/execution-history.ts';
import { MANUAL_JOB_REQUEST_ID } from "../shared/manual-job-request.ts";
import { redactSecretsInText } from "./redact.ts";
import { DATA_DIR } from "./config.ts";
import { oplog } from "./oplog.ts";
import { evaluatorForLoop } from "./workflow-catalog.ts";
import { recipeClockRunnable, type Loop, type LoopId, type LoopRun, type LoopRunStatus, type LoopSchedule, type Recipe } from "../shared/contracts.ts";

export type { Loop, LoopId, LoopRun, LoopRunStatus, LoopSchedule };

export const loopRunBinding = loopHistoryBinding;
export const parseHistoricalLoopRun = parseHistoryLoopRun;

export interface LoopExecuteResult {
  ok: boolean;
  status?: "completed" | "partial" | "awaiting-approval" | "failed";
  detail: string;
  covered?: number;
  uncovered?: number;
  jobRunId?: string;
}

export interface LoopManagerOptions {
  file?: string;
  database?: WorkflowDatabase;
  now?: () => number;
  emit?: (payload: unknown) => void;
  timezone?: string;
  hostTimezone?: string;
  /** Ceiling on one run. Tests shorten it; production uses RUN_DEADLINE_MS. */
  runDeadlineMs?: number;
  /**
   * The worker identity to stamp on each run as it starts, for provenance. Returns
   * undefined when no worker is established yet, in which case nothing is recorded
   * rather than a misleading placeholder.
   */
  workerIdentity?: () => string | undefined;
  execute: (loop: Loop, run: LoopRun) => Promise<LoopExecuteResult>;
  /** Taught jobs. Re-read each tick so a save, pause, or delete lands without a restart. */
  listRecipes?: () => ReadonlyArray<
    Pick<Recipe, "id" | "title" | "status" | "schedule" | "planApprovedAt" | "revision" | "approvedRevision">
  >;
  /** Pause/resume from the clock writes through to the job's status. */
  setRecipeEnabled?: (recipeId: string, enabled: boolean) => void;
}

/** A worker that answered some addresses and held the rest is not a miss. */
export function settleLoopRunStatus(result: Pick<LoopExecuteResult, "ok" | "status" | "covered" | "uncovered">): LoopRunStatus {
  if (result.status) return result.status;
  if ((result.covered ?? 0) > 0 && (result.uncovered ?? 0) > 0) return "partial";
  return result.ok ? "completed" : "failed";
}

/** Coverage already written by Desk — only used to label the run. */
export function coverageFromUncoveredHeld(
  detail: string | null | undefined,
  results: ReadonlyArray<{ reason: string }>,
): { covered: number; uncovered: number } | null {
  if (!detail?.includes("Uncovered stay held")) return null;
  let covered = 0;
  let uncovered = 0;
  for (const row of results) {
    if (row.reason === "uncovered-by-worker") uncovered += 1;
    else covered += 1;
  }
  return { covered, uncovered };
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const CATCH_UP_MS = 12 * 60 * 60_000;

/** Ceiling on one run. Generous next to the worker's own 20s timeout — this
 * only catches a path that would otherwise hang forever. */
const RUN_DEADLINE_MS = 5 * 60_000;
const MAX_RUNS = 2_000;
const HISTORY_RECOVERY = "The schedule needs recovery. Clockwork is paused and the saved history has been preserved. Restore a known-good schedule, then restart RealBud.";
const WRITE_RECOVERY = "RealBud could not safely save the schedule. Clockwork is paused. Check disk space and file access, then restart RealBud before trying again.";
const SOURCE_RECOVERY = "A saved job could not be read or updated. Clockwork is paused. Check the saved plan and schedule, then restart RealBud.";
const cloneLoop = (loop: Loop): Loop => ({ ...loop, schedule: { ...loop.schedule, weekdays: [...loop.schedule.weekdays] } });
interface ExecutionOutcome { result?: LoopExecuteResult; error?: unknown }


/** Strict "HH:MM", 00-23 / 00-59. Returns null when it is not a clock time. */
export function parseClockTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  return match ? value : null;
}

/** Non-empty set of weekday numbers 0 (Sun) .. 6 (Sat), deduped and sorted. */
export function parseWeekdays(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 7) return null;
  const seen = new Set<number>();
  for (const raw of value) {
    if (!Number.isInteger(raw) || raw < 0 || raw > 6) return null;
    seen.add(raw);
  }
  return [...seen].sort((a, b) => a - b);
}

export function recipeLoopId(recipeId: string): LoopId {
  return `recipe-${recipeId}`;
}

export function recipeIdFromLoopId(id: LoopId): string | null {
  return id.startsWith("recipe-") ? id.slice("recipe-".length) : null;
}

const RECIPE_LOOP_DESCRIPTION =
  "An approved job prepares work at its scheduled time and saves a result for your review. It does not send, submit or pay.";

export const LOOP_CATALOG: ReadonlyArray<Omit<Loop, "enabled" | "nextRunAt" | "timezonePaused" | "revision">> = [
  {
    id: "morning-arrears",
    name: "Morning money check",
    description:
      "Checks the property book and puts tasks that need your review on Desk. Uses the current saved sources without opening websites.",
    available: true,
    schedule: { type: "daily", time: "07:30", weekdays: WEEKDAYS },
    evaluatorId: "morning-money",
    evaluatorVersion: 1,
  },
  {
    id: "owner-letter",
    name: "Friday owner letter",
    description:
      "Prepares a Friday update for each owner using the property book and notes. Review and copy the wording yourself.",
    available: true,
    schedule: { type: "daily", time: "16:00", weekdays: [5] },
    evaluatorId: "owner-letter",
    evaluatorVersion: 1,
  },
  {
    id: "inbound-triage",
    name: "Morning priorities",
    description:
      "Collects your reviewed Gmail scope, prepares priorities with Bud and keeps your saved task decisions. Starts only after agency setup and plan review.",
    available: true,
    schedule: { type: "daily", time: "08:00", weekdays: WEEKDAYS },
    evaluatorId: "inbound-triage",
    evaluatorVersion: 1,
  },
];

export function hostTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function wallInZone(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "0";
  const weekday = get("weekday");
  const dow =
    weekday === "Sun" ? 0 : weekday === "Mon" ? 1 : weekday === "Tue" ? 2 : weekday === "Wed" ? 3 : weekday === "Thu" ? 4 : weekday === "Fri" ? 5 : 6;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour") === "24" ? "0" : get("hour")),
    minute: Number(get("minute")),
    dow,
  };
}

function utcFromWall(timeZone: string, year: number, month: number, day: number, hour: number, minute: number): number {
  let guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  for (let i = 0; i < 6; i++) {
    const wall = wallInZone(guess, timeZone);
    const delta =
      Date.UTC(year, month - 1, day, hour, minute) - Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
    if (delta === 0) return guess;
    guess += delta;
  }
  return guess;
}

export function nextOccurrence(schedule: LoopSchedule, after: number, timeZone?: string): number | null {
  const [hour, minute] = schedule.time.split(":").map(Number);
  const weekdays = new Set(schedule.weekdays);
  if (!timeZone) {
    for (let offset = 0; offset <= 8; offset++) {
      const d = new Date(after);
      d.setDate(d.getDate() + offset);
      d.setHours(hour, minute, 0, 0);
      if (d.getTime() > after && weekdays.has(d.getDay())) return d.getTime();
    }
    return null;
  }
  for (let offset = 0; offset <= 8; offset++) {
    const wall = wallInZone(after + offset * 86_400_000, timeZone);
    const candidate = utcFromWall(timeZone, wall.year, wall.month, wall.day, hour, minute);
    const candWall = wallInZone(candidate, timeZone);
    // A nonexistent DST minute is skipped, not silently moved an hour later.
    if (candidate > after && candWall.hour === hour && candWall.minute === minute && weekdays.has(candWall.dow)) return candidate;
  }
  return null;
}

export class LoopManager {
  private readonly generation = randomUUID();
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: LoopManagerOptions;
  private loops: Loop[];
  private runs: LoopRun[] = [];
  private handledThrough = new Map<LoopId, number>();
  /** PM-retuned clocks; null means the catalog schedule still stands. */
  private overrides = new Map<LoopId, { time: string; weekdays: number[]; timezone?: string } | null>();
  private revisions = new Map<LoopId, number>();
  private savedState: LoopsFile["state"] = {};
  /** Recipe catalog clocks (before a PM retune). */
  private recipeBase = new Map<LoopId, LoopSchedule>();
  /** Clock pause, separate from a paused job — save() persists this, not the overlay. */
  private clockEnabled = new Map<LoopId, boolean>();
  /** Scheduled jobs that may fire on tick: active + plan approved. */
  private recipeClockOk = new Set<LoopId>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  timezone: string;
  private readonly hostTz: string;
  private recoveryDetail: string | null = null;
  private executing = new Set<LoopId>();
  private ledger?: ExecutionHistory<LoopRun, Omit<LoopsFile, "version" | "runs">>;

  constructor(options: LoopManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "loops.json");
    this.now = options.now ?? Date.now;
    const requestedHost = options.hostTimezone ?? hostTimezone();
    this.hostTz = validTimezone(requestedHost) ? requestedHost : "UTC";
    let saved: LoopsFile = { version: 3, timezone: this.hostTz, state: {}, runs: [] };
    let savedHash = executionDigest('absent'), migratedProjection = false;
    try {
      if (statSync(this.file).size > 8 * 1024 * 1024) throw new Error('Schedule history exceeds the supported file size');
      const contents = readFileSync(this.file, 'utf8'), raw: unknown = JSON.parse(contents);
      savedHash = executionDigest(contents);
      if (raw && typeof raw === 'object' && 'executionHistory' in raw) {
        if (raw.executionHistory !== 1) throw new Error('Unknown execution projection');
        migratedProjection = true;
      }
      saved = parseLoopsFile(raw, this.hostTz);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.recoveryDetail = HISTORY_RECOVERY;
    }
    if (!this.recoveryDetail) {
      try {
        this.ledger = new ExecutionHistory({ type: 'loop', file: this.file, database: options.database, expectedFileHash: savedHash, requireExisting: migratedProjection,
          parse: parseHistoricalLoopRun, binding: loopRunBinding, requestKey: run => run.requestId, subject: run => run.loopId });
        const retained = this.ledger.load(saved.runs, { timezone: saved.timezone, state: saved.state });
        saved = parseLoopsFile({ version: 3, ...retained.context, runs: retained.runs }, this.hostTz);
      } catch { this.recoveryDetail = HISTORY_RECOVERY; }
    }
    const timezone = options.timezone ?? saved.timezone;
    if (!validTimezone(timezone) || !validTimezone(requestedHost)) this.recoveryDetail = HISTORY_RECOVERY;
    this.timezone = validTimezone(timezone) ? timezone : this.hostTz;
    this.runs = saved.runs;
    this.savedState = saved.state;
    const savedState = this.savedState;
    const paused = this.timezone !== this.hostTz;
    this.loops = LOOP_CATALOG.map((loop) => {
      const spec = evaluatorForLoop(loop.id);
      // First-run inbox access must be deliberately enabled after scope review.
      const enabled = loop.available && (loop.id === 'inbound-triage' ? savedState[loop.id]?.enabled === true : savedState[loop.id]?.enabled !== false);
      const handled = Number.isFinite(savedState[loop.id]?.handledThrough)
        ? savedState[loop.id]!.handledThrough
        : this.now() - 1;
      this.handledThrough.set(loop.id, handled);
      // v2 files carry no per-loop clock; the catalog schedule migrates as-is
      // and the first retune bumps revision from its initial 1.
      const savedSchedule = savedState[loop.id]?.schedule;
      const override =
        savedSchedule && parseClockTime(savedSchedule.time) && parseWeekdays(savedSchedule.weekdays)
          ? { time: savedSchedule.time, weekdays: parseWeekdays(savedSchedule.weekdays)!, ...(savedSchedule.timezone ? { timezone: savedSchedule.timezone } : {}) }
          : null;
      this.overrides.set(loop.id, override);
      this.revisions.set(loop.id, Number.isInteger(savedState[loop.id]?.revision) ? savedState[loop.id]!.revision! : 1);
      const schedule: LoopSchedule = { type: "daily", ...(override ?? loop.schedule) };
      return {
        ...loop,
        evaluatorId: spec?.id ?? loop.evaluatorId,
        evaluatorVersion: spec?.version ?? loop.evaluatorVersion,
        schedule,
        revision: this.revisions.get(loop.id)!,
        enabled,
        timezonePaused: paused && !schedule.timezone,
        nextRunAt: enabled && (!paused || !!schedule.timezone) ? nextOccurrence(schedule, Math.max(this.now(), this.handledThrough.get(loop.id) ?? 0), this.zoneForClock(schedule)) : null,
      };
    });
    this.refreshRecipeLoops();
    if (!this.recovery.active && this.runs.some((run) => run.status === "queued" || run.status === "running" ||
      (!run.manual && run.scheduledFor > (this.handledThrough.get(run.loopId) ?? 0)))) {
      try {
        this.commit(() => {
          for (const run of this.runs) {
            if (run.status === "queued" || run.status === "running") {
              run.status = "interrupted";
              run.finishedAt = this.now();
              run.detail = "Interrupted on startup — not resumed mid-action. Check saved results before trying again.";
            }
            // Old versions could save even completed receipts before advancing
            // the bookmark. Every retained scheduled outcome claims its slot.
            if (!run.manual) this.handledThrough.set(run.loopId, Math.max(this.handledThrough.get(run.loopId) ?? 0, run.scheduledFor));
          }
        });
      } catch { /* recovery is visible; startup remains available */ }
    }
    if (this.recovery.active) this.emitRecovery();
  }

  get recovery(): { active: boolean; detail: string; generation: string } {
    return { active: this.recoveryDetail !== null, detail: this.recoveryDetail ?? "", generation: this.generation };
  }

  listLoops(): Loop[] {
    this.refreshRecipeLoops();
    return this.loops.map((loop) => ({ ...cloneLoop(loop), ...(this.recovery.active ? { nextRunAt: null } : {}) }));
  }

  listRuns(from?: number, to?: number): LoopRun[] {
    return this.runs
      .filter((run) => (from == null || run.scheduledFor >= from) && (to == null || run.scheduledFor <= to))
      .sort((a, b) => b.scheduledFor - a.scheduledFor)
      .map((run) => ({ ...run }));
  }

  getRun(id: string): LoopRun | undefined {
    this.assertWritable();
    return this.readHistory(() => this.ledger?.get(id));
  }

  /** Durable lookup also covers receipts evicted from the recent-run projection. */
  getRunByRequest(requestId: string): LoopRun | undefined {
    this.assertWritable();
    if (!MANUAL_JOB_REQUEST_ID.test(requestId)) throw Object.assign(new Error('Invalid run request ID.'), { status: 400 });
    return this.readHistory(() => this.ledger?.byRequest(requestId.toLowerCase()));
  }

  history(query: Omit<ExecutionHistoryQuery, 'subjectId'> & { loopId?: string } = {}) {
    this.assertWritable();
    return this.readHistory(() => this.ledger!.page({ ...query, subjectId: query.loopId }));
  }

  close() { this.stop(); this.ledger?.close(); }

  activeRun(loopId: LoopId): LoopRun | null {
    const run = this.runs.find((r) => r.loopId === loopId && ["queued", "running"].includes(r.status));
    return run ? { ...run } : null;
  }

  /** One door for clock changes: enabled, time, weekdays. Every accepted
   * change bumps revision and recomputes nextRunAt strictly forward — a
   * retune never backfills an already-passed slot. An idempotent PATCH
   * (values identical to current) is acknowledged without touching the
   * bookmark or revision, so it can never swallow a pending slot. */
  patchClock(id: LoopId, patch: { enabled?: boolean; time?: string; weekdays?: number[]; timezone?: string }): Loop {
    this.assertWritable();
    this.refreshRecipeLoops();
    this.assertWritable();
    const loop = this.loops.find((candidate) => candidate.id === id);
    if (!loop) throw Object.assign(new Error("no such loop"), { status: 404 });
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
      throw Object.assign(new Error("enabled must be true or false"), { status: 400 });
    }
    const wantsEnable = patch.enabled !== undefined && patch.enabled !== loop.enabled;
    // Declared-but-not-built is a state conflict, not malformed input: it is 409 here
    // and 409 on run (index.ts, "that routine is declared but not built yet"). This
    // throw carried no status, so the PATCH handler's `?? 400` default made the two
    // paths disagree — docs/ROUTINES.md:56 is what the pair is now brought back to.
    if (wantsEnable && !loop.available) {
      throw Object.assign(new Error("that loop is declared but not built yet"), { status: 409 });
    }
    if (patch.enabled === undefined && patch.time === undefined && patch.weekdays === undefined && patch.timezone === undefined) {
      throw Object.assign(new Error("nothing to change — send enabled, time, or weekdays"), { status: 400 });
    }
    if (patch.time !== undefined && !parseClockTime(patch.time)) {
      throw Object.assign(new Error("time must be HH:MM (00:00–23:59)"), { status: 400 });
    }
    if (patch.weekdays !== undefined && !parseWeekdays(patch.weekdays)) {
      throw Object.assign(new Error("weekdays must be a non-empty list of numbers 0–6"), { status: 400 });
    }
    if (patch.timezone !== undefined && !validTimezone(patch.timezone)) throw Object.assign(new Error('Choose a valid office timezone.'), { status: 400 });
    const currentOverride = this.overrides.get(id);
    const nextTime = patch.time ?? currentOverride?.time ?? loop.schedule.time;
    const nextZone = patch.timezone ?? currentOverride?.timezone ?? loop.schedule.timezone;
    // compare by content: catalog arrays are shared references
    const nextDays = (patch.weekdays ?? currentOverride?.weekdays ?? loop.schedule.weekdays).slice().sort((a, b) => a - b);
    const clockChanged =
      (patch.time !== undefined || patch.weekdays !== undefined || patch.timezone !== undefined) &&
      (nextTime !== loop.schedule.time || nextDays.join(",") !== loop.schedule.weekdays.join(",") || nextZone !== loop.schedule.timezone);
    if (!clockChanged && !wantsEnable) return cloneLoop(loop);
    this.commit(() => {
      if (clockChanged) this.overrides.set(id, { time: nextTime, weekdays: nextDays, ...(nextZone ? { timezone: nextZone } : {}) });
      // A deliberate clock change starts strictly forward, including resume.
      this.handledThrough.set(id, Math.max(this.handledThrough.get(id) ?? 0, this.now()));
      if (wantsEnable) {
        loop.enabled = patch.enabled!;
        this.clockEnabled.set(id, loop.enabled);
      }
      const catalogSchedule = LOOP_CATALOG.find((item) => item.id === id)?.schedule ?? this.recipeBase.get(id);
      loop.schedule = { type: "daily", ...(this.overrides.get(id) ?? catalogSchedule ?? loop.schedule) };
      loop.timezonePaused = !loop.schedule.timezone && this.timezone !== this.hostTz;
      loop.revision = (this.revisions.get(id) ?? 1) + 1;
      this.revisions.set(id, loop.revision);
      loop.nextRunAt = loop.enabled && !loop.timezonePaused ? nextOccurrence(loop.schedule, this.now(), this.zoneForClock(loop.schedule)) : null;
    });
    if (wantsEnable) {
      const recipeId = recipeIdFromLoopId(id);
      if (recipeId) {
        try { this.options.setRecipeEnabled?.(recipeId, loop.enabled); }
        catch { this.hold(SOURCE_RECOVERY); this.assertWritable(); }
      }
    }
    this.emitLoop(loop);
    return cloneLoop(loop);
  }

  setEnabled(id: LoopId, enabled: boolean): Loop {
    return this.patchClock(id, { enabled });
  }

  /** A reviewed job plan owns its time; older per-loop overrides cannot win. */
  adoptRecipePlan(recipeId: string): void {
    this.assertWritable();
    const id = recipeLoopId(recipeId);
    this.commit(() => {
      this.overrides.set(id, null);
      this.clockEnabled.set(id, true);
      this.handledThrough.set(id, Math.max(this.handledThrough.get(id) ?? 0, this.now()));
      this.revisions.set(id, this.revisions.has(id) ? this.revisions.get(id)! + 1 : 1);
      this.refreshRecipeLoops();
      this.assertWritable();
    });
  }

  runNow(id: LoopId, request?: { requestId: string; expectedRevision: number }): LoopRun | null {
    this.assertWritable();
    if (request) {
      if (typeof request.requestId !== "string" || !MANUAL_JOB_REQUEST_ID.test(request.requestId) ||
        !Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 1) {
        throw Object.assign(new Error("A valid request ID and saved schedule revision are required."), { status: 400 });
      }
      const existing = this.readHistory(() => this.ledger!.byRequest(request.requestId.toLowerCase()));
      if (existing) {
        if (existing.loopId !== id || existing.loopRevision !== request.expectedRevision) {
          throw Object.assign(new Error("That request belongs to another schedule or version. Check its original result."), { status: 409 });
        }
        return { ...existing };
      }
    }
    this.refreshRecipeLoops();
    this.assertWritable();
    const loop = this.loops.find((candidate) => candidate.id === id);
    if (request && loop && request.expectedRevision !== loop.revision) {
      throw Object.assign(new Error("This schedule changed. Reload it before starting a new run."), { status: 409 });
    }
    if (!loop || !loop.available || (!loop.enabled && !loop.waitingForPlan && id !== 'inbound-triage')) return null;
    if (this.activeRun(id) || this.executing.has(id)) throw Object.assign(new Error("this loop is already running"), { status: 409 });
    let run!: LoopRun;
    this.commit(() => {
      run = this.newRun(loop, this.now(), true);
      if (request) run.requestId = request.requestId.toLowerCase();
    });
    this.emitRun(run);
    queueMicrotask(() => this.tickSafely());
    return { ...run };
  }

  markSeen(id: string): LoopRun | null {
    this.assertWritable();
    const run = this.getRun(id);
    if (!run) return null;
    if (!run.seenAt) {
      this.commit(() => {
        run.seenAt = this.now();
        const index = this.runs.findIndex(item => item.id === id);
        if (index >= 0) this.runs[index] = run;
        else this.runs.push(run);
        this.trimRuns();
      });
      this.emitRun(run);
    }
    return { ...run };
  }

  get busy() { return this.ticking || this.executing.size > 0; }

  start() {
    if (this.timer || this.recovery.active) return;
    this.tickSafely();
    if (this.recovery.active) return;
    this.timer = setInterval(() => this.tickSafely(), 10_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tickSafely(): void {
    void this.tick().catch(() => this.hold(WRITE_RECOVERY));
  }

  async tick(): Promise<void> {
    if (this.ticking || this.recovery.active) return;
    this.ticking = true;
    try {
      this.refreshRecipeLoops();
      this.assertWritable();
      const now = this.now();
      for (const loop of this.loops) {
        if (!loop.enabled || !loop.available || loop.timezonePaused) continue;
        if (recipeIdFromLoopId(loop.id) && !this.recipeClockOk.has(loop.id)) continue;
        let handled = this.handledThrough.get(loop.id) ?? now - 1;
        const recent = now - CATCH_UP_MS;
        // Compress ancient downtime into one explicit missed receipt per loop.
        // Only the recent catch-up window is enumerated, irrespective of file age.
        const first = nextOccurrence(loop.schedule, handled, this.zoneForClock(loop.schedule));
        if (handled < recent && first != null && first < recent) {
          let missed!: LoopRun;
          this.commit(() => {
            missed = this.newRun(loop, first, false);
            missed.status = "missed";
            missed.finishedAt = now;
            missed.detail = "One or more scheduled times were missed while this computer was offline for more than 12 hours. Older work was not replayed.";
            this.handledThrough.set(loop.id, Math.max(this.handledThrough.get(loop.id) ?? 0, recent));
          });
          this.emitRun(missed);
          handled = this.handledThrough.get(loop.id)!;
        }
        for (let at = nextOccurrence(loop.schedule, handled, this.zoneForClock(loop.schedule)); at != null && at <= now;
          at = nextOccurrence(loop.schedule, Math.max(at, this.handledThrough.get(loop.id) ?? at), this.zoneForClock(loop.schedule))) {
          let run!: LoopRun;
          this.commit(() => {
            const occupied = Boolean(this.activeRun(loop.id)) || this.executing.has(loop.id);
            run = this.newRun(loop, at!, false);
            if (occupied) {
              run.status = "missed";
              run.finishedAt = this.now();
              run.detail = "This scheduled time was skipped because the previous run was still waiting or working. Check that result before starting more work.";
            }
            // Claim the occurrence in the same durable write as its receipt,
            // before any executor or observer can see runnable work.
            this.handledThrough.set(loop.id, Math.max(this.handledThrough.get(loop.id) ?? 0, at!));
          });
          this.emitRun(run);
          if (run.status === "queued") await this.executeRun(run, loop);
          this.assertWritable();
        }
        loop.nextRunAt = loop.enabled && !loop.timezonePaused
          ? nextOccurrence(loop.schedule, Math.max(now, this.handledThrough.get(loop.id) ?? handled), this.zoneForClock(loop.schedule)) : null;
        this.emitLoop(loop);
      }
      for (const run of [...this.runs].reverse()) {
        if (run.status !== "queued") continue;
        const loop = this.loops.find((candidate) => candidate.id === run.loopId);
        if (!loop || !loop.available || (!loop.enabled && !loop.waitingForPlan && !(loop.id === 'inbound-triage' && run.manual)) || (run.loopRevision != null && run.loopRevision !== loop.revision)) {
          this.commit(() => {
            run.status = "interrupted";
            run.finishedAt = this.now();
            run.detail = "Not started because the saved job or schedule changed. Review its current plan before trying again.";
          });
          this.emitRun(run);
          continue;
        }
        if (!this.executing.has(loop.id)) await this.executeRun(run, loop);
      }
    } catch {
      this.hold(WRITE_RECOVERY);
    } finally {
      this.ticking = false;
    }
  }

  private async executeRun(run: LoopRun, loop: Loop): Promise<void> {
    if (run.status !== "queued" || this.executing.has(loop.id)) return;
    // Stamp the worker before the work starts, so a receipt says what produced it
    // even if the worker is upgraded or the model changed while the run was open.
    const worker = this.options.workerIdentity?.();
    this.commit(() => {
      run.startedAt = this.now();
      run.status = "running";
      if (worker) run.workerFingerprint = worker;
    });
    this.emitRun(run);
    this.executing.add(loop.id);
    let work: Promise<LoopExecuteResult>;
    try { work = Promise.resolve(this.options.execute(cloneLoop(loop), { ...run })); }
    catch (error) { work = Promise.reject(error); }
    const outcome: Promise<ExecutionOutcome> = work.then((result) => ({ result }), (error) => ({ error }));
    const deadlineMarker = Symbol("deadline");
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<typeof deadlineMarker>((resolve) => {
      timer = setTimeout(() => resolve(deadlineMarker), this.options.runDeadlineMs ?? RUN_DEADLINE_MS);
      timer.unref?.();
    });
    const first = await Promise.race([outcome, deadline]);
    clearTimeout(timer);
    if (first === deadlineMarker) {
      // The deadline does not cancel the executor. Keep the receipt and lock
      // running while other loops proceed; the eventual result settles this ID.
      void outcome.then((late) => this.finishRun(run.id, loop.id, late)).catch(() => this.hold(WRITE_RECOVERY));
      this.commit(() => {
        run.detail = "This run is taking longer than expected. Its outcome is still unconfirmed; RealBud is waiting for the original work and will not start a second run.";
      });
      this.emitRun(run);
      return;
    }
    this.finishRun(run.id, loop.id, first);
  }

  private finishRun(id: string, loopId: LoopId, outcome: ExecutionOutcome): void {
    try {
      if (this.recovery.active) return;
      const run = this.runs.find((item) => item.id === id);
      if (!run || run.status !== "running") return;
      this.commit(() => {
        run.status = outcome.result ? settleLoopRunStatus(outcome.result) : "failed";
        run.detail = redactSecretsInText(outcome.result?.detail ?? (outcome.error instanceof Error ? outcome.error.message : "The work could not complete.")).slice(0, 500);
        if (outcome.result?.jobRunId) run.jobRunId = outcome.result.jobRunId;
        run.finishedAt = this.now();
      });
      this.emitRun(run);
      try {
        oplog("routine", run.detail || run.status, { loopId, runId: run.id, status: run.status, scheduledFor: new Date(run.scheduledFor).toISOString() });
      } catch { console.warn("[schedule] A completed run diagnostic could not be saved."); }
    } finally {
      this.executing.delete(loopId);
    }
  }

  private newRun(loop: Loop, scheduledFor: number, manual: boolean): LoopRun {
    const run: LoopRun = {
      id: randomUUID(),
      loopId: loop.id,
      loopName: loop.name,
      scheduledFor,
      status: "queued",
      manual,
      loopRevision: loop.revision,
      createdAt: this.now(),
    };
    this.runs.push(run);
    this.trimRuns();
    return run;
  }

  private trimRuns(): void {
    while (this.runs.length > MAX_RUNS) {
      const removable = this.runs.findIndex((item) => item.status !== "queued" && item.status !== "running");
      if (removable < 0) break;
      this.runs.splice(removable, 1);
    }
  }

  private emitLoop(loop: Loop) {
    this.safeEmit({ kind: "loop", loop: cloneLoop(loop) });
  }

  private emitRun(run: LoopRun) {
    this.safeEmit({ kind: "loop.run", run: { ...run } });
  }

  /** Always an IANA zone. Gating this on `options.timezone` left production on
   * the local-Date branch, so the DST-aware path and its test were unreachable
   * from the running clock. `this.timezone` always resolves (option, saved file,
   * then host), and a zone that disagrees with the host pauses the clock rather
   * than firing in the wrong hour. */
  private zoneForClock(schedule?: LoopSchedule): string {
    return schedule?.timezone ?? this.timezone;
  }

  private readHistory<T>(read: () => T): T {
    this.assertWritable();
    try { return read(); }
    catch (error) {
      if ((error as { status?: number }).status === 503) this.hold(HISTORY_RECOVERY);
      throw error;
    }
  }

  private assertWritable(): void {
    if (this.recoveryDetail) throw Object.assign(new Error(this.recoveryDetail), { status: 503 });
  }

  private hold(detail: string): void {
    if (this.recoveryDetail) return;
    this.recoveryDetail = detail;
    this.stop();
    this.emitRecovery();
  }

  private emitRecovery(): void { this.safeEmit({ kind: "loops.recovery", recovery: this.recovery }); }

  private safeEmit(payload: unknown): void {
    try { this.options.emit?.(payload); }
    catch { console.warn("[schedule] A committed schedule update could not be delivered to an observer."); }
  }

  /** Synchronous mutations become executable and observable only after atomic
   * persistence. Preserve the disk's actual state if rename succeeded but its
   * durability confirmation failed; otherwise restore the known prior state. */
  private commit(change: () => void): void {
    this.assertWritable();
    const before = {
      loops: this.loops.map(cloneLoop), runs: this.runs.map((run) => ({ ...run })),
      handledThrough: new Map(this.handledThrough), overrides: new Map(this.overrides),
      revisions: new Map(this.revisions), savedState: this.savedState,
      recipeBase: new Map(this.recipeBase), clockEnabled: new Map(this.clockEnabled), recipeClockOk: new Set(this.recipeClockOk),
    };
    const restore = () => {
      this.loops = before.loops; this.runs = before.runs; this.handledThrough = before.handledThrough;
      this.overrides = before.overrides; this.revisions = before.revisions; this.savedState = before.savedState;
      this.recipeBase = before.recipeBase; this.clockEnabled = before.clockEnabled; this.recipeClockOk = before.recipeClockOk;
    };
    try { change(); } catch (error) { restore(); throw error; }
    const state: LoopsFile["state"] = {};
    for (const loop of this.loops) state[loop.id] = {
      enabled: recipeIdFromLoopId(loop.id) ? (this.clockEnabled.get(loop.id) ?? true) : loop.enabled,
      handledThrough: this.handledThrough.get(loop.id) ?? 0,
      schedule: this.overrides.get(loop.id) ?? undefined,
      revision: this.revisions.get(loop.id) ?? 1,
    };
    const saved: LoopsFile & { executionHistory: 1 } = { version: 3, executionHistory: 1, timezone: this.timezone, state, runs: this.runs };
    const contents = JSON.stringify(saved, null, 2);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      this.ledger!.save(this.runs, { timezone: this.timezone, state }, contents, () => writeFileAtomic(this.file, contents, 0o600));
      this.savedState = state;
    } catch {
      let written = false;
      try { written = readFileSync(this.file, "utf8") === contents; } catch { /* preserve known memory below */ }
      if (written) this.savedState = state;
      else restore();
      this.hold(WRITE_RECOVERY);
      this.assertWritable();
    }
  }

  /** Catalog + current taught jobs. Recipes can be added, paused, or deleted between ticks. */
  private refreshRecipeLoops(): void {
    if (this.recovery.active) return;
    let recipes: ReturnType<NonNullable<LoopManagerOptions["listRecipes"]>>;
    try { recipes = this.options.listRecipes?.() ?? []; }
    catch { this.hold(SOURCE_RECOVERY); return; }
    const paused = this.timezone !== this.hostTz;
    const wanted = new Map<
      LoopId,
      {
        recipe: Pick<
          Recipe,
          "id" | "title" | "status" | "schedule" | "planApprovedAt" | "revision" | "approvedRevision"
        >;
        catalog: LoopSchedule;
      }
    >();
    for (const recipe of recipes) {
      if (!recipe.schedule) continue;
      const time = parseClockTime(recipe.schedule.time);
      const weekdays = parseWeekdays(recipe.schedule.weekdays);
      if (!time || !weekdays) continue;
      wanted.set(recipeLoopId(recipe.id), { recipe, catalog: { type: "daily", time, weekdays } });
    }

    this.loops = this.loops.filter((loop) => !recipeIdFromLoopId(loop.id) || wanted.has(loop.id));
    this.recipeClockOk = new Set();

    for (const [id, { recipe, catalog }] of wanted) {
      this.recipeBase.set(id, catalog);
      const saved = this.savedState[id];
      if (!this.handledThrough.has(id)) {
        const handled = Number.isFinite(saved?.handledThrough) ? saved!.handledThrough : this.now() - 1;
        this.handledThrough.set(id, handled);
      }
      if (!this.overrides.has(id)) {
        const savedSchedule = saved?.schedule;
        const override =
          savedSchedule && parseClockTime(savedSchedule.time) && parseWeekdays(savedSchedule.weekdays)
            ? { time: savedSchedule.time, weekdays: parseWeekdays(savedSchedule.weekdays)!, ...(savedSchedule.timezone ? { timezone: savedSchedule.timezone } : {}) }
            : null;
        this.overrides.set(id, override);
      }
      if (!this.revisions.has(id)) {
        this.revisions.set(id, Number.isInteger(saved?.revision) ? saved!.revision! : 1);
      }
      if (!this.clockEnabled.has(id)) {
        this.clockEnabled.set(id, saved?.enabled !== false);
      }

      const override = this.overrides.get(id);
      const schedule: LoopSchedule = { type: "daily", ...(override ?? catalog) };
      const waitingForPlan = recipe.planApprovedAt == null || recipe.approvedRevision !== recipe.revision;
      const clockRunnable = recipeClockRunnable(recipe);
      const enabled = clockRunnable && this.clockEnabled.get(id) !== false;
      if (clockRunnable) this.recipeClockOk.add(id);
      const existing = this.loops.find((loop) => loop.id === id);
      if (existing) {
        existing.name = recipe.title;
        existing.schedule = schedule;
        existing.revision = this.revisions.get(id)!;
        existing.enabled = enabled;
        existing.timezonePaused = paused && !schedule.timezone;
        existing.waitingForPlan = waitingForPlan;
        existing.nextRunAt = enabled && (!paused || !!schedule.timezone) ? nextOccurrence(schedule, Math.max(this.now(), this.handledThrough.get(id) ?? 0), this.zoneForClock(schedule)) : null;
        continue;
      }
      this.loops.push({
        id,
        name: recipe.title,
        description: RECIPE_LOOP_DESCRIPTION,
        available: true,
        enabled,
        schedule,
        revision: this.revisions.get(id)!,
        evaluatorId: "recipe",
        evaluatorVersion: 1,
        timezonePaused: paused && !schedule.timezone,
        waitingForPlan,
        nextRunAt: enabled && (!paused || !!schedule.timezone) ? nextOccurrence(schedule, Math.max(this.now(), this.handledThrough.get(id) ?? 0), this.zoneForClock(schedule)) : null,
      });
    }
  }
}
