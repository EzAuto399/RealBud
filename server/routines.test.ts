import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { LOOP_CATALOG, LoopManager, nextOccurrence, type Loop, type LoopManagerOptions, type LoopRun } from "./routines.ts";

const dirs: string[] = [];

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "realbud-loops-"));
  dirs.push(dir);
  return join(dir, "loops.json");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("nextOccurrence", () => {
  const schedule = { type: "daily" as const, time: "07:30", weekdays: [1, 2, 3, 4, 5] };
  // 2026-08-18 is a Tuesday
  const tue = new Date(2026, 7, 18, 8, 0, 0).getTime();

  it("finds the next weekday occurrence strictly after the anchor", () => {
    const next = nextOccurrence(schedule, tue);
    expect(next).toBe(new Date(2026, 7, 19, 7, 30, 0).getTime());
  });

  it("skips weekends", () => {
    const fri = new Date(2026, 7, 21, 8, 0, 0).getTime();
    expect(nextOccurrence(schedule, fri)).toBe(new Date(2026, 7, 24, 7, 30, 0).getTime());
  });
});

function makeManager(options: Partial<LoopManagerOptions> & { execute?: LoopManagerOptions["execute"] } = {}) {
  const calls: Loop[] = [];
  const runs: LoopRun[] = [];
  const manager = new LoopManager({
    file: tempFile(),
    now: () => options.now?.() ?? Date.now(),
    emit: (payload) => {
      if (payload && typeof payload === "object" && (payload as { kind?: string }).kind === "loop.run") {
        runs.push((payload as { run: LoopRun }).run);
      }
    },
    execute:
      options.execute ??
      (async (loop) => {
        calls.push(loop);
        return { ok: true, detail: "desk check done — 2 drafts waiting" };
      }),
  });
  return { manager, calls, runs };
}

describe("LoopManager catalog", () => {
  it("declares the three named loops; morning-arrears and owner-letter are available", () => {
    const { manager } = makeManager();
    const loops = manager.listLoops();
    expect(loops.map((loop) => loop.id)).toEqual(["morning-arrears", "owner-letter", "inbound-triage"]);
    expect(loops[0]).toMatchObject({ available: true, enabled: true, name: "Morning money check" });
    expect(loops[1]).toMatchObject({ available: true, enabled: true });
    expect(loops[2]).toMatchObject({ available: false, enabled: false });
    expect(loops[0].nextRunAt).not.toBeNull();
    expect(loops[1].nextRunAt).not.toBeNull();
    expect(loops[2].nextRunAt).toBeNull();
  });

  it("names the agency inbox on inbound and keeps Hermes out of routine copy", () => {
    const { manager } = makeManager();
    const inbound = manager.listLoops().find((loop) => loop.id === "inbound-triage");
    expect(inbound?.description).toMatch(/Microsoft 365|Gmail/);
    expect(JSON.stringify(manager.listLoops().map((loop) => loop.description))).not.toMatch(/Hermes/i);
  });

  it("refuses to enable or run a loop that is not available yet; owner-letter v0 runs", () => {
    const { manager, calls } = makeManager();
    expect(() => manager.setEnabled("inbound-triage", true)).toThrow(/not built yet/);
    expect(manager.runNow("inbound-triage")).toBeNull();
    // owner-letter v0 is built: Run now goes through the injected executor
    const run = manager.runNow("owner-letter");
    expect(run).not.toBeNull();
    void manager.tick();
    expect(calls.some((loop) => loop.id === "owner-letter")).toBe(true);
  });

  it("persists the enabled flag across reloads", () => {
    const file = tempFile();
    const first = new LoopManager({
      file,
      execute: async () => ({ ok: true, detail: "" }),
    });
    first.setEnabled("morning-arrears", false);
    const second = new LoopManager({ file, execute: async () => ({ ok: true, detail: "" }) });
    expect(second.listLoops().find((loop) => loop.id === "morning-arrears")?.enabled).toBe(false);
  });

  it("survives a corrupt loops.json and still declares the catalog", () => {
    const file = tempFile();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "not json {{{");
    const manager = new LoopManager({ file, execute: async () => ({ ok: true, detail: "" }) });
    const loops = manager.listLoops();
    expect(loops.map((loop) => loop.id)).toEqual(["morning-arrears", "owner-letter", "inbound-triage"]);
    expect(loops.find((loop) => loop.id === "morning-arrears")?.enabled).toBe(true);
    expect(manager.listRuns()).toEqual([]);
  });
});

