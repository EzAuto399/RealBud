// Named product loops on the RealBud clock. The injected executor resolves
// a code-owned evaluator and writes proposals through Desk. A loop never
// launches Cua, waits for approval, or performs a background handoff.
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";
import { RecoveryRequiredError, readRecoverableFile, writeRecoverableFile } from "./recoverable-file.ts";
import { evaluatorForLoop } from "./workflow-catalog.ts";
import type {
  Loop,
  LoopId,
  LoopRun,
  LoopRunStatus,
  LoopRunStep,
  LoopRunStepId,
  LoopRunStepStatus,
  LoopSchedule,
} from "../shared/contracts.ts";
import { redactSecretsInText } from "./redact.ts";

export type { Loop, LoopId, LoopRun, LoopRunStatus, LoopRunStep, LoopRunStepId, LoopRunStepStatus, LoopSchedule };

export interface LoopRunStepUpdate {
  id: LoopRunStepId;
  label: string;
  status: Exclude<LoopRunStepStatus, "interrupted">;
  detail?: string;
}

export type LoopRunReporter = (update: LoopRunStepUpdate) => void;

export interface LoopManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (payload: unknown) => void;
  timezone?: string;
  hostTimezone?: string;
  execute: (loop: Loop, run: LoopRun, report: LoopRunReporter) => Promise<{ ok: boolean; detail: string }>;
}

interface LoopsFile {
  version: 3;
  timezone: string;
  state: Record<
    string,
    { enabled: boolean; handledThrough: number; schedule?: { time: string; weekdays: number[] }; revision?: number }
  >;
  runs: LoopRun[];
}

export interface LoopRecoveryStatus {
  active: boolean;
  action: "none" | "restored-previous" | "attention";
  detail: string;
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const CATCH_UP_MS = 12 * 60 * 60_000;
const MAX_RUNS = 2_000;
const MAX_RUN_STEPS = 8;
const MAX_RUN_DETAIL = 500;
const MAX_STEP_DETAIL = 240;
const MAX_STEP_LABEL = 80;

const STEP_IDS = new Set<LoopRunStepId>(["preflight", "collect", "evaluate", "stage-desk"]);
const LOOP_IDS = new Set<LoopId>(["morning-arrears", "owner-letter", "inbound-triage"]);
const RUN_STATUSES = new Set<LoopRunStatus>(["queued", "running", "completed", "failed", "missed", "interrupted"]);
const STEP_STATUSES = new Set<LoopRunStepStatus>(["running", "completed", "failed", "skipped", "interrupted"]);

function cleanReceiptText(value: unknown, limit: number): string {
  return redactSecretsInText(typeof value === "string" ? value : String(value ?? ""))
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim()
    .slice(0, limit);
}

export function scheduledOccurrenceKey(loopId: LoopId, scheduledFor: number): string {
  return `scheduled:${loopId}:${Math.trunc(scheduledFor)}`;
}

function cloneRun(run: LoopRun): LoopRun {
  return { ...run, steps: run.steps?.map((step) => ({ ...step })) };
}

function cloneLoop(loop: Loop): Loop {
  return {
    ...loop,
    schedule: { ...loop.schedule, weekdays: [...loop.schedule.weekdays] },
    requirements: loop.requirements?.map((requirement) => ({ ...requirement })),
  };
}

function finiteTime(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeLoadedRun(value: unknown): LoopRun | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id.trim() || raw.id.length > 200) return null;
  if (typeof raw.loopId !== "string" || !LOOP_IDS.has(raw.loopId as LoopId)) return null;
  if (typeof raw.status !== "string" || !RUN_STATUSES.has(raw.status as LoopRunStatus)) return null;
  const scheduledFor = finiteTime(raw.scheduledFor);
  const createdAt = finiteTime(raw.createdAt);
  if (scheduledFor === undefined || createdAt === undefined || typeof raw.manual !== "boolean") return null;
  const loopId = raw.loopId as LoopId;
  const manual = raw.manual;
  const steps = Array.isArray(raw.steps)
    ? raw.steps.slice(0, MAX_RUN_STEPS).flatMap((value): LoopRunStep[] => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const step = value as Record<string, unknown>;
        if (typeof step.id !== "string" || !STEP_IDS.has(step.id as LoopRunStepId)) return [];
        if (typeof step.status !== "string" || !STEP_STATUSES.has(step.status as LoopRunStepStatus)) return [];
        const startedAt = finiteTime(step.startedAt);
        if (startedAt === undefined) return [];
        const label = cleanReceiptText(step.label, MAX_STEP_LABEL);
        if (!label) return [];
        const detail = cleanReceiptText(step.detail, MAX_STEP_DETAIL);
        const finishedAt = finiteTime(step.finishedAt);
        return [{
          id: step.id as LoopRunStepId,
          label,
          status: step.status as LoopRunStepStatus,
          ...(detail ? { detail } : {}),
          startedAt,
          ...(finishedAt === undefined ? {} : { finishedAt }),
        }];
      })
    : undefined;
  const detail = cleanReceiptText(raw.detail, MAX_RUN_DETAIL);
  const requestId = cleanReceiptText(raw.requestId, 200);
  const occurrenceKey = manual
    ? cleanReceiptText(raw.occurrenceKey, 240)
    : scheduledOccurrenceKey(loopId, scheduledFor);
  const routineRevision = Number.isInteger(raw.routineRevision) && Number(raw.routineRevision) > 0
    ? Number(raw.routineRevision)
    : undefined;
  const runStartedAt = finiteTime(raw.startedAt);
  const runFinishedAt = finiteTime(raw.finishedAt);
  const seenAt = finiteTime(raw.seenAt);
  const notifiedAt = finiteTime(raw.notifiedAt);
  return {
    id: raw.id.trim(),
    loopId,
    loopName: cleanReceiptText(raw.loopName, 120) || loopId,
    ...(requestId ? { requestId } : {}),
    ...(occurrenceKey ? { occurrenceKey } : {}),
    ...(routineRevision ? { routineRevision } : {}),
    scheduledFor,
    status: raw.status as LoopRunStatus,
    manual,
    ...(detail ? { detail } : {}),
    ...(steps?.length ? { steps } : {}),
    ...(runStartedAt === undefined ? {} : { startedAt: runStartedAt }),
    ...(runFinishedAt === undefined ? {} : { finishedAt: runFinishedAt }),
    ...(seenAt === undefined ? {} : { seenAt }),
    ...(notifiedAt === undefined ? {} : { notifiedAt }),
    createdAt,
  };
}

