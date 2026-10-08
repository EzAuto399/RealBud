import { describe, expect, it } from "vitest";
import type { JobRun, Recipe } from "./desk";
import type { Loop, LoopRun } from "./routines";
import { buildScheduleRows, type ScheduleRowInput } from "./schedule-rows";
import { filterScheduleRows, scheduleRowGuidance, scheduleRowSection } from "./schedule-presentation";

const NOW = Date.UTC(2026, 9, 3);
const loop = (patch: Partial<Loop> = {}): Loop => ({
  id: "owner-letter", name: "Owner letter", description: "Fictional letter", available: true, enabled: true,
  schedule: { type: "daily", time: "16:00", weekdays: [5] }, revision: 1, nextRunAt: NOW + 86_400_000,
  evaluatorId: "fictional", evaluatorVersion: 1, ...patch,
});
const recipe = (patch: Partial<Recipe> = {}): Recipe => ({
  id: "portal-check", title: "Portal check", description: "Fictional portal", steps: ["Read"], allowedOrigins: ["portal.example.test"],
  evidence: "Readback", capabilities: ["portal-read"], limits: { maxRuntimeMinutes: 2, maxTurns: 6 }, status: "active", createdAt: 1, updatedAt: 1,
  schedule: null, planApprovedAt: 10, revision: 2, approvedRevision: 2, attachment: null, submitAcknowledgedAt: null, ...patch,
});
const run = (patch: Partial<LoopRun> = {}): LoopRun => ({
  id: "run-1", loopId: "owner-letter", loopName: "Owner letter", scheduledFor: NOW - 60_000,
  status: "completed", manual: false, createdAt: NOW - 60_000, ...patch,
});
const jobRun = (patch: Partial<JobRun> = {}): JobRun => ({
  id: "job-run-1", jobId: "portal-check", jobTitle: "Portal check", jobRevision: 2, mode: "attended", status: "queued", trigger: "manual",
  scheduledFor: NOW - 60_000, idempotencyKey: "fictional-key", attempt: 1,
  spec: { title: "Portal check", description: "Read", steps: ["Read"], allowedOrigins: [], evidence: "Readback", capabilities: ["portal-read"], limits: { maxRuntimeMinutes: 2, maxTurns: 6 } },
  evidence: [], approvalRequests: [], detail: "Fictional detail", createdAt: NOW - 60_000, ...patch,
});
const rows = (patch: Partial<ScheduleRowInput>) => buildScheduleRows({
  loops: [], recipes: [], loopRuns: [], jobRuns: [], nowMs: NOW, timeZone: "Australia/Brisbane", ...patch,
});
const only = (patch: Partial<ScheduleRowInput>) => {
  const result = rows(patch);
  expect(result).toHaveLength(1);
  return result[0]!;
};

