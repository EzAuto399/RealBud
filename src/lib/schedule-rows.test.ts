import { describe, expect, it } from "vitest";
import type { JobRun, Recipe } from "./desk";
import type { Loop, LoopRun } from "./routines";
import { buildScheduleRows, listedScheduleRows, nextRunText, SCHEDULE_NOT_CONFIRMED, scheduleRowForJob, stableOrder, type ScheduleRowInput } from "./schedule-rows";

const TZ = "Australia/Brisbane";
// Thursday 1 Oct 2026, 9:00 am in Brisbane (UTC+10, no daylight saving).
const NOW = Date.UTC(2026, 9, 0, 23, 0);
const brisbane = (day: number, hour: number, minute = 0) => Date.UTC(2026, 9, day, hour - 10, minute);

const loop = (patch: Partial<Loop> = {}): Loop => ({
  id: "owner-letter", name: "Owner letter", description: "Fictional owner letter", available: true, enabled: true,
  schedule: { type: "daily", time: "16:00", weekdays: [5] }, revision: 1, nextRunAt: brisbane(2, 16), evaluatorId: "fictional", evaluatorVersion: 1, ...patch,
});
const loopRun = (patch: Partial<LoopRun> = {}): LoopRun => ({
  id: "loop-run-1", loopId: "owner-letter", loopName: "Owner letter", scheduledFor: NOW - 3_600_000, status: "completed", manual: false,
  createdAt: NOW - 3_600_000, finishedAt: NOW - 3_000_000, ...patch,
});
const recipe = (patch: Partial<Recipe> = {}): Recipe => ({
  id: "fictional-site", title: "Fictional portal check", description: "Read a fictional portal", steps: ["Read"], allowedOrigins: ["portal.example.test"],
  evidence: "Readback", capabilities: ["portal-read"], limits: { maxRuntimeMinutes: 2, maxTurns: 6 }, status: "active", createdAt: 1, updatedAt: 1,
  schedule: null, planApprovedAt: 10, revision: 2, approvedRevision: 2, attachment: null, submitAcknowledgedAt: null, ...patch,
});
const jobRun = (patch: Partial<JobRun> = {}): JobRun => ({
  id: "job-run-1", jobId: "fictional-site", jobTitle: "Fictional portal check", jobRevision: 2, mode: "prepare", status: "completed", trigger: "manual",
  scheduledFor: NOW - 3_600_000, idempotencyKey: "fictional-key", attempt: 1,
  spec: { title: "Fictional portal check", description: "Read", steps: ["Read"], allowedOrigins: [], evidence: "Readback", capabilities: ["portal-read"], limits: { maxRuntimeMinutes: 2, maxTurns: 6 } },
  evidence: [], approvalRequests: [], detail: "Fictional detail", createdAt: NOW - 3_600_000, ...patch,
});
const rows = (patch: Partial<ScheduleRowInput>) => buildScheduleRows({ loops: [], recipes: [], loopRuns: [], jobRuns: [], nowMs: NOW, timeZone: TZ, ...patch });
const only = (patch: Partial<ScheduleRowInput>) => { const list = rows(patch); expect(list).toHaveLength(1); return list[0]!; };
const shape = (patch: Partial<ScheduleRowInput>) => { const row = only(patch); return [row.next, row.attention, row.actionLabel]; };

describe("hidden loops (an Auston loop before its role pack)", () => {
  it("stay out of the list only: a deep link (#job-<id>, the sidebar) still opens them", () => {
    const all = rows({ loops: [loop(), loop({ id: "bank-references", name: "Bank reference review", enabled: false, nextRunAt: null })] });
    const hidden = new Set(["bank-references"]);
    expect(listedScheduleRows(all, hidden).map(row => row.key)).toEqual(["loop:owner-letter"]);
    expect(scheduleRowForJob(all, "bank-references")).toMatchObject({ key: "loop:bank-references", name: "Bank reference review" });
    expect(scheduleRowForJob(all, "owner-letter")?.key).toBe("loop:owner-letter");
    expect(scheduleRowForJob(all, "nope")).toBeUndefined();
  });
});