describe("LoopManager runs", () => {
  it("runNow executes the loop and records the detail", async () => {
    const { manager, calls, runs } = makeManager();
    const run = manager.runNow("morning-arrears");
    expect(run).not.toBeNull();
    await manager.tick();
    expect(calls.map((loop) => loop.id)).toEqual(["morning-arrears"]);
    const settled = manager.listRuns().find((r) => r.id === run!.id);
    expect(settled?.status).toBe("completed");
    expect(settled?.detail).toBe("desk check done — 2 drafts waiting");
    expect(runs.some((r) => r.id === run!.id && r.status === "completed")).toBe(true);
  });

  it("refuses a second run while one is queued or running", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { manager } = makeManager({
      execute: async () => {
        await gate;
        return { ok: true, detail: "" };
      },
    });
    manager.runNow("morning-arrears");
    expect(() => manager.runNow("morning-arrears")).toThrow(/already running/);
    release();
    await manager.tick();
  });

  it("runs a due scheduled occurrence once, and not again", async () => {
    // 2026-08-18 is a Tuesday. The app is open: watch the clock cross 07:30.
    let now = new Date(2026, 7, 18, 7, 29, 0).getTime();
    const { manager, calls } = makeManager({ now: () => now });
    await manager.tick();
    expect(calls).toHaveLength(0);
    now = new Date(2026, 7, 18, 7, 31, 0).getTime();
    await manager.tick();
    expect(calls).toHaveLength(1);
    await manager.tick();
    expect(calls).toHaveLength(1);
    const run = manager.listRuns()[0];
    expect(run.manual).toBe(false);
    expect(run.scheduledFor).toBe(new Date(2026, 7, 18, 7, 30, 0).getTime());
  });

  it("marks a run missed when the tick is more than 12 hours late", async () => {
    // boot with handledThrough 20h behind the anchor so the 07:30 tick
    // on the anchor day is discovered late
    const anchor = new Date(2026, 7, 18, 7, 30, 0).getTime();
    const now = anchor + 20 * 60 * 60_000;
    const file = tempFile();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        state: { "morning-arrears": { enabled: true, handledThrough: anchor - 24 * 60 * 60_000 } },
        runs: [],
      }),
    );
    const manager = new LoopManager({ file, now: () => now, execute: async () => ({ ok: true, detail: "" }) });
    await manager.tick();
    const runs = manager.listRuns();
    expect(runs.some((run) => run.status === "missed")).toBe(true);
    expect(runs.some((run) => run.status === "completed")).toBe(false);
  });

  it("markSeen sets seenAt exactly once", async () => {
    const { manager } = makeManager();
    const run = manager.runNow("morning-arrears")!;
    await manager.tick();
    const marked = manager.markSeen(run.id)!;
    const again = manager.markSeen(run.id)!;
    expect(marked.seenAt).toBeDefined();
    expect(again.seenAt).toBe(marked.seenAt);
  });

  it("never exposes Hermes cron or send paths in the catalog", () => {
    const { manager } = makeManager();
    for (const loop of manager.listLoops()) {
      expect(loop).not.toHaveProperty("prompt");
      expect(loop).not.toHaveProperty("botId");
      expect(loop).not.toHaveProperty("runOn");
    }
    expect(LOOP_CATALOG.every((loop) => !/send|pay|cron/i.test(loop.description + loop.name))).toBe(true);
  });

  it("marks persisted queued and running runs as interrupted on startup", () => {
    const file = tempFile();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        timezone: "Australia/Sydney",
        state: { "morning-arrears": { enabled: true, handledThrough: Date.now() } },
        runs: [
          {
            id: "run-queued",
            loopId: "morning-arrears",
            loopName: "Morning money check",
            scheduledFor: Date.now() - 1000,
            status: "queued",
            manual: false,
            createdAt: Date.now() - 1000,
          },
          {
            id: "run-running",
            loopId: "morning-arrears",
            loopName: "Morning money check",
            scheduledFor: Date.now() - 500,
            status: "running",
            manual: false,
            createdAt: Date.now() - 500,
          },
        ],
      }),
    );
    const manager = new LoopManager({ file, execute: async () => ({ ok: true, detail: "" }) });
    const runs = manager.listRuns();
    expect(runs.every((run) => run.status === "interrupted")).toBe(true);
    expect(runs.every((run) => /not resumed/i.test(run.detail ?? ""))).toBe(true);
  });

  it("pauses the clock when the agency timezone does not match the host", () => {
    const { manager } = makeManager();
    const paused = new LoopManager({
      file: tempFile(),
      timezone: "Australia/Sydney",
      hostTimezone: "America/Los_Angeles",
      execute: async () => ({ ok: true, detail: "" }),
    });
    const loop = paused.listLoops()[0];
    expect(loop.timezonePaused).toBe(true);
    expect(loop.nextRunAt).toBeNull();
    expect(manager.listLoops()[0].timezonePaused).toBeFalsy();
  });

  it("does not double-fire when the clock rolls back inside the same minute", async () => {
    let now = new Date(2026, 7, 18, 7, 29, 0).getTime();
    const { manager, calls } = makeManager({ now: () => now });
    await manager.tick();
    expect(calls).toHaveLength(0);
    now = new Date(2026, 7, 18, 7, 31, 0).getTime();
    await manager.tick();
    expect(calls).toHaveLength(1);
    now = new Date(2026, 7, 18, 7, 30, 30).getTime();
    await manager.tick();
    expect(calls).toHaveLength(1);
  });

  it("schedules the next weekday 07:30 across the Sydney DST spring-forward", () => {
    const schedule = { type: "daily" as const, time: "07:30", weekdays: [1, 2, 3, 4, 5] };
    // Saturday 3 Oct 2026 12:00 Sydney — DST starts Sunday 4 Oct 02:00 → 03:00
    const saturday = Date.parse("2026-10-03T02:00:00.000Z");
    const next = nextOccurrence(schedule, saturday, "Australia/Sydney");
    expect(next).not.toBeNull();
    const wall = new Intl.DateTimeFormat("en-AU", {
      timeZone: "Australia/Sydney",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(next!));
    expect(wall).toMatch(/Mon/);
    expect(wall).toMatch(/07:30/);
  });
});

