import { describe, expect, it } from "vitest";

import type { JobRun, LoopRun } from "@shared/contracts";
import { buildWorkActivity, routineRunsForActivity } from "./work-activity";

function job(id: string, at: number): JobRun {
  return {
    id,
    jobId: "recipe-1",
    jobTitle: "Owner brief",
    jobRevision: 1,
    mode: "shadow",
    status: "completed",
    trigger: "manual",
    scheduledFor: at,
    idempotencyKey: `key-${id}`,
    attempt: 1,
    spec: { title: "Owner brief", description: "", steps: ["Read"], allowedOrigins: [], evidence: "receipt", capabilities: ["read-book"], limits: { maxRuntimeMinutes: 2, maxTurns: 6 } },
    evidence: [],
    approvalRequests: [],
    detail: "done",
    createdAt: at,
  };
}

function routine(id: string, at: number, jobRunId?: string): LoopRun {
  return { id, loopId: "morning-arrears", loopName: "Morning money", scheduledFor: at, status: "completed", manual: true, createdAt: at, jobRunId };
}

describe("work activity", () => {
  it("combines jobs and routines newest-first and deduplicates linked wrappers", () => {
    const rows = buildWorkActivity([job("job-1", 20)], [routine("loop-linked", 21, "job-1"), routine("recheck", 30)]);
    expect(rows.map((row) => row.id)).toEqual(["routine:recheck", "job:job-1"]);
  });

  it("keeps a clock wrapper when its durable receipt is unavailable", () => {
    expect(buildWorkActivity([], [routine("orphan", 10, "missing")])).toHaveLength(1);
  });

  it("preserves a held job result while hiding only its matching clock wrapper", () => {
    const held: JobRun = { ...job("held-result", 30), mode: "prepare", status: "awaiting-approval", approvalRequests: ["Review the owner update before sending."] };
    const clock: LoopRun = { ...routine("held-clock", 29, held.id), status: "awaiting-approval" };
    const rows = buildWorkActivity([held], [clock]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "job", run: { status: "awaiting-approval", approvalRequests: held.approvalRequests } });
    expect(routineRunsForActivity(rows[0], [clock])).toEqual([clock]);
  });

  it("keeps an orphaned held clock visible with its original review state", () => {
    const held: LoopRun = { ...routine("held-clock", 20, "unloaded-job"), status: "awaiting-approval" };
    expect(buildWorkActivity([], [held])).toEqual([{ kind: "routine", id: "routine:held-clock", at: 20, run: held }]);
  });

  it("shows on-demand preparation alongside scheduled work without its duplicate clock wrapper", () => {
    const manual: JobRun = { ...job("manual", 40), mode: "prepare", status: "partial" };
    const scheduled: JobRun = { ...job("scheduled", 30), mode: "prepare", trigger: "schedule" };
    const rows = buildWorkActivity([manual, scheduled], [routine("clock", 31, "scheduled")]);
    expect(rows.map((row) => row.id)).toEqual(["job:manual", "job:scheduled"]);
    expect(rows[0].run.status).toBe("partial");
  });

  it("routes acknowledgement and produced Desk cases through the exact clock receipt, never a different run of the same job", () => {
    const clocks = [routine("older-clock", 10, "old-run"), routine("matching-clock", 20, "current-run")];
    const [activity] = buildWorkActivity([job("current-run", 21)], clocks);
    expect(routineRunsForActivity(activity, clocks).map((run) => run.id)).toEqual(["matching-clock"]);
    const [manual] = buildWorkActivity([job("on-demand", 30)], []);
    expect(routineRunsForActivity(manual, clocks)).toEqual([]);
    const [orphan] = buildWorkActivity([], [routine("orphan-clock", 10, "missing")]);
    expect(routineRunsForActivity(orphan, clocks).map((run) => run.id)).toEqual(["orphan-clock"]);
  });
});
