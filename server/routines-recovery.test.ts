import { mkdtempSync, readFileSync, copyFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as atomic from "./atomic.ts";
import { LoopManager, settleLoopRunStatus, type LoopManagerOptions, type LoopRun } from "./routines.ts";
import { removeFixture } from "./testing/private-fixture.ts";

const folders: string[] = [];
// Managers hold their execution-history database open; close them before removal (Windows).
const managers: LoopManager[] = [];
const track = (manager: LoopManager) => { managers.push(manager); return manager; };
const at = Date.parse("2026-08-18T07:30:00Z");
const requestId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
function file() { const folder = mkdtempSync(join(tmpdir(), "realbud-clock-recovery-")); folders.push(folder); return join(folder, "loops.json"); }
const failure = () => { throw Object.assign(new Error("private path must not escape"), { code: "ENOSPC" }); };
function options(path: string, extra: Partial<LoopManagerOptions> = {}): LoopManagerOptions {
  return { file: path, now: () => at + 60_000, timezone: "UTC", hostTimezone: "UTC", execute: async () => ({ ok: true, detail: "Prepared" }), ...extra };
}
function saved(run?: Partial<LoopRun>) {
  return {
    version: 3, timezone: "UTC",
    state: { "morning-arrears": { enabled: true, handledThrough: at - 60_000, revision: 1 } },
    runs: run ? [{ id: "prior-run", loopId: "morning-arrears", loopName: "Morning money check", manual: false, scheduledFor: at, createdAt: at, status: "running", ...run }] : [],
  };
}
afterEach(async () => { vi.restoreAllMocks(); for (const manager of managers.splice(0)) manager.close(); for (const folder of folders.splice(0)) await removeFixture(folder); });

describe("schedule storage recovery", () => {
  it.each(["null", "not-json", JSON.stringify({ ...saved(), timezone: "not-a-zone" }), JSON.stringify({ ...saved(), runs: [null] }), JSON.stringify({ ...saved(), state: { "morning-arrears": { enabled: "yes", handledThrough: at } } })])("holds invalid existing history without overwriting it: %s", async (contents) => {
    const path = file(); writeFileSync(path, contents);
    const execute = vi.fn(async () => ({ ok: true, detail: "must not run" }));
    const manager = track(new LoopManager(options(path, { execute })));
    expect(manager.recovery.active).toBe(true);
    expect(manager.listLoops().every((loop) => loop.nextRunAt === null)).toBe(true);
    for (const mutate of [() => manager.runNow("morning-arrears"), () => manager.patchClock("morning-arrears", { enabled: false }), () => manager.markSeen("prior-run"), () => manager.adoptRecipePlan("job")]) {
      expect(mutate).toThrow(/recovery/i);
      try { mutate(); } catch (error) { expect((error as { status: number }).status).toBe(503); }
    }
    manager.start(); await manager.tick(); manager.stop();
    expect(execute).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(contents);
  });

  it("treats only a missing file as first run and rejects an invalid configured timezone safely", () => {
    expect(track(new LoopManager(options(file()))).recovery.active).toBe(false);
    const manager = track(new LoopManager(options(file(), { timezone: "broken-zone" })));
    expect(manager.recovery.active).toBe(true);
    expect(manager.listLoops()[0].nextRunAt).toBeNull();
  });

  it("rolls back failed enqueue and clock changes without emitting or launching ghost work", async () => {
    const path = file();
    const events: unknown[] = [];
    const execute = vi.fn(async () => ({ ok: true, detail: "must not run" }));
    const manager = track(new LoopManager(options(path, { execute, emit: (event) => events.push(event) })));
    manager.patchClock("owner-letter", { enabled: false });
    const original = readFileSync(path, "utf8");
    events.length = 0;
    vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce(failure);
    expect(() => manager.runNow("morning-arrears", { requestId, expectedRevision: 1 })).toThrow(/could not safely save/i);
    await manager.tick();
    expect(manager.listRuns()).toEqual([]);
    expect(manager.recovery.active).toBe(true);
    expect(events).toEqual([{ kind: "loops.recovery", recovery: manager.recovery }]);
    expect(execute).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(JSON.stringify(events)).not.toContain("private path");
  });

  it("does not update the recipe when the clock pause could not be saved", () => {
    const path = file();
    const update = vi.fn();
    const manager = track(new LoopManager(options(path, {
      listRecipes: () => [{ id: "job", title: "Task", schedule: { time: "08:00", weekdays: [2] }, status: "active", revision: 1, planApprovedAt: 1, approvedRevision: 1 }],
      setRecipeEnabled: update,
    })));
    vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce(failure);
    expect(() => manager.setEnabled("recipe-job", false)).toThrow(/could not safely save/);
    expect(update).not.toHaveBeenCalled();
    expect(manager.listLoops().find((loop) => loop.id === "recipe-job")?.enabled).toBe(true);
    expect(manager.recovery.active).toBe(true);
  });

  it("keeps a committed pause authoritative across restart when the recipe update failed", () => {
    const path = file();
    const recipe = { id: "job", title: "Task", schedule: { time: "08:00", weekdays: [2] }, status: "active" as const, revision: 1, planApprovedAt: 1, approvedRevision: 1 };
    const manager = track(new LoopManager(options(path, { listRecipes: () => [recipe], setRecipeEnabled: failure })));
    expect(() => manager.setEnabled("recipe-job", false)).toThrow(/saved job could not be read or updated/);
    expect(manager.recovery.active).toBe(true);
    const restarted = track(new LoopManager(options(path, { listRecipes: () => [recipe] })));
    expect(restarted.listLoops().find((loop) => loop.id === "recipe-job")?.enabled).toBe(false);
  });

  it("preserves a post-rename queued receipt under an uncertain write and never executes it", async () => {
    const path = file();
    const execute = vi.fn(async () => ({ ok: true, detail: "must not run" }));
    const manager = track(new LoopManager(options(path, { execute })));
    const write = atomic.writeFileAtomic;
    vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce((...args) => { write(...args); failure(); });
    expect(() => manager.runNow("morning-arrears", { requestId, expectedRevision: 1 })).toThrow(/could not safely save/);
    expect(manager.listRuns()[0]?.status).toBe("queued");
    await manager.tick();
    expect(execute).not.toHaveBeenCalled();
    const restarted = track(new LoopManager(options(path, { execute })));
    const prior = restarted.runNow("morning-arrears", { requestId, expectedRevision: 1 });
    expect(prior?.status).toBe("interrupted");
    await restarted.tick();
    expect(execute).not.toHaveBeenCalled();
  });

  it("holds startup when interrupted history cannot be committed and preserves the original bytes", () => {
    const path = file(); const contents = JSON.stringify(saved({})); writeFileSync(path, contents);
    vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce(failure);
    const manager = track(new LoopManager(options(path)));
    expect(manager.recovery.active).toBe(true);
    expect(manager.listRuns()[0].status).toBe("running");
    expect(readFileSync(path, "utf8")).toBe(contents);
  });

  it("holds a start or settlement write failure without claiming work was saved", async () => {
    for (const stage of ["start", "settle"]) {
      const path = file();
      const execute = vi.fn(async () => {
        if (stage === "settle") vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce(failure);
        return { ok: true, detail: "Prepared" };
      });
      const manager = track(new LoopManager(options(path, { execute })));
      const run = manager.runNow("morning-arrears")!;
      if (stage === "start") vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce(failure);
      await manager.tick();
      expect(manager.recovery.active).toBe(true);
      expect(manager.listRuns().find((row) => row.id === run.id)?.status).toBe(stage === "start" ? "queued" : "running");
      expect(execute).toHaveBeenCalledTimes(stage === "start" ? 0 : 1);
      vi.restoreAllMocks();
    }
  });
});

describe("occurrence claims and manual recovery", () => {
  it("persists the occurrence bookmark with its receipt before work or any run event", async () => {
    const path = file(); const crashCopy = file();
    let now = at - 60_000;
    const observed: string[] = [];
    const manager = track(new LoopManager(options(path, {
      now: () => now,
      emit: (event) => {
        const value = event as { kind: string; run?: LoopRun };
        if (value.kind !== "loop.run") return;
        const disk = JSON.parse(readFileSync(path, "utf8"));
        expect(disk.state["morning-arrears"].handledThrough).toBeGreaterThanOrEqual(at);
        expect(disk.runs.find((row: LoopRun) => row.id === value.run!.id)?.status).toBe(value.run!.status);
        observed.push(value.run!.status);
      },
      execute: async () => {
        writeFileSync(crashCopy, readFileSync(path));
        // A crash snapshot now includes the authoritative encrypted ledger and
        // its key; copying only the rolling JSON must fail closed.
        copyFileSync(join(dirname(path), 'workflow-state.sqlite'), join(dirname(crashCopy), 'workflow-state.sqlite'));
        copyFileSync(join(dirname(path), 'desk.key'), join(dirname(crashCopy), 'desk.key'));
        return { ok: true, detail: "Prepared" };
      },
    })));
    now = at + 60_000; await manager.tick();
    expect(observed).toEqual(["queued", "running", "completed"]);
    const execute = vi.fn(async () => ({ ok: true, detail: "must not replay" }));
    const restarted = track(new LoopManager(options(crashCopy, { execute })));
    await restarted.tick();
    expect(restarted.listRuns()[0].status).toBe("interrupted");
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(["completed", "failed", "partial", "awaiting-approval", "missed", "interrupted"])("repairs the old %s-receipt/bookmark crash gap without replaying", async (status) => {
    const path = file(); writeFileSync(path, JSON.stringify(saved({ status: status as LoopRun["status"], finishedAt: at + 1000 })));
    const execute = vi.fn(async () => ({ ok: true, detail: "must not replay" }));
    const manager = track(new LoopManager(options(path, { execute }))); await manager.tick();
    expect(execute).not.toHaveBeenCalled();
    expect(manager.listRuns()).toHaveLength(1);
    expect(JSON.parse(readFileSync(path, "utf8")).state["morning-arrears"].handledThrough).toBe(at);
  });

  it("compresses ancient missed slots without unbounded catch-up and keeps the recent slot", async () => {
    const path = file(); const data = saved(); data.state["morning-arrears"].handledThrough = Date.UTC(1970, 0, 1);
    writeFileSync(path, JSON.stringify(data));
    const execute = vi.fn(async () => ({ ok: true, detail: "Prepared" }));
    const manager = track(new LoopManager(options(path, { execute }))); await manager.tick();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(manager.listRuns()).toHaveLength(2);
    expect(manager.listRuns().some((run) => run.status === "missed" && run.detail?.includes("Older work was not replayed"))).toBe(true);
  });

  it("reuses exact manual IDs across pause, retune and restart while rejecting changed identities", async () => {
    const path = file(); const execute = vi.fn(async () => ({ ok: true, detail: "Prepared" }));
    const manager = track(new LoopManager(options(path, { execute })));
    const request = { requestId, expectedRevision: 1 };
    const first = manager.runNow("morning-arrears", request)!;
    expect(manager.runNow("morning-arrears", request)?.id).toBe(first.id);
    await manager.tick();
    manager.patchClock("morning-arrears", { enabled: false, time: "08:00" });
    expect(manager.runNow("morning-arrears", request)?.id).toBe(first.id);
    const restarted = track(new LoopManager(options(path, { execute })));
    expect(restarted.runNow("morning-arrears", request)?.id).toBe(first.id);
    expect(() => restarted.runNow("morning-arrears", { requestId, expectedRevision: 2 })).toThrow(/another schedule or version/);
    expect(() => restarted.runNow("owner-letter", request)).toThrow(/another schedule or version/);
    expect(() => restarted.runNow("morning-arrears", { requestId: secondId, expectedRevision: 1 })).toThrow(/schedule changed/);
    expect(() => restarted.runNow("morning-arrears", { requestId: "bad", expectedRevision: 2 })).toThrow(/valid request ID/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("honors an explicit held outcome instead of displaying it as completed", () => {
    expect(settleLoopRunStatus({ ok: true, status: "awaiting-approval" })).toBe("awaiting-approval");
  });

  it("retains a later valid bookmark through a clock rollback rather than replaying its slot", async () => {
    const path = file(); const data = saved({ status: "completed", finishedAt: at + 1000 });
    data.state["morning-arrears"].handledThrough = at;
    writeFileSync(path, JSON.stringify(data));
    let now = at - 30 * 60_000;
    const execute = vi.fn(async () => ({ ok: true, detail: "must not replay" }));
    const manager = track(new LoopManager(options(path, { now: () => now, execute })));
    await manager.tick(); now = at + 60_000; await manager.tick();
    expect(execute).not.toHaveBeenCalled();
    expect(manager.listRuns()).toHaveLength(1);
  });

  it("records skipped slots during an unresolved run and safely settles a late failure without undoing a pause", async () => {
    const path = file();
    let now = at - 60_000;
    let reject!: (error: Error) => void;
    const execute = vi.fn(() => new Promise<{ ok: boolean; detail: string }>((_resolve, fail) => { reject = fail; }));
    const manager = track(new LoopManager(options(path, { now: () => now, execute, runDeadlineMs: 10 })));
    manager.setEnabled("owner-letter", false);
    now = at + 60_000; await manager.tick();
    const original = manager.listRuns()[0];
    expect(original.status).toBe("running");
    expect(original.finishedAt).toBeUndefined();
    expect(original.detail).not.toMatch(/stopped|nothing was sent/i);
    now = at + 24 * 60 * 60_000 + 60_000;
    await manager.tick();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(manager.listRuns().some((run) => run.status === "missed" && run.detail?.includes("previous run was still"))).toBe(true);
    manager.patchClock("morning-arrears", { enabled: false, time: "08:00" });
    reject(new Error("The original worker failed late"));
    await vi.waitFor(() => expect(manager.listRuns().find((run) => run.id === original.id)?.status).toBe("failed"));
    const restarted = track(new LoopManager(options(path, { now: () => now })));
    expect(restarted.listLoops().find((loop) => loop.id === "morning-arrears")).toMatchObject({ enabled: false, schedule: { time: "08:00" } });
    expect(restarted.listRuns().find((run) => run.id === original.id)?.detail).toBe("The original worker failed late");
  });
});
