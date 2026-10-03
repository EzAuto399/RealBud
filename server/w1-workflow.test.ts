import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createW1Workflow, type W1BankSource, type W1Inspection, type W1Readback, type W1ReiBridge, type W1Session } from "./w1-workflow.ts";
import { W1StateStore, compareTransactionIds, type W1Preview } from "./w1-state.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tempDir = () => { const dir = mkdtempSync(join(tmpdir(), "bud-w1-")); dirs.push(dir); return dir; };

const DIGEST = "a".repeat(64);
const ACCOUNT = "acct_fictional1";
const DEST = "rei-fictional-trust";

/** Fictional bank source: pulls return queued batches; review is set by the test. */
function fakeSource() {
  const state = {
    pulls: [] as { id: string; transactionIds: string[] }[] | null[],
    /** transactionIds are the import file's rows; held and excluded rows default to none. */
    reviewed: new Map<string, { batchId: string; outputDigest: string; transactionIds: string[]; heldIds?: string[]; excludedIds?: string[] }>(),
    confirmCalls: [] as { batchId: string; expectedCoverageRevision: number }[],
    confirmFailures: 0, coverageRevision: 0,
  };
  const source: W1BankSource = {
    async pull() {
      const batch = (state.pulls as ({ id: string; transactionIds: string[] } | null)[]).shift() ?? null;
      return { window: { from: "2026-09-28", to: "2026-10-02" }, coverageRevision: state.coverageRevision, batch };
    },
    async reviewed(batchId) {
      const saved = state.reviewed.get(batchId);
      return saved ? { batchId: saved.batchId, outputDigest: saved.outputDigest, importIds: saved.transactionIds, heldIds: saved.heldIds ?? [], excludedIds: saved.excludedIds ?? [] } : null;
    },
    async confirmImport(input) {
      state.confirmCalls.push(input);
      if (state.confirmFailures > 0) { state.confirmFailures--; throw new Error("socket hang up"); }
      return { coveredThrough: "2026-10-02", revision: input.expectedCoverageRevision + 1, reused: false };
    },
  };
  return { state, source };
}

function fakeRei() {
  const state = {
    session: { kind: "signed_in" } as W1Session,
    uploads: [] as { attemptId: string; artifactDigest: string }[],
    uploadBehaviour: "ok" as "ok" | "throw" | "hang" | "warn",
    handoffs: 0,
    readback: null as W1Readback | null,
    inspection: { kind: "unknown" } as W1Inspection,
    inspections: 0,
  };
  const previewFor = (ids: string[], attemptId: string): W1Preview => ({ previewId: `preview-${attemptId.slice(-6)}`, destination: DEST, artifactDigest: DIGEST,
    rows: ids.map(transactionId => ({ transactionId, included: true })), warnings: state.uploadBehaviour === "warn" ? ["2 rows unmatched"] : [] });
  let ids: string[] = [];
  const rei: W1ReiBridge = {
    async session() { return state.session; },
    async uploadPreview(input) {
      state.uploads.push({ attemptId: input.attemptId, artifactDigest: input.artifactDigest });
      if (state.uploadBehaviour === "throw") throw new Error("timeout");
      if (state.uploadBehaviour === "hang") return new Promise<W1Preview>(() => {});
      return previewFor(ids, input.attemptId);
    },
    async handOffPosting() { state.handoffs++; },
    async readback() { if (!state.readback) throw new Error("no readback configured"); return state.readback; },
    async inspect() { state.inspections++; return state.inspection; },
  };
  return { state, rei, setIds: (next: string[]) => { ids = next; }, previewFor };
}

