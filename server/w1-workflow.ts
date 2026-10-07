// W1 resumable run: fetch (bank source) → review → REI sign-in → upload
// preview → the person posts → readback → confirm import.
//
// Every step is a durable checkpoint in W1StateStore. Side effects that cannot
// be repeated safely (the REI upload) record their intent first; an intent
// without a saved result is an unknown outcome and moves the run to
// "check_outcome", which inspects REI and never re-sends on its own. Only a
// readback whose row ids match the REI import file exactly can reach "confirm",
// and only "confirm" advances the bank coverage cursor (through the source port).
// The import file carries only the review's import rows: held and excluded
// rows are recorded on the run but never expected in REI's preview or register.
//
// The bank source (Packet 1) and REI bridge (Packet 3) are injected ports.
import {
  W1StateStore, W1_ACCOUNT, W1_DESTINATION, blankRun, compareTransactionIds, duplicateIds, isActive, logged, newAttemptId,
  type W1AttentionReason, type W1Preview, type W1ReadbackFound, type W1Run,
} from "./w1-state.ts";

// ---- Ports -----------------------------------------------------------------

/** Packet 1. A pull is read-only and repeatable; it never moves coverage. */
export interface W1BankSource {
  pull(input: { account: string; today: string }): Promise<{
    window: { from: string; to: string };
    /** Coverage revision the window was computed from; confirm compares it. */
    coverageRevision: number;
    /** Null when nothing new arrived. Ids are stable bank transaction ids in
     * file order, already excluding ids the source has confirmed. */
    batch: { id: string; transactionIds: string[] } | null;
  }>;
  /** Newest reviewed version of a batch (an amendment may replace the id), or
   * null while any row still needs a decision. outputDigest is the REI import
   * file's; every pulled id is in exactly one of the three lists. */
  reviewed(batchId: string): Promise<{ batchId: string; outputDigest: string; importIds: string[]; heldIds: string[]; excludedIds: string[] } | null>;
  /** Advances the account cursor. Idempotent for the same batch (a retry after
   * a lost reply returns the saved result). 409 when coverage moved. */
  confirmImport(input: { batchId: string; expectedCoverageRevision: number }): Promise<{ coveredThrough: string; revision: number; reused: boolean }>;
}

export type W1Session = { kind: "signed_in" } | { kind: "needs_sign_in" } | { kind: "wrong_account" };
export type W1Readback = W1ReadbackFound | { kind: "not_found" };
/** "preview": our file is still pending in REI (unposted). "pending_other": REI
 * holds a pending bank file RealBud cannot match to this run. */
export type W1Inspection = { kind: "nothing" } | { kind: "preview"; preview: W1Preview } | { kind: "posted"; readback: W1ReadbackFound } | { kind: "pending_other" } | { kind: "unknown" };

/** Packet 3. Only uploadPreview changes REI; everything else reads or hands over. */
export interface W1ReiBridge {
  session(input: { destination: string }): Promise<W1Session>;
  /** Loads the exact reviewed file into REI's import preview. Never posts. */
  uploadPreview(input: { attemptId: string; destination: string; batchId: string; artifactDigest: string }): Promise<W1Preview>;
  /** Puts the verified preview in front of the person, who posts it. */
  handOffPosting(input: { attemptId: string; destination: string; previewId: string }): Promise<void>;
  readback(input: { attemptId: string; destination: string; previewId: string; artifactDigest: string }): Promise<W1Readback>;
  /** Read-only check of what an earlier attempt left in REI: the register, then
   * the pending imports. "nothing" only when both show nothing of it. */
  inspect(input: { attemptId: string; destination: string; artifactDigest: string; previewId: string | null }): Promise<W1Inspection>;
}

export interface W1WorkflowDeps {
  store: W1StateStore; source: W1BankSource; rei: W1ReiBridge;
  now?: () => Date; attemptId?: () => string;
  /** Office-local calendar date (YYYY-MM-DD) for the pull. */
  today?: () => string;
}

