// W1 host wiring: the durable run (w1-workflow.ts) over the office's Redbark
// pull and review store (the bank source) and over REI through the portal
// recipe runner (w1-rei-workflow.ts), plus the /api/w1 routes and the
// bank-references loop runner. index.ts applies the session gate and the JSON
// content-type rule before handing over here.
//
// Authority stays where it is: the host issues each REI grant itself, bound to
// the selected browser, the saved REI account marker and (for the preview)
// exactly one reviewed file {name, sha256}. The runner's broker still asks the
// person once for the upload and for the register download; those asks are
// answered only through POST /api/w1/runs/:id/answer. Bud never posts: the
// person processes the receipts in REI and reports it. The clock (runLoop)
// pulls, waits for review, and once the review is done waits on REI's sign-in
// page until the end of the office day (owner decision, 6 Oct 2026;
// server/w1-sign-in-wait.ts), then carries on to the upload ask by itself.
//
// Every REI stage refuses while a saved sign-in handover holds (the same hold
// Ask's browser tasks respect) and takes the run's AbortSignal: POST
// /api/w1/runs/:id/stop ends the stage in flight through the runner's Stop
// (broker closed, open ask declined) and refuses further stages of that advance.
// Before a re-upload is offered, inspect reads REI's pending imports as well as
// the register. A loaded-but-unprocessed import sits on Bulk Receipting
// (/customers/importbanklink/index), never on Pending Transactions (pending
// payments, whose Process/Delete Bud never presses). How live REI lists a
// pending import there is unobserved: without the pack recipe the inspection
// is "unknown" and no re-upload is offered.
//
// REI account: REI reads the office's ANZ export natively (File Format
// "ANZ(csv file)", the office default), so that is the default format. After
// sign-in REI's addresses carry no reicid; the top-bar business code is the
// account and the reicid is optional (kept when an office saved one).
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { HumanHandoffs } from "./human-handoffs.ts";
import { workflowDatabase } from "./workflow-services.ts";
import { join } from "node:path";
import { bankNotConnected, providerClient, type BankProvider } from "./bank-provider.ts";
import { sameW1Destination, type BankReferenceStore, type RedbarkCoverage } from "./bank-reference-store.ts";
import { addBrowserTaskUpload, browserTaskWorkroom } from "./browser-runtime.ts";
import type { BrowserSessionRuntime } from "./browser-session.ts";
import { answerPortalRecipeAsk, loadPortalRecipePack, portalRecipeApprovalChannel, type PackLoader } from "./portal-recipe-task.ts";
import { portalRecipeGrantNeeds, runPortalRecipes } from "./portal-recipe-runner.ts";
import { readPrivateJson, writePrivateJson } from "./private-json.ts";
import { isFresh, REI_FRESH_MS } from "./source-gate.ts";
import { pullRedbarkReview } from "./redbark-source.ts";
import { amountCents, isoDate, reconcilePreview, type W1PreviewReconciliation, type W1RegisterBaseline } from "./w1-rei-reconciliation.ts";
import { assertW1ReiBatch, awaitPosting, captureBaseline, preview, readback, W1_REI_PORTAL, w1ImportProof, w1ReiAccountKey, w1ReiGrantNeeds, type W1ImportProof, type W1PreviewOutcome, type W1ReiBatch, type W1ReiContext } from "./w1-rei-workflow.ts";
import { isActive, serializeFile, W1StateStore, W1_DESTINATION, type W1Preview, type W1ReadbackFound, type W1Run } from "./w1-state.ts";
import { createW1Workflow, type W1BankSource, type W1Inspection, type W1ReiBridge, type W1Readback, type W1Session } from "./w1-workflow.ts";
import { reiSignInWaits, withReiSignInWait, type ReiWaitCopy } from "./w1-sign-in-wait.ts";
import { REDBARK_ACCOUNT_ID } from "../shared/bank-source.ts";
import { bankReviewVersion } from "../shared/bank-review.ts";
import { parseBrowserTaskGrant, type BrowserTaskGrant, type BrowserTaskUpload } from "../shared/browser-task.ts";

const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };
const message = (error: unknown) => error instanceof Error ? error.message : "Something went wrong.";
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: unknown, allowed: string[]): v is Record<string, unknown> => object(v) && Object.keys(v).sort().join(",") === [...allowed].sort().join(",");
const plain = (v: unknown, max: number): v is string => typeof v === "string" && v.trim() === v && v.length > 0 && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const money = (cents: number) => (cents / 100).toFixed(2);
/** Review rows carry "redbark:<transaction id>"; the run keys on the bank's transaction id. */
const txid = (rowId: string) => rowId.replace(/^redbark:/, "");

// ── office settings: which bank account feeds which REI account ────────────
/** `rei.marker`: the business code in REI's top bar (the account scope). `rei.urlValue`: a reicid, only when the office saved one. */
export interface W1Settings { version: 1; kind: "w1-settings"; account: string; rei: { urlValue?: string; marker: string }; bankFormat: string; revision: number; savedAt: string }
/** REI's Bulk Receipting File Format for the office's ANZ export (the office default on that page). */
export const W1_DEFAULT_BANK_FORMAT = "ANZ(csv file)";
/** The run's destination: the saved reicid, else the top-bar business code. */
const destinationOf = (office: W1Settings) => w1ReiAccountKey(office.rei);
const settingsPath = (dataDir: string) => join(dataDir, "w1", "settings.json");
function validSettings(v: unknown): W1Settings {
  if (!keys(v, ["version", "kind", "account", "rei", "bankFormat", "revision", "savedAt"]) || v.version !== 1 || v.kind !== "w1-settings" ||
      typeof v.account !== "string" || !REDBARK_ACCOUNT_ID.test(v.account) || !(keys(v.rei, ["marker"]) || keys(v.rei, ["urlValue", "marker"])) ||
      (v.rei.urlValue !== undefined && (typeof v.rei.urlValue !== "string" || !W1_DESTINATION.test(v.rei.urlValue))) || !plain(v.rei.marker, 100) ||
      !W1_DESTINATION.test(w1ReiAccountKey(v.rei as W1Settings["rei"])) || !plain(v.bankFormat, 100) ||
      !Number.isSafeInteger(v.revision) || Number(v.revision) < 1 || typeof v.savedAt !== "string") {
    return fail(503, "The saved bank import settings need recovery. Nothing was changed.");
  }
  return v as unknown as W1Settings;
}
export async function readW1Settings(dataDir: string): Promise<W1Settings | null> {
  const saved = await readPrivateJson(settingsPath(dataDir));
  return saved === undefined ? null : validSettings(saved);
}