function setup(dir = tempDir()) {
  const bank = fakeSource(), portal = fakeRei();
  let n = 0;
  const make = () => createW1Workflow({ store: new W1StateStore(dir), source: bank.source, rei: portal.rei, today: () => "2026-10-02",
    attemptId: () => `w1up_00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });
  return { dir, bank, portal, make };
}

const found = (ids: string[], status: "accepted" | "rejected" | "pending" = "accepted"): W1Readback =>
  ({ kind: "found", importRef: "REI-IMPORT-1", destination: DEST, artifactDigest: DIGEST, rows: ids.map(transactionId => ({ transactionId, status })) });

/** Run to the posting handoff, restarting the workflow between every checkpoint. */
async function toHandoff(t: ReturnType<typeof setup>, ids: string[]) {
  t.bank.state.pulls = [{ id: "bank:batch1", transactionIds: ids }];
  t.portal.setIds(ids);
  let run = await t.make().start({ account: ACCOUNT, destination: DEST });
  run = await t.make().advance(run.id);
  expect(run.step).toBe("review");
  t.bank.state.reviewed.set("bank:batch1", { batchId: "bank:batch1", outputDigest: DIGEST, transactionIds: ids });
  run = await t.make().advance(run.id);
  expect(run.step).toBe("handoff");
  expect(run.handoff).not.toBeNull();
  return run;
}

describe("W1 durable run", () => {
  it("resumes at every checkpoint and confirms only after a matching readback", async () => {
    const t = setup();
    let run = await toHandoff(t, ["txn_1", "txn_2"]);
    expect(t.portal.state.uploads).toHaveLength(1);
    expect(t.portal.state.handoffs).toBe(1);
    // Restarting while waiting for the person does nothing on its own.
    run = await t.make().advance(run.id);
    expect(run.step).toBe("handoff");
    expect(t.portal.state.handoffs).toBe(1);
    expect(t.bank.state.confirmCalls).toHaveLength(0);
    run = await t.make().postingReported(run.id, run.revision, "posted");
    t.portal.state.readback = found(["txn_1", "txn_2"]);
    run = await t.make().advance(run.id);
    expect(run).toMatchObject({ step: "done", outcome: "imported", confirm: { coveredThrough: "2026-10-02", coverageRevision: 1 } });
    expect(t.bank.state.confirmCalls).toEqual([{ batchId: "bank:batch1", expectedCoverageRevision: 0 }]);
    expect(t.portal.state.uploads).toHaveLength(1);
    // The saved file is private and readable by a fresh store.
    expect((await new W1StateStore(t.dir).get(run.id)).outcome).toBe("imported");
  });

  it("holds at REI sign-in and continues there once signed in", async () => {
    const t = setup();
    t.bank.state.pulls = [{ id: "bank:batch1", transactionIds: ["txn_1"] }];
    t.bank.state.reviewed.set("bank:batch1", { batchId: "bank:batch1", outputDigest: DIGEST, transactionIds: ["txn_1"] });
    t.portal.setIds(["txn_1"]);
    t.portal.state.session = { kind: "needs_sign_in" };
    let run = await t.make().start({ account: ACCOUNT, destination: DEST });
    run = await t.make().advance(run.id);
    expect(run).toMatchObject({ step: "sign_in", attention: { reason: "sign_in" } });
    t.portal.state.session = { kind: "wrong_account" };
    run = await t.make().advance(run.id);
    expect(run).toMatchObject({ step: "sign_in", attention: { reason: "account_mismatch" } });
    expect(t.portal.state.uploads).toHaveLength(0);
    t.portal.state.session = { kind: "signed_in" };
    run = await t.make().advance(run.id);
    expect(run.step).toBe("handoff");
  });

  it("a lost upload reply goes to check-outcome and never re-sends or advances coverage", async () => {
    const t = setup();
    t.bank.state.pulls = [{ id: "bank:batch1", transactionIds: ["txn_1"] }];
    t.bank.state.reviewed.set("bank:batch1", { batchId: "bank:batch1", outputDigest: DIGEST, transactionIds: ["txn_1"] });
    t.portal.setIds(["txn_1"]);
    t.portal.state.uploadBehaviour = "throw";
    let run = await t.make().start({ account: ACCOUNT, destination: DEST });
    run = await t.make().advance(run.id);
    expect(run).toMatchObject({ step: "check_outcome", uncertain: { kind: "upload", inspection: "unknown" }, attention: { reason: "outcome_unknown" } });
    for (let i = 0; i < 3; i++) run = await t.make().advance(run.id);
    expect(t.portal.state.uploads).toHaveLength(1);
    expect(t.bank.state.confirmCalls).toHaveLength(0);
    await expect(t.make().retryUpload(run.id, run.revision)).rejects.toMatchObject({ status: 409 });
    await expect(t.make().abandon(run.id, run.revision)).rejects.toMatchObject({ status: 409 });
    // REI shows the preview was loaded: continue to the person, still one upload.
    t.portal.state.uploadBehaviour = "ok";
    t.portal.state.inspection = { kind: "preview", preview: t.portal.previewFor(["txn_1"], run.upload!.attemptId) };
    run = await t.make().advance(run.id);
    expect(run.step).toBe("handoff");
    expect(t.portal.state.uploads).toHaveLength(1);
  });

  it("a restart mid-upload is an unknown outcome; only an inspected empty REI allows a person-chosen re-upload", async () => {
    const t = setup();
    t.bank.state.pulls = [{ id: "bank:batch1", transactionIds: ["txn_1"] }];
    t.bank.state.reviewed.set("bank:batch1", { batchId: "bank:batch1", outputDigest: DIGEST, transactionIds: ["txn_1"] });
    t.portal.setIds(["txn_1"]);
    t.portal.state.uploadBehaviour = "hang";
    const before = t.make();
    let run = await before.start({ account: ACCOUNT, destination: DEST });
    void before.advance(run.id);
    for (let i = 0; i < 200 && !t.portal.state.uploads.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
    expect(t.portal.state.uploads).toHaveLength(1);
    // The same process refuses a second concurrent advance.
    await expect(before.advance(run.id)).rejects.toMatchObject({ status: 409 });
    // New process after the crash.
    const after = t.make();
    const [recovered] = await after.recover();
    expect(recovered).toMatchObject({ step: "check_outcome", uncertain: { kind: "upload", inspection: null } });
    t.portal.state.inspection = { kind: "nothing" };
    run = await after.advance(recovered.id);
    expect(run).toMatchObject({ step: "check_outcome", attention: { reason: "nothing_found" }, uncertain: { inspection: "nothing" } });
    expect(t.portal.state.uploads).toHaveLength(1);
    t.portal.state.uploadBehaviour = "ok";
    run = await after.retryUpload(run.id, run.revision);
    run = await after.advance(run.id);
    expect(run.step).toBe("handoff");
    expect(t.portal.state.uploads.map(upload => upload.attemptId)).toEqual([
      "w1up_00000000-0000-4000-8000-000000000001", "w1up_00000000-0000-4000-8000-000000000002"]);
  });

  it("an unsure or unfound posting is checked in REI before anything is confirmed", async () => {
    const t = setup();
    let run = await toHandoff(t, ["txn_1"]);
    run = await t.make().postingReported(run.id, run.revision, "unsure");
    expect(run).toMatchObject({ step: "check_outcome", uncertain: { kind: "posting" } });
    run = await t.make().advance(run.id);
    expect(run.attention?.reason).toBe("outcome_unknown");
    expect(t.bank.state.confirmCalls).toHaveLength(0);
    t.portal.state.inspection = { kind: "posted", readback: found(["txn_1"]) as Extract<W1Readback, { kind: "found" }> };
    run = await t.make().advance(run.id);
    expect(run).toMatchObject({ step: "done", outcome: "imported" });

    const u = setup();
    run = await toHandoff(u, ["txn_9"]);
    run = await u.make().postingReported(run.id, run.revision, "posted");
    u.portal.state.readback = { kind: "not_found" };
    run = await u.make().advance(run.id);
    expect(run).toMatchObject({ step: "check_outcome", uncertain: { kind: "posting" } });
    expect(u.bank.state.confirmCalls).toHaveLength(0);
    expect(u.portal.state.uploads).toHaveLength(1);
  });

  it("partial rejection, pending rows and mismatched readbacks never advance coverage", async () => {
    const t = setup();
    let run = await toHandoff(t, ["txn_1", "txn_2"]);
    run = await t.make().postingReported(run.id, run.revision, "posted");
    t.portal.state.readback = { ...found(["txn_1"]), rows: [{ transactionId: "txn_1", status: "accepted" }, { transactionId: "txn_2", status: "rejected" }] } as W1Readback;
    run = await t.make().advance(run.id);
    expect(run).toMatchObject({ step: "readback", attention: { reason: "rejected_rows" } });
    t.portal.state.readback = found(["txn_1", "txn_2"], "pending");
    run = await t.make().advance(run.id);
    expect(run.attention?.reason).toBe("pending_rows");
    t.portal.state.readback = { ...found(["txn_1", "txn_2"]), destination: "rei-other-trust" } as W1Readback;
    run = await t.make().advance(run.id);
    expect(run.attention?.reason).toBe("readback_mismatch");
    expect(t.bank.state.confirmCalls).toHaveLength(0);
  });

  it("keeps two legitimate identical payments by transaction id", async () => {
    // Same date, amount and narrative at the bank; different stable ids.
    const t = setup();
    let run = await toHandoff(t, ["txn_same_a", "txn_same_b"]);
    run = await t.make().postingReported(run.id, run.revision, "posted");
    // A readback that collapsed them into one receipt is a mismatch.
    t.portal.state.readback = found(["txn_same_a", "txn_same_a"]);
    run = await t.make().advance(run.id);
    expect(run.attention?.reason).toBe("readback_mismatch");
    t.portal.state.readback = found(["txn_same_a"]);
    run = await t.make().advance(run.id);
    expect(run.attention?.reason).toBe("readback_mismatch");
    t.portal.state.readback = found(["txn_same_b", "txn_same_a"]);
    run = await t.make().advance(run.id);
    expect(run).toMatchObject({ step: "done", outcome: "imported" });
    expect(compareTransactionIds(["x", "x"], ["x"])).toMatchObject({ same: false, missing: ["x"] });
  });

  it("an overlapping pull keeps late postings and refuses already-imported ids", async () => {
    const t = setup();
    let run = await toHandoff(t, ["txn_1", "txn_2"]);
    run = await t.make().postingReported(run.id, run.revision, "posted");
    t.portal.state.readback = found(["txn_1", "txn_2"]);
    run = await t.make().advance(run.id);
    expect(run.outcome).toBe("imported");

    // Late-posted payment dated inside the earlier window arrives with its own id.
    t.bank.state.pulls = [{ id: "bank:batch2", transactionIds: ["txn_late", "txn_3"] }];
    let second = await t.make().start({ account: ACCOUNT, destination: DEST });
    second = await t.make().advance(second.id);
    expect(second).toMatchObject({ step: "review", attention: null, fetch: { transactionIds: ["txn_late", "txn_3"] } });
    await t.make().abandon(second.id, second.revision);

    // A source that returns an imported id again is held before upload.
    t.bank.state.pulls = [{ id: "bank:batch3", transactionIds: ["txn_2", "txn_4"] }];
    let third = await t.make().start({ account: ACCOUNT, destination: DEST });
    third = await t.make().advance(third.id);
    expect(third).toMatchObject({ step: "fetch", attention: { reason: "already_imported" } });

    const u = setup();
    u.bank.state.pulls = [{ id: "bank:dup", transactionIds: ["txn_1", "txn_1"] }];
    let dup = await u.make().start({ account: ACCOUNT, destination: DEST });
    dup = await u.make().advance(dup.id);
    expect(dup.attention?.reason).toBe("duplicate_ids");
    expect(u.portal.state.uploads).toHaveLength(0);
  });

  it("refuses an overlapping run for the same account or destination", async () => {
    const t = setup();
    await t.make().start({ account: ACCOUNT, destination: DEST });
    await expect(t.make().start({ account: ACCOUNT, destination: "rei-other" })).rejects.toMatchObject({ status: 409 });
    await expect(t.make().start({ account: "acct_other", destination: DEST })).rejects.toMatchObject({ status: 409 });
  });

  it("finishes with nothing new when the pull is empty", async () => {
    const t = setup();
    t.bank.state.pulls = [null];
    let run = await t.make().start({ account: ACCOUNT, destination: DEST });
    run = await t.make().advance(run.id);
    expect(run).toMatchObject({ step: "done", outcome: "nothing_new" });
  });

  it("a review changed after upload is held at confirm; a lost confirm reply is retried safely", async () => {
    const t = setup();
    let run = await toHandoff(t, ["txn_1"]);
    run = await t.make().postingReported(run.id, run.revision, "posted");
    t.portal.state.readback = found(["txn_1"]);
    t.bank.state.reviewed.set("bank:batch1", { batchId: "bank:batch1:r2", outputDigest: "b".repeat(64), transactionIds: ["txn_1"] });
    run = await t.make().advance(run.id);
    expect(run).toMatchObject({ step: "confirm", attention: { reason: "review_changed" } });
    expect(t.bank.state.confirmCalls).toHaveLength(0);

    t.bank.state.reviewed.set("bank:batch1", { batchId: "bank:batch1", outputDigest: DIGEST, transactionIds: ["txn_1"] });
    t.bank.state.confirmFailures = 1;
    run = await t.make().advance(run.id);
    expect(run).toMatchObject({ step: "confirm", attention: { reason: "confirm_failed" } });
    run = await t.make().advance(run.id);
    expect(run).toMatchObject({ step: "done", outcome: "imported" });
    expect(t.bank.state.confirmCalls).toHaveLength(2);
    expect(new Set(t.bank.state.confirmCalls.map(call => call.batchId))).toEqual(new Set(["bank:batch1"]));
  });

  it("a preview with warnings is never handed over for posting", async () => {
    const t = setup();
    t.bank.state.pulls = [{ id: "bank:batch1", transactionIds: ["txn_1"] }];
    t.bank.state.reviewed.set("bank:batch1", { batchId: "bank:batch1", outputDigest: DIGEST, transactionIds: ["txn_1"] });
    t.portal.setIds(["txn_1"]);
    t.portal.state.uploadBehaviour = "warn";
    let run = await t.make().start({ account: ACCOUNT, destination: DEST });
    run = await t.make().advance(run.id);
    expect(run).toMatchObject({ step: "handoff", handoff: null, attention: { reason: "preview_mismatch" } });
    run = await t.make().advance(run.id);
    expect(t.portal.state.handoffs).toBe(0);
    await expect(t.make().postingReported(run.id, run.revision, "posted")).rejects.toMatchObject({ status: 409 });
  });

  it("imports a batch with held and excluded rows: only the import file's rows are previewed, read back and confirmed", async () => {
    const t = setup();
    const pulled = ["txn_1", "txn_debit", "txn_2", "txn_unclear", "txn_3"], imported = ["txn_1", "txn_2", "txn_3"];
    t.bank.state.pulls = [{ id: "bank:mixed", transactionIds: pulled }];
    t.portal.setIds(imported);
    let run = await t.make().start({ account: ACCOUNT, destination: DEST });
    run = await t.make().advance(run.id);
    expect(run.step).toBe("review");
    t.bank.state.reviewed.set("bank:mixed", { batchId: "bank:mixed", outputDigest: DIGEST, transactionIds: imported, heldIds: ["txn_debit"], excludedIds: ["txn_unclear"] });
    run = await t.make().advance(run.id);
    expect(run).toMatchObject({ step: "handoff", attention: null, review: { importIds: imported, heldIds: ["txn_debit"], excludedIds: ["txn_unclear"] } });
    expect(run.log.map(entry => entry.event)).toContain("Review complete: 3 to import, 1 held, 1 excluded.");
    run = await t.make().postingReported(run.id, run.revision, "posted");
    t.portal.state.readback = found(imported);
    run = await t.make().advance(run.id);
    expect(run).toMatchObject({ step: "done", outcome: "imported" });
    // The held and excluded rows were never expected in REI and are not counted as imported.
    expect(run.readback!.rows.map(row => row.transactionId)).toEqual(imported);
    expect(run.fetch!.transactionIds).toEqual(pulled);
    // A later pull that offers the held debit again is not "already imported".
    t.bank.state.pulls = [{ id: "bank:next", transactionIds: ["txn_debit", "txn_4"] }];
    let next = await t.make().start({ account: ACCOUNT, destination: DEST });
    next = await t.make().advance(next.id);
    expect(next).toMatchObject({ step: "review", attention: null });
    // A review that drops a pulled row is a changed review, never an import.
    await t.make().abandon(next.id, next.revision);
    t.bank.state.pulls = [{ id: "bank:lost", transactionIds: ["txn_5", "txn_6"] }];
    let lost = await t.make().start({ account: ACCOUNT, destination: DEST });
    lost = await t.make().advance(lost.id);
    t.bank.state.reviewed.set("bank:lost", { batchId: "bank:lost", outputDigest: DIGEST, transactionIds: ["txn_5"] });
    lost = await t.make().advance(lost.id);
    expect(lost).toMatchObject({ step: "review", attention: { reason: "review_changed" } });
    // Everything held: nothing goes to REI.
    t.bank.state.reviewed.set("bank:lost", { batchId: "bank:lost", outputDigest: DIGEST, transactionIds: [], heldIds: ["txn_5", "txn_6"] });
    lost = await t.make().advance(lost.id);
    expect(lost).toMatchObject({ step: "review", attention: { reason: "nothing_to_import" } });
    expect(t.portal.state.uploads).toHaveLength(1);
  });

  it("an unmatched pending file in REI blocks a re-upload", async () => {
    const t = setup();
    t.bank.state.pulls = [{ id: "bank:batch1", transactionIds: ["txn_1"] }];
    t.bank.state.reviewed.set("bank:batch1", { batchId: "bank:batch1", outputDigest: DIGEST, transactionIds: ["txn_1"] });
    t.portal.setIds(["txn_1"]);
    t.portal.state.uploadBehaviour = "throw";
    t.portal.state.inspection = { kind: "pending_other" };
    let run = await t.make().start({ account: ACCOUNT, destination: DEST });
    run = await t.make().advance(run.id);
    expect(run).toMatchObject({ step: "check_outcome", attention: { reason: "pending_unknown" }, uncertain: { inspection: "unknown" } });
    await expect(t.make().retryUpload(run.id, run.revision)).rejects.toMatchObject({ status: 409 });
    expect(t.portal.state.uploads).toHaveLength(1);
  });

  it("concurrent advances and starts from several store instances never corrupt the saved runs", async () => {
    const dir = tempDir();
    const runs = await Promise.all(Array.from({ length: 6 }, (_, i) => createW1Workflow({ store: new W1StateStore(dir), source: fakeSource().source, rei: fakeRei().rei, today: () => "2026-10-02" })
      .start({ account: `acct_fictional_${i}`, destination: `rei-fictional-${i}` })));
    // Every run pulls nothing new; each advance writes through its own store instance.
    await Promise.all(runs.flatMap(run => [0, 1, 2].map(() => {
      const bank = fakeSource(); bank.state.pulls = [null];
      return createW1Workflow({ store: new W1StateStore(dir), source: bank.source, rei: fakeRei().rei, today: () => "2026-10-02" }).advance(run.id).catch(error => {
        // Two advances of one run can race on its revision: a 409 is the expected loser, never a damaged file.
        if (error?.status !== 409) throw error;
      });
    })));
    const saved = await new W1StateStore(dir).list();
    expect(saved).toHaveLength(6);
    expect(saved.every(run => run.step === "done" && run.outcome === "nothing_new")).toBe(true);
  });

  it("holds every run when the saved file is damaged and keeps the file", async () => {
    const dir = tempDir();
    mkdirSync(join(dir, "w1"), { mode: 0o700 });
    const path = join(dir, "w1", "runs.json");
    writeFileSync(path, JSON.stringify({ version: 1, kind: "w1-runs", runs: [{ id: "broken" }] }), { mode: 0o600 });
    const t = setup(dir);
    await expect(t.make().start({ account: ACCOUNT, destination: DEST })).rejects.toMatchObject({ status: 503 });
    expect(readFileSync(path, "utf8")).toContain("broken");
  });
});
