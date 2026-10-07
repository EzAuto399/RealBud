// W1 REI bridge: takes one reviewed receipt CSV into REI's Bulk receipting
// preview, reconciles the preview row by row, hands posting to the person and
// reads the Receipt Register back. It drives the pack's recipes through the
// portal recipe runner (server/portal-recipe-runner.ts), so the grant, the
// fence, the account checks, the sign-in pause and Stop all apply unchanged.
// Durable state is the caller's (Packet 2: server/w1-workflow.ts, w1-state.ts);
// this module keeps none.
//
// Interfaces for the W1 runner
//   w1ReiPreviewProposal(batch, {threadId, messageId})
//       → the Ask card for the upload-and-preview task, bound to the batch's
//         artifact {name, sha256} and destination account. The person's Start
//         issues the grant (server/browser-grants.ts); the grant must list
//         exactly that file.
//   preview(batch, ctx) → W1PreviewOutcome
//       Checks before the browser: rows valid, grant lists the artifact with the
//       same sha256, grant account marker = destination marker, the private copy
//       still hashes the same. Then open-session + bulk-receipting-preview. The
//       upload is asked once of the person (the broker's once-only prompt).
//       status: "ready"           every row matched; awaitPosting may follow
//               "mismatch"        hold and report; never re-upload to try again
//               "unknown-upload"  an upload was dispatched but its preview was not
//                                 confirmed (lost reply, reload, sign-in, Stop after
//                                 upload): readback is required before anything else
//               "not-uploaded"    ended before any file left RealBud (handover,
//                                 blocked, declined); safe to preview again
//   awaitPosting(batch, outcome) → W1PostingHandoff
//       What the person must do in REI themselves (Process Receipts / Receipt
//       All / Save / Post / Finalise). Bud never presses these. Throws unless the
//       outcome is a "ready" preview of this exact batch and artifact.
//   captureBaseline(batch, ctx, {from, to}) → W1BaselineOutcome
//       Before the upload: the Receipt Register as it stands, account-scoped and
//       complete for the window. The caller saves it with the batch.
//   readback(batch, ctx, {from, to}, baseline) → W1ReadbackOutcome
//       open-session + receipt-register (Export Only, the download asked once of
//       the person), then classifyReadback: accepted / rejected / pending per
//       row, counting only receipts new since the baseline (the runner's account
//       checks around the download scope an export that names no account). Only
//       `readback.complete` may advance the import cursor.
//   w1ImportProof(batch, readbackOutcome) → the verified outcome confirm-import
//       requires (bound to batch, artifact sha256, destination and row ids).
//   nextReiStep(events) → what is allowed next, from the caller's saved events.
//       An unknown upload always leads to "readback" first; any accepted or
//       rejected row means the batch is never uploaded again. A person-approved
//       retry also needs a complete, scoped register showing nothing of the
//       batch and a pending-import inspection showing nothing pending.
//
// Account scope: REI's addresses carry no reicid after sign-in (seen 2 Oct
// 2026). The top-bar business code (destination.marker) is the scope and a
// mismatch always stops; a reicid is checked only when the office saved one.
//
// Credentials and MFA stay with the person: a sign-in page is a handover.
import { createHash } from "node:crypto";
import type { BrowserApprovalStore } from "./browser-authority.ts";
import type { BrowserTaskProposal, BrowserTaskRecipe } from "./browser-grants.ts";
import { browserTaskWorkroom, grantedUploadPath } from "./browser-runtime.ts";
import type { BrowserSessionRuntime } from "./browser-session.ts";
import type { ConnectedAppOperationStore } from "./connected-app-operations.ts";
import type { PortalRecipePack } from "./portal-recipe.ts";
import { portalRecipeGrantNeeds, runPortalRecipes, type PersonApprove, type PortalRunResult, type PortalRunRequest } from "./portal-recipe-runner.ts";
import { loadPortalRecipePack, portalRecipeTaskProposal, type PackLoader } from "./portal-recipe-task.ts";
import { assertExpectedRows, classifyReadback, isoDate, reconcilePreview, registerBaseline, type W1DateWindow, type W1Destination, type W1ExpectedRow, type W1PreviewReconciliation, type W1Readback, type W1RegisterBaseline, type W1RegisterEvidence } from "./w1-rei-reconciliation.ts";
import { browserTaskUploadName, type BrowserActionClass, type BrowserTaskGrant } from "../shared/browser-task.ts";