describe("LoopManager clock retune (PR A)", () => {
  it("migrates a v2 loops.json: catalog schedule stands, first save is v3", () => {
    const file = tempFile();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        version: 2,
        timezone: "Australia/Sydney",
        state: { "morning-arrears": { enabled: true, handledThrough: Date.now() } },
        runs: [],
      }),
    );
    const first = new LoopManager({ file, execute: async () => ({ ok: true, detail: "" }) });
    const loop = first.listLoops().find((l) => l.id === "morning-arrears")!;
    expect(loop.schedule).toMatchObject({ time: "07:30", weekdays: [1, 2, 3, 4, 5] });
    expect(loop.revision).toBe(1);

    first.patchClock("morning-arrears", { time: "08:15" });
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.version).toBe(3);
    expect(onDisk.state["morning-arrears"]).toMatchObject({ schedule: { time: "08:15" }, revision: 2 });

    const second = new LoopManager({ file, execute: async () => ({ ok: true, detail: "" }) });
    const reloaded = second.listLoops().find((l) => l.id === "morning-arrears")!;
    expect(reloaded.schedule.time).toBe("08:15");
    expect(reloaded.revision).toBe(2);
  });

  it("retunes time and weekdays forward, bumping revision on every accepted change", () => {
    const now = new Date(2026, 7, 18, 8, 0, 0).getTime(); // Tuesday
    const { manager } = makeManager({ now: () => now });
    const first = manager.patchClock("morning-arrears", { time: "08:15" });
    expect(first.schedule.time).toBe("08:15");
    expect(first.revision).toBe(2);
    expect(first.nextRunAt!).toBeGreaterThan(now);
    const second = manager.patchClock("morning-arrears", { weekdays: [1, 3, 5] });
    expect(second.schedule.weekdays).toEqual([1, 3, 5]);
    expect(second.schedule.time).toBe("08:15"); // untouched field survives
    expect(second.revision).toBe(3);
    // next occurrence respects both fields: Tue 18th → Wednesday 19th 08:15
    expect(second.nextRunAt).toBe(new Date(2026, 7, 19, 8, 15, 0).getTime());
  });

  it("retunes the clock without backfilling a slot that already passed today", async () => {
    const now = new Date(2026, 7, 18, 8, 0, 0).getTime(); // Tue 08:00 — today's 07:30 passed
    const { manager, calls } = makeManager({ now: () => now });
    const patched = manager.patchClock("morning-arrears", { time: "07:00", weekdays: [1, 2, 3, 4, 5] });
    expect(patched.revision).toBe(2);
    expect(patched.nextRunAt!).toBeGreaterThan(now); // tomorrow 07:00, not today's
    await manager.tick();
    expect(calls).toHaveLength(0); // no surprise run for the earlier slot
  });

  it("lets a planned loop retune its clock but still refuses to enable it", () => {
    const { manager } = makeManager();
    const patched = manager.patchClock("inbound-triage", { time: "09:15", weekdays: [1, 2, 3, 4, 5] });
    expect(patched.schedule.time).toBe("09:15");
    expect(patched.enabled).toBe(false);
    expect(() => manager.patchClock("inbound-triage", { enabled: true })).toThrow(/not built yet/);
  });

  it("rejects malformed clock patches with a 400 status", () => {
    const { manager } = makeManager();
    expect(() => manager.patchClock("morning-arrears", {})).toThrow(/nothing to change/);
    expect(() => manager.patchClock("morning-arrears", { enabled: "false" as never })).toThrow(/true or false/);
    expect(() => manager.patchClock("morning-arrears", { time: "7:30" })).toThrow(/HH:MM/);
    expect(() => manager.patchClock("morning-arrears", { time: "24:00" })).toThrow(/HH:MM/);
    expect(() => manager.patchClock("morning-arrears", { weekdays: [] })).toThrow(/non-empty list/);
    expect(() => manager.patchClock("morning-arrears", { weekdays: [1, 9] })).toThrow(/0–6/);
    expect(() => manager.patchClock("no-such-loop" as never, { enabled: true })).toThrow(/no such loop/);
  });

  it("an idempotent clock PATCH neither bumps revision nor swallows a pending slot", async () => {
    // Constructed at 07:29: today's 07:30 slot is still pending.
    let now = new Date(2026, 7, 18, 7, 29, 0).getTime();
    const { manager, calls } = makeManager({ now: () => now });
    const revisionBefore = manager.listLoops()[0].revision;

    // A client re-sending the current clock must be inert: before the
    // dirty-check this clamped the bookmark past 07:30 and the slot died.
    const patched = manager.patchClock("morning-arrears", { time: "07:30", weekdays: [1, 2, 3, 4, 5] });
    expect(patched.revision).toBe(revisionBefore);

    now = new Date(2026, 7, 18, 7, 31, 0).getTime();
    await manager.tick();
    expect(calls).toHaveLength(1); // the pending slot still fired
    expect(manager.listRuns()[0].scheduledFor).toBe(new Date(2026, 7, 18, 7, 30, 0).getTime());
  });

  it("a retune while a run executes fires the new slot once and never rewinds the bookmark", async () => {
    // Constructed before the slot so 07:30 is genuinely pending; the tick
    // starting at 07:30:10 walks into the gated executor. At 07:40 the PM
    // moves the clock to 07:45; the executor finishes at 07:46. The new
    // slot fires exactly once (it had not run yet) and the bookmark never
    // rewinds to the old slot time.
    let now = new Date(2026, 7, 18, 7, 29, 0).getTime();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { manager } = makeManager({
      now: () => now,
      execute: async () => {
        await gate;
        return { ok: true, detail: "" };
      },
    });

    now = new Date(2026, 7, 18, 7, 30, 10).getTime();
    const ticking = manager.tick(); // discovers 07:30 due, enters the gated run
    await new Promise((resolve) => setTimeout(resolve, 20));

    now = new Date(2026, 7, 18, 7, 40, 0).getTime();
    manager.patchClock("morning-arrears", { time: "07:45" }); // clamps bookmark to 07:40

    now = new Date(2026, 7, 18, 7, 46, 0).getTime();
    release();
    await ticking;
    await new Promise((resolve) => setTimeout(resolve, 20));
    await manager.tick();

    const completed = manager.listRuns().filter((r) => r.status === "completed");
    expect(completed).toHaveLength(2); // the 07:30 run + one 07:45 pass — never three
    expect(completed.map((r) => r.scheduledFor).sort((a, b) => a - b)).toEqual([
      new Date(2026, 7, 18, 7, 30, 0).getTime(),
      new Date(2026, 7, 18, 7, 45, 0).getTime(),
    ]);
    const next = manager.listLoops()[0].nextRunAt!;
    expect(next).toBe(new Date(2026, 7, 19, 7, 45, 0).getTime()); // tomorrow on the new clock
  });
});
