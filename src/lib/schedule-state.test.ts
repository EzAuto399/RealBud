import { describe, expect, it } from "vitest";
import type { JobRun, Loop, LoopRun } from "@shared/contracts";
import { mergeJobRuns, mergeLoopClock, mergeLoopClocks, mergeLoopRuns, mergeScheduleRecovery } from "./schedule-state";

function run(overrides: Partial<LoopRun> = {}): LoopRun {
  return { id: "run-1", loopId: "owner-letter", loopName: "Owner update", scheduledFor: 100, createdAt: 100, manual: true, status: "queued", ...overrides };
}
function loop(overrides: Partial<Loop> = {}): Loop {
  return { id: "owner-letter", name: "Owner update", description: "Prepare an update", available: true, enabled: true,
    schedule: { type: "daily", time: "16:00", weekdays: [5] }, revision: 1, nextRunAt: 200,
    evaluatorId: "owner-letter", evaluatorVersion: 1, ...overrides };
}
function job(overrides: Partial<JobRun> = {}): JobRun {
  return { id: "job-run", jobId: "job-1", jobTitle: "Owner update", jobRevision: 1, mode: "prepare", trigger: "manual",
    idempotencyKey: "manual-key", attempt: 1, scheduledFor: 100, createdAt: 100, status: "queued", detail: "Queued",
    spec: { title: "Owner update", description: "Prepare an update", steps: ["Draft a private update"], allowedOrigins: [], evidence: "Complete draft",
      capabilities: ["analyse", "draft"], limits: { maxRuntimeMinutes: 2, maxTurns: 3 } }, evidence: [], approvalRequests: [], ...overrides };
}

