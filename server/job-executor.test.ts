import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PortalSession, Recipe } from "../shared/contracts.ts";
import { executeRecipeJob, jobWorkerToolsets, parsePrepareResult, prepareJobPrompt } from "./job-executor.ts";
import { JobRunStore } from "./job-runs.ts";

const dirs: string[] = [];

function store(): JobRunStore {
  const dir = mkdtempSync(join(tmpdir(), "realbud-job-executor-"));
  dirs.push(dir);
  return new JobRunStore({ file: join(dir, "runs.json"), now: () => 100 });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function job(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: "job-1",
    title: "Weekly owner pack",
    description: "Read the book and prepare a factual owner update.",
    steps: ["Read current facts", "Draft the update"],
    allowedOrigins: ["propertyme.com.au"],
    evidence: "Facts and draft location",
    capabilities: ["read-book", "analyse", "draft"],
    limits: { maxRuntimeMinutes: 2, maxTurns: 6 },
    siteNotes: null,
    status: "active",
    createdAt: 1,
    schedule: null,
    planApprovedAt: 2,
    revision: 1,
    updatedAt: 1,
    approvedRevision: 1,
    attachment: null,
    submitAcknowledgedAt: null,
    ...overrides,
  };
}

describe("prepare result", () => {
  it("parses the final bounded JSON object and rejects junk", () => {
    expect(
      parsePrepareResult(
        `notes first\n{"summary":"Prepared","evidence":["book"],"outputs":["draft"],"needsApproval":[]}`,
      ),
    ).toEqual({ summary: "Prepared", evidence: ["book"], outputs: ["draft"], needsApproval: [] });
    expect(parsePrepareResult("not json")).toBeNull();
    expect(parsePrepareResult('{"summary":"x","evidence":[],"outputs":[]}')).toBeNull();
  });

  it("keeps consequential actions outside the granted prepare prompt", () => {
    const prompt = prepareJobPrompt(job());
    expect(prompt).toMatch(/PREPARE-ONLY/);
    expect(prompt).toMatch(/must not send|must not.*submit/i);
    expect(prompt).toMatch(/propertyme\.com\.au/);
    expect(prompt).toMatch(/untrusted data/i);
  });

  it("maps job capabilities to the narrow Hermes toolsets for that run", () => {
    expect(jobWorkerToolsets(["analyse", "draft"])).toEqual(["todo"]);
    expect(jobWorkerToolsets(["read-book", "analyse"])).toEqual(["file"]);
    expect(jobWorkerToolsets(["read-files", "web-research", "draft"])).toEqual(["file", "web"]);
  });
});

describe("executeRecipeJob", () => {
  it("records a successful prepare run and executes a duplicate key once", async () => {
    const runs = store();
    const ask = vi.fn(async () => ({
      ok: true as const,
      stdout: '{"summary":"Owner pack prepared","evidence":["Book revision 4"],"outputs":["draft-owner.md"],"needsApproval":[]}',
    }));
    const input = { mode: "prepare" as const, trigger: "manual" as const, idempotencyKey: "manual-1" };
    const first = await executeRecipeJob(job(), input, { store: runs, ask });
    const again = await executeRecipeJob(job(), input, { store: runs, ask });

    expect(first.run).toMatchObject({ status: "completed", detail: "Owner pack prepared" });
    expect(first.run.evidence.map((item) => item.kind)).toEqual(["observation", "output"]);
    expect(again.reused).toBe(true);
    expect(again.run.id).toBe(first.run.id);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ toolsets: ["file"], maxTurns: 6, timeoutMs: 120_000 }),
    );
  });

  it("holds a consequential next step for approval", async () => {
    const runs = store();
    const result = await executeRecipeJob(
      job(),
      { mode: "prepare", trigger: "schedule", idempotencyKey: "slot-1", scheduledFor: 90 },
      {
        store: runs,
        ask: async () => ({
          ok: true,
          stdout:
            '{"summary":"Draft ready","evidence":["owner facts"],"outputs":["email draft"],"needsApproval":["Review and send the owner email"]}',
        }),
      },
    );
    expect(result.run.status).toBe("awaiting-approval");
    expect(result.run.approvalRequests).toEqual(["Review and send the owner email"]);
    expect(result.run.evidence.some((item) => item.kind === "approval")).toBe(true);
  });

  it("fails closed on worker failure or malformed receipts", async () => {
    const failed = await executeRecipeJob(
      job(),
      { mode: "prepare", trigger: "manual", idempotencyKey: "manual-fail" },
      { store: store(), ask: async () => ({ ok: false, detail: "Bud took too long." }) },
    );
    expect(failed.run).toMatchObject({ status: "failed", detail: "Bud took too long." });

    const malformed = await executeRecipeJob(
      job({ id: "job-2" }),
      { mode: "prepare", trigger: "manual", idempotencyKey: "manual-junk" },
      { store: store(), ask: async () => ({ ok: true, stdout: "I did it" }) },
    );
    expect(malformed.run.status).toBe("failed");
    expect(malformed.run.detail).toMatch(/usable job receipt/i);
  });

  it("records the existing shadow-session walkthrough without a second worker call", async () => {
    const runs = store();
    const session: PortalSession = {
      id: "session-1",
      recipeId: "job-1",
      state: "done",
      shadow: true,
      allowedOrigins: ["propertyme.com.au"],
      submitLease: null,
      evidence: [{ at: 99, note: "Would open the owner page" }],
      detail: "Shadow run — nothing was browsed or clicked.",
      startedAt: 90,
      endedAt: 100,
    };
    const shadow = vi.fn(async () => session);
    const result = await executeRecipeJob(
      job(),
      { mode: "shadow", trigger: "manual", idempotencyKey: "shadow-1" },
      { store: runs, shadow },
    );
    expect(result.session?.id).toBe("session-1");
    expect(result.run).toMatchObject({
      status: "completed",
      legacySessionId: "session-1",
      mode: "shadow",
    });
    expect(result.run.evidence[0]?.note).toMatch(/owner page/);
    expect(shadow).toHaveBeenCalledTimes(1);
  });
});
