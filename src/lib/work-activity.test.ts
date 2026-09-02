import { describe, expect, it } from "vitest";

import type { JobRun, LoopRun } from "@shared/contracts";
import { buildWorkActivity } from "./work-activity";

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
});
