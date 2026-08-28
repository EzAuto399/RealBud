import { describe, expect, it } from "vitest";

import type { Loop } from "@/lib/routines";
import { buildRoutineCalendarMonth, moveRoutineCalendarMonth } from "./routine-calendar";

function loop(patch: Partial<Loop>): Loop {
  return {
    id: "morning-arrears",
    name: "Morning money check",
    description: "",
    available: true,
    enabled: true,
    schedule: { type: "daily", time: "07:30", weekdays: [1, 2, 3, 4, 5] },
    revision: 1,
    nextRunAt: null,
    evaluatorId: "morning-money",
    evaluatorVersion: 1,
    ...patch,
  };
}

describe("routine calendar", () => {
  it("builds a Monday-first six-week month and places typed routine occurrences", () => {
    const owner = loop({
      id: "owner-letter",
      name: "Friday owner letter",
      schedule: { type: "daily", time: "16:00", weekdays: [5] },
    });
    const calendar = buildRoutineCalendarMonth([loop({}), owner], 2026, 7, new Date(2026, 7, 3, 9).getTime());

    expect(calendar.label).toBe("August 2026");
    expect(calendar.days).toHaveLength(42);
    expect(calendar.days[0].key).toBe("2026-07-27");
    expect(calendar.days.at(-1)?.key).toBe("2026-09-06");
    expect(calendar.days.find((day) => day.key === "2026-08-02")?.occurrences).toHaveLength(0);
    expect(calendar.days.find((day) => day.key === "2026-08-03")).toMatchObject({
      today: true,
      occurrences: [{ loopId: "morning-arrears", enabled: true }],
    });
    expect(calendar.days.find((day) => day.key === "2026-08-07")?.occurrences.map((item) => item.loopId)).toEqual([
      "morning-arrears",
      "owner-letter",
    ]);
  });

  it("shows paused built routines but never promotes a declared unavailable routine", () => {
    const paused = loop({ enabled: false, timezonePaused: true });
    const planned = loop({ id: "inbound-triage", name: "Inbound triage", available: false });
    const calendar = buildRoutineCalendarMonth([paused, planned], 2026, 7);
    const monday = calendar.days.find((day) => day.key === "2026-08-03")!;

    expect(monday.occurrences).toEqual([
      expect.objectContaining({ loopId: "morning-arrears", enabled: false, timezonePaused: true }),
    ]);
    expect(calendar.days.flatMap((day) => day.occurrences).some((item) => item.loopId === "inbound-triage")).toBe(false);
  });

  it("moves across year boundaries without carrying an invalid day", () => {
    expect(moveRoutineCalendarMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(moveRoutineCalendarMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
  });
});
