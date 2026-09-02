import { describe, expect, it } from "vitest";

import {
  buildScheduleWeek,
  calendarShortName,
  mondayOfWeek,
  plannedLoopFootnote,
  recipeScheduleLine,
  scheduleSummary,
  splitPlannedLoops,
  weekOutcomeTone,
} from "./schedule-week";

const loops = [
  {
    id: "morning-arrears" as const,
    name: "Morning money",
    available: true,
    enabled: true,
    schedule: { type: "daily" as const, time: "07:30", weekdays: [1, 2, 3, 4, 5] },
    nextRunAt: new Date(2026, 8, 2, 7, 30, 0).getTime(),
  },
  {
    id: "owner-letter" as const,
    name: "Friday owner letter",
    available: true,
    enabled: true,
    schedule: { type: "daily" as const, time: "16:00", weekdays: [5] },
    nextRunAt: new Date(2026, 8, 4, 16, 0, 0).getTime(),
  },
  {
    id: "inbound-triage" as const,
    name: "Inbound triage",
    available: false,
    enabled: false,
    schedule: { type: "daily" as const, time: "09:00", weekdays: [1, 2, 3, 4, 5] },
    nextRunAt: null,
  },
];

describe("schedule week", () => {
  it("opens on Monday and puts Friday letter only on Friday", () => {
    const wed = new Date(2026, 8, 2, 10, 0, 0).getTime();
    expect(new Date(mondayOfWeek(wed)).getDay()).toBe(1);
    const week = buildScheduleWeek(loops, wed);
    expect(week).toHaveLength(7);
    expect(week[0]?.isToday).toBe(false);
    expect(week[2]?.isToday).toBe(true);
    expect(week[4]?.slots.map((slot) => slot.loopId)).toEqual([
      "morning-arrears",
      "owner-letter",
    ]);
    expect(week[5]?.slots).toEqual([]);
    expect(week[6]?.slots).toEqual([]);
    expect(week[2]?.slots.find((slot) => slot.loopId === "morning-arrears")?.shortName).toBe("Morning");
    expect(week[2]?.slots.find((slot) => slot.loopId === "morning-arrears")?.next).toBe(true);
    expect(week[4]?.slots.find((slot) => slot.loopId === "owner-letter")?.next).toBe(true);
    expect(week[2]?.slots.find((slot) => slot.loopId === "morning-arrears")?.outcome).toBe("next");
    expect(week.every((day) => day.slots.every((slot) => slot.loopId !== "inbound-triage"))).toBe(true);
  });

  it("stamps a clock run and Desk cards on that day", () => {
    const wed = new Date(2026, 8, 2, 10, 0, 0).getTime();
    const week = buildScheduleWeek(loops, wed, undefined, {
      runs: [
        {
          id: "run-1",
          loopId: "morning-arrears",
          scheduledFor: new Date(2026, 8, 2, 7, 30, 0).getTime(),
          status: "completed",
          finishedAt: new Date(2026, 8, 2, 7, 31, 0).getTime(),
        },
      ],
      desk: {
        lastRunAt: new Date(2026, 8, 2, 7, 31, 0).getTime(),
        hands: "hermes",
        handsDetail: "6 addresses",
        needsYou: 2,
        checkedCount: 6,
        producedByRunId: { "run-1": 2 },
      },
    });
    const morning = week[2]?.slots.find((slot) => slot.loopId === "morning-arrears");
    expect(morning).toMatchObject({ outcome: "done", stamp: "2 on Desk", produced: 2, openDesk: true, runId: "run-1" });
  });

  it("Desk Recheck miss stamps Morning even without a clock run", () => {
    const wed = new Date(2026, 8, 2, 10, 0, 0).getTime();
    const week = buildScheduleWeek(loops, wed, undefined, {
      desk: {
        lastRunAt: new Date(2026, 8, 2, 7, 40, 0).getTime(),
        hands: "demo",
        handsDetail: "The worker answered without ledger JSON — facts stay held.",
        needsYou: 0,
        checkedCount: 0,
        producedByRunId: {},
      },
      worker: { lastTest: { at: new Date(2026, 8, 2, 7, 40, 0).getTime(), ok: false, kind: "recheck" } },
    });
    const morning = week[2]?.slots.find((slot) => slot.loopId === "morning-arrears");
    expect(morning).toMatchObject({ outcome: "missed", stamp: "Missed", openDesk: true });
    expect(week[1]?.slots.find((slot) => slot.loopId === "morning-arrears")?.outcome).toBe("scheduled");
  });

  it("a completed run still reads as a miss when the worker missed", () => {
    const wed = new Date(2026, 8, 2, 10, 0, 0).getTime();
    const week = buildScheduleWeek(loops, wed, undefined, {
      runs: [
        {
          id: "run-miss",
          loopId: "morning-arrears",
          scheduledFor: new Date(2026, 8, 2, 7, 30, 0).getTime(),
          status: "completed",
          finishedAt: new Date(2026, 8, 2, 7, 31, 0).getTime(),
        },
      ],
      desk: {
        lastRunAt: new Date(2026, 8, 2, 7, 31, 0).getTime(),
        hands: "demo",
        handsDetail: "The worker answered without ledger JSON — facts stay held.",
        needsYou: 0,
        checkedCount: 0,
        producedByRunId: {},
      },
    });
    expect(week[2]?.slots.find((slot) => slot.loopId === "morning-arrears")?.outcome).toBe("missed");
  });

  it("uses the agency zone for today", () => {
    const utc = Date.parse("2026-09-01T16:00:00.000Z");
    const sydney = buildScheduleWeek(loops, utc, "Australia/Sydney");
    expect(sydney.find((day) => day.isToday)?.weekday).toBe(3);
    const la = buildScheduleWeek(loops, utc, "America/Los_Angeles");
    expect(la.find((day) => day.isToday)?.weekday).toBe(2);
  });

  it("stamps a partial run hold-toned, not as a miss", () => {
    const wed = new Date(2026, 8, 2, 10, 0, 0).getTime();
    const week = buildScheduleWeek(loops, wed, undefined, {
      runs: [
        {
          id: "run-partial",
          loopId: "morning-arrears",
          scheduledFor: new Date(2026, 8, 2, 7, 30, 0).getTime(),
          status: "partial",
          finishedAt: new Date(2026, 8, 2, 7, 31, 0).getTime(),
        },
      ],
      desk: {
        lastRunAt: new Date(2026, 8, 2, 7, 31, 0).getTime(),
        hands: "held",
        handsDetail: "Worker answered 1 of 6 properties. Uncovered stay held.",
        needsYou: 0,
        checkedCount: 1,
        producedByRunId: {},
      },
    });
    expect(week[2]?.slots.find((slot) => slot.loopId === "morning-arrears")).toMatchObject({
      outcome: "partial",
      stamp: "Partial",
      openDesk: true,
      runId: "run-partial",
    });
  });

  it("puts a Sunday Desk Recheck on the map even though Morning is weekdays", () => {
    const sun = new Date(2026, 8, 6, 10, 0, 0).getTime();
    const week = buildScheduleWeek(loops, sun, undefined, {
      desk: {
        lastRunAt: new Date(2026, 8, 6, 6, 1, 0).getTime(),
        hands: "demo",
        handsDetail: "The worker answered without ledger JSON — facts stay held.",
        needsYou: 0,
        checkedCount: 0,
        producedByRunId: {},
      },
    });
    const sunday = week[6]?.slots.find((slot) => slot.loopId === "morning-arrears");
    expect(sunday).toMatchObject({ shortName: "Recheck", outcome: "missed", stamp: "Missed", time: "06:01" });
  });

  it("puts a taught job on its weekday and shows the run outcome, not Desk", () => {
    const wed = new Date(2026, 8, 2, 10, 0, 0).getTime();
    const job = {
      id: "recipe-job-1" as const,
      name: "Friday arrears",
      available: true,
      enabled: true,
      schedule: { type: "daily" as const, time: "16:00", weekdays: [5] },
      nextRunAt: new Date(2026, 8, 4, 16, 0, 0).getTime(),
    };
    const week = buildScheduleWeek([...loops, job], wed, undefined, {
      runs: [
        {
          id: "run-job",
          loopId: "recipe-job-1",
          scheduledFor: new Date(2026, 8, 4, 16, 0, 0).getTime(),
          status: "completed",
          finishedAt: new Date(2026, 8, 4, 16, 1, 0).getTime(),
        },
      ],
    });
    expect(calendarShortName("recipe-job-1")).toBe("Job");
    const friday = week[4]?.slots.find((slot) => slot.loopId === "recipe-job-1");
    expect(friday).toMatchObject({
      shortName: "Job",
      name: "Friday arrears",
      time: "16:00",
      outcome: "done",
      stamp: "Finished",
      produced: 0,
      openDesk: false,
    });
    expect(week[2]?.slots.find((slot) => slot.loopId === "recipe-job-1")).toBeUndefined();
  });

  it("shows an unapproved taught job as review, never paused or next", () => {
    const wed = new Date(2026, 8, 2, 10, 0, 0).getTime();
    const review = {
      id: "recipe-review" as const,
      name: "Owner exception brief",
      available: true,
      enabled: false,
      waitingForPlan: true,
      schedule: { type: "daily" as const, time: "16:00", weekdays: [5] },
      nextRunAt: null,
    };
    const friday = buildScheduleWeek([...loops, review], wed)[4]?.slots.find((slot) => slot.loopId === "recipe-review");
    expect(friday).toMatchObject({ outcome: "review", stamp: "Review plan", next: false });
  });
});