function decodeLoopsFile(raw: string): Partial<LoopsFile> & { version: number } {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("routine state is invalid");
  const file = parsed as Record<string, unknown>;
  if (!Number.isInteger(file.version) || Number(file.version) < 1 || Number(file.version) > 3) {
    throw new Error("routine state version is unsupported");
  }
  if (file.timezone !== undefined && typeof file.timezone !== "string") throw new Error("routine timezone is invalid");
  if (file.state !== undefined && (!file.state || typeof file.state !== "object" || Array.isArray(file.state))) {
    throw new Error("routine settings are invalid");
  }
  if (file.runs !== undefined && !Array.isArray(file.runs)) throw new Error("routine history is invalid");
  return file as unknown as Partial<LoopsFile> & { version: number };
}

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

export const LOOP_CATALOG: ReadonlyArray<Omit<Loop, "enabled" | "nextRunAt" | "timezonePaused" | "revision">> = [
  {
    id: "morning-arrears",
    name: "Morning money check",
    description:
      "The clock presses Desk Recheck. Sources are validated, shop rules run, and exception cards land on Desk. No portal session starts from the clock.",
    available: true,
    schedule: { type: "daily", time: "07:30", weekdays: WEEKDAYS },
    evaluatorId: "morning-money",
    evaluatorVersion: 1,
    requirements: [
      {
        id: "desk-book",
        label: "Desk book",
        purpose: "The properties and current recovery state this run works from.",
        setupTarget: "desk",
      },
      {
        id: "current-money-source",
        label: "Current money source",
        purpose: "A current PMS export is the authority for live balances; Demo stays practice-only.",
        setupTarget: "desk",
      },
    ],
  },
  {
    id: "owner-letter",
    name: "Friday owner letter",
    description:
      "Every Friday the clock drafts each owner a factual catch-up from the Desk book and Notes. You approve the wording and copy it out yourself.",
    available: true,
    schedule: { type: "daily", time: "16:00", weekdays: [5] },
    evaluatorId: "owner-letter",
    evaluatorVersion: 1,
    requirements: [
      {
        id: "desk-book",
        label: "Desk book",
        purpose: "Current property, case and optional Notes context for factual drafts.",
        setupTarget: "desk",
      },
      {
        id: "current-money-source",
        label: "Current money source",
        purpose: "Live owner wording stays held unless current PMS evidence supports it.",
        setupTarget: "desk",
      },
    ],
  },
  {
    id: "inbound-triage",
    name: "Inbound triage",
    description: "Mail in → classify → job + reply draft. Declared, not built.",
    available: false,
    schedule: { type: "daily", time: "09:00", weekdays: WEEKDAYS },
    evaluatorId: "inbound-triage",
    evaluatorVersion: 0,
    requirements: [
      {
        id: "desk-book",
        label: "Desk book",
        purpose: "Mail can only be linked to known portfolio records and Desk cases.",
        setupTarget: "desk",
      },
      {
        id: "read-only-mail",
        label: "Read-only mail",
        purpose: "One named office inbox, exact account and read-only operation list.",
        setupTarget: "connections",
      },
    ],
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
    if (candidate > after && weekdays.has(candWall.dow)) return candidate;
  }
  return null;
}