describe("schedule row copy (proposal section 5)", () => {
  it("scheduled with no issue shows plain timing, no status, and View result or Run now", () => {
    expect(shape({ loops: [loop()], loopRuns: [loopRun()] })).toEqual(["Tomorrow, 4:00 pm", null, "View result"]);
    expect(shape({ loops: [loop()] })).toEqual(["Tomorrow, 4:00 pm", null, "Run now"]);
  });

  it("paused with no issue reads Paused with Resume", () => {
    expect(shape({ loops: [loop({ enabled: false })], loopRuns: [loopRun()] })).toEqual(["Paused", null, "Resume"]);
    expect(shape({ recipes: [recipe({ status: "paused" })] })).toEqual(["Paused", null, "Resume"]);
  });

  it.each([
    ["failed", "Failed"],
    ["missed", "Missed"],
    ["interrupted", "Interrupted"],
    ["partial", "Incomplete"],
  ] as const)("a %s run asks for review with its own word", (status, word) => {
    expect(shape({ loops: [loop()], loopRuns: [loopRun({ status })] })).toEqual(["Tomorrow, 4:00 pm", word, "Review result"]);
    expect(shape({ loops: [loop({ enabled: false })], loopRuns: [loopRun({ status })] })).toEqual(["Paused", word, "Review result"]);
  });

  it("a plan awaiting approval is not scheduled and asks for plan review", () => {
    expect(shape({ recipes: [recipe({ planApprovedAt: null, approvedRevision: null })] })).toEqual(["Not scheduled", "Review", "Review plan"]);
    expect(shape({ recipes: [recipe({ revision: 3 })] })).toEqual(["Not scheduled", "Review", "Review plan"]);
  });

  it("a result awaiting a decision keeps the next time and asks for review", () => {
    expect(shape({ loops: [loop()], loopRuns: [loopRun({ status: "awaiting-approval" })] })).toEqual(["Tomorrow, 4:00 pm", "Review", "Review result"]);
  });

  it("a website result without verification reads Unverified", () => {
    const scheduled = recipe({ schedule: { time: "16:00", weekdays: [5] } });
    const clock = loop({ id: "recipe-fictional-site", name: "Fictional portal check" });
    for (const status of ["completed", "partial"] as const) {
      expect(shape({ loops: [clock], recipes: [scheduled], jobRuns: [jobRun({ mode: "attended", status })] })).toEqual(["Tomorrow, 4:00 pm", "Unverified", "Review result"]);
    }
  });

  it("website work waiting for the person offers Start beside me without an extra chip", () => {
    expect(shape({ recipes: [recipe()], jobRuns: [jobRun({ mode: "attended", status: "queued" })] })).toEqual(["Waiting for you", null, "Start beside me"]);
  });

  it("running website work offers Stop; other running preparation offers View progress", () => {
    expect(shape({ recipes: [recipe()], jobRuns: [jobRun({ mode: "attended", status: "running" })] })).toEqual(["Running now", null, "Stop"]);
    expect(shape({ recipes: [recipe()], jobRuns: [jobRun({ status: "running" })] })).toEqual(["Running now", null, "View progress"]);
    expect(shape({ loops: [loop()], loopRuns: [loopRun({ status: "queued" })] })).toEqual(["Running now", null, "View progress"]);
  });

  it("an uncertain run reply asks to check the previous run, never to start fresh", () => {
    expect(shape({ loops: [loop()], loopRuns: [loopRun()], pendingLoops: new Set(["owner-letter"]) })).toEqual(["Checking last run", "Unconfirmed", "Check previous run"]);
    expect(shape({ recipes: [recipe()], pendingJobs: new Set(["fictional-site"]) })).toEqual(["Checking last run", "Unconfirmed", "Check previous run"]);
  });

  it("never presents a missing next run as a real schedule", () => {
    expect(only({ loops: [loop({ nextRunAt: null })] }).next).toBe(SCHEDULE_NOT_CONFIRMED);
    expect(only({ recipes: [recipe({ schedule: { time: "09:00", weekdays: [1] } })] }).next).toBe(SCHEDULE_NOT_CONFIRMED);
    expect(only({ recipes: [recipe()] }).next).toBe("Only when you run it");
    expect(nextRunText(brisbane(2, 16), NOW, "Not/AZone")).toBe(SCHEDULE_NOT_CONFIRMED);
  });

  it("formats later days by weekday and distant days by date", () => {
    expect(nextRunText(brisbane(1, 7, 30), NOW, TZ)).toBe("Today, 7:30 am");
    expect(nextRunText(brisbane(5, 9), NOW, TZ)).toBe("Monday, 9:00 am");
    expect(nextRunText(brisbane(12, 9), NOW, TZ)).toBe("Mon 12 Oct, 9:00 am");
  });
});

