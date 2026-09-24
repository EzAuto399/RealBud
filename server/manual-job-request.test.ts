import { describe, expect, it } from "vitest";
import { manualRecipeRequestKey } from "./manual-job-request.ts";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { executeRecipeJob } from "./job-executor.ts";
import { JobRunStore } from "./job-runs.ts";
import { removeFixture } from "./testing/private-fixture.ts";
import type { Recipe } from "../shared/contracts.ts";

const recipe = { id: "owner-pack", revision: 3 };
const requestId = "ABCDEF01-1234-4567-89AB-ABCDEF012345";

describe("manual job request boundary", () => {
  it("binds one operation to the requested version and mode and normalizes UUID casing", () => {
    const body = { requestId, expectedRevision: 3 };
    const key = manualRecipeRequestKey(recipe, body, "prepare");
    expect(manualRecipeRequestKey(recipe, { ...body, requestId: requestId.toLowerCase() }, "prepare")).toBe(key);
    expect(manualRecipeRequestKey(recipe, body, "shadow")).not.toBe(key);
    expect(manualRecipeRequestKey(recipe, { ...body, expectedRevision: 2 }, "prepare")).not.toBe(key);
    expect(manualRecipeRequestKey({ ...recipe, id: "another" }, body, "prepare")).not.toBe(key);
  });

  it.each([null, 4, "", "some job instruction", "x".repeat(400), `${requestId}\n`])("rejects invalid supplied request identity %j", (invalid) => {
    expect(() => manualRecipeRequestKey(recipe, { requestId: invalid, expectedRevision: 3 }, "prepare")).toThrow(/valid run request ID/);
  });

  it.each([undefined, null, "3", 0, -1, 1.5, Infinity])("requires a saved integer version when a request ID is present: %j", (expectedRevision) => {
    expect(() => manualRecipeRequestKey(recipe, { requestId, expectedRevision }, "prepare")).toThrow(/saved plan version/);
  });

  it("keeps legacy calls independent", () => {
    expect(manualRecipeRequestKey(recipe, {}, "prepare")).not.toBe(manualRecipeRequestKey(recipe, {}, "prepare"));
  });

  it("returns the in-flight run on overlap and the saved result after a lost response and restart", async () => {
    const folder = mkdtempSync(join(tmpdir(), "realbud-manual-recovery-"));
    const file = join(folder, "runs.json");
    // Each store holds its execution-history database open in the folder; close them before removal (Windows).
    const stores: JobRunStore[] = [];
    const track = (store: JobRunStore) => { stores.push(store); return store; };
    const job: Recipe = {
      ...recipe, title: "Owner pack", description: "Fictional local notes", steps: ["Draft the report"],
      allowedOrigins: [], evidence: "Complete draft", capabilities: ["analyse", "draft"],
      limits: { maxRuntimeMinutes: 2, maxTurns: 6 }, status: "active", createdAt: 1, updatedAt: 1,
      approvedRevision: 3, planApprovedAt: 1, attachment: null, submitAcknowledgedAt: null, schedule: null,
    };
    const input = {
      mode: "prepare" as const, trigger: "manual" as const,
      idempotencyKey: manualRecipeRequestKey(job, { requestId, expectedRevision: 3 }, "prepare"),
    };
    let release!: (value: { ok: true; stdout: string }) => void;
    let reachWorker!: () => void;
    // The first attempt reaches the worker after an unspecified number of awaits
    // (optional pack instructions, assigned-case checks). Wait for the worker
    // itself rather than assuming a microtask count.
    const reachedWorker = new Promise<void>((resolve) => { reachWorker = resolve; });
    let calls = 0;
    const ask = () => { calls += 1; reachWorker(); return new Promise<{ ok: true; stdout: string }>((resolve) => { release = resolve; }); };
    try {
      const runs = track(new JobRunStore({ file }));
      const original = executeRecipeJob(job, input, { store: runs, ask });
      const overlapping = await executeRecipeJob(job, input, { store: runs, ask });
      expect(overlapping).toMatchObject({ reused: true, run: { status: "running" } });
      await reachedWorker;
      expect(calls).toBe(1);
      release({ ok: true, stdout: JSON.stringify({ summary: "Draft ready", evidence: ["Fictional notes"], outputs: ["Full owner report"], needsApproval: [] }) });
      const completed = await original;
      // The first HTTP response is discarded; reopening loads its durable receipt.
      const retry = await executeRecipeJob(job, input, { store: track(new JobRunStore({ file })), ask });
      expect(retry).toMatchObject({ reused: true, run: { id: completed.run.id, status: "completed" } });
      expect(retry.run.evidence.find((row) => row.kind === "output")?.note).toBe("Full owner report");
      expect(calls).toBe(1);
    } finally {
      for (const store of stores) store.close();
      await removeFixture(folder);
    }
  });
});