export interface W1HostDeps {
  dataDir: string;
  /** The office's bank feed (the Redbark MCP connection), or null while it is not connected. */
  provider: () => BankProvider | null;
  coverage: RedbarkCoverage;
  store: () => BankReferenceStore;
  /** Office-local calendar date. */
  today: () => Promise<string>;
  /** The saved REI tenant directory (server/tenant-directory.ts) a batch's tenants come from, or null before the first save. */
  tenantDirectory: () => { checkedAt?: number; savedAt?: number; hash?: string } | null;
  /** index.ts passes the shared browserRuntime, whose connect() opens the work browser at a cold start. */
  runtime: BrowserSessionRuntime & { connect?: () => Promise<unknown> };
  /** The selected browser when it is ready, else null. */
  browserId: () => Promise<string | null>;
  load?: PackLoader;
  /** Called when the office saves or clears its settings (the loop's opt-in). */
  onSettings?: (settings: W1Settings | null) => void;
  /** True while a saved sign-in handover holds browser work (default: the shared human-handoffs record, as Ask checks). */
  signInHolding?: () => boolean;
  /** Opens the work browser at the site's sign-in page for the person and resolves when they are done (server/browser-sign-in.ts). Without it, sign-in stays a stop with a message. */
  openForSignIn?: (input: { site: string; url?: string; reason: string; signal?: AbortSignal; account?: string; threadId?: string; until?: number }) => Promise<{ outcome: "signed_in" | "stopped" | "timed_out" | "wrong_account"; origin: string }>;
  /** Test lab hooks (server/testing/w1-lab.ts); null in production. Its openForSignIn, once the lab turns it on, stands in for the one above. */
  lab?: { handle(body: unknown): Promise<unknown>; openForSignIn?: W1HostDeps["openForSignIn"] } | null;
  pollMs?: number;
  /** The office timezone for a scheduled sign-in wait's deadline (undefined: this computer's). */
  timeZone?: () => Promise<string | undefined>;
  /** The clock for a scheduled sign-in wait (the lab moves it). */
  now?: () => number;
  /** How often a scheduled sign-in wait checks for its midday reminder. */
  waitPollMs?: number;
}

type Ask = { requestId: string; tool: string; summary: string; at: string };
/** `unattended`: a loop run, which waits on REI's sign-in page until the office day ends; `note` tells its Schedule row what it waits for. */
type RunContext = { runId: string; unattended: boolean; signal: AbortSignal; note?: (detail: string) => void };
/** The read-only pending-import recipe. Only the fictional pack has it so far (see the header). */
const PENDING_RECIPE = "bulk-receipting-pending";
const BULK_RECEIPTING_ROUTE = "/customers/importbanklink/index";
const PENDING_HANDOFF = "Your earlier upload is waiting in REI. Process or delete it there.";
const STOPPED = "Stopped. Bud did nothing more in REI. Check the import before continuing.";
const LIST_CHANGED = "The REI tenant list changed since this batch was prepared. Prepare it again.";
const SIGN_IN_HOLD = "Finish the saved sign-in handover before starting more browser work.";
const WAIT_COPY = (until: string): ReiWaitCopy => ({
  first: `Sign in to REI Cloud so Bud can finish the bank import. REI's sign-in page is open in the work browser; Bud carries on by itself once you're signed in (waiting until ${until}).`,
  reminder: `Reminder: sign in to REI Cloud so Bud can finish the bank import. Bud waits until ${until}, then the next scheduled run tries again.` });
export const W1_MISSED = "Missed: REI Cloud wasn't signed in today, so the bank import is waiting. The next scheduled run tries again.";
const ASK_LINE: Record<string, string> = { browser_upload: "Waiting for your approval to upload the reviewed bank file to REI", browser_download: "Waiting for you to allow the download of REI's Receipt Register" };
const NO_BROWSER = "The work browser could not be opened. Check that Chrome or Edge is installed, then try again.";
/** The hold check only lists saved handoffs; it never releases or verifies anything. */
const readOnly = async (): Promise<never> => { throw new Error("Read-only sign-in hold check."); };
const NO_HANDOFF_HOST = { release: readOnly, verify: readOnly };