const MESSAGES: Record<W1AttentionReason, string> = {
  fetch_failed: "The bank transactions could not be fetched. Try again.",
  sign_in: "Sign in to REI in the work browser, then continue.",
  account_mismatch: "REI is signed in to a different agency or trust account. Switch to the selected account, then continue.",
  duplicate_ids: "The bank returned the same transaction id twice. Nothing was uploaded. Check the bank source.",
  already_imported: "This pull contains payments an earlier run already imported. Nothing was uploaded. Check the bank coverage.",
  review_changed: "The reviewed file no longer matches this run's transactions. Nothing was confirmed. Check the review.",
  preview_mismatch: "REI's preview does not match the reviewed file row for row. Do not post it. Check the preview.",
  handoff_failed: "The REI preview could not be opened for posting. Try again.",
  readback_failed: "REI's import result could not be read. Try again.",
  readback_mismatch: "REI's import result does not match this run's transactions. Coverage was not advanced. Check the import in REI.",
  pending_rows: "Some payments are still pending in REI. Check again later; coverage was not advanced.",
  rejected_rows: "REI rejected some payments. Coverage was not advanced. Resolve them in REI.",
  nothing_found: "REI shows nothing from the earlier upload. You can upload the reviewed file again.",
  outcome_unknown: "RealBud cannot tell whether the earlier REI step finished. Check REI before doing anything else.",
  coverage_conflict: "The bank coverage changed since this pull. Coverage was not advanced. Check the bank coverage.",
  confirm_failed: "The confirmed import could not be saved. Try again; it is safe to repeat.",
  nothing_to_import: "Every pulled transaction is held or excluded, so there is nothing to import into REI. Finish the held rows in the review, or close this import.",
  pending_unknown: "REI has a bank file waiting in Bulk receipting that RealBud cannot match to this import. Process or delete it in REI, then check again. Nothing was uploaded.",
};

const conflict = (message: string): never => { throw Object.assign(new Error(message), { status: 409 }); };
const statusOf = (error: unknown) => (error as { status?: unknown } | null)?.status;

