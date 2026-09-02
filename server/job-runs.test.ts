import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { Recipe } from "../shared/contracts.ts";
import { JobRunStore } from "./job-runs.ts";

const dirs: string[] = [];

function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "realbud-job-runs-"));
  dirs.push(dir);
  return join(dir, "job-runs.json");
}

afterEach(() => {
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
    const again = store.enqueue(recipe, {
      mode: "prepare",
      trigger: "schedule",
      scheduledFor: 90,
      loopRunId: "loop-1",
      idempotencyKey: "job-1:2:90",
    });

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

  it("survives corrupt and mixed persisted rows", () => {
    const file = tempFile();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "not json");
    expect(new JobRunStore({ file }).list()).toEqual([]);
    writeFileSync(file, JSON.stringify({ version: 1, runs: [null, { id: 1 }] }));
    expect(new JobRunStore({ file }).list()).toEqual([]);
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

    expect(new JobRunStore({ file }).list()).toEqual([]);
  });
});
