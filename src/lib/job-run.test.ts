import { describe, expect, it } from "vitest";

import type { JobRun } from "./desk";
import {
  attendedEvidenceLine,
  attendedHeaderLabel,
  attendedRunLabel,
  jobActionLabel,
  jobRunEvidenceCount,
  jobRunModeLabel,
  jobRunStatusChip,
  jobRunSummaryLine,
  latestAttendedFor,
  loopRunStatusLabel,
  queuedAttended,
  runningAttended,
  safeJobRunDetail,
} from "./job-run";

function run(partial: Partial<JobRun> = {}): JobRun {
  return {
    id: "run-1",
    jobId: "job-1",
    jobTitle: "Friday arrears",
    jobRevision: 3,
    mode: "prepare",
    status: "completed",
    trigger: "manual",
    scheduledFor: 1_700_000_000_000,
    idempotencyKey: "manual-1",
    attempt: 1,
    spec: {
      title: "Friday arrears",
      description: "Prepare exceptions.",
      steps: ["Read the book"],
      allowedOrigins: [],
      evidence: "exception rows",
      capabilities: ["read-book", "analyse"],
      limits: { maxRuntimeMinutes: 2, maxTurns: 6 },
    },
    evidence: [{ at: 1, kind: "observation", note: "Read book revision 4" }],
    approvalRequests: [],
    detail: "Prepared the exception list.",
    createdAt: 1_700_000_000_000,
    finishedAt: 1_700_000_060_000,
    ...partial,
  };
}

describe("job run copy", () => {
  it("uses calm PM-facing mode and status labels", () => {
    expect(jobRunModeLabel("shadow")).toBe("Shadow rehearsal");
    expect(jobRunModeLabel("prepare")).toBe("Prepared by Bud");
    expect(jobRunStatusChip("awaiting-approval")).toMatchObject({ label: "Needs you" });
    expect(jobRunStatusChip("interrupted")).toMatchObject({ label: "Interrupted" });
  });

  it("counts receipts and summarizes the pinned version", () => {
    const now = 1_700_000_120_000;
    expect(jobRunEvidenceCount(run())).toBe("1 receipt");
    expect(jobRunEvidenceCount(run({ evidence: [] }))).toBe("0 receipts");
    expect(jobRunSummaryLine(run(), now)).toBe("Prepared by Bud · 1 receipt · v3 · 1 min ago");
  });

  it("normalizes and bounds detail copy", () => {
    expect(safeJobRunDetail("  one\n\n two  ")).toBe("one two");
    expect(safeJobRunDetail("abcdefgh", 5)).toBe("abcd…");
  });

  it("labels an attended run for the Schedule card", () => {
    expect(jobRunModeLabel("attended")).toBe("Beside you");
    expect(attendedHeaderLabel("Friday arrears")).toBe("Running Friday arrears beside you");
    expect(attendedRunLabel({ ...run(), mode: "prepare", status: "running" })).toBeNull();
    expect(attendedRunLabel({ ...run(), mode: "attended", status: "running" })).toEqual({
      label: "Running beside you",
      tone: "agency",
    });
    expect(
      attendedRunLabel({
        ...run(),
        mode: "attended",
        status: "completed",
        spec: { ...run().spec, allowedOrigins: ["portal.example.com"] },
      }),
    ).toEqual({ label: "Done · read back from portal.example.com", tone: "agency" });
    expect(attendedRunLabel({ ...run(), mode: "attended", status: "partial" })).toEqual({
      label: "Unknown — check the site yourself",
      tone: "hold",
    });
    expect(attendedRunLabel({ ...run(), mode: "attended", status: "unknown" })).toEqual({
      label: "Unknown — check the site yourself",
      tone: "hold",
    });
    expect(attendedRunLabel({ ...run(), mode: "attended", status: "failed" })).toEqual({
      label: "Stopped",
      tone: "danger",
    });
    expect(attendedRunLabel({ ...run(), mode: "attended", status: "interrupted" })).toEqual({
      label: "Stopped by you — check the site yourself",
      tone: "hold",
    });
    expect(attendedRunLabel({ ...run(), mode: "attended", status: "queued" })).toEqual({
      label: "Ready beside you",
      tone: "hold",
    });
    expect(attendedRunLabel({ ...run(), mode: "attended", status: "missed" })).toEqual({
      label: "Not started — waited a day",
      tone: "hold",
    });
  });

  it("maps tool ids to open/read/fill/click and flags fence denials", () => {
    expect(jobActionLabel("browser_open")).toBe("open");
    expect(jobActionLabel("read_page")).toBe("read");
    expect(jobActionLabel("fill_field")).toBe("fill");
    expect(jobActionLabel("click_submit")).toBe("click");
    expect(jobActionLabel("mcp__browser__screenshot")).toBe("read");
    expect(jobActionLabel("mystery_tool")).toBe("action");
    expect(attendedEvidenceLine({ kind: "denied", note: "click" })).toEqual({
      label: "click",
      denied: true,
      rule: false,
      submitApproved: false,
    });
    expect(attendedEvidenceLine({ kind: "observation", note: "open arrears" })).toEqual({
      label: "open",
      denied: false,
      rule: false,
      submitApproved: false,
    });
    expect(attendedEvidenceLine({ kind: "action", note: "allowed by rule — read the page" })).toEqual({
      label: "read",
      denied: false,
      rule: true,
      submitApproved: false,
    });
    expect(attendedEvidenceLine({ kind: "approval", note: "Submit allowed" })).toEqual({
      label: "Submit pressed with your approval",
      denied: false,
      rule: false,
      submitApproved: true,
    });
  });

  it("finds the newest attended run for a job", () => {
    const older = { ...run(), id: "a", mode: "attended", createdAt: 10, startedAt: 10 };
    const newer = { ...run(), id: "b", mode: "attended", status: "running", createdAt: 20, startedAt: 20 };
    const other = { ...run(), id: "c", jobId: "job-2", mode: "attended", createdAt: 99 };
    expect(latestAttendedFor([older, other, newer], "job-1")?.id).toBe("b");
    expect(runningAttended([older, newer], "job-1")?.id).toBe("b");
    expect(runningAttended([older], "job-1")).toBeUndefined();
    const queued = { ...run(), id: "q", mode: "attended", status: "queued" as const, createdAt: 5 };
    expect(queuedAttended([queued, newer], "job-1")?.id).toBe("q");
  });

  it("maps clock-run chips onto the StatusLabel tones", () => {
    expect(loopRunStatusLabel("queued")).toEqual({ label: "Queued", tone: "agency" });
    expect(loopRunStatusLabel("running")).toEqual({ label: "Running", tone: "agency" });
    expect(loopRunStatusLabel("partial")).toEqual({ label: "Partly done", tone: "hold" });
    expect(loopRunStatusLabel("completed")).toEqual({ label: "Finished", tone: "muted" });
    expect(loopRunStatusLabel("failed")).toEqual({ label: "Failed", tone: "danger" });
    expect(loopRunStatusLabel("missed")).toEqual({ label: "Missed", tone: "danger" });
    expect(loopRunStatusLabel("interrupted")).toEqual({ label: "Interrupted", tone: "danger" });
  });
});
