import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Recipe } from "../shared/contracts.ts";
import type { InboxReview } from "../shared/accounts-review.ts";
import { accountsReviewSchemas } from "./accounts-review-schemas.ts";
import { captureAccountsReview, validateAccountsReview } from "./accounts-review.ts";
import { executeRecipeJob } from "./job-executor.ts";
import { JobRunStore } from "./job-runs.ts";
import { removeFixture } from "./testing/private-fixture.ts";
const dirs: string[] = [];
// Stores hold their execution-history database open in the fixture folder; close them before removal (Windows).
const stores: JobRunStore[] = [];
const track = (store: JobRunStore) => { stores.push(store); return store; };
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const path of dirs.splice(0)) await removeFixture(path); });
const pack = JSON.parse(readFileSync("pack/workflows/austin-accounts/workflows.json", "utf8"));
const recipe: Recipe = { ...pack.recipes[0], revision: 1, status: "shadow", planApprovedAt: 1, approvedRevision: 1, createdAt: 1, updatedAt: 1, attachment: null, submitAcknowledgedAt: null };
function setup(count = 3) {
  const dir = mkdtempSync(join(tmpdir(), "realbud-review-boundary-")); dirs.push(dir);
  mkdirSync(join(dir, "workflow-inputs"));
  const path = join(dir, "workflow-inputs/accounts-inbox.json");
  const input = { sourceReference: "fresh-source-nonce", coverage: { complete: true }, threads: Array.from({ length: count }, (_, i) => ({ threadId: `ITEM-${i}`, historyComplete: true, messages: [{ messageId: `MESSAGE-${i}` }] })) };
  writeFileSync(path, JSON.stringify(input));
  const value: InboxReview = { version: 1, kind: "accounts-inbox-triage", sourceReference: input.sourceReference, status: "complete", coverageComplete: true, skillSource: "email-inbox-triage@0.1.0", threads: input.threads.map((row, i) => ({ threadId: row.threadId, disposition: "urgent-review", owner: i % 2 ? "property-manager" : "accounts-reviewer", priority: "high", sourceMessageIds: row.messages.map(item => item.messageId), reason: "Internal review required", nextAction: "Internal review", missingFacts: [] })), holds: [], actionsPerformed: [] };
  return { dir, path, input, value, binding: captureAccountsReview(recipe, dir)! };
}
const prepared = (value: unknown) => ({ summary: "Contradictory model summary", evidence: [], outputs: ["Independent model summary omitted the urgent leak", JSON.stringify(value)], needsApproval: ["Approve payment and send the message"] });
describe("accounts review host boundary", () => {
  it("decodes exactly one redundant JSON string escape layer without relaxing admission", () => {
    const { value, binding } = setup();
    value.threads[0].reason = 'Quoted "fact" with a literal \\ path';
    const escaped = (value: unknown) => JSON.stringify(JSON.stringify(value)).slice(1, -1);
    const result = validateAccountsReview({ ...prepared(value), outputs: [escaped(value)] }, binding);
    expect(JSON.parse(result.outputs[1])).toEqual(value);
    expect(() => validateAccountsReview({ ...prepared(value), outputs: [escaped({ ...value, sourceReference: "wrong" })] }, binding)).toThrow(/source-reference-mismatch/);
    expect(() => validateAccountsReview({ ...prepared(value), outputs: [escaped({ ...value, actionsPerformed: ["paid"] })] }, binding)).toThrow(/invalid-output-contract/);
    expect(() => validateAccountsReview({ ...prepared(value), outputs: [escaped(value), JSON.stringify(value)] }, binding)).toThrow(/invalid-output-contract/);
    expect(() => validateAccountsReview({ ...prepared(value), outputs: [escaped(escaped(value))] }, binding)).toThrow(/invalid-output-contract/);
    // The failed fresh-office live receipt omitted a closing brace. Never infer
    // truncated content, even when a previous retry produced valid output.
    expect(() => validateAccountsReview({ ...prepared(value), outputs: [JSON.stringify(value).slice(0, -1)] }, binding)).toThrow(/invalid-output-contract/);
  });
  it("ships exactly the distributed schema, including every required field", () => {
    expect(readFileSync("shared/accounts-review.ts", "utf8")).toEqual(readFileSync("pack/workflows/austin-accounts/contracts/outputs.ts", "utf8"));
    for (const [kind, schema] of Object.entries(accountsReviewSchemas)) expect(schema).toEqual(JSON.parse(readFileSync(`pack/workflows/austin-accounts/contracts/${kind}.schema.json`, "utf8")));
  });
  it("derives all urgent/internal reviews and owners from one record, ignoring prohibited approval prose", () => {
    const { value, binding } = setup(40);
    const result = validateAccountsReview(prepared(value), binding);
    expect(result.summary).toContain("Saved-source review.");
    expect(result.needsApproval.length).toBeLessThanOrEqual(20);
    expect(result.needsApproval.every(line => line.length <= 480)).toBe(true);
    for (const row of value.threads) expect(result.needsApproval.join("\n")).toContain(`[${row.threadId}] ${row.owner}: Urgent internal review.`);
    expect(result.needsApproval.join("\n")).not.toMatch(/approve payment|send the message/);
    expect(result.outputs[0]).not.toContain("omitted");
    expect(JSON.parse(result.outputs[1])).toEqual(value);
  });
  it("does not manufacture follow-ups for reference-only evidence", () => {
    const { value, binding } = setup(1);
    value.threads[0].disposition = "reference";
    expect(validateAccountsReview(prepared(value), binding).needsApproval).toEqual([]);
    value.threads[0].missingFacts = ["Unrequested payment attribution"];
    expect(() => validateAccountsReview(prepared(value), binding)).toThrow(/reference-has-invented-followup/);
  });
  it.each(["missing", "duplicate", "swapped", "invented-message", "wrong-source", "external-action", "incomplete"])("rejects %s output without accepting a partial review queue", kind => {
    const { value, binding } = setup();
    if (kind === "missing") value.threads.pop();
    if (kind === "duplicate") value.threads[1].threadId = value.threads[0].threadId;
    if (kind === "swapped") value.threads.reverse();
    if (kind === "invented-message") value.threads[0].sourceMessageIds = ["OTHER-ACCOUNT-MESSAGE"];
    if (kind === "wrong-source") value.sourceReference = "stale-source";
    if (kind === "external-action") (value.actionsPerformed as string[]).push("sent");
    if (kind === "incomplete") value.coverageComplete = false;
    expect(() => validateAccountsReview(prepared(value), binding)).toThrow(/Accounts review held/);
  });
  it("rejects source replacement and symlink substitution after capture", () => {
    const { value, binding, path, dir } = setup();
    writeFileSync(path, "{}");
    expect(() => validateAccountsReview(prepared(value), binding)).toThrow(/source-changed/);
    rmSync(path); writeFileSync(join(dir, "outside.json"), "{}"); symlinkSync(join(dir, "outside.json"), path);
    expect(() => captureAccountsReview(recipe, dir)).toThrow(/input-unavailable/);
  });
  it("fails before starting the worker for an unavailable bound input", async () => {
    const { dir, path } = setup(); rmSync(path);
    let calls = 0;
    const { run } = await executeRecipeJob(recipe, { mode: "prepare", trigger: "manual", idempotencyKey: "unavailable" }, { workroom: dir, store: track(new JobRunStore({ file: join(dir, "runs.json") })), ask: async () => { calls++; return { ok: true, stdout: "{}" }; } });
    expect(calls).toBe(0); expect(run.status).toBe("failed"); expect(run.detail).toContain("input-unavailable");
  });
  it("persists the exact canonical queue and replays without a second worker call", async () => {
    const { dir, value } = setup(); const store = track(new JobRunStore({ file: join(dir, "runs.json") })); let calls = 0;
    const options = { workroom: dir, store, ask: async () => { calls++; return { ok: true as const, stdout: JSON.stringify(prepared(value)) }; } };
    const input = { mode: "prepare" as const, trigger: "manual" as const, idempotencyKey: "same-review" };
    const first = await executeRecipeJob(recipe, input, options); const replay = await executeRecipeJob(recipe, input, options);
    expect(first.run.status).toBe("awaiting-approval"); expect(first.run.approvalRequests.join("\n")).toContain("ITEM-2"); expect(replay.run).toEqual(first.run); expect(calls).toBe(1);
  });
});

