import { describe, expect, it } from "vitest";
import type { Recipe } from "./desk";
import { jobPlanChanged, jobPlanFields, jobPlanInput } from "./job-plan";

const plan: Recipe = {
  id: "owner-review",
  title: "Owner review",
  description: "Review the source and prepare an owner update.",
  steps: ["Read the current book", "Prepare the update"],
  allowedOrigins: [],
  evidence: "Source dates and a draft",
  capabilities: ["read-book", "analyse", "draft"],
  limits: { maxRuntimeMinutes: 2, maxTurns: 6 },
  status: "shadow",
  createdAt: 100,
  updatedAt: 100,
  revision: 3,
  planApprovedAt: null,
  approvedRevision: null,
  attachment: null,
  submitAcknowledgedAt: null,
  schedule: null,
};

describe("job plan editing", () => {
  it("keeps on-demand jobs manual and compares edits against the saved plan", () => {
    const fields = jobPlanFields(plan);
    expect(jobPlanChanged(plan, fields)).toBe(false);
    expect(jobPlanInput(plan, fields, true)).toMatchObject({
      schedule: null,
      expectedRevision: 3,
      limits: plan.limits,
    });
    expect(jobPlanChanged(plan, { ...fields, steps: "Check the agreed export" })).toBe(true);
  });

  it("saves a chosen cadence, ordered steps and the exact read version", () => {
    const input = jobPlanInput(
      plan,
      {
        ...jobPlanFields(plan),
        steps: " Read the book\n\nPrepare the update ",
        scheduled: true,
        time: "16:30",
        weekdays: [5],
      },
      true,
    );
    expect(input.steps).toEqual(["Read the book", "Prepare the update"]);
    expect(input.schedule).toEqual({ time: "16:30", weekdays: [5] });
    expect(input.expectedRevision).toBe(3);
    expect(jobPlanInput(plan, jobPlanFields(plan), false).expectedRevision).toBe(0);
  });

  it.each(["", "24:00", "9:30"])('rejects invalid clock "%s" instead of silently saving a manual job', (time) => {
    expect(() => jobPlanInput(plan, { ...jobPlanFields(plan), scheduled: true, time }, true)).toThrow(/valid time/);
  });

  it.each([{ weekdays: [] }, { weekdays: [7] }, { weekdays: [-1] }])(
    "rejects invalid weekdays $weekdays",
    ({ weekdays }) => {
      expect(() => jobPlanInput(plan, { ...jobPlanFields(plan), scheduled: true, weekdays }, true)).toThrow(
        /at least one day/,
      );
    },
  );

  it("does not grant broader capabilities when editing timing", () => {
    const input = jobPlanInput(plan, { ...jobPlanFields(plan), scheduled: true }, true);
    expect(input.capabilities).toEqual(plan.capabilities);
    expect(input.attachment).toBeNull();
    expect(input.submitAcknowledgedAt).toBeNull();
  });

  it("saves fresh inputs as a plan change without altering steps or permissions", () => {
    const fields = { ...jobPlanFields(plan), description: " Updated quote: AUD 1,250. Access remains unconfirmed. " };
    expect(jobPlanChanged(plan, fields)).toBe(true);
    const input = jobPlanInput(plan, fields, true);
    expect(input.description).toBe(fields.description.trim());
    expect(input.steps).toEqual(plan.steps);
    expect(input.capabilities).toEqual(plan.capabilities);
    expect(input.expectedRevision).toBe(plan.revision);
    expect(() => jobPlanInput(plan, { ...fields, description: "x".repeat(4001) }, true)).toThrow(/4,000 characters/);
  });

  it.each(["", Array(13).fill("A step").join("\n"), "x".repeat(201)])("rejects unusable steps", (steps) => {
    expect(() => jobPlanInput(plan, { ...jobPlanFields(plan), steps }, true)).toThrow(/1 to 12 steps/);
  });
});
