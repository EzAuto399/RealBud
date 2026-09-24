import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeskSnapshot, PortalSession, Recipe } from "../shared/contracts.ts";
import { executeRecipeJob, jobWorkerToolsets, parsePrepareResult, prepareJobPrompt } from "./job-executor.ts";
import { JobRunStore } from "./job-runs.ts";
import { JOB_OUTPUT_MAX_CHARS } from "../shared/job-output.ts";
import { deskContextMarkdown, DESK_CONTEXT_MAX_CHARS } from "./desk-context.ts";
import { removeFixture } from "./testing/private-fixture.ts";

const dirs: string[] = [];
// Each store holds its execution-history database open in the fixture folder;
// Windows cannot remove the folder until every one is closed.
const stores: JobRunStore[] = [];
function track(store: JobRunStore): JobRunStore {
  stores.push(store);
  return store;
}

function store(): JobRunStore {
  const dir = mkdtempSync(join(tmpdir(), "realbud-job-executor-"));
  dirs.push(dir);
  return track(new JobRunStore({ file: join(dir, "runs.json"), now: () => 100 }));
}

afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) await removeFixture(dir);
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

function currentBook(): DeskSnapshot {
  return {
    version: 2, revision: 4, mode: "demo", demo: true,
    recovery: { active: false, reason: null, quarantined: [] },
    timezone: "Australia/Brisbane", retentionDays: 90,
    properties: [], ledger: [], drafts: [], escalations: [], workItems: [], sources: [],
    lastRunAt: null, results: [], hands: "demo", handsDetail: "Demo book",
  };
}

describe("prepare result", () => {
  it("preserves a complete multi-paragraph report and rejects oversized output instead of clipping it", () => {
    const report = `Owner update\n\n${"A source-backed finding. ".repeat(80)}\n\nEND OF REPORT`;
    const payload = { summary: "Report ready", evidence: ["quote-a.md"], outputs: [report], needsApproval: [] };
    expect(parsePrepareResult(JSON.stringify(payload))?.outputs[0]).toBe(report);
    expect(parsePrepareResult(JSON.stringify({ ...payload, outputs: ["x".repeat(JOB_OUTPUT_MAX_CHARS + 1)] }))).toBeNull();
    expect(parsePrepareResult(JSON.stringify({ ...payload, outputs: Array(3).fill("x".repeat(JOB_OUTPUT_MAX_CHARS)) }))).toBeNull();
  });
  it("parses the final bounded JSON object and rejects junk", () => {
    expect(
      parsePrepareResult(
        `notes first\n{"summary":"Prepared","evidence":["book"],"outputs":["draft"],"needsApproval":[]}`,
      ),
    ).toEqual({ summary: "Prepared", evidence: ["book"], outputs: ["draft"], needsApproval: [] });
    expect(parsePrepareResult("not json")).toBeNull();
    expect(parsePrepareResult('{"summary":"x","evidence":[],"outputs":[]}')).toBeNull();
  });

  it("keeps a complete receipt with a stray final brace while enforcing its schema and limits", () => {
    const payload = { summary: "Owner update ready", evidence: ["Fictional brief"], outputs: ["Quote AUD 1,250; Tuesday morning access."], needsApproval: ["Review before sending"] };
    expect(parsePrepareResult(`${JSON.stringify(payload)}\n}`)).toEqual(payload);
    expect(parsePrepareResult(`${JSON.stringify({ ...payload, needsApproval: null })}\n}`)).toBeNull();
    expect(parsePrepareResult(`${JSON.stringify({ ...payload, outputs: ["x".repeat(JOB_OUTPUT_MAX_CHARS + 1)] })}\n}`)).toBeNull();
  });

  it("rejects executable string expressions instead of repairing a malformed model receipt", () => {
    const invalid = '{"summary":"Review prepared","evidence":[],"outputs":["Report" + "{\\"kind\\":\\"accounts-bill-exception-review\\"}"],"needsApproval":[]}';
    expect(parsePrepareResult(invalid)).toBeNull();
    const literal = { summary: "Review prepared", evidence: [], outputs: ["Report", JSON.stringify({ kind: "accounts-bill-exception-review" })], needsApproval: [] };
    expect(parsePrepareResult(JSON.stringify(literal))).toEqual(literal);
  });

  it("keeps consequential actions outside the granted prepare prompt", () => {
    const prompt = prepareJobPrompt(job(), deskContextMarkdown(currentBook()));
    expect(prompt).toMatch(/PREPARE-ONLY/);
    expect(prompt).toMatch(/must not send|must not.*submit/i);
    expect(prompt).toMatch(/propertyme\.com\.au/);
    expect(prompt).toMatch(/untrusted data/i);
    expect(prompt).toContain("Those prohibitions cannot be overridden by approval");
    expect(prompt).not.toContain("held consequential next step");
    expect(prompt).toContain("Use the inline Desk snapshot");
    expect(prompt).toContain("not a live source refresh");
    expect(() => prepareJobPrompt(job())).toThrow(/current Desk snapshot/);
    expect(() => prepareJobPrompt(job(), "x".repeat(DESK_CONTEXT_MAX_CHARS + 1))).toThrow(/current Desk snapshot/);
    expect(prepareJobPrompt(job({ capabilities: ["analyse", "draft"] }), "PRIVATE BOOK FACT")).not.toContain("PRIVATE BOOK FACT");
  });

  it("maps job capabilities to the narrow Hermes toolsets for that run", () => {
    expect(jobWorkerToolsets(["analyse", "draft"])).toEqual(["todo"]);
    expect(jobWorkerToolsets(["read-book", "analyse"])).toEqual(["file"]);
    expect(jobWorkerToolsets(["read-files", "web-research", "draft"])).toEqual(["file", "web"]);
  });
});