export const W1_REI_PORTAL = "rei-cloud" as const;
export const W1_PREVIEW_RECIPE = "bulk-receipting-preview" as const;
export const W1_READBACK_RECIPE = "receipt-register" as const;

/** One reviewed batch, exactly as the reviewer approved it. */
export interface W1ReiBatch {
  batchId: string;
  version: number;
  /** The reviewed CSV: its file name in the grant and the sha256 of its exact bytes. */
  artifact: { name: string; sha256: string };
  /** The REI agency/trust account the batch was reviewed for: its top-bar business code, and a reicid only when saved. */
  destination: { portal: typeof W1_REI_PORTAL } & W1Destination;
  /** REI's File Format option for this CSV (a verified format, never guessed). */
  bankFormat: string;
  rows: W1ExpectedRow[];
}

/** What a run needs from the host. The grant is host-issued; this module never creates or widens one. */
export interface W1ReiContext {
  grant: BrowserTaskGrant;
  runtime: BrowserSessionRuntime;
  threadId: string;
  approve: PersonApprove;
  signal?: AbortSignal;
  isActive?: () => boolean;
  workroom?: string;
  load?: PackLoader;
  operations?: ConnectedAppOperationStore;
  approvals?: BrowserApprovalStore;
  rules?: () => ReadonlyArray<{ key: string; decision: "allow" | "deny" }>;
  assertCapability?: () => void;
  now?: () => number;
  pollMs?: number;
}

export interface W1RunSummary { outcome: PortalRunResult["outcome"]; reason?: string; detail?: string; receipt: PortalRunResult["receipt"] }
export type W1PreviewStatus = "ready" | "mismatch" | "unknown-upload" | "not-uploaded";
export interface W1PreviewOutcome {
  kind: "w1-rei-preview";
  batchId: string; version: number; artifactSha256: string;
  status: W1PreviewStatus;
  reason?: string; detail?: string;
  reconciliation?: W1PreviewReconciliation;
  /** Consequential controls seen on the preview page and left unpressed. */
  stopBefore: string[];
  run?: W1RunSummary;
}
export interface W1PostingHandoff {
  kind: "w1-rei-posting-handoff";
  batchId: string; version: number;
  artifact: { name: string; sha256: string };
  destination: W1Destination;
  rows: number; totalCents: number;
  /** The controls only the person presses. */
  personActions: string[];
  message: string;
}
export type W1ReadbackStatus = "read" | "not-read";
export type W1BaselineOutcome = { kind: "w1-rei-baseline-outcome"; batchId: string; version: number } & (
  | { status: "read"; baseline: W1RegisterBaseline; run: W1RunSummary }
  | { status: "not-read"; reason: string; detail: string; run?: W1RunSummary });
/** The verified W1 outcome bank coverage requires: only w1ImportProof issues it, from a complete readback. */
export interface W1ImportProof {
  kind: "w1-rei-import-proof";
  batchId: string; version: number; artifactSha256: string;
  /** The batch's REI account: its business code, and its reicid only when the office saved one. */
  destination: { portal: typeof W1_REI_PORTAL } & W1Destination;
  rowIds: string[];
}
export interface W1ReadbackOutcome {
  kind: "w1-rei-readback-outcome";
  batchId: string; version: number; artifactSha256: string;
  status: W1ReadbackStatus;
  reason?: string; detail?: string;
  readback?: W1Readback;
  run?: W1RunSummary;
}

const fail = (message: string) => new Error(message);
const SHA256 = /^[0-9a-f]{64}$/;
const cents = (value: number) => (value / 100).toFixed(2);
/** The account the runner checks: the business code, plus the reicid only when one was saved. */
const account = (destination: W1Destination): W1Destination => ({ ...(destination.urlValue ? { urlValue: destination.urlValue } : {}), marker: destination.marker });
/** One identity per REI account for saved runs and proofs: the saved reicid, else the top-bar business code. */
export const w1ReiAccountKey = (destination: W1Destination) => destination.urlValue || destination.marker;
const summary = (run: PortalRunResult): W1RunSummary => ({ outcome: run.outcome, ...(run.reason ? { reason: run.reason } : {}), ...(run.detail ? { detail: run.detail } : {}), receipt: run.receipt });