describe("schedule presentation", () => {
  it("separates active work from requests waiting for a person or confirmation", () => {
    const waiting = only({ recipes: [recipe()], jobRuns: [jobRun()] });
    const active = only({ recipes: [recipe()], jobRuns: [jobRun({ status: "running" })] });
    const preparation = only({ loops: [loop()], loopRuns: [run({ status: "queued" })] });
    const pending = only({ loops: [loop()], pendingLoops: new Set(["owner-letter"]) });
    expect([waiting, active, preparation, pending].map(scheduleRowSection)).toEqual(["attention", "running", "running", "attention"]);
    expect(filterScheduleRows([waiting, active, preparation, pending], "attention")).toEqual([waiting, pending]);
    expect(scheduleRowGuidance(pending)).toBe("Confirm the earlier request before starting another run.");
  });

  it("says a never-run off job is switched on, and a scheduled job runs by itself", () => {
    const off = only({ loops: [loop({ enabled: false, nextRunAt: null })] });
    expect([off.next, off.actionLabel, scheduleRowGuidance(off)]).toEqual(["Off", "Switch on", "Switch this on when you want it to run."]);
    expect(scheduleRowGuidance(only({ loops: [loop({ enabled: false })], loopRuns: [run()] }))).toBe("Resume this job when you want it to run again.");
    const scheduled = only({ loops: [loop({ schedule: { type: "daily", time: "07:30", weekdays: [1, 2, 3, 4, 5] } })] });
    expect(scheduled.actionLabel).toBe("Run now");
    expect(scheduleRowGuidance(scheduled)).toBe("Runs automatically: Weekdays 7:30 am. Run now if you need it sooner.");
    // Without a confirmed zone it never claims a time.
    expect(scheduleRowGuidance(only({ loops: [loop()], timeZone: undefined }))).toBe("Check the job's timing before relying on a scheduled run.");
    // A job with no clock (on demand) still says to open it.
    expect(scheduleRowGuidance(only({ recipes: [recipe()] }))).toBe("Open this job when you are ready to run it.");
  });

  it("keeps a paused failure in Attention and discoverable in the Paused filter", () => {
    const failed = only({ loops: [loop({ enabled: false })], loopRuns: [run({ status: "failed" })] });
    const paused = only({ recipes: [recipe({ status: "paused" })] });
    expect([failed, paused].map(scheduleRowSection)).toEqual(["attention", "paused"]);
    expect(filterScheduleRows([failed, paused], "paused")).toEqual([failed, paused]);
    expect(filterScheduleRows([failed, paused], "scheduled")).toEqual([]);
    expect(scheduleRowGuidance(failed)).toBe("Review the failed run before trying again.");
  });

  it("explains plan review separately from a result waiting for review", () => {
    const plan = only({ recipes: [recipe({ approvedRevision: null })] });
    const result = only({ loops: [loop()], loopRuns: [run({ status: "awaiting-approval" })] });
    expect([plan, result].map(scheduleRowSection)).toEqual(["attention", "attention"]);
    expect(scheduleRowGuidance(plan)).toBe("Review the steps before this job can run.");
    expect(scheduleRowGuidance(result)).toBe("A result is waiting for your review.");
  });

  it("does not claim that a website run's completed report verifies its result", () => {
    const unverified = only({ recipes: [recipe()], jobRuns: [jobRun({ status: "completed" })] });
    expect(scheduleRowSection(unverified)).toBe("attention");
    expect(scheduleRowGuidance(unverified)).toBe("Check the recorded result against the website.");
  });

  it("includes confirmed upcoming timing even when an earlier result needs attention", () => {
    const ready = only({ loops: [loop()] });
    const failed = only({ loops: [loop()], loopRuns: [run({ status: "failed" })] });
    const noZone = only({ loops: [loop()], timeZone: undefined });
    const invalidZone = only({ loops: [loop()], timeZone: "Not/AZone" });
    const noTime = only({ loops: [loop({ nextRunAt: null })] });
    const noApproval = only({ loops: [loop({ waitingForPlan: true })] });
    const pending = only({ loops: [loop()], pendingLoops: new Set(["owner-letter"]) });
    const active = only({ loops: [loop()], loopRuns: [run({ status: "running" })] });
    expect(filterScheduleRows([ready, failed, noZone, invalidZone, noTime, noApproval, pending, active], "scheduled")).toEqual([ready, failed]);
    expect(scheduleRowSection(ready)).toBe("ready");
  });

  it("does not advertise scheduling or enable controls during recovery", () => {
    const held = only({ loops: [loop()], recovery: true });
    const review = only({ loops: [loop()], loopRuns: [run({ status: "failed" })], recovery: true });
    expect(filterScheduleRows([held, review], "scheduled")).toEqual([]);
    expect(filterScheduleRows([held, review], "paused")).toEqual([held, review]);
    expect(held.actionDisabled).toBe(true);
    expect(review.actionDisabled).toBe(false);
    expect(scheduleRowGuidance(held)).toBe("Scheduled work is paused; saved results remain available.");
  });

  it("keeps manual bank review reachable without classifying it as paused or scheduled", () => {
    const bank = only({ loops: [loop({ id: "bank-references", available: false, enabled: false, nextRunAt: null })] });
    expect(scheduleRowSection(bank)).toBe("ready");
    expect(scheduleRowGuidance(bank)).toBe("Choose a bank file to review.");
    expect(filterScheduleRows([bank], "paused")).toEqual([]);
    expect(filterScheduleRows([bank], "scheduled")).toEqual([]);
    expect(filterScheduleRows([bank], "all")).toEqual([bank]);
  });

  it("combines trimmed case-insensitive search with filters without reordering or changing rows", () => {
    const one = only({ loops: [loop({ name: "Accounts invoice review" })] });
    const two = only({ loops: [loop({ name: "Property inspection", enabled: false })] });
    const three = only({ loops: [loop({ name: "Accounts admin", enabled: false })] });
    const input = Object.freeze([Object.freeze(three), Object.freeze(one), Object.freeze(two)]);
    expect(filterScheduleRows(input, "all", "  ACCOUNTS  ")).toEqual([three, one]);
    expect(filterScheduleRows(input, "paused", "accounts")).toEqual([three]);
    expect(filterScheduleRows(input, "all", "   ")).toEqual(input);
    expect(filterScheduleRows(input, "all", "missing")).toEqual([]);
    expect(filterScheduleRows(input, "all")[0]).toBe(three);
  });
});