describe("schedule state reconciliation", () => {
  it.each(["completed", "partial", "awaiting-approval", "failed", "missed", "interrupted"] as const)("does not regress a %s receipt when an older active response arrives", (status) => {
    const completed = run({ status, finishedAt: 140, detail: "Saved outcome", jobRunId: "job-receipt" });
    for (const stale of [run(), run({ status: "running", startedAt: 110 })]) {
      expect(mergeLoopRuns([completed], [stale])).toEqual([completed]);
      expect(mergeLoopRuns([stale], [completed])).toEqual([completed]);
    }
  });

  it("does not regress running work to queued, and accepts a later running detail", () => {
    const active = run({ status: "running", startedAt: 110, detail: "Preparing" });
    expect(mergeLoopRuns([active], [run()])).toEqual([active]);
    expect(mergeLoopRuns([active], [{ ...active, detail: "Taking longer; outcome unconfirmed" }])[0].detail).toMatch(/unconfirmed/);
  });

  it("preserves the latest acknowledgement across delayed receipts", () => {
    const completed = run({ status: "completed", finishedAt: 140, seenAt: 160 });
    expect(mergeLoopRuns([completed], [run({ seenAt: 120 })])[0]).toEqual(completed);
    expect(mergeLoopRuns([completed], [{ ...completed, seenAt: 180 }])[0].seenAt).toBe(180);
    expect(mergeLoopRuns([completed], [{ ...completed, finishedAt: 130, seenAt: 180 }])[0]).toMatchObject({ finishedAt: 140, seenAt: 180 });
  });

  it("retains SSE-only rows while keeping history bounded and newest first", () => {
    const history = Array.from({ length: 2_001 }, (_, index) => run({ id: `run-${index}`, scheduledFor: index, createdAt: index }));
    const merged = mergeLoopRuns(history, [run({ id: "newest", scheduledFor: 3_000 })]);
    expect(merged).toHaveLength(2_000);
    expect(merged[0].id).toBe("newest");
    expect(merged.some((item) => item.id === "run-0")).toBe(false);
    expect(mergeLoopRuns([run({ id: "sse-only" })], [])).toHaveLength(1);
  });

  it.each(["completed", "partial", "awaiting-approval", "failed", "interrupted", "cancelled", "missed"] as const)("keeps a %s job's complete evidence and approvals over a delayed active read", (status) => {
    const terminal = job({ status, startedAt: 110, finishedAt: 140, seenAt: 170, detail: "Complete prepared result",
      evidence: [{ at: 130, kind: "output", note: "Full owner update\nReview access before booking." }], approvalRequests: ["PM to approve booking"] });
    for (const stale of [job(), job({ status: "running", startedAt: 110, seenAt: 120 })]) {
      expect(mergeJobRuns([terminal], [stale])).toEqual([terminal]);
      expect(mergeJobRuns([stale], [terminal])).toEqual([terminal]);
    }
    expect(mergeJobRuns([terminal], [{ ...terminal, seenAt: 190 }])[0]).toMatchObject({ seenAt: 190, evidence: terminal.evidence, approvalRequests: terminal.approvalRequests });
  });

  it("advances job progress normally, uses later finished receipts, and bounds history to 200 by start time", () => {
    const active = job({ status: "running", startedAt: 110 });
    expect(mergeJobRuns([job()], [active])).toEqual([active]);
    expect(mergeJobRuns([active], [job()])).toEqual([active]);
    const terminal = job({ status: "completed", finishedAt: 150, evidence: [{ kind: "output", at: 149, note: "Final report" }] });
    expect(mergeJobRuns([terminal], [{ ...terminal, finishedAt: 140, evidence: [], seenAt: 180 }])[0]).toMatchObject({ finishedAt: 150, seenAt: 180, evidence: terminal.evidence });
    const history = Array.from({ length: 201 }, (_, index) => job({ id: `job-${index}`, startedAt: index, createdAt: 1_000 - index }));
    const merged = mergeJobRuns(history, [job({ id: "newest-job", createdAt: 3_000 })]);
    expect(merged).toHaveLength(200);
    expect(merged[0].id).toBe("newest-job");
    expect(merged[1].id).toBe("job-200");
    expect(merged.some((item) => item.id === "job-0")).toBe(false);
  });

  it("keeps newer clock revisions for hydration and individual patches", () => {
    const newer = loop({ revision: 3, enabled: false, nextRunAt: null, schedule: { type: "daily", time: "17:00", weekdays: [4] } });
    expect(mergeLoopClock(newer, loop())).toEqual(newer);
    expect(mergeLoopClocks([newer], [loop()])).toEqual([newer]);
    expect(mergeLoopClock(loop(), newer)).toEqual(newer);
    expect(mergeLoopClock(loop(), loop({ nextRunAt: 300 })).nextRunAt).toBe(300);
  });

  it("lets a complete catalog remove deleted jobs without mutating inputs", () => {
    const original = loop();
    expect(mergeLoopClocks([original], [])).toEqual([]);
    const merged = mergeLoopClock(undefined, original);
    merged.schedule.weekdays.push(6);
    expect(original.schedule.weekdays).toEqual([5]);
  });

  it("keeps same-generation recovery held against stale healthy responses", () => {
    const held = { generation: "server-a", active: true, detail: "History needs recovery" };
    expect(mergeScheduleRecovery(held, { generation: "server-a", active: false, detail: "" })).toEqual(held);
    expect(mergeScheduleRecovery(held, { active: false, detail: "" })).toEqual(held);
    expect(mergeScheduleRecovery(held, { generation: "server-a", active: true, detail: "Recovery updated" }).detail).toBe("Recovery updated");
  });

  it("accepts a healthy restarted server and a newly reported recovery hold", () => {
    const healthy = { generation: "server-b", active: false, detail: "" };
    expect(mergeScheduleRecovery({ generation: "server-a", active: true, detail: "Held" }, healthy)).toEqual(healthy);
    expect(mergeScheduleRecovery(healthy, { ...healthy, active: true, detail: "Disk full" }).active).toBe(true);
  });
});