/** Validates the batch's own shape; throws a user-facing sentence. */
export function assertW1ReiBatch(batch: W1ReiBatch): void {
  if (typeof batch.batchId !== "string" || !batch.batchId || !Number.isSafeInteger(batch.version) || batch.version < 1) throw fail("This batch has no id or version.");
  if (!browserTaskUploadName(batch.artifact?.name) || !SHA256.test(batch.artifact?.sha256 ?? "")) throw fail("This batch has no reviewed file name and sha256.");
  if (batch.destination?.portal !== W1_REI_PORTAL || typeof batch.destination.marker !== "string" || !batch.destination.marker.trim() ||
      (batch.destination.urlValue !== undefined && (typeof batch.destination.urlValue !== "string" || !batch.destination.urlValue.trim()))) throw fail("This batch has no REI destination account.");
  if (typeof batch.bankFormat !== "string" || !batch.bankFormat.trim()) throw fail("This batch has no verified REI file format.");
  assertExpectedRows(batch.rows);
}

const totalCents = (batch: W1ReiBatch) => batch.rows.reduce((sum, row) => sum + row.amountCents, 0);
function previewRuns(batch: W1ReiBatch): PortalRunRequest[] {
  return [{ recipe: "open-session" }, { recipe: W1_PREVIEW_RECIPE, inputs: {
    bank_format: batch.bankFormat, approved_file: batch.artifact.name, approved_sha256: batch.artifact.sha256,
    expected_rows: String(batch.rows.length), expected_total: cents(totalCents(batch)) } }];
}

/** The Ask card for this batch's upload-and-preview task. */
export async function w1ReiPreviewProposal(batch: W1ReiBatch, input: { threadId: string; messageId: string }, load?: PackLoader): Promise<BrowserTaskProposal & { recipe: BrowserTaskRecipe }> {
  assertW1ReiBatch(batch);
  const inputs = previewRuns(batch)[1].inputs!;
  return portalRecipeTaskProposal({ ...input, portal: W1_REI_PORTAL, target: W1_PREVIEW_RECIPE, inputs, account: account(batch.destination),
    upload: { name: batch.artifact.name, sha256: batch.artifact.sha256 } }, load);
}

/** The sites and action classes a grant needs for the preview or the readback. */
export async function w1ReiGrantNeeds(stage: "preview" | "readback", load: PackLoader = loadPortalRecipePack): Promise<{ sites: string[]; actions: BrowserActionClass[] }> {
  const pack = await load(W1_REI_PORTAL);
  return portalRecipeGrantNeeds(pack, stage === "preview" ? [{ recipe: "open-session" }, { recipe: W1_PREVIEW_RECIPE }] : [{ recipe: "open-session" }, { recipe: W1_READBACK_RECIPE }]);
}

/** Destination and account binding shared by both stages: refused before any browser step. */
function bindingProblem(batch: W1ReiBatch, ctx: W1ReiContext, pack: PortalRecipePack): string | null {
  if (pack.portal !== batch.destination.portal) return "The portal recipes are not for this batch's destination.";
  if (ctx.grant.browser.accountMarker !== batch.destination.marker) return "This task's permission is not bound to the batch's REI account.";
  return null;
}

async function runWith(batch: W1ReiBatch, ctx: W1ReiContext, pack: PortalRecipePack, runs: PortalRunRequest[]): Promise<PortalRunResult> {
  return runPortalRecipes({
    pack, runs, account: account(batch.destination), grant: ctx.grant, threadId: ctx.threadId,
    runtime: ctx.runtime, approve: ctx.approve,
    ...(ctx.signal ? { signal: ctx.signal } : {}), ...(ctx.isActive ? { isActive: ctx.isActive } : {}), ...(ctx.workroom ? { workroom: ctx.workroom } : {}),
    ...(ctx.operations ? { operations: ctx.operations } : {}), ...(ctx.approvals ? { approvals: ctx.approvals } : {}), ...(ctx.rules ? { rules: ctx.rules } : {}),
    ...(ctx.assertCapability ? { assertCapability: ctx.assertCapability } : {}), ...(ctx.now ? { now: ctx.now } : {}), ...(ctx.pollMs !== undefined ? { pollMs: ctx.pollMs } : {}),
  });
}