describe("schedule row safety", () => {
  it("keeps an unreviewed failure visible after a later success and after a pause", () => {
    const failed = loopRun({ id: "older-failure", status: "failed", createdAt: NOW - 7_200_000 });
    const later = loopRun({ id: "later-success", status: "completed", createdAt: NOW - 600_000 });
    const row = only({ loops: [loop()], loopRuns: [later, failed] });
    expect([row.attention, row.actionLabel, row.attentionRun]).toEqual(["Failed", "Review result", { kind: "loop", id: "older-failure" }]);
    expect(shape({ loops: [loop({ enabled: false })], loopRuns: [later, failed] })).toEqual(["Paused", "Failed", "Review result"]);
    expect(shape({ loops: [loop()], loopRuns: [later, { ...failed, seenAt: NOW }] })).toEqual(["Tomorrow, 4:00 pm", null, "View result"]);
  });

  it("treats a job receipt as reviewed once its linked clock receipt was opened", () => {
    const clock = loop({ id: "recipe-fictional-site", name: "Fictional portal check" });
    const failed = jobRun({ status: "failed" });
    expect(only({ loops: [clock], recipes: [recipe()], jobRuns: [failed] }).attentionRun).toEqual({ kind: "job", id: "job-run-1" });
    const seen = loopRun({ loopId: "recipe-fictional-site", jobRunId: "job-run-1", status: "failed", seenAt: NOW });
    expect(only({ loops: [clock], recipes: [recipe()], jobRuns: [failed], loopRuns: [seen] }).attention).toBeNull();
  });

  it("disables changing row actions during recovery but keeps results and Stop available", () => {
    const run = only({ loops: [loop()], recovery: true });
    expect([run.next, run.actionLabel, run.actionDisabled]).toEqual(["Paused", "Run now", true]);
    expect(only({ loops: [loop({ enabled: false })], recovery: true }).actionDisabled).toBe(true);
    expect(only({ loops: [loop()], loopRuns: [loopRun()], pendingLoops: new Set(["owner-letter"]), recovery: true }).actionDisabled).toBe(true);
    expect(only({ loops: [loop()], loopRuns: [loopRun({ status: "failed" })], recovery: true }).actionDisabled).toBe(false);
    expect(only({ recipes: [recipe()], jobRuns: [jobRun({ mode: "attended", status: "running" })], recovery: true }).actionDisabled).toBe(false);
  });
});

describe("schedule row inventory and order", () => {
  it("merges loops with saved jobs, drops unavailable placeholders and orders attention, upcoming, then paused", () => {
    const list = rows({
      loops: [
        loop({ id: "morning-arrears", name: "Morning money check", nextRunAt: brisbane(2, 7, 30) }),
        loop({ id: "owner-letter", name: "Owner letter", nextRunAt: brisbane(2, 16) }),
        loop({ id: "inbound-triage", name: "Morning priorities", enabled: false }),
        loop({ id: "weekly-bills", name: "Weekly bills review", available: false }),
        loop({ id: "recipe-fictional-site", name: "clock copy", nextRunAt: brisbane(1, 12) }),
        loop({ id: "bank-references", name: "Bank references", enabled: false }),
      ],
      recipes: [recipe(), recipe({ id: "draft-job", title: "Draft job", planApprovedAt: null, approvedRevision: null })],
      loopRuns: [loopRun({ loopId: "bank-references", loopName: "Bank references", status: "failed" })],
    });
    expect(list.map((row) => row.name)).toEqual(["Bank references", "Draft job", "Fictional portal check", "Morning money check", "Owner letter", "Morning priorities"]);
    expect(list.map((row) => row.key)).toContain("job:fictional-site");
    expect(list.some((row) => row.name === "Weekly bills review" || row.name === "clock copy")).toBe(false);
  });

  it("keeps the visible order stable while someone interacts", () => {
    expect(stableOrder(["a", "b", "c"], ["c", "d", "a"])).toEqual(["a", "c", "d"]);
    expect(stableOrder([], ["x", "y"])).toEqual(["x", "y"]);
  });
});

describe("schedule row evidence and manual work", () => {
  it("never formats a next run in this computer's zone when no confirmed zone exists", () => {
    expect(nextRunText(brisbane(2, 16), NOW, undefined)).toBe(SCHEDULE_NOT_CONFIRMED);
    expect(only({ loops: [loop()], timeZone: undefined }).next).toBe(SCHEDULE_NOT_CONFIRMED);
    const zoned = loop({ schedule: { type: "daily", time: "16:00", weekdays: [5], timezone: TZ } });
    expect(only({ loops: [zoned], timeZone: undefined }).next).toBe("Tomorrow, 4:00 pm");
  });

  it("keeps an unavailable bank review as a manual row with no schedule claims or run action", () => {
    const bank = loop({ id: "bank-references", name: "Bank reference review", available: false, enabled: false, nextRunAt: null });
    expect(shape({ loops: [bank] })).toEqual(["On demand", null, "Review bank file"]);
    expect(only({ loops: [bank] }).manualOnly).toBe(true);
    expect(only({ loops: [bank], recovery: true }).actionDisabled).toBe(false);
    expect(rows({ loops: [loop({ id: "weekly-bills", available: false })] })).toEqual([]);
  });
});
