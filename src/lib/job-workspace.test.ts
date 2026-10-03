import { describe, expect, it, vi } from "vitest";
import type { JobRun, Recipe } from "./desk";
import { approveSingleTry, firstTrySuggestion, latestJobTrial } from "./job-workspace";

const plan: Recipe = { id: "fictional-review", title: "Review supplied invoices", description: "Review supplied invoices each Friday.", steps: ["Read the supplied evidence", "List questions for review"], allowedOrigins: [], evidence: "Sources and questions", capabilities: ["read-files", "analyse", "draft"], limits: { maxRuntimeMinutes: 2, maxTurns: 6 }, status: "shadow", createdAt: 1, updatedAt: 1, revision: 3, approvedRevision: null, planApprovedAt: null, attachment: null, submitAcknowledgedAt: null, schedule: null };
const approved = (): Recipe => ({ ...plan, status: "active", planApprovedAt: 100, approvedRevision: plan.revision });

describe("first job trial authority", () => {
  it("keeps a generated recurring suggestion on demand with its requested cadence and sources intact", () => {
    const generated = { ...approved(), schedule: { time: "09:00", weekdays: [5] } };
    const original = structuredClone(generated);
    expect(firstTrySuggestion(generated)).toEqual({ ...plan, schedule: null });
    expect(generated).toEqual(original);
  });

  it("requires the exact saved approval before handing a local job to its first run, and does not reapprove existing authority", async () => {
    const patch = vi.fn(async () => ({ recipes: [approved()] }));
    const next = await approveSingleTry(plan, patch);
    expect(patch).toHaveBeenCalledWith({ planApproved: true, status: "active", expectedRevision: 3 });
    expect(next).toEqual(approved());
    patch.mockClear();
    expect(await approveSingleTry(next, patch)).toEqual(next);
    expect(patch).not.toHaveBeenCalled();
  });

  it.each([
    { revision: 4, approvedRevision: 4 }, { schedule: { time: "09:00", weekdays: [1] } },
    { capabilities: ["read-book", "analyse", "draft"] }, { description: "A different task" },
    { approvedRevision: null }, { status: "paused" },
    { attachment: { attachedAt: 100, acknowledged: "human-login-and-submit" } }, { submitAcknowledgedAt: 100 },
  ] as Partial<Recipe>[])('rejects an unconfirmed or broadened approval receipt %#', async change => {
    await expect(approveSingleTry(plan, async () => ({ recipes: [{ ...approved(), ...change }] }))).rejects.toThrow(/could not be confirmed/);
  });

  it("keeps website binding and repeating approval outside the one-try shortcut", async () => {
    const patch = vi.fn();
    for (const value of [{ ...plan, schedule: { time: "09:00", weekdays: [1] } }, { ...plan, capabilities: ["portal-read"] as Recipe['capabilities'], allowedOrigins: ["example.test"] }]) {
      await expect(approveSingleTry(value, patch)).rejects.toThrow(/website or repeat settings/);
    }
    expect(patch).not.toHaveBeenCalled();
  });

  it("does not treat walkthroughs, unfinished work or results from another revision as a current trial", () => {
    const run = (over: Partial<JobRun>): JobRun => ({ id: "fictional-run", jobId: plan.id, jobRevision: plan.revision, mode: "prepare", status: "completed", createdAt: 10, ...over } as JobRun);
    const result = run({});
    expect(latestJobTrial(plan, [run({ mode: "shadow", createdAt: 30 }), run({ jobRevision: 2, createdAt: 40 }), run({ jobId: "other", createdAt: 50 }), run({ status: "running", createdAt: 60 }), result])).toEqual(result);
    expect(latestJobTrial(plan, [run({ mode: "shadow" })])).toBeUndefined();
  });
});
