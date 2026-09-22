import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Recipe } from "../shared/contracts.ts";
import { JobRunStore } from "./job-runs.ts";
import * as atomic from "./atomic.ts";

const dirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "realbud-job-runs-"));
  dirs.push(dir);
  return join(dir, "job-runs.json");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function job(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: "job-1",
    title: "Friday arrears",
    description: "Check the arrears report and prepare exceptions.",
    steps: ["Read the report", "Prepare exceptions on Desk"],
    allowedOrigins: ["propertyme.com.au"],
    evidence: "Rows and source",
    capabilities: ["read-book", "analyse", "draft"],
    limits: { maxRuntimeMinutes: 2, maxTurns: 6 },
    siteNotes: null,
    status: "active",
    createdAt: 10,
    schedule: { time: "16:00", weekdays: [5] },
    planApprovedAt: 11,
    revision: 2,
    updatedAt: 12,
    approvedRevision: 2,
    attachment: null,
    submitAcknowledgedAt: null,
    ...overrides,
  };
}

describe("JobRunStore", () => {
  it("deduplicates an idempotency key and freezes the queued revision", () => {
    const store = new JobRunStore({ file: tempFile(), now: () => 100 });
    const recipe = job();
    const first = store.enqueue(recipe, {
      mode: "prepare",
      trigger: "schedule",
      scheduledFor: 90,
      loopRunId: "loop-1",
      idempotencyKey: "job-1:2:90",
    });
    recipe.steps[0] = "Changed later";
    recipe.revision = 3;
    const again = store.enqueue(job(), {
      mode: "prepare",
      trigger: "schedule",
      scheduledFor: 90,
      loopRunId: "loop-1",
      idempotencyKey: "job-1:2:90",
    });

    expect(() => store.enqueue(recipe, { mode: "prepare", trigger: "schedule", scheduledFor: 90, loopRunId: "loop-1", idempotencyKey: "job-1:2:90" })).toThrow(expect.objectContaining({ status: 409 }));
    expect(first.created).toBe(true);
    expect(again.created).toBe(false);
    expect(again.run.id).toBe(first.run.id);
    expect(again.run.jobRevision).toBe(2);
    expect(again.run.spec.steps[0]).toBe("Read the report");
    expect(store.list()).toHaveLength(1);
  });

  it("rejects overlapping unresolved work for the same job", () => {
    const store = new JobRunStore({ file: tempFile() });
    store.enqueue(job(), { mode: "shadow", trigger: "manual", idempotencyKey: "manual-1" });
    expect(() =>
      store.enqueue(job(), { mode: "shadow", trigger: "manual", idempotencyKey: "manual-2" }),
    ).toThrow(/already has work/i);
    expect(
      store.enqueue(job({ id: "job-2" }), {
        mode: "shadow",
        trigger: "manual",
        idempotencyKey: "manual-3",
      }).created,
    ).toBe(true);
  });

  it("does not let a safely held receipt deadlock the next scheduled occurrence", () => {
    const store = new JobRunStore({ file: tempFile(), now: () => 100 });
    const first = store.enqueue(job(), {
      mode: "prepare",
      trigger: "schedule",
      idempotencyKey: "job-1:2:100",
    }).run;
    store.start(first.id);
    store.settle(first.id, {
      status: "awaiting-approval",
      detail: "Draft ready; sending remains held.",
      approvalRequests: ["Review and send the draft yourself."],
    });

    expect(store.enqueue(job(), {
      mode: "prepare",
      trigger: "schedule",
      idempotencyKey: "job-1:2:200",
    }).created).toBe(true);
    expect(store.list()).toHaveLength(2);
  });

  it("redacts receipts, persists them, and marks seen once", () => {
    let now = 100;
    const file = tempFile();
    const store = new JobRunStore({ file, now: () => now });
    const queued = store.enqueue(job(), { mode: "prepare", trigger: "manual", idempotencyKey: "manual-1" }).run;
    store.start(queued.id);
    now = 120;
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    const settled = store.settle(queued.id, {
      status: "awaiting-approval",
      detail: `Prepared with sk-ant-api03-${alpha}`,
      evidence: [{ at: 119, kind: "output", note: `draft sk-ant-api03-${alpha}` }],
      approvalRequests: [`send using sk-ant-api03-${alpha}`],
    });
    expect(JSON.stringify(settled)).not.toContain("sk-ant-api03");
    expect(settled.status).toBe("awaiting-approval");
    expect(settled.finishedAt).toBe(120);

    now = 130;
    const seen = store.markSeen(queued.id);
    now = 140;
    expect(store.markSeen(queued.id).seenAt).toBe(seen.seenAt);
    expect(new JobRunStore({ file }).get(queued.id)).toMatchObject({
      status: "awaiting-approval",
      seenAt: 130,
    });
  });

  it("keeps a queued attended run and misses it after a day", () => {
    const file = tempFile();
    let now = 100;
    const first = new JobRunStore({ file, now: () => now });
    const queued = first.enqueue(job({ capabilities: ["portal-read"] }), {
      mode: "attended",
      trigger: "schedule",
      idempotencyKey: "job-1:2:ready",
      detail: "Ready to run beside you — press Start when you are at the screen.",
    }).run;
    expect(queued.status).toBe("queued");

    const restarted = new JobRunStore({ file, now: () => 200 });
    expect(restarted.get(queued.id)?.status).toBe("queued");

    now = 100 + 24 * 60 * 60_000 + 1;
    const late = new JobRunStore({ file, now: () => now });
    expect(late.get(queued.id)).toMatchObject({
      status: "missed",
      detail: "Not started — the run waited a day for someone at the screen.",
    });
  });

  it("marks queued and running work interrupted after restart", () => {
    const file = tempFile();
    const first = new JobRunStore({ file, now: () => 100 });
    const running = first.enqueue(job(), { mode: "prepare", trigger: "manual", idempotencyKey: "manual-1" }).run;
    first.start(running.id);

    const second = new JobRunStore({ file, now: () => 200 });
    expect(second.get(running.id)).toMatchObject({
      status: "interrupted",
      finishedAt: 200,
    });
    expect(second.get(running.id)?.detail).toMatch(/no action was resumed/i);
  });

  it.each([
    "not json",
    JSON.stringify({ version: 1, runs: [null, { id: 1 }] }),
    JSON.stringify({ version: 2, runs: [] }),
    JSON.stringify({ version: 1 }),
  ])("preserves unreadable history and blocks reads and mutations: %s", (contents) => {
    const file = tempFile();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, contents);
    const store = new JobRunStore({ file });
    expect(store.recovery).toMatchObject({ active: true, detail: expect.stringMatching(/preserved/) });
    for (const action of [
      () => store.list(),
      () => store.get("old-run"),
      () => store.enqueue(job(), { mode: "prepare", trigger: "manual", idempotencyKey: "new-key" }),
      () => store.start("old-run"),
      () => store.sweepQueuedAttended(),
      () => store.markSeen("old-run"),
      () => store.cancel("old-run"),
    ]) expect(action).toThrow(expect.objectContaining({ status: 503 }));
    expect(readFileSync(file, "utf8")).toBe(contents);
  });

  it("rejects persisted snapshots with invented capabilities or unbounded limits", () => {
    const file = tempFile();
    const store = new JobRunStore({ file, now: () => 100 });
    const run = store.enqueue(job(), {
      mode: "prepare",
      trigger: "manual",
      idempotencyKey: "manual-1",
    }).run;
    const unsafe = {
      version: 1,
      runs: [
        { ...run, spec: { ...run.spec, capabilities: ["send-email"] } },
        { ...run, id: "unbounded", idempotencyKey: "manual-2", spec: { ...run.spec, limits: { maxRuntimeMinutes: 999, maxTurns: 999 } } },
      ],
    };
    writeFileSync(file, JSON.stringify(unsafe));

    expect(() => new JobRunStore({ file }).list()).toThrow(/history needs recovery/);
  });

  it("accepts legacy arrays while blocking duplicate receipt identities", () => {
    const file = tempFile();
    const original = new JobRunStore({ file: tempFile(), now: () => 100 });
    const run = original.enqueue(job(), { mode: "attended", trigger: "manual", idempotencyKey: "legacy-key" }).run;
    writeFileSync(file, JSON.stringify([run]));
    expect(new JobRunStore({ file, now: () => 101 }).get(run.id)).toEqual(run);
    for (const duplicate of [{ ...run, id: "another-id" }, { ...run, idempotencyKey: "another-key" }]) {
      const contents = JSON.stringify({ version: 1, runs: [run, duplicate] });
      writeFileSync(file, contents);
      expect(() => new JobRunStore({ file }).list()).toThrow(/history needs recovery/);
      expect(readFileSync(file, "utf8")).toBe(contents);
    }
  });

  it("holds a durable intent without publishing it when the activity projection cannot be saved", () => {
    const file = tempFile();
    const emit = vi.fn();
    const store = new JobRunStore({ file, now: () => 100, emit });
    vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOSPC: sensitive file path"), { code: "ENOSPC" });
    });
    const input = { mode: "attended" as const, trigger: "manual" as const, idempotencyKey: "disk-full-key" };
    expect(() => store.enqueue(job(), input)).toThrow(expect.objectContaining({ status: 503, message: expect.stringContaining("disk space") }));
    expect(() => store.list()).toThrow(expect.objectContaining({ status: 503 }));
    expect(emit).not.toHaveBeenCalled();
    expect(store.recovery.active).toBe(true);
    expect(() => store.enqueue(job(), input)).toThrow(expect.objectContaining({ status: 503 }));
    const restarted = new JobRunStore({ file, now: () => 101 });
    const retry = restarted.enqueue(job(), input);
    expect(retry.created).toBe(false);
    expect(restarted.get(retry.run.id)).toEqual(retry.run);
  });

  it.each(["start", "evidence", "settle", "seen", "cancel", "sweep"] as const)("holds a failed %s projection without publishing or replaying its durable transition", (action) => {
    const file = tempFile();
    let now = 100;
    const emit = vi.fn();
    const store = new JobRunStore({ file, now: () => now, emit });
    const run = store.enqueue(job(), { mode: "attended", trigger: "manual", idempotencyKey: `rollback-${action}` }).run;
    if (action === "evidence" || action === "settle") store.start(run.id);
    const onDisk = readFileSync(file, "utf8");
    emit.mockClear();
    now += 24 * 60 * 60_000 + 1;
    vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce(() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    const change = () => {
      if (action === "start") return store.start(run.id, "Starting", { threadId: "thread-1" });
      if (action === "evidence") return store.appendEvidence(run.id, [{ kind: "output", note: "complete draft", at: now }]);
      if (action === "settle") return store.settle(run.id, { status: "completed", detail: "Done", evidence: [{ kind: "output", note: "complete draft", at: now }] });
      if (action === "seen") return store.markSeen(run.id);
      if (action === "cancel") return store.cancel(run.id);
      return store.sweepQueuedAttended();
    };
    expect(change).toThrow(expect.objectContaining({ status: 503 }));
    expect(() => store.get(run.id)).toThrow(expect.objectContaining({ status: 503 }));
    expect(readFileSync(file, "utf8")).toBe(onDisk);
    expect(emit).not.toHaveBeenCalled();
    expect(change).toThrow(expect.objectContaining({ status: 503 }));
    const restarted = new JobRunStore({ file, now: () => now });
    const saved = restarted.get(run.id)!;
    expect(saved.status).toBe(action === 'settle' ? 'completed' : action === 'cancel' ? 'cancelled' : action === 'sweep' || action === 'seen' ? 'missed' : 'interrupted');
    if (action === 'seen') expect(saved.seenAt).toBe(now);
    if (action === 'evidence' || action === 'settle') expect(saved.evidence[0]?.note).toBe('complete draft');
  });

  it("keeps the app available but pauses work if restart recovery cannot be saved", () => {
    const file = tempFile();
    const original = new JobRunStore({ file, now: () => 100 });
    const run = original.enqueue(job(), { mode: "prepare", trigger: "manual", idempotencyKey: "interrupted" }).run;
    original.start(run.id);
    const before = readFileSync(file, "utf8");
    vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce(() => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    const restarted = new JobRunStore({ file, now: () => 200 });
    expect(restarted.recovery.active).toBe(true);
    expect(() => restarted.list()).toThrow(expect.objectContaining({ status: 503 }));
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(new JobRunStore({ file, now: () => 300 }).get(run.id)).toMatchObject({ status: "interrupted", finishedAt: 200 });
  });

  it("does not revert an already-renamed receipt when the final directory flush fails", () => {
    const file = tempFile();
    const store = new JobRunStore({ file, now: () => 100 });
    const run = store.enqueue(job(), { mode: "prepare", trigger: "manual", idempotencyKey: "uncertain-save" }).run;
    store.start(run.id);
    const write = atomic.writeFileAtomic;
    vi.spyOn(atomic, "writeFileAtomic").mockImplementationOnce((...args) => {
      write(...args);
      throw Object.assign(new Error("fsync error"), { code: "EIO" });
    });
    expect(() => store.settle(run.id, { status: "completed", detail: "Prepared" })).toThrow(/durable save could not be confirmed/);
    expect(store.recovery.active).toBe(true);
    expect(() => store.get(run.id)).toThrow(expect.objectContaining({ status: 503 }));
    expect(JSON.parse(readFileSync(file, "utf8")).runs[0]).toMatchObject({ id: run.id, status: "completed" });
    expect(new JobRunStore({ file }).get(run.id)).toMatchObject({ status: "completed" });
  });

  it("keeps concurrent duplicate requests on the same persisted receipt", async () => {
    const file = tempFile();
    const store = new JobRunStore({ file, now: () => 100 });
    const results = await Promise.all(Array.from({ length: 8 }, async () => store.enqueue(job(), {
      mode: "attended", trigger: "manual", idempotencyKey: "one-operation",
    })));
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.run.id)).size).toBe(1);
    expect(new JobRunStore({ file, now: () => 101 }).list()).toHaveLength(1);
  });
});