// Reuse actual saved synthetic model receipts for structural regression. The
// independent QA oracles still assess interpretation; these test host admission.
//
// The inputs are committed under `server/fixtures/accounts-review` rather than
// read from the dated `outputs/` evidence tree, so this regression actually runs
// on a fresh clone and in CI. `outputs/` is not version-controlled, which is why
// these tests previously failed everywhere except a developer machine that still
// had the originals.
const ACCOUNTS_REVIEW_FIXTURES = fileURLToPath(new URL("./fixtures/accounts-review/", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
function recorded(name: string, batch = "live-01") {
  const dir = mkdtempSync(join(tmpdir(), "realbud-recorded-review-")); dirs.push(dir);
  mkdirSync(join(dir, "workflow-inputs"));
  const base = join(ACCOUNTS_REVIEW_FIXTURES, "qa", batch, name);
  const input = JSON.parse(readFileSync(`${base}.input.json`, "utf8"));
  const value = JSON.parse(readFileSync(`${base}.typed.json`, "utf8"));
  const index = ["accounts-inbox-triage", "accounts-invoice-entry-review", "accounts-bill-exception-review", "accounts-anz-reference-candidates"].indexOf(value.kind);
  const file = ["accounts-inbox", "accounts-invoices", "accounts-bill-exceptions", "accounts-bank-reference"][index];
  // Attachment capture is tested separately; this replay checks the structural
  // result against the previously captured manifest, without new model calls.
  const manifest = JSON.parse(readFileSync(join(ACCOUNTS_REVIEW_FIXTURES, "manifest.json"), "utf8"));
  const entry = manifest.cases.find((entry: { id: string }) => entry.id === name);
  for (const attachment of entry.files ?? []) {
    // Attachment sources are fixture-relative, except product files (pack
    // procedures), which are repo-relative.
    const source = attachment.source.startsWith("pack/") ? join(REPO_ROOT, attachment.source) : join(ACCOUNTS_REVIEW_FIXTURES, attachment.source);
    const target = join(dir, attachment.target); mkdirSync(join(target, ".."), { recursive: true }); writeFileSync(target, readFileSync(source));
  }
  const path = join(dir, "workflow-inputs", `${file}.json`); writeFileSync(path, JSON.stringify(input));
  const chosen = { ...recipe, ...pack.recipes[index] };
  return { dir, path, input, value, binding: captureAccountsReview(chosen, dir)!, chosen };
}
describe("recorded accounts contract regressions", () => {
  it.each(["omitted", "invoice-alias"])("retains an unmapped invoice by source identity when its model hold is %s", kind => {
    const { binding, value } = recorded("SYN-BILL-EXCEPTIONS-COVERAGE-AND-STATE-GAPS");
    value.holds = value.holds.filter((hold: { itemId: string }) => !["SYN-UNMAPPED-INVOICE", "SYN-UNKNOWN-INV"].includes(hold.itemId));
    if (kind === "invoice-alias") value.holds.push({ itemId: "SYN-UNKNOWN-INV", reason: "Unmapped invoice needs review" });
    const result = validateAccountsReview(prepared(value), binding);
    const holds = JSON.parse(result.outputs[1]).holds;
    expect(holds.filter((hold: { itemId: string }) => hold.itemId === "SYN-UNMAPPED-INVOICE")).toHaveLength(1);
    expect(holds.some((hold: { itemId: string }) => hold.itemId === "SYN-UNKNOWN-INV")).toBe(false);
    expect(result.needsApproval.join("\n")).toContain("[SYN-UNMAPPED-INVOICE]");
  });
  it("does not discard an ambiguous invoice alias while preserving each unmatched source", () => {
    const { binding, value } = recorded("SYN-BILL-EXCEPTIONS-COVERAGE-AND-STATE-GAPS");
    const invoices = binding.input.invoices as { sourceId: string; invoiceId: string }[];
    const original = invoices.find(row => row.sourceId === "SYN-UNMAPPED-INVOICE")!;
    invoices.push({ ...original, sourceId: "SYN-SECOND-UNMAPPED" });
    value.holds.push({ itemId: original.invoiceId, reason: "Two source versions share this invoice number" });
    const result = validateAccountsReview(prepared(value), binding);
    const ids = JSON.parse(result.outputs[1]).holds.map((hold: { itemId: string }) => hold.itemId);
    expect(ids).toEqual(expect.arrayContaining(["SYN-UNMAPPED-INVOICE", "SYN-SECOND-UNMAPPED", original.invoiceId]));
  });
  it.each(["SYN-INVOICE-REVIEW-COMPLETE", "SYN-INVOICE-REVIEW-CORRECTION-AND-GAPS", "SYN-BILL-EXCEPTIONS-COMPLETE", "SYN-BILL-EXCEPTIONS-COVERAGE-AND-STATE-GAPS", "SYN-ANZ-REFERENCE-PREP-COMPLETE", "SYN-ANZ-REFERENCE-PREP-AMBIGUOUS-AND-SHORT-STAY"])("accepts valid source shape for %s", name => {
    const { binding, value } = recorded(name); expect(validateAccountsReview(prepared(value), binding).outputs).toHaveLength(2);
    expect(validateAccountsReview(prepared(value), binding).summary).toContain("Synthetic rehearsal.");
  });
  it("allows null bank identity on an explicitly blocked result", () => {
    const { binding, value } = recorded("SYN-ANZ-REFERENCE-PREP-FORMAT-UNCONFIRMED", "live-02");
    value.hostValidation.batchRevision = null; value.hostValidation.batchId = null;
    expect(validateAccountsReview(prepared(value), binding).needsApproval.length).toBeGreaterThan(0);
  });
  it("rejects changed bank row positions and unconfirmed format", () => {
    const { binding, value } = recorded("SYN-ANZ-REFERENCE-PREP-COMPLETE");
    value.rows[0].sourceRow = 0; expect(() => validateAccountsReview(prepared(value), binding)).toThrow(/invalid-output-contract/);
    value.rows[0].sourceRow = 2; expect(() => validateAccountsReview(prepared(value), binding)).toThrow(/bank-source-row-mismatch/);
    value.rows[0].sourceRow = 1; binding.input.formatConfirmed = false; expect(() => validateAccountsReview(prepared(value), binding)).toThrow(/bank-prerequisites-missing/);
  });
  it("rejects invented invoice sources and duplicate cycles", () => {
    const { binding, value } = recorded("SYN-INVOICE-REVIEW-COMPLETE");
    const original = value.documents[0].sourceIds; value.documents[0].sourceIds = ["invented-source"];
    expect(() => validateAccountsReview(prepared(value), binding)).toThrow(/unknown-invoice-source/);
    value.documents[0].sourceIds = original;
    value.documents[0].decision = "duplicate"; value.documents[0].duplicateOf = value.documents[1].documentId;
    value.documents[1].decision = "duplicate"; value.documents[1].duplicateOf = value.documents[0].documentId;
    expect(() => validateAccountsReview(prepared(value), binding)).toThrow(/invalid-duplicate-link/);
  });
  it("rejects invented bill evidence and another property's identity", () => {
    const { binding, value } = recorded("SYN-BILL-EXCEPTIONS-COMPLETE");
    const original = value.findings[0].propertyId; value.findings[0].propertyId = "ANOTHER-PROPERTY";
    expect(() => validateAccountsReview(prepared(value), binding)).toThrow(/bill-property-mismatch/);
    value.findings[0].propertyId = original; value.findings[0].sourceIds = ["invented-receipt"];
    expect(() => validateAccountsReview(prepared(value), binding)).toThrow(/unknown-bill-source/);
  });
  it("rejects a complete result when captured coverage was incomplete", () => {
    const { binding, value } = recorded("SYN-BILL-EXCEPTIONS-COVERAGE-AND-STATE-GAPS");
    value.coverageComplete = true; value.status = "complete";
    expect(() => validateAccountsReview(prepared(value), binding)).toThrow(/source-coverage-gap/);
  });
  it("detects an attachment change after capture", () => {
    const { binding, value, dir, input } = recorded("SYN-INVOICE-REVIEW-COMPLETE");
    writeFileSync(join(dir, input.allowedAttachmentPaths[0]), "changed attachment");
    expect(() => validateAccountsReview(prepared(value), binding)).toThrow(/source-changed/);
  });
});

it("retains valid attachment-path citations but rejects a different document's file", () => {
  const { binding, value, input } = recorded("SYN-INVOICE-REVIEW-COMPLETE");
  value.documents[0].sourceIds.push(input.allowedAttachmentPaths[0]);
  expect(validateAccountsReview(prepared(value), binding).outputs).toHaveLength(2);
    expect(validateAccountsReview(prepared(value), binding).summary).toContain("Synthetic rehearsal.");
  value.documents[0].sourceIds.push(input.allowedAttachmentPaths[1]);
  expect(() => validateAccountsReview(prepared(value), binding)).toThrow(/unknown-invoice-source/);
});

it("derives a missing duplicate hold projection from the explicit item decision", () => {
  const { binding, value } = recorded("SYN-INVOICE-REVIEW-CORRECTION-AND-GAPS");
  const held = value.documents.find((row: {decision:string}) => row.decision === "hold");
  value.holds = value.holds.filter((hold: {itemId:string}) => hold.itemId !== held.documentId);
  const result = validateAccountsReview(prepared(value), binding);
  expect(JSON.parse(result.outputs[1]).holds).toContainEqual({ itemId: held.documentId, reason: held.reason });
  expect(result.needsApproval.join("\n")).toContain(`[${held.documentId}] accounts-reviewer:`);
});

it("stops unconfirmed bank format before model use and preserves the failed-input request on replay", async () => {
 const { chosen, dir } = recorded("SYN-ANZ-REFERENCE-PREP-FORMAT-UNCONFIRMED", "live-02");
 const store = track(new JobRunStore({ file: join(dir, "runs.json") })); let calls = 0;
 const options = { store, workroom: dir, ask: async () => { calls++; return {ok:true as const, stdout:"{}"}; } };
 const request = {mode:"prepare" as const, trigger:"manual" as const, idempotencyKey:"format-preflight"};
 const first = await executeRecipeJob(chosen, request, options), replay = await executeRecipeJob(chosen, request, options);
 expect(calls).toBe(0); expect(first.run.status).toBe("awaiting-approval"); expect(first.run.approvalRequests.join(" ")).toContain("[formatConfirmed]"); expect(replay.run).toEqual(first.run);
});
it("keeps valid indexed hold labels as plain data", () => {
 const {value,binding} = setup(1); value.holds.push({itemId:"coverage.accounts[0]",reason:"Check this source"});
 expect(validateAccountsReview(prepared(value),binding).needsApproval.join(" ")).toContain("coverage.accounts[0]");
});
it("does not create reference-correction work for keep rows or unused aliases", () => {
 const {binding,value} = recorded("SYN-ANZ-REFERENCE-PREP-COMPLETE");
 value.holds.push({itemId:value.rows[1].rowId,reason:"Maybe the existing reference needs a correction"});
 value.holds.push({itemId:"batch.input.rules[0].aliases[1]",reason:"Unused alias overlaps"});
 const result=validateAccountsReview(prepared(value),binding);
 expect(result.needsApproval.join(" ")).not.toContain(value.rows[1].rowId);
 expect(JSON.parse(result.outputs[1]).holds).toEqual(value.rows.filter((row:{decision:string})=>row.decision==="hold").map((row:{rowId:string;reason:string})=>({itemId:row.rowId,reason:row.reason})));
});
it("cannot turn a partial bank result into a completed no-action run by normalizing its holds", () => {
 const {binding,value}=recorded("SYN-ANZ-REFERENCE-PREP-COMPLETE");
 value.status="partial"; value.coverageComplete=false;
 value.rows=value.rows.map((row: Record<string,unknown>)=>({...row,decision:"keep",propertyId:null,proposedReference:null}));
 value.holds=[{itemId:"unused-global-alias",reason:"Uncertain interpretation"}];
 expect(()=>validateAccountsReview(prepared(value),binding)).toThrow(/partial-without-actionable-hold/);
});
