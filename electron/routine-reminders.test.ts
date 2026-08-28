import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const reminders = require("./routine-reminders.cjs") as {
  parseRoutineReminder(input: unknown): { runId: string; kind: "failed" | "held" } | null;
  routineNotificationCopy(kind: "failed" | "held"): { title: string; body: string };
};

describe("routine reminder shell boundary", () => {
  it("accepts only the closed reminder payload", () => {
    expect(reminders.parseRoutineReminder({ runId: "run-123", kind: "held" })).toEqual({
      runId: "run-123",
      kind: "held",
    });
  });

  it("drops renderer and model text instead of forwarding it", () => {
    const parsed = reminders.parseRoutineReminder({
      runId: "run-123",
      kind: "failed",
      title: "12 Oak St",
      body: "Tenant balance $900",
      modelText: "invented detail",
    });
    expect(parsed).toEqual({ runId: "run-123", kind: "failed" });
    expect(parsed).not.toHaveProperty("title");
    expect(parsed).not.toHaveProperty("body");
  });

  it.each([
    null,
    {},
    { runId: "", kind: "failed" },
    { runId: "../tenant", kind: "failed" },
    { runId: "run-123", kind: "completed" },
  ])("rejects invalid input %#", (input) => {
    expect(reminders.parseRoutineReminder(input)).toBeNull();
  });

  it("uses fixed privacy-safe copy for both reasons", () => {
    const failed = reminders.routineNotificationCopy("failed");
    const held = reminders.routineNotificationCopy("held");
    expect(failed).toEqual({
      title: "A RealBud routine needs attention",
      body: "Open RealBud to review it. Nothing was sent.",
    });
    expect(held).toEqual({
      title: "RealBud left work on hold",
      body: "Open RealBud to review it. Nothing was sent.",
    });
  });
});
