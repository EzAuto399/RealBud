// Named product loops on the RealBud clock. RealBud owns WHEN and what the
// human sees; Hermes owns HOW (facts only, headless, cron_mode: deny). A
// loop is "Desk, but the clock pressed Recheck" — never a second agent, no
// free-text prompt, no MAUS roster. The OpenMausBot routine runner is gone.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DATA_DIR } from "./config.ts";

export type LoopId = "morning-arrears" | "owner-letter" | "inbound-triage";

export type LoopSchedule = { type: "daily"; time: string; weekdays: number[] };

export type LoopRunStatus = "queued" | "running" | "completed" | "failed" | "missed";

export interface Loop {
  id: LoopId;
  name: string;
  description: string;
  /** available = built and runnable now; false = declared, coming later. */
  available: boolean;
  enabled: boolean;
  schedule: LoopSchedule;
  nextRunAt: number | null;
}

export interface LoopRun {
  id: string;
  loopId: LoopId;
  loopName: string;
  scheduledFor: number;
  status: LoopRunStatus;
  manual: boolean;
  /** handsDetail of the desk check, or the failure reason. */
  detail?: string;
  startedAt?: number;
  finishedAt?: number;
  seenAt?: number;
  createdAt: number;
}

export interface LoopManagerOptions {
  file?: string;
  now?: () => number;
  emit?: (payload: unknown) => void;
  /** Runs one loop. Return the one-line detail to show on the run receipt. */
  execute: (loop: Loop) => Promise<{ ok: boolean; detail: string }>;
}

interface LoopsFile {
  version: 1;
  /** enabled flags + handledThrough per loop id (catalog owns the rest). */
  state: Record<string, { enabled: boolean; handledThrough: number }>;
  runs: LoopRun[];
}

const WEEKDAYS = [1, 2, 3, 4, 5];
const CATCH_UP_MS = 12 * 60 * 60_000;
const MAX_RUNS = 2_000;

/** Fixed product catalog. Hermes does not invent the clock. */
export const LOOP_CATALOG: ReadonlyArray<Omit<Loop, "enabled" | "nextRunAt">> = [
  {
    id: "morning-arrears",
    name: "Morning arrears",
    description:
      "The clock presses Desk Recheck. Hermes reads the ledger, RealBud applies the shop rules, and courtesy drafts, levy flags, and escalations land on Desk for you to allow or deny.",
    available: true,
    schedule: { type: "daily", time: "07:30", weekdays: WEEKDAYS },
  },
  {
    id: "owner-letter",
    name: "Friday owner letter",
    description:
      "Same path, different skill. Hermes reads jobs, arrears, and inspections; RealBud drafts the owner catch-up. Declared, not built — lands after the first paid loop is chosen.",
    available: false,
    schedule: { type: "daily", time: "16:00", weekdays: [5] },
  },
  {
    id: "inbound-triage",
    name: "Inbound triage",
    description:
      "Mail in → classify → job + reply draft. Declared, not built.",
    available: false,
    schedule: { type: "daily", time: "09:00", weekdays: WEEKDAYS },
  },
];

export function nextOccurrence(schedule: LoopSchedule, after: number): number | null {
  const [hour, minute] = schedule.time.split(":").map(Number);
  const weekdays = new Set(schedule.weekdays);
  for (let offset = 0; offset <= 8; offset++) {
    const d = new Date(after);
    d.setDate(d.getDate() + offset);
    d.setHours(hour, minute, 0, 0);
    if (d.getTime() > after && weekdays.has(d.getDay())) return d.getTime();
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
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(options: LoopManagerOptions) {
    this.options = options;
    this.file = options.file ?? join(DATA_DIR, "loops.json");
    this.now = options.now ?? Date.now;
    let saved: Partial<LoopsFile> = {};
    try {
      saved = JSON.parse(readFileSync(this.file, "utf8")) as Partial<LoopsFile>;
    } catch {
      /* first run */
    }
    this.runs = Array.isArray(saved.runs) ? saved.runs : [];
    const savedState = saved.state ?? {};
    this.loops = LOOP_CATALOG.map((loop) => {
      const enabled = loop.available && savedState[loop.id]?.enabled !== false;
      const handled = Number.isFinite(savedState[loop.id]?.handledThrough)
        ? savedState[loop.id]!.handledThrough
        : this.now() - 1;
      this.handledThrough.set(loop.id, Math.min(handled, this.now() - 1));
      return {
        ...loop,
        schedule: { ...loop.schedule },
        enabled,
        nextRunAt: enabled ? nextOccurrence(loop.schedule, this.now()) : null,
      };
    });
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

  setEnabled(id: LoopId, enabled: boolean): Loop {
    const loop = this.loops.find((candidate) => candidate.id === id);
    if (!loop || !loop.available) throw new Error("that loop cannot be toggled");
    loop.enabled = enabled;
    loop.nextRunAt = enabled ? nextOccurrence(loop.schedule, this.now()) : null;
    this.save();
    this.emitLoop(loop);
    return { ...loop, schedule: { ...loop.schedule } };
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
        const handled = this.handledThrough.get(loop.id) ?? now - 1;
        for (let at = nextOccurrence(loop.schedule, handled); at != null && at <= now; at = nextOccurrence(loop.schedule, at)) {
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
          this.handledThrough.set(loop.id, at);
          changed = true;
        }
        loop.nextRunAt = loop.enabled ? nextOccurrence(loop.schedule, Math.max(now, this.handledThrough.get(loop.id) ?? handled)) : null;
        this.emitLoop(loop);
      }
      // manual runs queue themselves, then tick; drain them here
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

  private save() {
    mkdirSync(dirname(this.file), { recursive: true });
    const state: LoopsFile["state"] = {};
    for (const loop of this.loops) {
      state[loop.id] = { enabled: loop.enabled, handledThrough: this.handledThrough.get(loop.id) ?? 0 };
    }
    const payload = JSON.stringify({ version: 1, state, runs: this.runs } satisfies LoopsFile, null, 2);
    const temp = `${this.file}.tmp`;
    writeFileSync(temp, payload);
    renameSync(temp, this.file);
  }
}