export async function preview(batch: W1ReiBatch, ctx: W1ReiContext): Promise<W1PreviewOutcome> {
  assertW1ReiBatch(batch);
  const base = { kind: "w1-rei-preview" as const, batchId: batch.batchId, version: batch.version, artifactSha256: batch.artifact.sha256, stopBefore: [] as string[] };
  const held = (status: W1PreviewStatus, reason: string, detail: string, run?: PortalRunResult): W1PreviewOutcome => ({ ...base, status, reason, detail, ...(run ? { run: summary(run) } : {}) });
  const pack = await (ctx.load ?? loadPortalRecipePack)(W1_REI_PORTAL);
  const problem = bindingProblem(batch, ctx, pack);
  if (problem) return held("not-uploaded", "destination-not-bound", problem);
  // Exact artifact binding, checked again here and by the runner and broker at upload.
  const granted = ctx.grant.uploads.find(upload => upload.name === batch.artifact.name);
  if (!granted) return held("not-uploaded", "artifact-not-granted", "This task was not given the reviewed file.");
  if (granted.sha256 !== batch.artifact.sha256) return held("not-uploaded", "artifact-differs", "The file given to this task is not the reviewed version of this batch.");
  const workroom = ctx.workroom ?? browserTaskWorkroom(ctx.runtime.root, ctx.grant.id);
  try { await grantedUploadPath(workroom, granted); }
  catch (error) { return held("not-uploaded", "artifact-changed", error instanceof Error ? error.message : "The reviewed file changed."); }

  const run = await runWith(batch, { ...ctx, workroom }, pack, previewRuns(batch));
  const result = run.results.find(item => item.recipe === W1_PREVIEW_RECIPE);
  const dispatched = (run.receipt.tools.browser_upload ?? 0) > 0;
  if (run.outcome !== "completed" || !result || result.outcome !== "completed") {
    // Once the upload tool was called, only the person's refusal proves no file left RealBud:
    // anything else (lost reply, reload, sign-in, Stop, a later refusal) is unknown until the register is read.
    const unknown = run.reason === "unknown-result" || run.reason === "earlier-upload-unknown" || (dispatched && run.reason !== "not-approved");
    return held(unknown ? "unknown-upload" : "not-uploaded", run.reason ?? run.outcome, run.detail ?? "", run);
  }
  const reconciliation = reconcilePreview(batch.rows, result.rows, { flags: run.receipt.flags, previewComplete: result.table !== "unread" });
  return { ...base, status: reconciliation.ready ? "ready" : "mismatch", reconciliation, stopBefore: result.stopBefore, run: summary(run) };
}

/** The person's posting step. Bud prepares and verifies; it never presses these controls. */
export async function awaitPosting(batch: W1ReiBatch, outcome: W1PreviewOutcome, load: PackLoader = loadPortalRecipePack): Promise<W1PostingHandoff> {
  assertW1ReiBatch(batch);
  if (outcome.kind !== "w1-rei-preview" || outcome.batchId !== batch.batchId || outcome.version !== batch.version || outcome.artifactSha256 !== batch.artifact.sha256) {
    throw fail("This preview is for a different batch or file. Preview the reviewed batch again.");
  }
  if (outcome.status !== "ready" || !outcome.reconciliation?.ready) throw fail("The REI preview does not match the reviewed batch. Nothing is ready to post.");
  const pack = await load(W1_REI_PORTAL);
  const personActions = [...pack.recipes[W1_PREVIEW_RECIPE].stopBefore];
  const total = totalCents(batch);
  return {
    kind: "w1-rei-posting-handoff", batchId: batch.batchId, version: batch.version, artifact: { ...batch.artifact },
    destination: account(batch.destination), rows: batch.rows.length, totalCents: total, personActions,
    message: `The REI preview for ${batch.destination.marker} matches the reviewed file ${batch.artifact.name}: ${batch.rows.length} row${batch.rows.length === 1 ? "" : "s"}, ${cents(total)}. Posting is yours: check the preview in REI and use ${personActions[0]} there yourself. Bud does not press ${personActions.join(", ")}. Tell RealBud when you have finished, and it will read the Receipt Register back.`,
  };
}

type RegisterRead = { ok: true; lines: string[][]; evidence: W1RegisterEvidence; run: PortalRunResult } | { ok: false; reason: string; detail: string; run?: PortalRunResult };
/** REI's export names no business code or period. The runner's receipt shows the recipe's own account checks (each one
 * throws on another account) before and after the download; the period is the one the recipe was asked to export.
 * ponytail: the runner should return the period REI actually applied (and parse the CSV's quoted fields itself);
 * until it does, exportPeriod is the requested range and registerRows rejoins comma-split quoted cells. */
