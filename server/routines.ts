// Named product loops on the RealBud clock. The injected executor resolves
// a code-owned evaluator and writes proposals through Desk. A loop never
// launches Cua, waits for approval, or performs a background handoff.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomic.ts";
import { DATA_DIR } from "./config.ts";
import { evaluatorForLoop } from "./workflow-catalog.ts";
import type { Loop, LoopId, LoopRun, LoopRunStatus, LoopSchedule } from "../shared/contracts.ts";

export type { Loop, LoopId, LoopRun, LoopRunStatus, LoopSchedule };

export interface LoopManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (payload: unknown) => void;
  timezone?: string;
  hostTimezone?: string;
  execute: (loop: Loop) => Promise<{ ok: boolean; detail: string }>;
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

const WEEKDAYS = [1, 2, 3, 4, 5];
const CATCH_UP_MS = 12 * 60 * 60_000;
const MAX_RUNS = 2_000;

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
  },
  {
    id: "inbound-triage",
    name: "Inbound triage",
    description: "Mail in → classify → job + reply draft. Declared, not built.",
    available: false,
    schedule: { type: "daily", time: "09:00", weekdays: WEEKDAYS },
    evaluatorId: "inbound-triage",
    evaluatorVersion: 0,
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
  timezone: string;
  private readonly hostTz: string;

  constructor(options: LoopManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "loops.json");
    this.now = options.now ?? Date.now;
    this.hostTz = options.hostTimezone ?? hostTimezone();
    let saved: Partial<LoopsFile> & { version?: number } = {};
    try {
      saved = JSON.parse(readFileSync(this.file, "utf8")) as Partial<LoopsFile>;
    } catch {
      /* first run */
    }
    this.timezone = options.timezone ?? saved.timezone ?? this.hostTz;
    this.runs = Array.isArray(saved.runs) ? saved.runs : [];
    for (const run of this.runs) {
      if (run.status === "queued" || run.status === "running") {
        run.status = "interrupted";
        run.finishedAt = this.now();
        run.detail = run.detail ?? "Interrupted on startup — not resumed mid-action";
      }
    }
    const savedState = saved.state ?? {};
    const paused = this.timezone !== this.hostTz;
    this.loops = LOOP_CATALOG.map((loop) => {
      const spec = evaluatorForLoop(loop.id);
      const enabled = loop.available && savedState[loop.id]?.enabled !== false;
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
    if (this.runs.some((r) => r.status === "interrupted")) this.save();
  }

  listLoops(): Loop[] {
    return this.loops.map((loop) => ({ ...loop, schedule: { ...loop.schedule } }));
  }

  listRuns(from?: number, to?: number): LoopRun[] {
    return this.runs
      .filter((run) => (from == null || run.scheduledFor >= from) && (to == null || run.scheduledFor <= to))
      .sort((a, b) => b.scheduledFor - a.scheduledFor)
      .map((run) => ({ ...run }));
  }

  activeRun(loopId: LoopId): LoopRun | null {
    const run = this.runs.find((r) => r.loopId === loopId && ["queued", "running"].includes(r.status));
    return run ? { ...run } : null;
  }

  /** One door for clock changes: enabled, time, weekdays. Every accepted
   * change bumps revision and recomputes nextRunAt strictly forward — a
   * retune never backfills an already-passed slot. An idempotent PATCH
   * (values identical to current) is acknowledged without touching the
   * bookmark or revision, so it can never swallow a pending slot. */
  patchClock(id: LoopId, patch: { enabled?: boolean; time?: string; weekdays?: number[] }): Loop {
    const loop = this.loops.find((candidate) => candidate.id === id);
    if (!loop) throw Object.assign(new Error("no such loop"), { status: 404 });
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
      return { ...loop, schedule: { ...loop.schedule } };
    }
    if (wantsEnable) loop.enabled = patch.enabled!;
    loop.schedule = { type: "daily", ...(this.overrides.get(id) ?? LOOP_CATALOG.find((l) => l.id === id)!.schedule) };
    loop.revision = (this.revisions.get(id) ?? 1) + 1;
    this.revisions.set(id, loop.revision);
    loop.nextRunAt =
      loop.enabled && !loop.timezonePaused ? nextOccurrence(loop.schedule, this.now(), this.zoneForClock()) : null;
    this.save();
    this.emitLoop(loop);
    return { ...loop, schedule: { ...loop.schedule } };
  }

  setEnabled(id: LoopId, enabled: boolean): Loop {
    return this.patchClock(id, { enabled });
  }

  runNow(id: LoopId): LoopRun | null {
    const loop = this.loops.find((candidate) => candidate.id === id);
    if (!loop || !loop.available || !loop.enabled) return null;
    if (this.activeRun(id)) throw Object.assign(new Error("this loop is already running"), { status: 409 });
    const run = this.newRun(loop, this.now(), true);
    this.save();
    this.emitRun(run);
    queueMicrotask(() => void this.tick());
    return { ...run };
  }

  markSeen(id: string): LoopRun | null {
    const run = this.runs.find((candidate) => candidate.id === id);
    if (!run) return null;
    if (!run.seenAt) {
      run.seenAt = this.now();
      this.save();
      this.emitRun(run);
    }
    return { ...run };
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
          const late = now - at;
          if (late > CATCH_UP_MS) {
            const missed = this.newRun(loop, at, false);
            missed.status = "missed";
            missed.finishedAt = now;
            missed.detail = "This computer was offline for more than 12 hours after the scheduled time";
            this.emitRun(missed);
          } else if (!this.activeRun(loop.id)) {
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
    this.save();
    this.emitRun(run);
    try {
      const { ok, detail } = await this.options.execute(loop);
      run.status = ok ? "completed" : "failed";
      run.detail = detail.slice(0, 500);
    } catch (error) {
      run.status = "failed";
      run.detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    }
    run.finishedAt = this.now();
    this.save();
    this.emitRun(run);
  }

  private newRun(loop: Loop, scheduledFor: number, manual: boolean): LoopRun {
    const run: LoopRun = {
      id: randomUUID(),
      loopId: loop.id,
      loopName: loop.name,
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
    this.options.emit?.({ kind: "loop", loop: { ...loop, schedule: { ...loop.schedule } } });
  }

  private emitRun(run: LoopRun) {
    this.options.emit?.({ kind: "loop.run", run: { ...run } });
  }

  private zoneForClock(): string | undefined {
    return this.options.timezone ? this.timezone : undefined;
  }

  private save() {
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
    writeFileAtomic(
      this.file,
      JSON.stringify({ version: 3, timezone: this.timezone, state, runs: this.runs } satisfies LoopsFile, null, 2),
    );
  }
}
