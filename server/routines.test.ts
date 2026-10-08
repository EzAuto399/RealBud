import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Recipe } from "../shared/contracts.ts";
import { removeFixture } from "./testing/private-fixture.ts";
import { parseLoopsFile } from "./routine-persistence.ts";
import {
  coverageFromUncoveredHeld,
  LOOP_CATALOG,
  LoopManager,
  nextOccurrence,
  recipeLoopId,
  RESUMED_DETAIL,
  settleLoopRunStatus,
  type Loop,
  type LoopManagerOptions,
  type LoopRun,
} from "./routines.ts";

const dirs: string[] = [];
// Each manager holds its execution-history database open in the fixture
// folder; Windows cannot remove the folder until every one is closed.
const managers: LoopManager[] = [];
function track(manager: LoopManager): LoopManager {
  managers.push(manager);
  return manager;
}

function tempFile() {
  const dir = mkdtempSync(join(tmpdir(), "realbud-loops-"));
  dirs.push(dir);
  return join(dir, "loops.json");
}

afterEach(async () => {
  for (const manager of managers.splice(0)) manager.close();
  for (const dir of dirs.splice(0)) await removeFixture(dir);
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

function taughtJob(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: "job-1",
    title: "Friday arrears",
    description: "Check arrears and prepare exceptions.",
    steps: ["Open the arrears report"],
    allowedOrigins: ["propertyme.com.au"],
    evidence: "arrears rows",
    capabilities: ["read-book", "analyse", "draft"],
    limits: { maxRuntimeMinutes: 2, maxTurns: 6 },
    status: "shadow",
    createdAt: 1,
    schedule: { time: "16:00", weekdays: [5] },
    planApprovedAt: null,
    revision: 1,
    updatedAt: 1,
    approvedRevision: null,
    attachment: null,
    submitAcknowledgedAt: null,
    ...overrides,
  };
}

function makeManager(options: Partial<LoopManagerOptions> & { execute?: LoopManagerOptions["execute"] } = {}) {
  const calls: Loop[] = [];
  const runs: LoopRun[] = [];
  const manager = track(new LoopManager({
    file: tempFile(),
    now: () => options.now?.() ?? Date.now(),
    emit: (payload) => {
      if (payload && typeof payload === "object" && (payload as { kind?: string }).kind === "loop.run") {
        runs.push((payload as { run: LoopRun }).run);
      }
    },
    listRecipes: options.listRecipes,
    setRecipeEnabled: options.setRecipeEnabled,
    workerIdentity: options.workerIdentity,
    execute:
      options.execute ??
      (async (loop) => {
        calls.push(loop);
        return { ok: true, detail: "desk check done — 2 drafts waiting" };
      }),
  }));
  return { manager, calls, runs };
}

describe("a loop run's own AI usage", () => {
  it("keeps the usage a loop reports on its run and in durable history, and drops a malformed one", async () => {
    const file = tempFile();
    let usage: unknown = { requestIds: ["req-fictional-loop"], calls: 1, inputTokens: 9 };
    const manager = track(new LoopManager({ file, execute: async () => ({ ok: true, detail: "checked", usage: usage as never }) }));
    const first = manager.runNow("morning-arrears")!;
    await manager.tick();
    expect(manager.getRun(first.id)?.usage).toEqual({ requestIds: ["req-fictional-loop"], calls: 1, inputTokens: 9 });
    usage = { requestIds: "req-fictional-loop", calls: 1 };
    const second = manager.runNow("owner-letter")!;
    await manager.tick();
    expect(manager.getRun(second.id)).not.toHaveProperty("usage");
    manager.close();
    const reloaded = track(new LoopManager({ file, execute: async () => ({ ok: true, detail: "" }) }));
    expect(reloaded.getRun(first.id)?.usage).toEqual({ requestIds: ["req-fictional-loop"], calls: 1, inputTokens: 9 });
  });

  it("loads a saved run without usage, and drops malformed usage without refusing the run", () => {
    const run = { id: "run-1", loopId: "morning-arrears", loopName: "Morning money check", scheduledFor: 1, status: "completed", manual: false, createdAt: 1 };
    const parsed = parseLoopsFile({ version: 3, timezone: "UTC", state: {}, runs: [run, { ...run, id: "run-2", usage: { requestIds: [], calls: -1 } }, { ...run, id: "run-3", usage: { requestIds: ["req-fictional-3"], calls: 1 } }] }, "UTC");
    expect(parsed.runs.map(saved => saved.usage)).toEqual([undefined, undefined, { requestIds: ["req-fictional-3"], calls: 1 }]);
    expect(parsed.runs[1]).not.toHaveProperty("usage");
  });
});

describe("LoopManager catalog", () => {
  it("declares built mail routines and keeps the unqualified bank routine paused", () => {
    const { manager } = makeManager();
    const loops = manager.listLoops();
    expect(loops.map((loop) => loop.id)).toEqual(["morning-arrears", "owner-letter", "inbound-triage", "bank-references", "weekly-bills", "maintenance-review", "rei-supplier-check", "rei-morning-refresh", "inspection-draft"]);
    expect(loops[0]).toMatchObject({ available: true, enabled: true, name: "Morning money check" });
    expect(loops[1]).toMatchObject({ available: true, enabled: true });
    expect(loops[2]).toMatchObject({ available: true, enabled: false });
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

  it("allows a deliberate manual inbox review without enabling its recurring schedule", async () => {
    const { manager, calls } = makeManager();
    expect(manager.listLoops().find(loop => loop.id === 'inbound-triage')?.enabled).toBe(false);
    expect(manager.runNow('inbound-triage')).not.toBeNull();
    await manager.tick();
    expect(calls.some(loop => loop.id === 'inbound-triage')).toBe(true);
    expect(manager.listLoops().find(loop => loop.id === 'inbound-triage')?.enabled).toBe(false);
  });

  it("persists the enabled flag across reloads", () => {
    const file = tempFile();
    const first = track(new LoopManager({
      file,
      execute: async () => ({ ok: true, detail: "" }),
    }));
    first.setEnabled("morning-arrears", false);
    const second = track(new LoopManager({ file, execute: async () => ({ ok: true, detail: "" }) }));
    expect(second.listLoops().find((loop) => loop.id === "morning-arrears")?.enabled).toBe(false);
  });

  it("preserves corrupt loops.json and declares the catalog with clockwork held for recovery", async () => {
    const file = tempFile();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "not json {{{");
    const manager = track(new LoopManager({ file, execute: async () => ({ ok: true, detail: "" }) }));
    const loops = manager.listLoops();
    expect(loops.map((loop) => loop.id)).toEqual(["morning-arrears", "owner-letter", "inbound-triage", "bank-references", "weekly-bills", "maintenance-review", "rei-supplier-check", "rei-morning-refresh", "inspection-draft"]);
    expect(loops.find((loop) => loop.id === "morning-arrears")?.enabled).toBe(true);
    expect(loops.every((loop) => loop.nextRunAt === null)).toBe(true);
    expect(manager.recovery.active).toBe(true);
    expect(() => manager.runNow("morning-arrears")).toThrow(/recovery/i);
    await manager.tick();
    expect(readFileSync(file, "utf8")).toBe("not json {{{");
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

  // A scheduled receipt is part of the audit trail a PM is asked to trust, so it has
  // to say which worker produced it. After a worker upgrade or a model change there
  // is otherwise nothing in the record that distinguishes the runs.
  it("stamps the worker identity on a run so the receipt has provenance", async () => {
    const { manager } = makeManager({ workerIdentity: () => "worker-fingerprint-abc" });
    const run = manager.runNow("morning-arrears");
    await manager.tick();
    expect(manager.listRuns().find((r) => r.id === run!.id)?.workerFingerprint).toBe("worker-fingerprint-abc");
  });

  it("records no worker identity rather than a placeholder when none is established", async () => {
    const { manager } = makeManager({ workerIdentity: () => undefined });
    const run = manager.runNow("morning-arrears");
    await manager.tick();
    const settled = manager.listRuns().find((r) => r.id === run!.id);
    expect(settled?.status).toBe("completed");
    expect(settled?.workerFingerprint).toBeUndefined();
  });

  it("classifies full / partial / none coverage without changing those counts", async () => {
    expect(settleLoopRunStatus({ ok: true, covered: 6, uncovered: 0 })).toBe("completed");
    expect(settleLoopRunStatus({ ok: false, covered: 1, uncovered: 5 })).toBe("partial");
    expect(settleLoopRunStatus({ ok: false, covered: 0, uncovered: 6 })).toBe("failed");
    expect(settleLoopRunStatus({ ok: false })).toBe("failed");
    const detail = "Worker answered 1 of 6 properties. Uncovered stay held.";
    expect(
      coverageFromUncoveredHeld(detail, [
        { reason: "rent-landed" },
        { reason: "uncovered-by-worker" },
        { reason: "uncovered-by-worker" },
        { reason: "uncovered-by-worker" },
        { reason: "uncovered-by-worker" },
        { reason: "uncovered-by-worker" },
      ]),
    ).toEqual({ covered: 1, uncovered: 5 });
    expect(coverageFromUncoveredHeld("the worker missed", [{ reason: "unknown-facts" }])).toBeNull();

    const { manager } = makeManager({
      execute: async () => ({ ok: false, detail, covered: 1, uncovered: 5 }),
    });
    const run = manager.runNow("morning-arrears")!;
    await manager.tick();
    expect(manager.listRuns().find((row) => row.id === run.id)?.status).toBe("partial");
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
    const manager = track(new LoopManager({ file, now: () => now, execute: async () => ({ ok: true, detail: "" }) }));
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
    const manager = track(new LoopManager({ file, execute: async () => ({ ok: true, detail: "" }) }));
    const runs = manager.listRuns();
    expect(runs.every((run) => run.status === "interrupted")).toBe(true);
    expect(runs.every((run) => /not resumed/i.test(run.detail ?? ""))).toBe(true);
  });

  it("a run a restart interrupted reads Resumed after restart once a new run carries it on; without a resume it stays Interrupted", async () => {
    const file = tempFile();
    mkdirSync(join(file, ".."), { recursive: true });
    const running = (id: string, loopId: string) => ({ id, loopId, loopName: loopId, scheduledFor: Date.now() - 1000, status: "running", manual: false, createdAt: Date.now() - 1000 });
    writeFileSync(file, JSON.stringify({ version: 2, timezone: "Australia/Sydney", state: { "morning-arrears": { enabled: true, handledThrough: Date.now() } },
      runs: [running("run-waiting", "morning-arrears"), running("run-other", "owner-letter")] }));
    const options = { file, execute: async () => ({ ok: true, detail: "" }) };
    const manager = track(new LoopManager(options));
    const resumedBy = manager.runNow("morning-arrears")!;
    manager.markResumed("morning-arrears");
    manager.markResumed("owner-letter"); // nothing carried it on: still a genuine interruption below
    await manager.tick();
    const byId = (runs: LoopRun[], id: string) => runs.find((run) => run.id === id)!;
    expect(byId(manager.listRuns(), "run-waiting")).toMatchObject({ status: "resumed", detail: RESUMED_DETAIL });
    expect(byId(manager.listRuns(), resumedBy.id).status).not.toBe("interrupted");
    // Saved: a restart reads "resumed" back, and a second resume never relabels a later interruption.
    manager.close();
    const restarted = track(new LoopManager(options));
    expect(byId(restarted.listRuns(), "run-waiting")).toMatchObject({ status: "resumed", detail: RESUMED_DETAIL });
    expect(byId(restarted.listRuns(), "run-other").status).toBe("interrupted");
  });

  it("schedules through the zone-aware path even when no timezone option is passed", () => {
    // Production constructs LoopManager without `timezone`. That used to fall
    // back to local-Date arithmetic, leaving the DST-aware path — and its test
    // — unreachable from the running clock.
    const manager = track(new LoopManager({
      file: tempFile(),
      hostTimezone: "Australia/Sydney",
      execute: async () => ({ ok: true, detail: "" }),
    }));
    const loop = manager.listLoops().find((row) => row.id === "morning-arrears")!;
    expect(loop.timezonePaused).toBeFalsy();
    expect(loop.nextRunAt).not.toBeNull();
    // the clock resolves a real zone rather than undefined
    const zoned = nextOccurrence(loop.schedule, Date.now(), "Australia/Sydney");
    expect(loop.nextRunAt).toBe(zoned);
  });

  it("keeps an overdue run locked until its actual result arrives while other loops remain usable", async () => {
    let finish!: (result: { ok: boolean; detail: string }) => void;
    const manager = track(new LoopManager({
      file: tempFile(),
      runDeadlineMs: 20,
      execute: (loop) => loop.id === "morning-arrears"
        ? new Promise((resolve) => { finish = resolve; })
        : Promise.resolve({ ok: true, detail: "Other job prepared" }),
    }));
    const run = manager.runNow("morning-arrears")!;
    await vi.waitFor(
      () => expect(manager.listRuns().find((row) => row.id === run.id)?.detail).toMatch(/taking longer/i),
      { timeout: 2000 },
    );
    expect(manager.listRuns().find((row) => row.id === run.id)?.status).toBe("running");
    expect(() => manager.runNow("morning-arrears")).toThrow(/already running/);
    const other = manager.runNow("owner-letter")!;
    await manager.tick();
    expect(manager.listRuns().find((row) => row.id === other.id)?.status).toBe("completed");
    finish({ ok: true, detail: "Original work completed late" });
    await vi.waitFor(() => expect(manager.listRuns().find((row) => row.id === run.id)?.status).toBe("completed"));
    expect(manager.listRuns().find((row) => row.id === run.id)?.detail).toBe("Original work completed late");
    expect(manager.listRuns().filter((row) => row.loopId === "morning-arrears")).toHaveLength(1);
  });

  it("Supplier list check: off until enabled, fortnightly Monday 08:15, says what it waits for, then awaits approval or ends quietly", async () => {
    let finish!: (result: { ok: boolean; status: "awaiting-approval" | "completed"; detail: string; quiet?: boolean }) => void;
    // A deadline far away: saying what it waits for is what releases the clock for other loops.
    const manager = track(new LoopManager({ file: tempFile(), runDeadlineMs: 60_000, execute: (loop, run) => {
      if (loop.id !== "rei-supplier-check") return Promise.resolve({ ok: true, detail: "" });
      manager.noteRun(run.id, "Waiting for you to sign in to REI Cloud.");
      return new Promise((resolve) => { finish = resolve; });
    } }));
    const check = manager.listLoops().find((loop) => loop.id === "rei-supplier-check")!;
    expect(check).toMatchObject({ available: true, enabled: false, nextRunAt: null, name: "Supplier list check", schedule: { time: "08:15", intervalDays: 14, anchorDate: "2026-10-12" } });
    expect(check.description).toMatch(/added or removed suppliers .* for you to approve/);
    const run = manager.runNow("rei-supplier-check")!;
    // The run keeps saying what it waits for; other loops carry on.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(manager.listRuns().find((row) => row.id === run.id)).toMatchObject({ status: "running", detail: "Waiting for you to sign in to REI Cloud." });
    const other = manager.runNow("owner-letter")!;
    await manager.tick();
    expect(manager.listRuns().find((row) => row.id === other.id)?.status).toBe("completed");
    finish({ ok: true, status: "awaiting-approval", detail: "Supplier list changed in REI: 1 added — review." });
    await vi.waitFor(() => expect(manager.listRuns().find((row) => row.id === run.id)).toMatchObject({ status: "awaiting-approval", detail: "Supplier list changed in REI: 1 added — review." }));
    expect(manager.listRuns().find((row) => row.id === run.id)?.seenAt).toBeUndefined();
    const quiet = manager.runNow("rei-supplier-check")!;
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await new Promise((resolve) => setTimeout(resolve, 30));
    finish({ ok: true, status: "completed", quiet: true, detail: "REI's supplier list has not changed." });
    await vi.waitFor(() => expect(manager.listRuns().find((row) => row.id === quiet.id)).toMatchObject({ status: "completed", seenAt: expect.any(Number) }));
    expect(manager.patchClock("rei-supplier-check", { enabled: true }).nextRunAt).not.toBeNull();
  });

  it("pauses the clock when the agency timezone does not match the host", () => {
    const { manager } = makeManager();
    const paused = track(new LoopManager({
      file: tempFile(),
      timezone: "Australia/Sydney",
      hostTimezone: "America/Los_Angeles",
      execute: async () => ({ ok: true, detail: "" }),
    }));
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
    const first = track(new LoopManager({ file, execute: async () => ({ ok: true, detail: "" }) }));
    const loop = first.listLoops().find((l) => l.id === "morning-arrears")!;
    expect(loop.schedule).toMatchObject({ time: "07:30", weekdays: [1, 2, 3, 4, 5] });
    expect(loop.revision).toBe(1);

    first.patchClock("morning-arrears", { time: "08:15" });
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.version).toBe(3);
    expect(onDisk.state["morning-arrears"]).toMatchObject({ schedule: { time: "08:15" }, revision: 2 });

    const second = track(new LoopManager({ file, execute: async () => ({ ok: true, detail: "" }) }));
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

  it("refuses a stale expectedRevision with a 409 and changes nothing", () => {
    const { manager } = makeManager();
    expect(manager.patchClock("morning-arrears", { time: "08:15", expectedRevision: 1 }).revision).toBe(2);
    let refusal: unknown;
    try { manager.patchClock("morning-arrears", { time: "09:00", expectedRevision: 1 }); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ status: 409, code: "schedule_changed" });
    expect(() => manager.patchClock("morning-arrears", { time: "09:00", expectedRevision: 0 })).toThrow(/revision/);
    expect(manager.listLoops()[0]).toMatchObject({ revision: 2, schedule: { time: "08:15" } });
  });

  it("retunes the inbox clock without enabling collection until explicitly enabled", () => {
    const { manager } = makeManager();
    const patched = manager.patchClock('inbound-triage', { time: '09:15', weekdays: [1,2,3,4,5], timezone: 'Australia/Brisbane' });
    expect(patched.schedule).toMatchObject({ time: '09:15', timezone: 'Australia/Brisbane' });
    expect(patched.enabled).toBe(false);
    expect(manager.patchClock('inbound-triage', { enabled: true }).enabled).toBe(true);
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

describe("LoopManager recipe loops", () => {
  it("adopts the reviewed plan's clock across restart without replaying old slots", async () => {
    const file = tempFile();
    const now = new Date(2026, 7, 21, 16, 1).getTime();
    let recipe = taughtJob({ status: "active", planApprovedAt: 1, approvedRevision: 1 });
    const execute = vi.fn(async () => ({ ok: true, detail: "prepared" }));
    const options = { file, now: () => now, emit: () => {}, listRecipes: () => [recipe], execute };
    const manager = track(new LoopManager(options));
    manager.setEnabled("morning-arrears", false);
    manager.setEnabled("owner-letter", false);
    manager.patchClock("recipe-job-1", { time: "17:00" });
    manager.setEnabled("recipe-job-1", false);
    recipe = { ...recipe, revision: 2, approvedRevision: 2, schedule: { time: "15:30", weekdays: [5] } };
    manager.adoptRecipePlan(recipe.id);
    expect(manager.listLoops().find((loop) => loop.id === "recipe-job-1")).toMatchObject({ enabled: true, schedule: { time: "15:30" } });
    await manager.tick();
    expect(execute).not.toHaveBeenCalled();
    const restarted = track(new LoopManager(options));
    expect(restarted.listLoops().find((loop) => loop.id === "recipe-job-1")).toMatchObject({ enabled: true, schedule: { time: "15:30" } });
    await restarted.tick();
    expect(execute).not.toHaveBeenCalled();
  });

  it("admits a scheduled job onto the clock and ignores a manual one", () => {
    const recipes = [taughtJob(), taughtJob({ id: "job-manual", title: "One-off", schedule: null })];
    const { manager } = makeManager({ listRecipes: () => recipes });
    const loops = manager.listLoops();
    expect(loops.map((loop) => loop.id)).toEqual([
      "morning-arrears",
      "owner-letter",
      "inbound-triage",
      "bank-references",
      "weekly-bills",
      "maintenance-review",
      "rei-supplier-check",
      "rei-morning-refresh",
      "inspection-draft",
      "recipe-job-1",
    ]);
    const job = loops.find((loop) => loop.id === "recipe-job-1")!;
    expect(job).toMatchObject({
      name: "Friday arrears",
      available: true,
      enabled: false,
      waitingForPlan: true,
      evaluatorId: "recipe",
      evaluatorVersion: 1,
      schedule: { type: "daily", time: "16:00", weekdays: [5] },
    });
    expect(job.description).toMatch(/approved job prepares work/);
    expect(job.nextRunAt).toBeNull();
    expect(manager.patchClock("recipe-job-1", { time: "16:30" }).schedule.time).toBe("16:30");
  });

  it("ticks a due recipe slot once and run-now executes the shadow path", async () => {
    // Friday 21 Aug 2026. Construct before 16:00 so today's slot is still pending.
    let now = new Date(2026, 7, 21, 15, 59, 0).getTime();
    const { manager, calls } = makeManager({
      now: () => now,
      listRecipes: () => [taughtJob({ status: "active", planApprovedAt: 1, approvedRevision: 1 })],
      execute: async (loop) => {
        calls.push(loop);
        return { ok: true, detail: "Shadow run — nothing was browsed or clicked." };
      },
    });
    manager.setEnabled("owner-letter", false);
    await manager.tick();
    expect(calls).toHaveLength(0);

    now = new Date(2026, 7, 21, 16, 1, 0).getTime();
    await manager.tick();
    expect(calls.map((loop) => loop.id)).toEqual(["recipe-job-1"]);
    await manager.tick();
    expect(calls).toHaveLength(1);
    const scheduled = manager.listRuns().find((run) => run.loopId === "recipe-job-1");
    expect(scheduled).toMatchObject({
      manual: false,
      status: "completed",
      detail: "Shadow run — nothing was browsed or clicked.",
      scheduledFor: new Date(2026, 7, 21, 16, 0, 0).getTime(),
    });

    const run = manager.runNow("recipe-job-1");
    expect(run).not.toBeNull();
    await manager.tick();
    expect(calls.filter((loop) => loop.id === "recipe-job-1")).toHaveLength(2);
    expect(manager.listRuns().find((row) => row.id === run!.id)?.status).toBe("completed");
  });

  it("pause stops the clock; a paused job is disabled; delete drops the loop and keeps runs", async () => {
    const recipes = [taughtJob()];
    let now = new Date(2026, 7, 21, 15, 59, 0).getTime();
    const { manager, calls } = makeManager({
      now: () => now,
      listRecipes: () => recipes,
    });
    manager.setEnabled("owner-letter", false);
    expect(manager.listLoops().some((loop) => loop.id === recipeLoopId("job-1"))).toBe(true);

    manager.setEnabled("recipe-job-1", false);
    now = new Date(2026, 7, 21, 16, 1, 0).getTime();
    await manager.tick();
    expect(calls).toHaveLength(0);
    expect(manager.listLoops().find((loop) => loop.id === "recipe-job-1")?.enabled).toBe(false);

    manager.setEnabled("recipe-job-1", true);
    recipes[0] = taughtJob({ status: "paused" });
    expect(manager.listLoops().find((loop) => loop.id === "recipe-job-1")?.enabled).toBe(false);
    await manager.tick();
    expect(calls).toHaveLength(0);

    recipes[0] = taughtJob();
    const run = manager.runNow("recipe-job-1")!;
    await manager.tick();
    expect(manager.listRuns().some((row) => row.id === run.id)).toBe(true);

    recipes.splice(0, recipes.length);
    expect(manager.listLoops().map((loop) => loop.id)).toEqual([
      "morning-arrears",
      "owner-letter",
      "inbound-triage",
      "bank-references",
      "weekly-bills",
      "maintenance-review",
      "rei-supplier-check",
      "rei-morning-refresh",
      "inspection-draft",
    ]);
    expect(manager.listRuns().some((row) => row.id === run.id)).toBe(true);
    expect(manager.runNow("recipe-job-1")).toBeNull();
  });

  it("skips an unapproved scheduled job on tick and still shadows on run-now", async () => {
    let now = new Date(2026, 7, 21, 15, 59, 0).getTime();
    const recipes = [taughtJob({ status: "active", planApprovedAt: null })];
    const { manager, calls } = makeManager({
      now: () => now,
      listRecipes: () => recipes,
      execute: async (loop) => {
        calls.push(loop);
        return { ok: true, detail: "Shadow run — nothing was browsed or clicked." };
      },
    });
    manager.setEnabled("owner-letter", false);
    const job = manager.listLoops().find((loop) => loop.id === "recipe-job-1");
    expect(job).toMatchObject({ available: true, enabled: false, waitingForPlan: true, nextRunAt: null });

    now = new Date(2026, 7, 21, 16, 1, 0).getTime();
    await manager.tick();
    expect(calls).toHaveLength(0);
    expect(manager.listRuns().filter((run) => run.loopId === "recipe-job-1")).toHaveLength(0);

    const run = manager.runNow("recipe-job-1");
    expect(run).not.toBeNull();
    await manager.tick();
    expect(calls.map((loop) => loop.id)).toEqual(["recipe-job-1"]);
    expect(manager.listRuns().find((row) => row.id === run!.id)).toMatchObject({
      manual: true,
      status: "completed",
      detail: "Shadow run — nothing was browsed or clicked.",
    });

    recipes[0] = taughtJob({ status: "active", planApprovedAt: now, approvedRevision: 1 });
    await manager.tick();
    expect(calls.filter((loop) => loop.id === "recipe-job-1")).toHaveLength(2);
    expect(manager.listLoops().find((loop) => loop.id === "recipe-job-1")?.waitingForPlan).toBe(false);
  });
});

describe('explicit office timezone for the morning mailbox', () => {
  it('keeps a reviewed office zone across reload and host timezone changes', async () => {
    const file=tempFile(); let now=Date.parse('2026-09-21T21:59:00Z'); const execute=vi.fn(async()=>({ok:true,detail:'Collected'}));
    const manager=track(new LoopManager({file,now:()=>now,hostTimezone:'UTC',execute}));
    manager.patchClock('inbound-triage',{enabled:true,time:'08:00',weekdays:[1,2,3,4,5],timezone:'Australia/Brisbane'});
    const before=manager.listLoops().find(l=>l.id==='inbound-triage')!;
    expect(before.nextRunAt).toBe(Date.parse('2026-09-21T22:00:00Z'));
    const restored=track(new LoopManager({file,now:()=>now,hostTimezone:'America/New_York',execute}));
    const current=restored.listLoops().find(l=>l.id==='inbound-triage')!;
    expect(current.schedule.timezone).toBe('Australia/Brisbane'); expect(current.timezonePaused).toBe(false);
    expect(restored.listLoops().find(l=>l.id==='morning-arrears')?.timezonePaused).toBe(true);
    now=Date.parse('2026-09-21T22:01:00Z'); await restored.tick(); expect(execute).toHaveBeenCalledTimes(1);
    await restored.tick(); expect(execute).toHaveBeenCalledTimes(1);
  });
  it('rejects malformed office zones without altering a saved clock',()=>{
    const {manager}=makeManager(); const before=manager.listLoops();
    expect(()=>manager.patchClock('inbound-triage',{timezone:'bad/timezone',enabled:true})).toThrow(/timezone/);
    expect(manager.listLoops()).toEqual(before);
  });
});

describe("bank-references opt-in", () => {
  it("is available but off until the office turns it on, keeps its two-day cadence and the saved on/off choice", () => {
    const file = tempFile();
    const options = { file, execute: async () => ({ ok: true, detail: "ok" }) };
    const manager = track(new LoopManager(options));
    const bank = () => manager.listLoops().find((loop) => loop.id === "bank-references")!;
    expect(bank()).toMatchObject({ available: true, enabled: false, nextRunAt: null, schedule: { intervalDays: 2, anchorDate: "2026-10-02" } });
    expect(bank().description).toMatch(/Redbark.*CSV.*REI tenant list/);
    expect(manager.setEnabled("bank-references", true)).toMatchObject({ enabled: true, schedule: { intervalDays: 2, anchorDate: "2026-10-02" } });
    expect(bank().nextRunAt).toEqual(expect.any(Number));
    manager.close();
    const restarted = track(new LoopManager(options));
    expect(restarted.listLoops().find((loop) => loop.id === "bank-references")).toMatchObject({ available: true, enabled: true });
    // The W1 startup hook's opt-in is a no-op for a loop the catalog declares available.
    restarted.setAvailable("bank-references", false);
    expect(restarted.listLoops().find((loop) => loop.id === "bank-references")).toMatchObject({ available: true, enabled: true });
  });
});

describe("saved schedules across the evaluator registry", () => {
  it("an old loops.json loads unchanged: on/off, clocks, revisions, history and off-but-runnable loops", async () => {
    const file = tempFile();
    const now = Date.UTC(2026, 9, 7, 0, 0); // Wed 7 Oct 2026, 10:00 in Brisbane
    const hour = 3_600_000;
    const run = (id: string, loopId: string, extra: Record<string, unknown> = {}) => ({
      id, loopId, loopName: loopId, scheduledFor: now - 30 * hour, status: "completed", manual: false,
      createdAt: now - 30 * hour, startedAt: now - 30 * hour, finishedAt: now - 30 * hour + 5_000, detail: `Fictional ${loopId} result.`, ...extra,
    });
    const runs = [
      run("run-money", "morning-arrears"),
      run("run-letter", "owner-letter", { status: "partial" }),
      run("run-inbox", "inbound-triage", { manual: true, requestId: "11111111-1111-4111-8111-111111111111", loopRevision: 4 }),
      run("run-job", "recipe-job-1", { jobRunId: "job-run-1", loopRevision: 2 }),
    ];
    writeFileSync(file, JSON.stringify({
      version: 3,
      timezone: "Australia/Brisbane",
      state: {
        "morning-arrears": { enabled: false, handledThrough: now - hour, revision: 3 },
        "owner-letter": { enabled: true, handledThrough: now - hour, schedule: { time: "15:30", weekdays: [5] }, revision: 2 },
        "inbound-triage": { enabled: true, handledThrough: now - hour, schedule: { time: "07:45", weekdays: [1, 2, 3, 4, 5], timezone: "Australia/Brisbane" }, revision: 4 },
        "weekly-bills": { enabled: false, handledThrough: now - hour },
        "bank-references": { enabled: true, handledThrough: now - hour, schedule: { time: "08:00", weekdays: [0, 1, 2, 3, 4, 5, 6], intervalDays: 2, anchorDate: "2026-10-02" } },
        "rei-supplier-check": { enabled: true, handledThrough: now - hour },
        "recipe-job-1": { enabled: true, handledThrough: now - hour, revision: 2 },
        "retired-loop": { enabled: true, handledThrough: 5 },
      },
      runs,
    }));
    const calls: string[] = [];
    const manager = track(new LoopManager({
      file, now: () => now, hostTimezone: "Australia/Brisbane",
      listRecipes: () => [taughtJob({ schedule: { time: "16:00", weekdays: [5] } })],
      execute: async (loop) => { calls.push(loop.id); return { ok: true, detail: "done" }; },
    }));
    expect(manager.recovery.active).toBe(false);
    // One line per loop. The expected lines are the pre-registry clock reading this same file.
    const line = (loop: Loop) => [loop.id, loop.enabled ? "on" : "off", loop.available ? "" : "unavailable", `r${loop.revision}`,
      loop.nextRunAt == null ? "next -" : `next ${new Date(loop.nextRunAt).toISOString()}`, JSON.stringify(loop.schedule, Object.keys(loop.schedule).sort()),
      `${loop.evaluatorId}@${loop.evaluatorVersion}`, loop.waitingForPlan ? "waiting-for-plan" : "", loop.timezonePaused ? "tz-paused" : ""].filter(Boolean).join(" ");
    expect(manager.listLoops().map(line)).toEqual([
      'morning-arrears off r3 next - {"time":"07:30","type":"daily","weekdays":[1,2,3,4,5]} morning-money@1',
      'owner-letter on r2 next 2026-10-09T05:30:00.000Z {"time":"15:30","type":"daily","weekdays":[5]} owner-letter@1',
      'inbound-triage on r4 next 2026-10-07T21:45:00.000Z {"time":"07:45","timezone":"Australia/Brisbane","type":"daily","weekdays":[1,2,3,4,5]} inbound-triage@1',
      'bank-references on r1 next 2026-10-07T22:00:00.000Z {"anchorDate":"2026-10-02","intervalDays":2,"time":"08:00","type":"daily","weekdays":[0,1,2,3,4,5,6]} bank-references@1',
      'weekly-bills off r1 next - {"time":"08:00","type":"daily","weekdays":[1]} weekly-bills@1',
      'maintenance-review off r1 next - {"time":"08:30","type":"daily","weekdays":[1,2,3,4,5]} maintenance-review@1',
      'rei-supplier-check on r1 next 2026-10-11T22:15:00.000Z {"anchorDate":"2026-10-12","intervalDays":14,"time":"08:15","type":"daily","weekdays":[0,1,2,3,4,5,6]} rei-supplier-check@1',
      'rei-morning-refresh off r1 next - {"time":"07:00","type":"daily","weekdays":[1,2,3,4,5]} rei-morning-refresh@1',
      'inspection-draft off r1 next - {"monthly":"first-weekday","time":"09:00","type":"daily","weekdays":[1,2,3,4,5]} inspection-draft@1',
      'recipe-job-1 off r2 next - {"time":"16:00","type":"daily","weekdays":[5]} recipe@1 waiting-for-plan',
    ]);
    expect(manager.listRuns()).toEqual(runs);
    // Opt-in loops run from Schedule while off; a loop the office turned off does not.
    expect(manager.runNow("maintenance-review")).toMatchObject({ loopId: "maintenance-review", manual: true, status: "queued" });
    expect(manager.runNow("morning-arrears")).toBeNull();
    await manager.tick();
    expect(calls).toEqual(["maintenance-review"]);
  });
});

