import { describe, expect, it } from "vitest";
import { jobRunContext, mergeWorkContext, hasHeldPreparationContext, hasUnfinishedJobDraft, repeatableJobDescription } from "./work-continuation";
import { EMPTY_JOB_DRAFT } from "./job-plan";
import { composeMessage, fileAttachment } from "./composer-attachments";
import { ASK_MESSAGE_MAX_CHARS, askMessageSizeError } from "../../shared/ask-message";
import type { JobRun } from "./desk";

const run: JobRun = {
  id: "run-1", jobId: "job-1", jobTitle: "Maintenance comparison", jobRevision: 2,
  mode: "prepare", status: "awaiting-approval", trigger: "manual", scheduledFor: 1, createdAt: 1, finishedAt: 2,
  idempotencyKey: "test", attempt: 1, detail: "Comparison prepared",
  spec: { title: "Maintenance comparison", description: "Compare the supplied quotes", steps: ["Compare"], capabilities: ["analyse", "draft"], allowedOrigins: [], limits: { maxRuntimeMinutes: 2, maxTurns: 6 }, evidence: "A comparison" },
  evidence: [{ at: 2, kind: "output", note: "The complete report\n\nFinal paragraph" }, { at: 2, kind: "observation", note: "Quote A and quote B" }],
  approvalRequests: ["Confirm the preferred option"],
};

describe("continuing prepared work", () => {
  it("carries the result, provenance and held steps as reference without implying new approval", () => {
    const context = jobRunContext(run, "handoff-1")!;
    expect(context.text).toContain("The complete report\n\nFinal paragraph");
    expect(context.text).toContain("Quote A and quote B");
    expect(context.text).toContain("Confirm the preferred option");
    expect(context.text).toContain("Plan version: 2");
    expect(context.text).toContain("does not authorize sending");
    expect(jobRunContext({ ...run, mode: "shadow" }, "shadow")).toBeNull();
    expect(jobRunContext({ ...run, status: "running" }, "running")).toBeNull();
  });

  it("preserves an existing draft and file, and deduplicates repeated transfers of the same receipt", () => {
    const context = jobRunContext(run, "first")!;
    const file = fileAttachment("quote.md", "/workroom/quote.md", 20);
    const first = mergeWorkContext("My unsent request", [file], context);
    expect(first.text).toBe("My unsent request");
    expect(first.attachments[0]).toEqual(file);
    const second = mergeWorkContext(first.text, first.attachments, { ...context, id: "second" });
    expect(second.attachments).toHaveLength(2);
    expect(second.attachments[1]).toMatchObject({ kind: "paste", label: "Maintenance comparison" });
    expect(mergeWorkContext("", [], context).text).toBe(context.instruction);
  });

  it("replaces a prior Desk-staged instruction when a new Desk case arrives", () => {
    const oak = {
      id: "oak",
      sourceKey: "desk-case-oak",
      title: "Maintenance · Oak",
      instruction: "Prepare the next useful deliverable for this selected case: a brief, checklist or draft for my review.",
      text: "Oak facts",
    };
    const king = {
      id: "king",
      sourceKey: "desk-case-king",
      title: "Licensee · King",
      instruction: "Prepare a concise evidence brief for the licensee about this case. Use only current Desk facts, identify missing evidence, and do not draft a statutory or legal notice.",
      text: "King facts",
    };
    const first = mergeWorkContext("", [], oak);
    expect(first.text).toBe(oak.instruction);
    const second = mergeWorkContext(first.text, first.attachments, king);
    expect(second.text).toBe(king.instruction);
    expect(second.attachments).toHaveLength(1);
    expect(second.attachments[0]).toMatchObject({ id: "desk-case-king", label: "Licensee · King" });
  });

  it.each(["awaiting-approval", "partial"] as const)("continues a %s preparation held for inputs without inventing output or approval", (status) => {
    const held: JobRun = {
      ...run, status, detail: "Waiting for the current quotes before comparing them.",
      evidence: [{ at: 2, kind: "observation", note: "No current quote files supplied." }],
      approvalRequests: ["Attach the current two quotes", "Confirm the preferred scope before choosing a supplier"],
    };
    expect(hasHeldPreparationContext(held)).toBe(true);
    const context = jobRunContext(held, "held-handoff")!;
    expect(context.text).toContain("No prepared output was recorded");
    expect(context.text).toContain(held.detail);
    expect(context.text).toContain("No current quote files supplied.");
    expect(context.text).toContain("Attach the current two quotes");
    expect(context.text).not.toContain("Prepared work:");
    expect(context.instruction).toContain("No held action is approved");
    expect(context.text).toContain("does not authorize sending");

    const file = fileAttachment("quote.md", "/workroom/quote.md", 20);
    const first = mergeWorkContext("My unsent clarification", [file], context);
    const second = mergeWorkContext(first.text, first.attachments, { ...context, id: "held-again" });
    expect(second.text).toBe("My unsent clarification");
    expect(second.attachments).toHaveLength(2);
    expect(second.attachments[0]).toEqual(file);
    expect(second.attachments[1]).toMatchObject({ id: `job-result-${held.id}`, text: context.text });
  });

  it("does not turn running, failed, rehearsal or attended receipts into held preparation handoffs", () => {
    const held: JobRun = { ...run, evidence: [], approvalRequests: ["Supply the current export"] };
    for (const status of ["queued", "running", "failed", "completed", "cancelled"] as const) {
      expect(jobRunContext({ ...held, status }, "no-handoff")).toBeNull();
    }
    for (const mode of ["shadow", "attended"] as const) {
      expect(jobRunContext({ ...held, mode }, "no-handoff")).toBeNull();
    }
    expect(jobRunContext({ ...held, approvalRequests: [] }, "no-handoff")).toBeNull();
    expect(jobRunContext({ ...held, approvalRequests: [" "] }, "no-handoff")).toBeNull();
  });

  it("checks the complete request envelope before sending a long result with an existing draft", () => {
    const context = jobRunContext(run, "large-handoff")!;
    const merged = mergeWorkContext("Existing instructions ".repeat(2500), [], context);
    expect(askMessageSizeError(composeMessage(merged.text, merged.attachments))).toMatch(/send fewer attachments/);
    expect(merged.attachments[0]).toMatchObject({ text: context.text });
    expect(askMessageSizeError("x".repeat(ASK_MESSAGE_MAX_CHARS))).toBeNull();
    expect(askMessageSizeError("x".repeat(ASK_MESSAGE_MAX_CHARS + 1))).not.toBeNull();
  });
});

describe("making work repeatable", () => {
  it("keeps a partly written job instead of replacing it", () => {
    expect(hasUnfinishedJobDraft(EMPTY_JOB_DRAFT)).toBe(false);
    expect(hasUnfinishedJobDraft({ ...EMPTY_JOB_DRAFT, text: "My unsaved job" })).toBe(true);
  });
  it("bounds the editable description and labels previous output as reference", () => {
    const text = repeatableJobDescription("task ".repeat(900), "result ".repeat(1000));
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).toContain("Example result (reference only");
    expect(text).toContain("Excerpt only");
    expect(text).toContain("Start on demand");
  });
});