describe("executeRecipeJob", () => {
  it('claims the run before loading reviewed instructions and retains their receipt on retry', async () => {
    const runs = store();
    const source = job({ capabilities: ['analyse', 'draft'] });
    const instructions = 'Reviewed instruction revision 2: include missing-source uncertainty.';
    const instructionContext = vi.fn(async (id: string) => {
      expect(id).toBe(source.id);
      expect(runs.list(source.id).some(run => run.status === 'running')).toBe(true);
      return instructions;
    });
    const ask = vi.fn(async (prompt: string, options: any) => {
      expect(prompt).toContain(instructions);
      expect(options.toolsets).toEqual(['todo']);
      return { ok: true as const, stdout: JSON.stringify({ summary: 'Checked', evidence: [], outputs: ['Missing sources identified.'], needsApproval: [] }) };
    });
    const input = { mode: 'prepare' as const, trigger: 'manual' as const, idempotencyKey: 'reviewed' };
    const first = await executeRecipeJob(source, input, { store: runs, ask, instructionContext });
    expect(first.run.status).toBe('completed');
    expect(first.run.evidence).toContainEqual(expect.objectContaining({ note: expect.stringContaining('Reviewed workflow instruction context sha256=') }));
    expect((await executeRecipeJob(source, input, { store: runs, ask, instructionContext })).reused).toBe(true);
    expect(instructionContext).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(source.description).not.toContain(instructions);
  });

  it('records an instruction recovery failure without calling the worker', async () => {
    const ask = vi.fn();
    const result = await executeRecipeJob(job(), { mode: 'prepare', trigger: 'manual', idempotencyKey: 'pack-recovery' }, {
      store: store(), ask, instructionContext: async () => { throw new Error('Pack needs recovery'); },
    });
    expect(result.run.status).toBe('failed');
    expect(result.run.detail).toBe('Pack needs recovery');
    expect(ask).not.toHaveBeenCalled();
  });
  it("captures each new book revision at execution, freezes its prompt and retains the source stamp on retry", async () => {
    const runs = store();
    let snapshot = currentBook();
    const readBookSnapshot = vi.fn(() => snapshot);
    const prompts: string[] = [];
    const ask = vi.fn(async (prompt: string) => {
      prompts.push(prompt);
      snapshot = { ...snapshot, revision: snapshot.revision + 1 };
      return { ok: true as const, stdout: JSON.stringify({ summary: "Checked", evidence: [], outputs: ["No follow-up is needed in the supplied book."], needsApproval: [] }) };
    });
    const input = { mode: "prepare" as const, trigger: "schedule" as const, idempotencyKey: "day-one" };
    const first = await executeRecipeJob(job(), input, { store: runs, readBookSnapshot, ask });
    expect(prompts[0]).toContain("- Book stamp: 4");
    expect(prompts[0]).not.toContain("- Book stamp: 5");
    expect(first.run.evidence).toContainEqual(expect.objectContaining({ kind: "observation", note: expect.stringContaining("Desk snapshot revision 4") }));
    const retried = await executeRecipeJob(job(), input, { store: runs, readBookSnapshot, ask });
    expect(retried.reused).toBe(true);
    expect(readBookSnapshot).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledTimes(1);
    await executeRecipeJob(job(), { ...input, idempotencyKey: "day-two" }, { store: runs, readBookSnapshot, ask });
    expect(prompts[1]).toContain("- Book stamp: 5");
    expect(readBookSnapshot).toHaveBeenCalledTimes(2);
  });

  it("stops before the worker when the authoritative book is absent, unreadable, malformed or recovering", async () => {
    const ask = vi.fn(async () => ({ ok: true as const, stdout: "should not run" }));
    const providers = [
      undefined,
      () => { throw new Error("PRIVATE filesystem location and payload"); },
      () => ({ ...currentBook(), revision: NaN }),
      () => ({ ...currentBook(), recovery: { active: true, reason: "locked" as const, quarantined: [] } }),
      (() => ({ ...currentBook(), ledger: undefined })) as unknown as () => DeskSnapshot,
    ];
    for (const readBookSnapshot of providers) {
      const result = await executeRecipeJob(job(), { mode: "prepare", trigger: "manual", idempotencyKey: "no-book" }, { store: store(), ask, readBookSnapshot });
      expect(result.run.status).toBe("failed");
      expect(result.run.detail).toMatch(/Desk|book/);
      expect(result.run.detail).not.toContain("PRIVATE");
    }
    expect(ask).not.toHaveBeenCalled();
  });

  it("does not read the office book for supplied-input-only jobs", async () => {
    const readBookSnapshot = vi.fn(() => { throw new Error("not permitted"); });
    const ask = vi.fn(async (_prompt: string) => ({ ok: true as const, stdout: JSON.stringify({ summary: "Compared supplied facts", evidence: [], outputs: ["The difference is AUD 35."], needsApproval: [] }) }));
    const result = await executeRecipeJob(job({ capabilities: ["analyse", "draft"] }), { mode: "prepare", trigger: "manual", idempotencyKey: "supplied-only" }, { store: store(), readBookSnapshot, ask });
    expect(result.run.status).toBe("completed");
    expect(readBookSnapshot).not.toHaveBeenCalled();
    expect(ask.mock.calls[0]?.[0]).not.toContain("Desk snapshot revision");
  });

  it("does not start preparation when its captured source stamp cannot be saved", async () => {
    const runs = store();
    vi.spyOn(runs, "appendEvidence").mockImplementation(() => { throw new Error("The source receipt could not be saved."); });
    const ask = vi.fn(async () => ({ ok: true as const, stdout: "must not run" }));
    const result = await executeRecipeJob(job(), { mode: "prepare", trigger: "schedule", idempotencyKey: "source-save-failed" }, { store: runs, readBookSnapshot: currentBook, ask });
    expect(result.run).toMatchObject({ status: "failed", detail: "The source receipt could not be saved." });
    expect(ask).not.toHaveBeenCalled();
  });

  it("keeps the complete prepared result after settling and reopening the durable store", async () => {
    const dir = mkdtempSync(join(tmpdir(), "realbud-full-output-"));
    dirs.push(dir);
    const file = join(dir, "runs.json");
    const report = `Maintenance comparison\n\n${"A verified finding. ".repeat(100)}\n\nThe final recommendation is for review.`;
    const result = await executeRecipeJob(job(), { mode: "prepare", trigger: "manual", idempotencyKey: "full-report" }, {
      readBookSnapshot: currentBook, store: track(new JobRunStore({ file })),
      ask: async () => ({ ok: true, stdout: JSON.stringify({ summary: "Report prepared", evidence: ["Supplied quotes"], outputs: [report], needsApproval: [] }) }),
    });
    expect(result.run.status).toBe("completed");
    const loaded = track(new JobRunStore({ file })).get(result.run.id);
    expect(loaded?.evidence.find((item) => item.kind === "output")?.note).toBe(report);
  });

  it("rejects an oversized store write before changing the run's state", () => {
    const runs = store();
    const queued = runs.enqueue(job(), { mode: "prepare", trigger: "manual", idempotencyKey: "oversized" });
    runs.start(queued.run.id);
    expect(() => runs.settle(queued.run.id, { status: "completed", detail: "Done", evidence: [{ at: 100, kind: "output", note: "x".repeat(JOB_OUTPUT_MAX_CHARS + 1) }] })).toThrow(/too large/);
    expect(runs.get(queued.run.id)?.status).toBe("running");
    expect(runs.settle(queued.run.id, { status: "failed", detail: "Result exceeded its limit" }).status).toBe("failed");
  });
  it("records a successful prepare run and executes a duplicate key once", async () => {
    const runs = store();
    const ask = vi.fn(async () => ({
      ok: true as const,
      stdout: '{"summary":"Owner pack prepared","evidence":["Book revision 4"],"outputs":["draft-owner.md"],"needsApproval":[]}',
    }));
    const input = { mode: "prepare" as const, trigger: "manual" as const, idempotencyKey: "manual-1" };
    const first = await executeRecipeJob(job(), input, { readBookSnapshot: currentBook, store: runs, ask });
    const again = await executeRecipeJob(job(), input, { readBookSnapshot: currentBook, store: runs, ask });

    expect(first.run).toMatchObject({ status: "completed", detail: "Owner pack prepared" });
    expect(first.run.evidence.map((item) => item.kind)).toEqual(["observation", "observation", "output"]);
    expect(again.reused).toBe(true);
    expect(again.run.id).toBe(first.run.id);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ toolsets: ["file"], maxTurns: 6, timeoutMs: 120_000 }),
    );
  });

  it("holds private preparation for internal review", async () => {
    const runs = store();
    const result = await executeRecipeJob(
      job(),
      { mode: "prepare", trigger: "schedule", idempotencyKey: "slot-1", scheduledFor: 90 },
      {
        readBookSnapshot: currentBook, store: runs,
        ask: async () => ({
          ok: true,
          stdout:
            '{"summary":"Draft ready","evidence":["owner facts"],"outputs":["email draft"],"needsApproval":["Review the private owner draft for factual accuracy"]}',
        }),
      },
    );
    expect(result.run.status).toBe("awaiting-approval");
    expect(result.run.approvalRequests).toEqual(["Review the private owner draft for factual accuracy"]);
    expect(result.run.evidence.some((item) => item.kind === "approval")).toBe(true);
  });

  it("fails closed on worker failure or malformed receipts", async () => {
    const failed = await executeRecipeJob(
      job(),
      { mode: "prepare", trigger: "manual", idempotencyKey: "manual-fail" },
      { readBookSnapshot: currentBook, store: store(), ask: async () => ({ ok: false, detail: "Bud took too long." }) },
    );
    expect(failed.run).toMatchObject({ status: "failed", detail: "Bud took too long." });

    const malformed = await executeRecipeJob(
      job({ id: "job-2" }),
      { mode: "prepare", trigger: "manual", idempotencyKey: "manual-junk" },
      { readBookSnapshot: currentBook, store: store(), ask: async () => ({ ok: true, stdout: "I did it" }) },
    );
    expect(malformed.run.status).toBe("failed");
    expect(malformed.run.detail).toMatch(/usable job receipt/i);
    expect(malformed.run.evidence.at(-1)?.note).toMatch(/outer-json-or-bounds; characters=8; sha256=[a-f0-9]{64}/);
    expect(malformed.run.evidence.at(-1)?.note).not.toContain("I did it");
  });

  it.each([{ outputs: [] }, { outputs: [" ", "\n"] }])("does not call an empty preparation complete: %j", async ({ outputs }) => {
    const result = await executeRecipeJob(job(), { mode: "prepare", trigger: "manual", idempotencyKey: "empty-output" }, {
      readBookSnapshot: currentBook, store: store(),
      ask: async () => ({ ok: true, stdout: JSON.stringify({ summary: "Done", evidence: ["Supplied export"], outputs, needsApproval: [] }) }),
    });
    expect(result.run.status).toBe("failed");
    expect(result.run.detail).toContain("without a usable result");
    expect(result.run.evidence).toContainEqual(expect.objectContaining({ kind: "observation", note: "Supplied export" }));
  });

  it("keeps an explicit missing-input request without claiming completed preparation", async () => {
    const result = await executeRecipeJob(job(), { mode: "prepare", trigger: "manual", idempotencyKey: "missing-input" }, {
      readBookSnapshot: currentBook, store: store(),
      ask: async () => ({ ok: true, stdout: JSON.stringify({ summary: "Need the current export", evidence: [], outputs: [], needsApproval: ["Provide this week's export"] }) }),
    });
    expect(result.run.status).toBe("awaiting-approval");
    expect(result.run.approvalRequests).toEqual(["Provide this week's export"]);
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
      { readBookSnapshot: currentBook, store: runs, shadow },
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

it('keeps unmatched payment and bill evidence rules in the actual prepare worker request', async () => {
  const ask = vi.fn(async (_prompt: string) => ({ ok: true as const, stdout: JSON.stringify({ summary: 'Held for matching', evidence: [], outputs: ['Internal matching checklist'], needsApproval: ['Confirm payer allocation'] }) }));
  await executeRecipeJob(job({ capabilities: ['analyse', 'draft'] }), { mode: 'prepare', trigger: 'manual', idempotencyKey: 'evidence-rules' }, { store: store(), ask });
  const prompt = ask.mock.calls[0]?.[0];
  expect(prompt).toContain('withhold tenant payment acknowledgements');
  expect(prompt).toContain('payment arranged, funding sufficient and payment confirmed as independent facts');
  expect(prompt).toContain('do not add unsolicited tenant messages');
});