export class LoopManager {
  private readonly file: string;
  private readonly now: () => number;
  private readonly options: LoopManagerOptions;
  private loops: Loop[];
  private runs: LoopRun[] = [];
  private handledThrough = new Map<LoopId, number>();
  /** PM-retuned clocks; null means the catalog schedule still stands. */
  private overrides = new Map<LoopId, { time: string; weekdays: number[] } | null>();
  private revisions = new Map<LoopId, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private recovery: LoopRecoveryStatus = { active: false, action: "none", detail: "Routine state is protected." };
  timezone: string;
  private readonly hostTz: string;

  constructor(options: LoopManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "loops.json");
    this.now = options.now ?? Date.now;
    this.hostTz = options.hostTimezone ?? hostTimezone();
    const loaded = readRecoverableFile(this.file, decodeLoopsFile);
    const saved: Partial<LoopsFile> & { version?: number } = loaded.value ?? {};
    if (loaded.state === "restored") {
      this.recovery = {
        active: false,
        action: "restored-previous",
        detail: "RealBud restored the last verified routine clock. Review the next run times before relying on them.",
      };
    } else if (loaded.state === "blocked") {
      this.recovery = {
        active: true,
        action: "attention",
        detail: "Routine state could not be verified. The clock is paused and the original file was preserved.",
      };
    }
    this.timezone = options.timezone ?? saved.timezone ?? this.hostTz;
    const savedRuns = Array.isArray(saved.runs) ? saved.runs : [];
    this.runs = savedRuns.flatMap((run) => {
      const normalized = normalizeLoadedRun(run);
      return normalized ? [normalized] : [];
    });
    let runsChanged = this.runs.length !== savedRuns.length || savedRuns.some((run) => {
      if (!run || typeof run !== "object" || Array.isArray(run)) return true;
      const raw = run as unknown as Record<string, unknown>;
      return raw.manual === false && typeof raw.occurrenceKey !== "string";
    });
    for (const run of this.runs) {
      if (run.status === "queued" || run.status === "running") {
        run.status = "interrupted";
        run.finishedAt = this.now();
        run.detail = run.detail ?? "Interrupted on startup — not resumed mid-action";
        for (const step of run.steps ?? []) {
          if (step.status !== "running") continue;
          step.status = "interrupted";
          step.finishedAt = run.finishedAt;
          step.detail = step.detail ?? "Interrupted on startup — not replayed";
        }
        runsChanged = true;
      }
    }
    const savedState = saved.state ?? {};
    const paused = this.timezone !== this.hostTz;
    this.loops = LOOP_CATALOG.map((loop) => {
      const spec = evaluatorForLoop(loop.id);
      const savedEnabled = savedState[loop.id]?.enabled;
      const enabled = !this.recovery.active && loop.available && (
        savedEnabled === undefined ? loop.id === "morning-arrears" : savedEnabled
      );
      const handled = Number.isFinite(savedState[loop.id]?.handledThrough)
        ? savedState[loop.id]!.handledThrough
        : this.now() - 1;
      this.handledThrough.set(loop.id, Math.min(handled, this.now() - 1));
      // v2 files carry no per-loop clock; the catalog schedule migrates as-is
      // and the first retune bumps revision from its initial 1.
      const savedSchedule = savedState[loop.id]?.schedule;
      const override =
        savedSchedule && parseClockTime(savedSchedule.time) && parseWeekdays(savedSchedule.weekdays)
          ? { time: savedSchedule.time, weekdays: parseWeekdays(savedSchedule.weekdays)! }
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
        timezonePaused: paused,
        nextRunAt: enabled && !paused ? nextOccurrence(schedule, this.now(), this.zoneForClock()) : null,
      };
    });
    if (runsChanged && !this.recovery.active) this.save();
  }

  recoveryStatus(): LoopRecoveryStatus {
    return { ...this.recovery };
  }

  private assertWritable(): void {
    if (!this.recovery.active) return;
    throw new RecoveryRequiredError("Routine state needs recovery. The clock and manual runs remain paused.");
  }

  listLoops(): Loop[] {
    return this.loops.map(cloneLoop);
  }

  listRuns(from?: number, to?: number): LoopRun[] {
    return this.runs
      .filter((run) => (from == null || run.scheduledFor >= from) && (to == null || run.scheduledFor <= to))
      .sort((a, b) => b.scheduledFor - a.scheduledFor)
      .map(cloneRun);
  }

  activeRun(loopId: LoopId): LoopRun | null {
    const run = this.runs.find((r) => r.loopId === loopId && ["queued", "running"].includes(r.status));
    return run ? cloneRun(run) : null;
  }

  /** One door for clock changes: enabled, time, weekdays. Every accepted
   * change bumps revision and recomputes nextRunAt strictly forward — a
   * retune never backfills an already-passed slot. An idempotent PATCH
   * (values identical to current) is acknowledged without touching the
   * bookmark or revision, so it can never swallow a pending slot. */
  patchClock(id: LoopId, patch: { enabled?: boolean; time?: string; weekdays?: number[]; expectedRevision?: number }): Loop {
    this.assertWritable();
    const loop = this.loops.find((candidate) => candidate.id === id);
    if (!loop) throw Object.assign(new Error("no such loop"), { status: 404 });
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== loop.revision) {
      throw Object.assign(new Error("stale routine revision"), { status: 409, code: "revision-conflict" });
    }
    if (patch.enabled !== undefined && typeof patch.enabled !== "boolean") {
      throw Object.assign(new Error("enabled must be true or false"), { status: 400 });
    }
    const wantsEnable = patch.enabled !== undefined && patch.enabled !== loop.enabled;
    if (wantsEnable && !loop.available) throw new Error("that loop is declared but not built yet");
    if (patch.enabled === undefined && patch.time === undefined && patch.weekdays === undefined) {
      throw Object.assign(new Error("nothing to change — send enabled, time, or weekdays"), { status: 400 });
    }
    if (patch.time !== undefined && !parseClockTime(patch.time)) {
      throw Object.assign(new Error("time must be HH:MM (00:00–23:59)"), { status: 400 });
    }
    if (patch.weekdays !== undefined && !parseWeekdays(patch.weekdays)) {
      throw Object.assign(new Error("weekdays must be a non-empty list of numbers 0–6"), { status: 400 });
    }
    const currentOverride = this.overrides.get(id);
    const nextTime = patch.time ?? currentOverride?.time ?? loop.schedule.time;
    // compare by content: catalog arrays are shared references
    const nextDays = (patch.weekdays ?? currentOverride?.weekdays ?? loop.schedule.weekdays).slice().sort((a, b) => a - b);
    const clockChanged =
      (patch.time !== undefined || patch.weekdays !== undefined) &&
      (nextTime !== loop.schedule.time || nextDays.join(",") !== loop.schedule.weekdays.join(","));
    if (clockChanged) {
      this.overrides.set(id, { time: nextTime, weekdays: nextDays });
      // the new clock starts from now: no backfill of earlier slots today
      this.handledThrough.set(id, Math.max(this.handledThrough.get(id) ?? 0, this.now()));
    }
    if (!clockChanged && !wantsEnable) {
      return cloneLoop(loop);
    }
    if (wantsEnable) loop.enabled = patch.enabled!;
    loop.schedule = { type: "daily", ...(this.overrides.get(id) ?? LOOP_CATALOG.find((l) => l.id === id)!.schedule) };
    loop.revision = (this.revisions.get(id) ?? 1) + 1;
    this.revisions.set(id, loop.revision);
    loop.nextRunAt =
      loop.enabled && !loop.timezonePaused ? nextOccurrence(loop.schedule, this.now(), this.zoneForClock()) : null;
    this.save();
    this.emitLoop(loop);
    return cloneLoop(loop);
  }

  setEnabled(id: LoopId, enabled: boolean): Loop {
    return this.patchClock(id, { enabled });
  }

  runNow(id: LoopId, requestId?: string): LoopRun | null {
    this.assertWritable();
    const loop = this.loops.find((candidate) => candidate.id === id);
    if (!loop || !loop.available || !loop.enabled) return null;
    if (requestId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/.test(requestId)) {
      throw Object.assign(new Error("routine request id is invalid"), { status: 400, code: "invalid-idempotency-key" });
    }
    if (requestId) {
      const existing = this.runs.find((run) => run.requestId === requestId);
      if (existing && existing.loopId !== id) {
        throw Object.assign(new Error("that routine request id is already bound to another routine"), {
          status: 409,
          code: "idempotency-conflict",
        });
      }
      if (existing) return cloneRun(existing);
    }
    if (this.activeRun(id)) throw Object.assign(new Error("this loop is already running"), { status: 409 });
    const run = this.newRun(loop, this.now(), true, requestId);
    this.save();
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return cloneRun(run);
  }

  markSeen(id: string): LoopRun | null {
    this.assertWritable();
    const run = this.runs.find((candidate) => candidate.id === id);
    if (!run) return null;
    if (!run.seenAt) {
      run.seenAt = this.now();
      this.save();
      this.emitRun(run);
    }
    return cloneRun(run);
  }

  /** Durable notification receipt. The renderer calls this only after the
   * desktop shell accepted the privacy-safe reminder. It is idempotent so a
   * reconnect cannot create a second receipt, and an active run cannot be
   * prematurely silenced. */
  markNotified(id: string): LoopRun | null {
    this.assertWritable();
    const run = this.runs.find((candidate) => candidate.id === id);
    if (!run) return null;
    if (run.status === "queued" || run.status === "running") {
      throw Object.assign(new Error("a running routine cannot be marked notified"), { status: 409 });
    }
    if (!run.notifiedAt) {
      run.notifiedAt = this.now();
      this.save();
      this.emitRun(run);
    }
    return cloneRun(run);
  }

  start() {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), 10_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.recovery.active) return;
    if (this.ticking) return;
    this.ticking = true;
    try {
      const now = this.now();
      let changed = false;
      for (const loop of this.loops) {
        if (!loop.enabled || !loop.available) continue;
        if (loop.timezonePaused) {
          loop.nextRunAt = null;
          this.emitLoop(loop);
          continue;
        }
        const handled = this.handledThrough.get(loop.id) ?? now - 1;
        for (
          let at = nextOccurrence(loop.schedule, handled, this.zoneForClock());
          at != null && at <= now;
          at = nextOccurrence(loop.schedule, at, this.zoneForClock())
        ) {
          const occurrenceKey = scheduledOccurrenceKey(loop.id, at);
          const existing = this.runs.find((run) => run.occurrenceKey === occurrenceKey);
          const late = now - at;
          if (existing) {
            // The effect owner persisted this occurrence before any work.
            // A stale bookmark after a crash may rediscover the clock slot,
            // but it must never replay or create a duplicate run.
          } else if (late > CATCH_UP_MS) {
            const missed = this.newRun(loop, at, false);
            missed.status = "missed";
            missed.finishedAt = now;
            missed.detail = "This computer was offline for more than 12 hours after the scheduled time";
            this.save();
            this.emitRun(missed);
          } else if (this.runs.some((run) => run.loopId === loop.id && (run.status === "queued" || run.status === "running"))) {
            const missed = this.newRun(loop, at, false);
            missed.status = "missed";
            missed.finishedAt = now;
            missed.detail = "Not started because the previous run was still active. RealBud never overlaps a routine.";
            this.save();
            this.emitRun(missed);
          } else {
            const run = this.newRun(loop, at, false);
            this.emitRun(run);
            await this.executeRun(run, loop);
          }
          // never rewind the bookmark: a retune that landed mid-execution
          // clamped it forward, and this slot's time is already stale
          this.handledThrough.set(loop.id, Math.max(this.handledThrough.get(loop.id) ?? 0, at));
          changed = true;
        }
        loop.nextRunAt = loop.enabled
          ? nextOccurrence(loop.schedule, Math.max(now, this.handledThrough.get(loop.id) ?? handled), this.zoneForClock())
          : null;
        this.emitLoop(loop);
      }
      for (const run of [...this.runs].reverse()) {
        if (run.status !== "queued") continue;
        const loop = this.loops.find((candidate) => candidate.id === run.loopId);
        if (!loop || !loop.available) {
          run.status = "failed";
          run.finishedAt = now;
          run.detail = "this loop no longer exists";
          this.emitRun(run);
          continue;
        }
        await this.executeRun(run, loop);
      }
      if (changed) this.save();
    } finally {
      this.ticking = false;
    }
  }

  private async executeRun(run: LoopRun, loop: Loop) {
    run.startedAt = this.now();
    run.status = "running";
    this.applyStep(run, {
      id: "preflight",
      label: "Check routine readiness",
      status: "running",
      detail: run.manual ? "Started by the PM" : "Started by RealBud's clock",
    });
    this.save();
    this.emitRun(run);
    try {
      const report: LoopRunReporter = (update) => {
        this.applyStep(run, update);
        this.save();
        this.emitRun(run);
      };
      const { ok, detail } = await this.options.execute(cloneLoop(loop), cloneRun(run), report);
      run.status = ok ? "completed" : "failed";
      run.detail = cleanReceiptText(detail, MAX_RUN_DETAIL);
      this.settleOpenSteps(run, ok, run.detail);
    } catch (error) {
      run.status = "failed";
      run.detail = cleanReceiptText(error instanceof Error ? error.message : String(error), MAX_RUN_DETAIL);
      this.settleOpenSteps(run, false, run.detail);
    }
    run.finishedAt = this.now();
    this.save();
    this.emitRun(run);
  }

  private applyStep(run: LoopRun, update: LoopRunStepUpdate): void {
    if (!STEP_IDS.has(update.id)) throw new Error("unknown routine receipt step");
    const label = cleanReceiptText(update.label, MAX_STEP_LABEL);
    if (!label) throw new Error("routine receipt step label is required");
    const detail = cleanReceiptText(update.detail, MAX_STEP_DETAIL);
    const steps = run.steps ?? (run.steps = []);
    let step = steps.find((candidate) => candidate.id === update.id);
    if (!step) {
      if (steps.length >= MAX_RUN_STEPS) throw new Error("routine receipt step limit exceeded");
      step = {
        id: update.id,
        label,
        status: update.status,
        ...(detail ? { detail } : {}),
        startedAt: this.now(),
        ...(update.status === "running" ? {} : { finishedAt: this.now() }),
      };
      steps.push(step);
      return;
    }
    if (step.status !== "running" && step.status !== update.status) {
      throw new Error("a settled routine receipt step cannot be reopened");
    }
    step.label = label;
    step.status = update.status;
    if (detail) step.detail = detail;
    else delete step.detail;
    if (update.status === "running") delete step.finishedAt;
    else step.finishedAt = this.now();
  }

  private settleOpenSteps(run: LoopRun, ok: boolean, detail: string): void {
    for (const step of run.steps ?? []) {
      if (step.status !== "running") continue;
      step.status = ok ? "completed" : "failed";
      step.finishedAt = this.now();
      if (!step.detail || !ok) step.detail = cleanReceiptText(detail, MAX_STEP_DETAIL) || (ok ? "Completed" : "Failed");
    }
  }

  private newRun(loop: Loop, scheduledFor: number, manual: boolean, requestId?: string): LoopRun {
    const run: LoopRun = {
      id: randomUUID(),
      loopId: loop.id,
      loopName: loop.name,
      ...(requestId ? { requestId } : {}),
      ...(!manual ? { occurrenceKey: scheduledOccurrenceKey(loop.id, scheduledFor) } : {}),
      routineRevision: loop.revision,
      scheduledFor,
      status: "queued",
      manual,
      createdAt: this.now(),
    };
    this.runs.push(run);
    if (this.runs.length > MAX_RUNS) this.runs.splice(0, this.runs.length - MAX_RUNS);
    return run;
  }

  private emitLoop(loop: Loop) {
    this.options.emit?.({ kind: "loop", loop: cloneLoop(loop) });
  }

  private emitRun(run: LoopRun) {
    this.options.emit?.({ kind: "loop.run", run: cloneRun(run) });
  }

  private zoneForClock(): string | undefined {
    return this.options.timezone ? this.timezone : undefined;
  }

  private save() {
    this.assertWritable();
    mkdirSync(dirname(this.file), { recursive: true });
    const state: LoopsFile["state"] = {};
    for (const loop of this.loops) {
      state[loop.id] = {
        enabled: loop.enabled,
        handledThrough: this.handledThrough.get(loop.id) ?? 0,
        schedule: this.overrides.get(loop.id) ?? undefined,
        revision: this.revisions.get(loop.id) ?? 1,
      };
    }
    writeRecoverableFile(
      this.file,
      JSON.stringify({ version: 3, timezone: this.timezone, state, runs: this.runs } satisfies LoopsFile, null, 2),
      decodeLoopsFile,
    );
  }
}