describe("recipeScheduleLine", () => {
  it("names the days, time, and agency zone", () => {
    expect(recipeScheduleLine({ time: "16:00", weekdays: [5] }, "Australia/Brisbane")).toBe(
      "Runs Fridays at 4:00 pm · Australia/Brisbane",
    );
    expect(recipeScheduleLine({ time: "07:30", weekdays: [1, 2, 3, 4, 5] })).toBe("Runs weekdays at 7:30 am");
  });
});

describe("planned loops stay off the day chips", () => {
  it("splits unavailable loops out for a single footnote", () => {
    const { scheduled, planned } = splitPlannedLoops(loops);
    expect(scheduled.map((loop) => loop.id)).toEqual(["morning-arrears", "owner-letter"]);
    expect(planned.map((loop) => loop.id)).toEqual(["inbound-triage"]);
    expect(plannedLoopFootnote({ name: "Inbound triage" })).toBe(
      "Inbound triage · Planned — set the clock now; RealBud runs it after it is built.",
    );
  });

  it("leaves weekend days as empty Quiet rows", () => {
    const wed = new Date(2026, 8, 2, 10, 0, 0).getTime();
    const week = buildScheduleWeek(loops, wed);
    expect(week[5]?.slots).toEqual([]);
    expect(week[6]?.slots).toEqual([]);
    expect(week[0]?.slots.map((slot) => slot.loopId)).toEqual(["morning-arrears"]);
  });
});

describe("scheduleSummary", () => {
  it("reads like the Change time disclosure", () => {
    expect(scheduleSummary({ time: "07:30", weekdays: [1, 2, 3, 4, 5] })).toBe("Weekdays 7:30 am");
    expect(scheduleSummary({ time: "16:00", weekdays: [5] })).toBe("Fri 4:00 pm");
    expect(scheduleSummary({ time: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe("Every day 9:00 am");
  });
});

describe("weekOutcomeTone", () => {
  it("maps running and next to agency, partial to hold, missed to danger, finished to muted", () => {
    expect(weekOutcomeTone("running")).toBe("agency");
    expect(weekOutcomeTone("next")).toBe("agency");
    expect(weekOutcomeTone("partial")).toBe("hold");
    expect(weekOutcomeTone("missed")).toBe("danger");
    expect(weekOutcomeTone("done")).toBe("muted");
    expect(weekOutcomeTone("planned")).toBe("muted");
    expect(weekOutcomeTone("scheduled")).toBeNull();
  });
});