export function createW1Workflow(deps: W1WorkflowDeps) {
  const { store, source, rei } = deps;
  const now = () => (deps.now?.() ?? new Date()).toISOString();
  const attemptId = deps.attemptId ?? newAttemptId;
  /** Runs with an external call in flight in this process. After a restart
   * the set is empty, so an intent without a result is truly uncertain. */
  const busy = new Set<string>();

  const save = (run: W1Run, change: (run: W1Run) => Partial<W1Run>, event: string) => {
    const at = now();
    return store.update(run.id, run.revision, current => {
      const next = { ...current, ...change(current) };
      return { ...next, log: logged(next, at, event) };
    }, at);
  };
  const attend = (run: W1Run, reason: W1AttentionReason, extra: Partial<W1Run> = {}) =>
    save(run, () => ({ ...extra, attention: { reason, message: MESSAGES[reason] } }), `Stopped: ${reason}.`);
  const moveTo = (run: W1Run, step: W1Run["step"], extra: Partial<W1Run>, event: string) =>
    save(run, () => ({ ...extra, step, attention: null }), event);

  /** The REI import file's rows: the only ids preview, readback and confirm match. */
  const importIds = (run: W1Run) => run.review?.importIds ?? [];
  function previewMatches(run: W1Run, preview: W1Preview) {
    const ids = importIds(run);
    return preview.destination === run.destination && preview.artifactDigest === run.upload?.artifactDigest && preview.warnings.length === 0 &&
      preview.rows.every(row => row.included) && compareTransactionIds(ids, preview.rows.map(row => row.transactionId)).same;
  }

  /** Readback (or an inspection that found the posted import): every id must
   * appear exactly once and be accepted before confirm can run. */
  async function applyReadback(run: W1Run, found: W1ReadbackFound): Promise<W1Run> {
    const ids = importIds(run);
    const readback = { importRef: found.importRef, rows: found.rows };
    if (found.destination !== run.destination || found.artifactDigest !== run.upload?.artifactDigest ||
        !compareTransactionIds(ids, found.rows.map(row => row.transactionId)).same)
      return attend(run, "readback_mismatch", { step: "readback", readback, uncertain: null });
    if (found.rows.some(row => row.status === "rejected")) return attend(run, "rejected_rows", { step: "readback", readback, uncertain: null });
    if (found.rows.some(row => row.status === "pending")) return attend(run, "pending_rows", { step: "readback", readback, uncertain: null });
    return moveTo(run, "confirm", { readback, uncertain: null }, `REI import ${found.importRef} read back; every payment accepted.`);
  }

  /** One step. Returns the saved run and whether the loop may continue. */
  async function step(run: W1Run): Promise<{ run: W1Run; more: boolean }> {
    switch (run.step) {
      case "fetch": {
        const today = deps.today?.() ?? new Date().toLocaleDateString("en-CA");
        let pulled: Awaited<ReturnType<W1BankSource["pull"]>>;
        try { pulled = await source.pull({ account: run.account, today }); }
        catch { return { run: await attend(run, "fetch_failed"), more: false }; }
        if (!pulled.batch) return { run: await save(run, () => ({ step: "done", outcome: "nothing_new", attention: null }), "No new bank transactions."), more: false };
        const ids = pulled.batch.transactionIds;
        const fetch = { today, from: pulled.window.from, to: pulled.window.to, coverageRevision: pulled.coverageRevision, batchId: pulled.batch.id, transactionIds: ids };
        if (duplicateIds(ids).length) return { run: await attend(run, "duplicate_ids", { fetch }), more: false };
        // Only rows that went into REI: an earlier run's held rows come back in later pulls by design.
        const imported = new Set((await store.list()).filter(other => other.account === run.account && other.outcome === "imported").flatMap(importIds));
        if (ids.some(id => imported.has(id))) return { run: await attend(run, "already_imported", { fetch }), more: false };
        return { run: await moveTo(run, "review", { fetch }, `Fetched ${ids.length} transactions (${fetch.from} to ${fetch.to}).`), more: true };
      }
      case "review": {
        const reviewed = await source.reviewed(run.fetch!.batchId);
        if (!reviewed) return { run, more: false };
        // Every pulled id is accounted for exactly once: imported, held or excluded.
        if (!compareTransactionIds(run.fetch!.transactionIds, [...reviewed.importIds, ...reviewed.heldIds, ...reviewed.excludedIds]).same) return { run: await attend(run, "review_changed"), more: false };
        const review = { batchId: reviewed.batchId, outputDigest: reviewed.outputDigest, importIds: reviewed.importIds, heldIds: reviewed.heldIds, excludedIds: reviewed.excludedIds };
        if (!review.importIds.length) return { run: await attend(run, "nothing_to_import"), more: false };
        return { run: await moveTo(run, "sign_in", { review },
          `Review complete: ${review.importIds.length} to import, ${review.heldIds.length} held, ${review.excludedIds.length} excluded.`), more: true };
      }
      case "sign_in": {
        const session = await rei.session({ destination: run.destination });
        if (session.kind === "needs_sign_in") return { run: await attend(run, "sign_in"), more: false };
        if (session.kind === "wrong_account") return { run: await attend(run, "account_mismatch"), more: false };
        return { run: await moveTo(run, "upload", {}, "REI session confirmed for the selected account."), more: true };
      }
      case "upload": {
        // An attempt is already recorded and this process is not running it:
        // the reply was lost (or the app restarted). Never send it again.
        if (run.upload && !run.upload.preview)
          return { run: await moveTo(run, "check_outcome", { uncertain: { kind: "upload", since: now(), inspection: null } }, "Upload outcome unknown; checking REI."), more: true };
        // Re-check the review right before the file leaves RealBud.
        const reviewed = await source.reviewed(run.review!.batchId);
        // Nothing has left RealBud yet, so a changed review simply goes back to review.
        if (!reviewed || reviewed.batchId !== run.review!.batchId || reviewed.outputDigest !== run.review!.outputDigest)
          return { run: await moveTo(run, "review", { review: null }, "The review changed before upload; checking it again."), more: true };
        const intent = { attemptId: attemptId(), startedAt: now(), batchId: run.review!.batchId, artifactDigest: run.review!.outputDigest, preview: null };
        const started = await save(run, () => ({ upload: intent, attention: null }), `Uploading reviewed file (attempt ${intent.attemptId}).`);
        let preview: W1Preview;
        try { preview = await rei.uploadPreview({ attemptId: intent.attemptId, destination: run.destination, batchId: intent.batchId, artifactDigest: intent.artifactDigest }); }
        catch { return { run: await moveTo(started, "check_outcome", { uncertain: { kind: "upload", since: now(), inspection: null } }, "Upload reply lost; checking REI."), more: true }; }
        const withPreview = { ...intent, preview };
        if (!previewMatches({ ...started, upload: withPreview }, preview)) return { run: await attend(started, "preview_mismatch", { step: "handoff", upload: withPreview }), more: false };
        return { run: await moveTo(started, "handoff", { upload: withPreview }, `Preview ${preview.previewId} matches the reviewed file.`), more: true };
      }
      case "handoff": {
        if (run.attention?.reason === "preview_mismatch" || run.handoff) return { run, more: false };
        const handoff = { at: now() };
        const saved = await save(run, () => ({ handoff }), "Preview handed to the person to post.");
        try { await rei.handOffPosting({ attemptId: run.upload!.attemptId, destination: run.destination, previewId: run.upload!.preview!.previewId }); }
        catch { return { run: await attend(saved, "handoff_failed", { handoff: null }), more: false }; }
        return { run: saved, more: false };
      }
      case "readback": {
        let result: W1Readback;
        try { result = await rei.readback({ attemptId: run.upload!.attemptId, destination: run.destination, previewId: run.upload!.preview!.previewId, artifactDigest: run.upload!.artifactDigest }); }
        catch { return { run: await attend(run, "readback_failed"), more: false }; }
        if (result.kind === "not_found")
          return { run: await moveTo(run, "check_outcome", { uncertain: { kind: "posting", since: now(), inspection: null } }, "No REI import found after posting; checking REI."), more: false };
        return { run: await applyReadback(run, result), more: true };
      }
      case "check_outcome": {
        const upload = run.upload!;
        const found = await rei.inspect({ attemptId: upload.attemptId, destination: run.destination, artifactDigest: upload.artifactDigest, previewId: upload.preview?.previewId ?? null });
        const uncertain = run.uncertain!;
        if (found.kind === "nothing") return { run: await attend(run, "nothing_found", { uncertain: { ...uncertain, inspection: "nothing" } }), more: false };
        if (found.kind === "unknown") return { run: await attend(run, "outcome_unknown", { uncertain: { ...uncertain, inspection: "unknown" } }), more: false };
        if (found.kind === "pending_other") return { run: await attend(run, "pending_unknown", { uncertain: { ...uncertain, inspection: "unknown" } }), more: false };
        if (found.kind === "posted") return { run: await applyReadback(run, found.readback), more: true };
        const withPreview = { ...upload, preview: found.preview };
        if (!previewMatches({ ...run, upload: withPreview }, found.preview)) return { run: await attend(run, "preview_mismatch", { step: "handoff", upload: withPreview, uncertain: null }), more: false };
        // The preview is there and nothing was posted: back to the person.
        return { run: await moveTo(run, "handoff", { upload: withPreview, uncertain: null, posting: null }, `Found preview ${found.preview.previewId} unposted.`), more: true };
      }
      case "confirm": {
        const reviewed = await source.reviewed(run.review!.batchId);
        if (!reviewed || reviewed.batchId !== run.review!.batchId || reviewed.outputDigest !== run.upload!.artifactDigest) return { run: await attend(run, "review_changed"), more: false };
        const started = run.confirm ? run : await save(run, () => ({ confirm: { startedAt: now(), coveredThrough: null, coverageRevision: null } }), "Confirming the import.");
        let result: Awaited<ReturnType<W1BankSource["confirmImport"]>>;
        try { result = await source.confirmImport({ batchId: run.review!.batchId, expectedCoverageRevision: run.fetch!.coverageRevision }); }
        catch (error) { return { run: await attend(started, statusOf(error) === 409 ? "coverage_conflict" : "confirm_failed"), more: false }; }
        return { run: await save(started, current => ({ step: "done", outcome: "imported", attention: null,
          confirm: { ...current.confirm!, coveredThrough: result.coveredThrough, coverageRevision: result.revision } }), `Coverage advanced through ${result.coveredThrough}.`), more: false };
      }
      case "done": return { run, more: false };
    }
  }

  async function exclusive<T>(id: string, work: () => Promise<T>): Promise<T> {
    if (busy.has(id)) return conflict("This bank import is already working. Wait for it to finish.");
    busy.add(id);
    try { return await work(); } finally { busy.delete(id); }
  }

  return {
    async start(input: { account: unknown; destination: unknown }) {
      if (typeof input.account !== "string" || !W1_ACCOUNT.test(input.account)) throw Object.assign(new Error("Choose a bank account."), { status: 400 });
      if (typeof input.destination !== "string" || !W1_DESTINATION.test(input.destination)) throw Object.assign(new Error("Choose the REI agency or trust account."), { status: 400 });
      return store.create(blankRun({ account: input.account, destination: input.destination, at: now() }));
    },
    /** Runs automatic steps until the run needs a person, REI or time. Safe to
     * call again at any point, including after a restart. */
    advance(id: string) {
      return exclusive(id, async () => {
        let run = await store.get(id);
        // A stop at the current step is retried by the next advance; an
        // explicit wait (review, posting, mismatch, unknown outcome) is kept.
        for (let guard = 0; guard < 12; guard++) {
          const { run: next, more } = await step(run);
          run = next;
          if (!more || !isActive(run)) break;
        }
        return run;
      });
    },
    /** Boot recovery without external calls: an upload intent with no saved
     * result is an unknown outcome. */
    async recover() {
      const runs = (await store.list()).filter(run => isActive(run) && !busy.has(run.id));
      const out: W1Run[] = [];
      for (const run of runs) {
        out.push(run.step === "upload" && run.upload && !run.upload.preview
          ? await moveTo(run, "check_outcome", { uncertain: { kind: "upload", since: now(), inspection: null } }, "Restarted during upload; checking REI.")
          : run);
      }
      return out;
    },
    /** The person reports the posting. "unsure" (a timeout or closed page)
     * is an unknown outcome that must be checked in REI. */
    postingReported(id: string, expectedRevision: number, outcome: unknown) {
      return exclusive(id, async () => {
        const run = await store.get(id);
        if (run.revision !== expectedRevision) return conflict("This bank import changed. Reload it and try again.");
        if (run.step !== "handoff" || !run.handoff || run.attention) return conflict("This import is not waiting for posting.");
        if (outcome !== "posted" && outcome !== "unsure") throw Object.assign(new Error("Say whether the import was posted."), { status: 400 });
        const posting = { reportedAt: now(), outcome: outcome as "posted" | "unsure" };
        return outcome === "posted"
          ? moveTo(run, "readback", { posting }, "Person reported the import posted.")
          : moveTo(run, "check_outcome", { posting, uncertain: { kind: "posting", since: now(), inspection: null } }, "Person unsure whether the import posted.");
      });
    },
    /** The only path to a second upload: REI was inspected and holds nothing
     * from the earlier attempt, and the person asked for it. */
    retryUpload(id: string, expectedRevision: number) {
      return exclusive(id, async () => {
        const run = await store.get(id);
        if (run.revision !== expectedRevision) return conflict("This bank import changed. Reload it and try again.");
        if (run.step !== "check_outcome" || run.uncertain?.inspection !== "nothing") return conflict("Check REI for the earlier upload before uploading again.");
        return moveTo(run, "sign_in", { upload: null, handoff: null, posting: null, uncertain: null }, "Person chose to upload again after REI showed nothing.");
      });
    },
    /** Abandon only while nothing can be in REI's hands. `notSent` answers from the host's durable evidence whether an
     * upload attempt was refused before its upload stage started; only then may an unknown upload outcome be closed directly. */
    abandon(id: string, expectedRevision: number, notSent: (attemptId: string) => Promise<boolean> = async () => false) {
      return exclusive(id, async () => {
        const run = await store.get(id);
        if (run.revision !== expectedRevision) return conflict("This bank import changed. Reload it and try again.");
        const safe = run.step === "fetch" || run.step === "review" || run.step === "sign_in" || (run.step === "upload" && !run.upload) ||
          (run.step === "handoff" && !run.handoff && run.attention?.reason === "preview_mismatch") ||
          (run.step === "check_outcome" && run.uncertain?.inspection === "nothing") ||
          (run.step === "check_outcome" && run.uncertain?.kind === "upload" && !!run.upload && !run.upload.preview && await notSent(run.upload.attemptId));
        if (!safe) return conflict("This import may already be in REI. Check its outcome before closing it.");
        return save(run, () => ({ step: "done", outcome: "abandoned", attention: null }), "Abandoned by the person.");
      });
    },
  };
}

export type W1Workflow = ReturnType<typeof createW1Workflow>;