export function w1RegisterEvidence(batch: W1ReiBatch, run: PortalRunResult, range: W1DateWindow): W1RegisterEvidence {
  const steps = run.receipt.steps.filter(step => step.recipe === W1_READBACK_RECIPE);
  const download = steps.findIndex(step => step.verb === "download" && step.ok);
  const checked = (list: typeof steps) => list.some(step => step.verb === "check" && step.target === "account" && step.ok);
  return { pageScope: { marker: batch.destination.marker, checkedBefore: download >= 0 && checked(steps.slice(0, download)), checkedAfter: download >= 0 && checked(steps.slice(download + 1)) },
    exportPeriod: { ...range } };
}
async function readRegister(batch: W1ReiBatch, ctx: W1ReiContext, range: W1DateWindow): Promise<RegisterRead> {
  if (isoDate(range.from) !== range.from || isoDate(range.to) !== range.to || range.from > range.to) throw fail("Choose the Receipt Register dates to read back.");
  const pack = await (ctx.load ?? loadPortalRecipePack)(W1_REI_PORTAL);
  const problem = bindingProblem(batch, ctx, pack);
  if (problem) return { ok: false, reason: "destination-not-bound", detail: problem };
  const run = await runWith(batch, ctx, pack, [{ recipe: "open-session" }, { recipe: W1_READBACK_RECIPE, inputs: { date_from: range.from, date_to: range.to } }]);
  const result = run.results.find(item => item.recipe === W1_READBACK_RECIPE);
  if (run.outcome !== "completed" || !result?.download) return { ok: false, reason: run.reason ?? (result?.download ? run.outcome : "no-register-file"), detail: run.detail ?? "", run };
  if (!result.download.rows.length) return { ok: false, reason: "register-unreadable", detail: "The Receipt Register export could not be read as text.", run };
  return { ok: true, lines: result.download.rows, evidence: w1RegisterEvidence(batch, run, range), run };
}

/** Before the upload: the register as it stands, so a later readback counts only new receipts. */
export async function captureBaseline(batch: W1ReiBatch, ctx: W1ReiContext, range: W1DateWindow): Promise<W1BaselineOutcome> {
  assertW1ReiBatch(batch);
  const base = { kind: "w1-rei-baseline-outcome" as const, batchId: batch.batchId, version: batch.version };
  const read = await readRegister(batch, ctx, range);
  if (!read.ok) return { ...base, status: "not-read", reason: read.reason, detail: read.detail, ...(read.run ? { run: summary(read.run) } : {}) };
  try { return { ...base, status: "read", baseline: registerBaseline(read.lines, batch.destination, range, read.evidence), run: summary(read.run) }; }
  catch (error) { return { ...base, status: "not-read", reason: "register-incomplete", detail: error instanceof Error ? error.message : "", run: summary(read.run) }; }
}

export async function readback(batch: W1ReiBatch, ctx: W1ReiContext, range: W1DateWindow, baseline?: W1RegisterBaseline): Promise<W1ReadbackOutcome> {
  assertW1ReiBatch(batch);
  const base = { kind: "w1-rei-readback-outcome" as const, batchId: batch.batchId, version: batch.version, artifactSha256: batch.artifact.sha256 };
  const read = await readRegister(batch, ctx, range);
  if (!read.ok) return { ...base, status: "not-read", reason: read.reason, detail: read.detail, ...(read.run ? { run: summary(read.run) } : {}) };
  return { ...base, status: "read", readback: classifyReadback(batch.rows, read.lines, batch.destination, { window: range, ...read.evidence, ...(baseline ? { baseline } : {}) }), run: summary(read.run) };
}

/** Issues the proof confirm-import requires; throws unless this readback completed this exact batch. */
export function w1ImportProof(batch: W1ReiBatch, outcome: W1ReadbackOutcome): W1ImportProof {
  assertW1ReiBatch(batch);
  if (outcome.kind !== "w1-rei-readback-outcome" || outcome.batchId !== batch.batchId || outcome.version !== batch.version || outcome.artifactSha256 !== batch.artifact.sha256)
    throw fail("This readback is for a different batch or file.");
  if (outcome.status !== "read" || !outcome.readback?.complete || outcome.readback.scope !== "verified" || outcome.readback.accepted !== batch.rows.length)
    throw fail("REI's Receipt Register does not show every row of this batch accepted. Nothing is confirmed.");
  return { kind: "w1-rei-import-proof", batchId: batch.batchId, version: batch.version, artifactSha256: batch.artifact.sha256,
    destination: { portal: W1_REI_PORTAL, ...account(batch.destination) }, rowIds: batch.rows.map(row => row.rowId) };
}