export function createW1Host(deps: W1HostDeps) {
  const store = new W1StateStore(deps.dataDir);
  const load = deps.load ?? loadPortalRecipePack;
  const context = new AsyncLocalStorage<RunContext>();
  /** Per-run facts shown beside the saved run. In memory only: after a restart
   * the saved run alone decides what happens next. */
  const notes = new Map<string, string>();
  const asks = new Map<string, Ask>();
  const readbacks = new Map<string, { accepted: number; rejected: number; pending: number; warnings: string[] }>();
  const handoffs = new Map<string, string>();
  const previews = new Map<string, { batch: W1ReiBatch; outcome: W1PreviewOutcome }>();
  const working = new Map<string, Promise<void>>();
  /** The Stop for each advance in flight. */
  const stops = new Map<string, AbortController>();
  /** Attempts whose file REI shows pending and unposted (found by inspect). */
  const pendingFound = new Set<string>();
  /** Attempts refused before sending because the saved REI tenant list changed since the batch was built (this process only). */
  const listChanged = new Set<string>();
  /** Runs waiting for the person to sign in to REI → the handover's thread (GET /api/browser/sign-in?threadId=…). */
  const signingIn = new Map<string, string>();
  const signInHolding = deps.signInHolding ?? (() => new HumanHandoffs(workflowDatabase(), NO_HANDOFF_HOST).isHolding());
  const waits = reiSignInWaits(deps.dataDir), now = deps.now ?? Date.now;
  let today = "";
  const note = (text: string) => { const ctx = context.getStore(); if (ctx) notes.set(ctx.runId, text.slice(0, 600)); };

  // ── host-owned records: pre-upload register baselines and import proofs ──
  // Private 0600 JSON beside the runs. A proof exists only after a complete,
  // attributed readback (w1ImportProof); confirm-import refuses without it.
  const saved_ = (() => {
    const path = join(deps.dataDir, "w1", "evidence.json");
    type Evidence = { version: 1; kind: "w1-evidence"; baselines: Record<string, W1RegisterBaseline>; proofs: Record<string, W1ImportProof> };
    const read = async (): Promise<Evidence> => {
      const value = await readPrivateJson(path, 4_000_000);
      if (value === undefined) return { version: 1, kind: "w1-evidence", baselines: {}, proofs: {} };
      if (!keys(value, ["version", "kind", "baselines", "proofs"]) || value.version !== 1 || value.kind !== "w1-evidence" || !object(value.baselines) || !object(value.proofs))
        return fail(503, "The saved bank import evidence needs recovery. Nothing was changed.");
      return value as unknown as Evidence;
    };
    const write = (change: (file: Evidence) => void) => serializeFile(path, async () => { const file = await read(); change(file); await writePrivateJson(path, file, { maxBytes: 4_000_000, validate: () => {} }); });
    return {
      baseline: async (attemptId: string) => (await read()).baselines[attemptId] ?? null,
      proof: async (batchId: string) => (await read()).proofs[batchId] ?? null,
      saveBaseline: (attemptId: string, baseline: W1RegisterBaseline) => write(file => { file.baselines[attemptId] = baseline; }),
      saveProof: (proof: W1ImportProof) => write(file => { file.proofs[proof.batchId] = proof; }),
    };
  })();
  /** A batch's proof, only while it names the saved REI account (same business code and reicid or none). */
  const currentProof = async (batchId: string) => {
    const [proof, office] = await Promise.all([saved_.proof(batchId), readW1Settings(deps.dataDir)]);
    return proof && office && sameW1Destination(proof.destination, office.rei) ? proof : null;
  };

  // ── bank source over the provider's pull and the review store ──
  const provider = () => deps.provider() ?? (() => { throw bankNotConnected(); })();
  const provenanceIds = (bank: BankReferenceStore, batchId: string): string[] => {
    const ids = bank.get(batchId).value.batch.source?.provenance?.transactionIds;
    return ids ? [...ids] : fail(409, "This review did not come from the bank feed.");
  };
  const newest = (bank: BankReferenceStore, batchId: string) => {
    let saved = bank.get(batchId);
    for (let guard = 0; saved.value.supersededBy && guard < 1000; guard++) saved = bank.get(saved.value.supersededBy.id);
    return saved;
  };
  const source: W1BankSource = {
    async pull({ account, today: day }) {
      const bank = deps.store();
      try {
        const summary = await pullRedbarkReview({ client: providerClient(provider()), store: bank, coverage: deps.coverage, account, today: day, rules: bank.settings()?.rules ?? [] });
        return { window: summary.window, coverageRevision: summary.coverage.revision,
          batch: summary.batch ? { id: summary.batch.id, transactionIds: provenanceIds(bank, summary.batch.id) } : null };
      } catch (error) { note(message(error)); throw error; }
    },
    /** The run's file is the REI import file (import rows only); held and
     * excluded rows are listed beside it and never sent to REI. */
    async reviewed(batchId) {
      const bank = deps.store(), saved = newest(bank, batchId);
      if (!saved.value.result) return null;
      const file = bank.importArtifact(saved.id), ids = provenanceIds(bank, saved.id);
      const of = (disposition: string) => file.rows.flatMap((row, index) => row.disposition === disposition ? [ids[index]] : []);
      // No import rows: no file; the run stops before REI (nothing_to_import).
      return { batchId: saved.id, outputDigest: file.artifact?.digest ?? "0".repeat(64), importIds: of("import"), heldIds: of("hold"), excludedIds: of("exclude") };
    },
    async confirmImport({ batchId, expectedCoverageRevision }) {
      const result = await deps.store().confirmRedbarkImport(deps.coverage, batchId, expectedCoverageRevision, await currentProof(batchId));
      return { coveredThrough: result.coveredThrough, revision: result.revision, reused: result.reused };
    },
  };

  // ── REI over the portal recipe runner ──
  const settings = async () => (await readW1Settings(deps.dataDir)) ?? fail(409, "Choose the bank account and REI account for bank imports first.");
  const runFor = async (attemptId: string) => (await store.list()).find(run => run.upload?.attemptId === attemptId) ?? fail(404, "That upload is not part of a saved bank import.");
  /** The REI import file and its rows, exactly as reviewed. Throws a sentence when REI receipting cannot take it.
   * `sending`: the file is about to go to REI, so its tenants must still be the saved list's. */
  async function batchFor(batchId: string, artifactDigest: string, destination: string, sending = false): Promise<{ batch: W1ReiBatch; bytes: Buffer }> {
    const office = await settings();
    if (destinationOf(office) !== destination) fail(409, "The saved REI account changed since this import started. Close it and start again.");
    const bank = deps.store(), file = bank.importArtifact(batchId);
    // Gate on the list W1 actually reads (recorded when the batch was made): any import row whose tenant came from the saved
    // REI tenant list (alone or mixed with the office's rules), or an unrecorded source, needs that list under a day old.
    // A batch whose tenants all come from the office's own rules is not gated on REI. No stamp is stale. The current list's
    // last complete REI check (else its save) is used, so a refresh, even one that finds no change, unblocks a run.
    // Before sending, the list must also be the one the batch was built from (old batches carry no hash).
    // (Desk's src-rei-tenants is stamped by a different read.)
    const source = bank.tenantSource(batchId);
    const fromDirectory = !source || (source.source === "rei-directory" && file.rows.some(row => row.disposition === "import" && row.propertyId !== undefined && source.propertyIds.includes(row.propertyId)));
    if (fromDirectory) {
      const list = deps.tenantDirectory(), checkedAt = list?.checkedAt ?? list?.savedAt;
      if (typeof checkedAt !== "number" || !isFresh(checkedAt, REI_FRESH_MS, now())) fail(409, "Refresh REI tenants first.");
      if (sending && source?.source === "rei-directory" && source.hash !== undefined && list?.hash !== source.hash) fail(409, LIST_CHANGED);
    }
    if (!file.artifact || file.artifact.digest !== artifactDigest) fail(409, "The reviewed import file changed. Nothing was uploaded.");
    const problems: string[] = [];
    const rows = file.rows.flatMap(row => {
      if (row.disposition !== "import") return [];
      const expected = { rowId: row.rowId, date: isoDate(row.date) ?? "", reference: row.reference.trim(), amountCents: amountCents(row.amount) ?? 0, tenant: row.tenant ?? "" };
      if (!expected.tenant) problems.push(`${row.date} ${row.amount} (${row.propertyId ?? "no property"}) has no REI tenant in the property directory`);
      return [expected];
    });
    if (problems.length) fail(409, `Nothing was uploaded: ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? ` and ${problems.length - 3} more` : ""}. Add each property's REI tenant to the property directory and review again.`);
    const batch: W1ReiBatch = { batchId, version: bankReviewVersion(batchId), artifact: { name: `REI-import-${file.artifact!.digest.slice(0, 12)}.csv`, sha256: file.artifact!.digest },
      destination: { portal: W1_REI_PORTAL, ...(office.rei.urlValue ? { urlValue: office.rei.urlValue } : {}), marker: office.rei.marker }, bankFormat: office.bankFormat, rows };
    assertW1ReiBatch(batch);
    return { bytes: Buffer.from(file.artifact!.bytesBase64, "base64"), batch };
  }
  const windowFor = (batch: W1ReiBatch) => ({ from: batch.rows.map(row => row.date).sort()[0], to: today });
  /** A host-issued grant for one stage: exact sites and actions from the pack, the selected browser and REI account, at most the one reviewed file. */
  async function context_(stage: "session" | "preview" | "readback" | "pending", marker: string, upload?: { name: string; bytes: Buffer }): Promise<W1ReiContext> {
    const ctx = context.getStore();
    if (!ctx) return fail(500, "The bank import step ran outside its run.");
    if (ctx.signal.aborted) return fail(409, STOPPED);
    // Credentials and MFA stay with the person: no REI stage starts while a sign-in handover holds.
    if (signInHolding()) return fail(409, SIGN_IN_HOLD);
    const browserId = await deps.browserId();
    if (!browserId) return fail(409, "Connect your browser before Bud checks REI.");
    const needs = stage === "session" || stage === "pending" ? portalRecipeGrantNeeds(await load(W1_REI_PORTAL), [{ recipe: "open-session" }, ...(stage === "pending" ? [{ recipe: PENDING_RECIPE }] : [])]) : await w1ReiGrantNeeds(stage, load);
    const id = randomUUID(), workroom = browserTaskWorkroom(deps.runtime.root, id);
    const uploads: BrowserTaskUpload[] = upload ? [await addBrowserTaskUpload(workroom, upload.name, upload.bytes)] : [];
    const text = stage === "preview"
      ? `Bank import: upload only the reviewed file ${upload!.name} to REI for ${marker} after your approval, then read the preview. Posting stays with you.`
      : stage === "readback" ? `Bank import: read REI's Receipt Register for ${marker} to check what was receipted.`
      : stage === "pending" ? `Bank import: read REI's pending bank imports for ${marker}. Nothing is uploaded or processed.` : `Bank import: check REI is signed in to ${marker}.`;
    const grant: BrowserTaskGrant = parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id, runId: `w1-${ctx.runId}`, route: "schedule",
      request: { text, sha256: createHash("sha256").update(text).digest("hex") }, sites: needs.sites, browser: { id: browserId, accountMarker: marker },
      actions: needs.actions, consequential: "ask-each", uploads, expiresAt: Date.now() + 30 * 60_000, budget: null });
    const approve = portalRecipeApprovalChannel(`w1:${ctx.runId}`, ask => { asks.set(ctx.runId, { requestId: ask.requestId, tool: ask.tool, summary: ask.summary.slice(0, 600), at: new Date().toISOString() });
      ctx.note?.(`${ASK_LINE[ask.tool] ?? "Waiting for you to allow a step in REI"}. Answer in Schedule → Bank reference review.`); },
      requestId => { if (asks.get(ctx.runId)?.requestId === requestId) asks.delete(ctx.runId); });
    return { grant, runtime: deps.runtime, threadId: `w1-${ctx.runId}-${id}`, approve, workroom, load, signal: ctx.signal, ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}) };
  }
  /** REI's view of an upload as a run preview: matched rows included, any difference a warning. */
  function previewOf(attemptId: string, destination: string, artifactDigest: string, rec: W1PreviewReconciliation, ready: boolean): W1Preview {
    const warnings = ready ? [] : [
      ...rec.mismatched.map(item => `${item.expected.reference} ${money(item.expected.amountCents)}: REI shows a different ${item.fields.join(" and ")}.`),
      ...rec.missing.map(row => `${row.reference} ${money(row.amountCents)} on ${row.date} is missing from REI's preview.`),
      ...rec.extra.map(row => `REI's preview has an extra row: ${row.reference || "no reference"}${row.amountCents === null ? "" : ` ${money(row.amountCents)}`}.`),
      ...rec.warnings.map(item => item.message),
    ].map(text => text.slice(0, 1000)).slice(0, 500);
    return { previewId: `rei-preview:${attemptId}`, destination, artifactDigest, warnings: warnings.length || ready ? warnings : ["REI's preview does not match the reviewed file."],
      rows: [...rec.matched.map(item => ({ transactionId: txid(item.expected.rowId), included: true })), ...rec.mismatched.map(item => ({ transactionId: txid(item.expected.rowId), included: false }))] };
  }
  /** Read-only: REI's pending bank file for the account. Our file, row for row → its preview; anything else pending → pending_other; none → nothing. */
  async function pendingImport(attemptId: string, destination: string, artifactDigest: string): Promise<W1Inspection> {
    const pack = await load(W1_REI_PORTAL);
    if (!pack.recipes[PENDING_RECIPE]) { note("RealBud cannot read REI's pending bank imports yet. Check Receipts › Bulk receipting in REI before uploading again."); return { kind: "unknown" }; }
    // A pending import is read on Bulk Receipting only: Pending Transactions lists payments, not imports.
    const pages = pack.recipes[PENDING_RECIPE].steps.flatMap(step => Array.isArray(step.nav) ? [pack.routes[step.nav.join(" › ")]] : []);
    if (!pages.length || pages.some(route => route !== BULK_RECEIPTING_ROUTE)) { note("RealBud's pending-import check does not open REI's Bulk Receipting page. Check Receipts › Bulk receipting in REI before uploading again."); return { kind: "unknown" }; }
    const run = await runFor(attemptId);
    const { batch } = await batchFor(run.upload!.batchId, artifactDigest, destination);
    const ctx = await context_("pending", batch.destination.marker);
    const read = await runPortalRecipes({ pack, runs: [{ recipe: "open-session" }, { recipe: PENDING_RECIPE }], account: { urlValue: batch.destination.urlValue, marker: batch.destination.marker },
      grant: ctx.grant, threadId: ctx.threadId, runtime: ctx.runtime, approve: ctx.approve, workroom: ctx.workroom, signal: ctx.signal, ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}) });
    const result = read.results.find(item => item.recipe === PENDING_RECIPE);
    if (read.outcome !== "completed" || !result || result.table === "unread") { note(`REI's pending bank imports could not be read${read.detail ? `: ${read.detail}` : "."}`); return { kind: "unknown" }; }
    if (result.table === "empty") return { kind: "nothing" };
    const rec = reconcilePreview(batch.rows, result.rows, { flags: read.receipt.flags, previewComplete: true });
    if (!rec.ready) return { kind: "pending_other" };
    pendingFound.add(attemptId);
    return { kind: "preview", preview: previewOf(attemptId, destination, artifactDigest, rec, true) };
  }
  /** Readback rows for the run. null means REI's complete register proves nothing of the batch arrived; unverified or unattributed reads throw. */
  async function register(attemptId: string, destination: string, artifactDigest: string): Promise<W1ReadbackFound | null> {
    const run = await runFor(attemptId);
    const { batch } = await batchFor(run.upload!.batchId, artifactDigest, destination);
    const baseline = await saved_.baseline(attemptId);
    const window = { from: baseline?.window.from ?? windowFor(batch).from, to: today };
    const result = await readback(batch, await context_("readback", batch.destination.marker), window, baseline ?? undefined);
    if (result.status !== "read" || !result.readback) return fail(502, `REI's Receipt Register could not be read${result.detail ? `: ${result.detail}` : "."}`);
    const found = result.readback;
    readbacks.set(run.id, { accepted: found.accepted, rejected: found.rejected, pending: found.pending, warnings: found.warnings.map(w => w.message).slice(0, 20) });
    if (found.complete) await saved_.saveProof(w1ImportProof(batch, result));
    if (found.scope !== "verified" || !found.registerComplete) return fail(502, found.warnings[0]?.message ?? "REI's Receipt Register could not be checked for the selected account. Nothing was confirmed.");
    if (found.absent) return null;
    // Only a complete, attributed readback may count a row as accepted.
    const status = (outcome: "accepted" | "rejected" | "pending") => outcome === "accepted" && !found.complete ? "pending" : outcome;
    return { kind: "found", importRef: `rei-register:${window.from}:${window.to}`, destination, artifactDigest,
      rows: found.outcomes.map(item => ({ transactionId: txid(item.rowId), status: status(item.outcome) })) };
  }
  const rei: W1ReiBridge = {
    async session({ destination }) {
      const office = await settings();
      if (destinationOf(office) !== destination) return { kind: "wrong_account" };
      const check = async (): Promise<W1Session> => {
        const ctx = await context_("session", office.rei.marker);
        const run = await runPortalRecipes({ pack: await load(W1_REI_PORTAL), runs: [{ recipe: "open-session" }], account: office.rei, grant: ctx.grant,
          threadId: ctx.threadId, runtime: ctx.runtime, approve: ctx.approve, workroom: ctx.workroom, signal: ctx.signal, ...(deps.pollMs !== undefined ? { pollMs: deps.pollMs } : {}) });
        if (run.outcome === "completed") return { kind: "signed_in" };
        if (run.outcome === "stopped") return fail(409, STOPPED);
        if (run.reason?.startsWith("account-")) return { kind: "wrong_account" };
        if (run.reason === "sign-in" || run.reason === "choose-tab") return { kind: "needs_sign_in" };
        return fail(502, `REI could not be checked${run.detail ? `: ${run.detail}` : "."}`);
      };
      const signIn = deps.openForSignIn ?? deps.lab?.openForSignIn;
      // Cold start: open the work browser first. Only a failed open refuses; a
      // browser that is still not ready goes straight to the sign-in handover.
      if (!(await deps.browserId())) {
        if (context.getStore()!.signal.aborted) return fail(409, STOPPED);
        if (signInHolding()) return fail(409, SIGN_IN_HOLD);
        try { await deps.runtime.connect?.(); } catch { return fail(409, NO_BROWSER); }
        if (!(await deps.browserId()) && !signIn) return fail(409, NO_BROWSER);
      }
      const first: W1Session = (await deps.browserId()) ? await check() : { kind: "needs_sign_in" };
      if (first.kind !== "needs_sign_in" || !signIn) return first;
      // Self-serve sign-in: the person signs in on REI's own page; Bud never sees credentials or codes.
      // The run waits here as long as the handover lasts; other loops are not held. Status names the
      // handover so Schedule shows it (with Done and Stop) instead of "Working".
      const ctx = context.getStore()!, { signal, runId } = ctx, threadId = `w1-${runId}`;
      /** One handover, then the same read-only check (signed in is not proof of the account). */
      const handover = async (until?: number): Promise<W1Session> => {
        signingIn.set(runId, threadId);
        let opened: Awaited<ReturnType<typeof signIn>>;
        try { opened = await signIn({ site: W1_REI_PORTAL, reason: "Import bank receipts", signal, threadId, ...(office.rei.urlValue ? { account: office.rei.urlValue } : {}), ...(until === undefined ? {} : { until }) }); }
        finally { signingIn.delete(runId); }
        if (opened.outcome === "wrong_account") return { kind: "wrong_account" };
        if (signal.aborted) return fail(409, STOPPED);
        if (opened.outcome === "stopped") { note(STOPPED); return first; }
        if (opened.outcome === "timed_out") { if (until !== undefined) note(W1_MISSED); return first; }
        return check();
      };
      // A person's Continue: the attended 15-minute handover.
      if (!ctx.unattended) return handover();
      // A loop run: REI's sign-in page stays open until the end of the office day, saved so a restart reopens it.
      return withReiSignInWait({ waits, loop: "bank-references", runId, now, timeZone: await deps.timeZone?.(), note: ctx.note, copy: WAIT_COPY,
        ...(deps.waitPollMs !== undefined ? { pollMs: deps.waitPollMs } : {}), work: handover });
    },
    async uploadPreview({ attemptId, destination, batchId, artifactDigest }) {
      let prepared: Awaited<ReturnType<typeof batchFor>>, ctx: W1ReiContext;
      try {
        prepared = await batchFor(batchId, artifactDigest, destination, true);
        // The register as it stands before anything is uploaded, so a later readback counts only new receipts.
        const before = await captureBaseline(prepared.batch, await context_("readback", prepared.batch.destination.marker), windowFor(prepared.batch));
        if (before.status !== "read") fail(409, `REI's Receipt Register could not be read before the upload, so nothing was uploaded${before.detail ? `: ${before.detail}` : "."}`);
        else await saved_.saveBaseline(attemptId, before.baseline);
        ctx = await context_("preview", prepared.batch.destination.marker, { name: prepared.batch.artifact.name, bytes: prepared.bytes });
      } catch (error) { if (message(error) === LIST_CHANGED) listChanged.add(attemptId); note(message(error)); throw error; }
      const outcome = await preview(prepared.batch, ctx);
      if (outcome.status === "not-uploaded" || outcome.status === "unknown-upload") {
        note(outcome.status === "not-uploaded" ? `Nothing was uploaded${outcome.detail ? `: ${outcome.detail}` : "."}` : "The upload may have reached REI, but its preview was not confirmed.");
        throw new Error(outcome.reason ?? outcome.status);
      }
      previews.set(attemptId, { batch: prepared.batch, outcome });
      return previewOf(attemptId, destination, artifactDigest, outcome.reconciliation!, outcome.status === "ready");
    },
    async handOffPosting({ attemptId }) {
      const saved = previews.get(attemptId), ctx = context.getStore();
      if (ctx && pendingFound.has(attemptId)) { handoffs.set(ctx.runId, PENDING_HANDOFF); return; }
      // After a restart the saved preview was already verified row by row by the run.
      if (!saved || !ctx) return;
      handoffs.set(ctx.runId, (await awaitPosting(saved.batch, saved.outcome, load)).message);
    },
    async readback({ attemptId, destination, artifactDigest }) {
      try { const found: W1Readback = (await register(attemptId, destination, artifactDigest)) ?? { kind: "not_found" }; return found; }
      catch (error) { note(message(error)); throw error; }
    },
    async inspect({ attemptId, destination, artifactDigest }): Promise<W1Inspection> {
      // A refusal (stale tenants, account scope, an unverified recipe, an incomplete register, Stop) is never "nothing":
      // only a complete, verified register that shows nothing of the batch, and no pending import, may offer a re-upload.
      // The refusal's own sentence is the note. A batch refused because the tenant list changed stays unknown (no REI read can
      // clear it, and a later readback is never blocked by the list): prepare it again. Nothing receipted is not yet nothing: the file may sit pending in Bulk receipting, where a second upload is refused.
      if (listChanged.has(attemptId)) { note(LIST_CHANGED); return { kind: "unknown" }; }
      try { const found = await register(attemptId, destination, artifactDigest); return found ? { kind: "posted", readback: found } : await pendingImport(attemptId, destination, artifactDigest); }
      // An unreadable or unattributed register proves nothing either way.
      catch (error) { note(message(error)); return { kind: "unknown" }; }
    },
  };

  const workflow = createW1Workflow({ store, source, rei, today: () => today });
  const ready = workflow.recover();

  /** One execution slot per run: its Stop and its "working" entry are registered
   * synchronously, before any await, so a Stop during setup is never missed. */
  function advance(id: string, unattended: boolean, noteRun?: (detail: string) => void): Promise<W1Run> {
    const stop = new AbortController();
    stops.set(id, stop);
    const job = (async () => {
      try {
        await ready;
        today = await deps.today();
        // Stopped while setting up: no stage starts.
        if (stop.signal.aborted) return fail(409, STOPPED);
        notes.delete(id);
        return await context.run({ runId: id, unattended, signal: stop.signal, ...(noteRun ? { note: noteRun } : {}) }, () => workflow.advance(id));
      } finally { if (stops.get(id) === stop) stops.delete(id); }
    })();
    const slot: Promise<void> = job.then(() => {}, () => {}).finally(() => { if (working.get(id) === slot) working.delete(id); });
    working.set(id, slot);
    return job;
  }
  /** Person-driven steps run in the background: an ask can wait minutes for the person. */
  function kick(id: string) {
    if (working.has(id)) return;
    advance(id, false).catch(error => { notes.set(id, message(error)); });
  }
  const latest = async () => { const runs = await store.list(); return runs.filter(isActive).at(-1) ?? runs.at(-1) ?? null; };
  async function status() {
    await ready;
    // Read "working" before the run, so a run read while work was going on is never shown as settled.
    const busy = new Set(working.keys());
    const run = await latest(), office = await readW1Settings(deps.dataDir);
    return { settings: office, run, working: run ? busy.has(run.id) : false, ask: run ? asks.get(run.id) ?? null : null, note: run ? notes.get(run.id) ?? null : null,
      readback: run ? readbacks.get(run.id) ?? null : null, handoff: run ? handoffs.get(run.id) ?? null : null, signIn: run ? signingIn.get(run.id) ?? null : null };
  }
  const revisionOf = (body: unknown) => keys(body, ["expectedRevision"]) && Number.isSafeInteger(body.expectedRevision) ? Number(body.expectedRevision) : fail(400, "Send the bank import's current revision.");

  async function handle(path: string, method: string, query: URLSearchParams, readBody: () => Promise<unknown>): Promise<{ status: number; body: unknown }> {
    if (path === "/api/w1/status" && method === "GET") return { status: 200, body: await status() };
    if (path === "/api/w1/settings" && method === "PUT") {
      const body = await readBody();
      // The REI account is its top-bar business code; a reicid and the file format are optional (default ANZ(csv file)).
      const shape = object(body) && ["account", "reiBusiness", "expectedRevision"].every(key => key in body) &&
        Object.keys(body).every(key => ["account", "reiAccount", "reiBusiness", "bankFormat", "expectedRevision"].includes(key)) &&
        (body.reiAccount === undefined || typeof body.reiAccount === "string") && (body.bankFormat === undefined || typeof body.bankFormat === "string");
      if (!shape) return { status: 400, body: { error: "Choose the bank account and the business shown in REI's top bar." } };
      const current = await readW1Settings(deps.dataDir);
      if (body.expectedRevision !== (current?.revision ?? 0)) return { status: 409, body: { error: "The bank import settings changed. Reload them and try again." } };
      if ((await store.list()).some(isActive)) return { status: 409, body: { error: "Finish or close the open bank import before changing these settings." } };
      const reicid = typeof body.reiAccount === "string" && body.reiAccount.trim() ? body.reiAccount.trim() : undefined;
      const next = validSettings({ version: 1, kind: "w1-settings", account: body.account, rei: { ...(reicid ? { urlValue: reicid } : {}), marker: body.reiBusiness },
        bankFormat: typeof body.bankFormat === "string" && body.bankFormat.trim() ? body.bankFormat.trim() : W1_DEFAULT_BANK_FORMAT,
        revision: (current?.revision ?? 0) + 1, savedAt: new Date().toISOString() });
      await writePrivateJson(settingsPath(deps.dataDir), next);
      deps.onSettings?.(next);
      return { status: 200, body: { settings: next } };
    }
    if (path === "/api/w1/coverage" && method === "GET") {
      const account = query.get("account") ?? "";
      if (!REDBARK_ACCOUNT_ID.test(account)) return { status: 400, body: { error: "Choose a bank account." } };
      const state = await deps.coverage.state(account), window = deps.coverage.window(state, await deps.today());
      return { status: 200, body: { coveredThrough: state?.coveredThrough ?? null, nextFrom: window.from, revision: state?.revision ?? 0 } };
    }
    // The provider's bank accounts (masked) and a manual pull into a review batch. A pull never moves coverage.
    if (path === "/api/w1/accounts" && method === "GET") {
      const accounts = await provider().listBankAccounts();
      return { status: 200, body: { accounts: accounts.map(item => ({ id: item.id, name: item.name, institution: item.institution, numberMasked: item.numberMasked, category: item.category ?? "banking" })) } };
    }
    if (path === "/api/w1/pull" && method === "POST") {
      const body = await readBody();
      if (!keys(body, ["account"]) || typeof body.account !== "string") return { status: 400, body: { error: "Choose the bank account to pull." } };
      const bank = deps.store();
      return { status: 200, body: await pullRedbarkReview({ client: providerClient(provider()), store: bank, coverage: deps.coverage, account: body.account, today: await deps.today(), rules: bank.settings()?.rules ?? [] }) };
    }
    if (path === "/api/w1/runs/start" && method === "POST") {
      await ready;
      const office = await settings();
      const run = await workflow.start({ account: office.account, destination: destinationOf(office) });
      kick(run.id);
      return { status: 200, body: await status() };
    }
    if (path === "/api/w1/lab" && method === "POST" && deps.lab) return { status: 200, body: await deps.lab.handle(await readBody()) };
    const match = path.match(/^\/api\/w1\/runs\/(w1run_[a-f0-9-]{36})\/(advance|posting|retry-upload|abandon|answer|stop)$/);
    if (!match || method !== "POST") return { status: 404, body: { error: "Unknown bank import action." } };
    await ready;
    const [, id, action] = match, body = await readBody();
    if (action === "advance") { const run = await store.get(id); if (run.revision !== revisionOf(body)) fail(409, "This bank import changed. Reload it and try again."); kick(id); }
    if (action === "posting") {
      if (!keys(body, ["expectedRevision", "outcome"]) || !Number.isSafeInteger(body.expectedRevision)) return { status: 400, body: { error: "Say whether you processed the receipts in REI." } };
      await workflow.postingReported(id, Number(body.expectedRevision), body.outcome);
      kick(id);
    }
    if (action === "retry-upload") { await workflow.retryUpload(id, revisionOf(body)); kick(id); }
    if (action === "abandon") await workflow.abandon(id, revisionOf(body));
    // Stop is always allowed: it ends the browser stage in flight (and its open ask) and starts nothing.
    if (action === "stop") {
      const stop = stops.get(id);
      if (stop) { stop.abort(); notes.set(id, STOPPED); }
      // Wait for the stage to unwind so the answer shows where the run stopped.
      await working.get(id);
      if (stop) notes.set(id, STOPPED);
    }
    if (action === "answer") {
      if (!keys(body, ["requestId", "allowed"]) || typeof body.requestId !== "string" || typeof body.allowed !== "boolean") return { status: 400, body: { error: "Answer the request with allow or don't allow." } };
      if (asks.get(id)?.requestId !== body.requestId || !answerPortalRecipeAsk(`w1:${id}`, body.requestId, body.allowed)) return { status: 409, body: { error: "This request has already been answered or has ended." } };
    }
    return { status: 200, body: await status() };
  }

  /** The bank-references loop: start a run when none is open, pull, wait for
   * the review, then wait on REI's sign-in page (until the office day ends)
   * and carry on to the upload ask, which waits for the person. `noteRun`
   * tells the Schedule row what the run waits for. */
  async function runLoop(noteRun: (detail: string) => void = () => {}): Promise<{ ok: boolean; status?: "completed" | "awaiting-approval" | "failed" | "missed"; detail: string; quiet?: boolean }> {
    await ready;
    const office = await readW1Settings(deps.dataDir);
    if (!office) return { ok: false, status: "failed", detail: "Choose the bank account and REI account for bank imports first." };
    let run = (await store.list()).find(item => isActive(item) && item.account === office.account) ?? null;
    try { run ??= await workflow.start({ account: office.account, destination: destinationOf(office) }); }
    catch (error) { return { ok: false, status: "failed", detail: message(error) }; }
    const waiting = { ok: true, status: "awaiting-approval" as const, detail: "A bank import is waiting for you in Schedule → Bank reference review." };
    if (working.has(run.id) || !["fetch", "review", "sign_in", "confirm"].includes(run.step)) return waiting;
    const id = run.id;
    try { run = await advance(id, true, noteRun); }
    catch (error) { return message(error) === STOPPED ? { ok: false, status: "failed", detail: STOPPED } : waiting; }
    if (run.outcome === "nothing_new") return { ok: true, status: "completed", detail: "No new bank transactions since the last import.", quiet: true };
    if (run.outcome === "imported") return { ok: true, status: "completed", detail: `Bank import confirmed through ${run.confirm?.coveredThrough ?? "today"}.` };
    if (run.attention?.reason === "fetch_failed") return { ok: false, status: "failed", detail: notes.get(id) ?? run.attention.message };
    if (notes.get(id) === W1_MISSED) return { ok: false, status: "missed", detail: W1_MISSED };
    if (notes.get(id) === STOPPED) return { ok: false, status: "failed", detail: STOPPED };
    if (run.step === "review") return { ok: true, status: "awaiting-approval", detail: `Pulled ${run.fetch?.transactionIds.length ?? 0} bank transactions. Review them in Schedule → Bank reference review.` };
    return run.attention ? { ok: true, status: "awaiting-approval", detail: `${run.attention.message} Continue in Schedule → Bank reference review.` } : waiting;
  }

  return { handle, runLoop, status, workflow, store, importProof: currentProof };
}
export type W1Host = ReturnType<typeof createW1Host>;