// ── what may happen next, from the caller's saved events ─────────────────
export type W1ReiEvent =
  | { kind: "preview"; status: W1PreviewStatus }
  | { kind: "posting-reported"; posted: boolean }
  /** registerComplete/absent come from W1Readback; missing means not proven. */
  | { kind: "readback"; complete: boolean; accepted: number; rejected: number; pending: number; registerComplete?: boolean; absent?: boolean }
  /** A read of REI's pending (unposted) imports for the destination; null when it could not tell. */
  | { kind: "pending-inspection"; pending: number | null }
  /** The person chose to preview again after a readback found nothing of this batch in REI. */
  | { kind: "retry-approved" };
export type W1ReiStep = "preview" | "await-posting" | "readback" | "done" | "hold";

/** The saved event for a readback outcome. */
export function w1ReadbackEvent(outcome: W1ReadbackOutcome): Extract<W1ReiEvent, { kind: "readback" }> {
  const read = outcome.readback;
  if (outcome.status !== "read" || !read) return { kind: "readback", complete: false, accepted: 0, rejected: 0, pending: 0, registerComplete: false, absent: false };
  return { kind: "readback", complete: read.complete, accepted: read.accepted, rejected: read.rejected, pending: read.pending, registerComplete: read.registerComplete, absent: read.absent };
}

export function nextReiStep(events: readonly W1ReiEvent[]): { step: W1ReiStep; uploadAllowed: boolean; reason: string } {
  const say = (step: W1ReiStep, reason: string) => ({ step, uploadAllowed: step === "preview", reason });
  // Anything of this batch already in the register: never upload it again.
  const readbacks = events.filter((event): event is Extract<W1ReiEvent, { kind: "readback" }> => event.kind === "readback");
  if (readbacks.some(event => event.complete)) return say("done", "REI's register shows every row of this batch.");
  if (readbacks.some(event => event.accepted > 0 || event.rejected > 0)) return say("hold", "Part of this batch is already in REI. The person resolves the rest there; Bud will not upload it again.");
  const last = events[events.length - 1];
  if (!last) return say("preview", "Nothing has been uploaded for this batch.");
  const lastUpload = events.map(event => event.kind === "preview" ? event.status : null).filter(status => status !== null && status !== "not-uploaded").pop();
  switch (last.kind) {
    case "preview":
      if (last.status === "ready") return say("await-posting", "The preview matches; posting is the person's.");
      if (last.status === "mismatch") return say("hold", "The preview does not match the reviewed batch. Bud will not upload it again to try.");
      if (last.status === "unknown-upload") return say("readback", "An upload's result is unknown. Read the Receipt Register before anything else.");
      return lastUpload ? say("readback", "An earlier upload of this batch is not settled.") : say("preview", "Nothing left RealBud; the preview can run again.");
    case "posting-reported":
      return say("readback", "Read the Receipt Register to confirm what REI accepted.");
    case "readback":
    case "pending-inspection":
      return events.some(event => event.kind === "posting-reported")
        ? say("readback", "REI shows nothing of this batch yet. Check the posting in REI, then read back again.")
        : say("hold", "REI shows nothing of this batch. The person decides whether to preview it again.");
    case "retry-approved": {
      // Proven absence: the latest readback is a complete, account-scoped register with nothing of this batch,
      // and a later pending-import inspection shows nothing pending. Anything less stays at checking the outcome.
      const at = events.length - 1;
      const readIndex = events.findLastIndex(event => event.kind === "readback");
      const read = readIndex < 0 ? undefined : events[readIndex] as Extract<W1ReiEvent, { kind: "readback" }>;
      const inspection = events.slice(readIndex + 1, at).findLast((event): event is Extract<W1ReiEvent, { kind: "pending-inspection" }> => event.kind === "pending-inspection");
      if (!read || read.accepted !== 0 || read.rejected !== 0 || read.registerComplete !== true || read.absent !== true)
        return say("readback", "A new preview needs a complete Receipt Register for this account showing nothing of this batch.");
      if (!inspection || inspection.pending !== 0)
        return say("readback", "A new preview needs REI's pending imports checked and empty first.");
      return say("preview", "The person chose to preview again after REI showed nothing of this batch and nothing pending.");
    }
  }
}

/** sha256 of exact bytes, for callers binding a reviewed file. */
export const w1ArtifactSha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
