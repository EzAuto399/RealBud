// W1 REI bridge through the real broker and recipe runner against the
// FICTIONAL REI-style portal. No network, no REI account, no credentials:
// passing proves the binding, reconciliation and guards, never REI Cloud behaviour.
import { randomUUID } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserApprovalStore } from "./browser-authority.ts";
import { addBrowserTaskUpload, browserTaskWorkroom, BrowserRuntime } from "./browser-runtime.ts";
import { ConnectedAppOperationStore } from "./connected-app-operations.ts";
import type { PersonApprove } from "./portal-recipe-runner.ts";
import { FICTIONAL_BUSINESS, FICTIONAL_REICID, fictionalReiPack, fictionalReiPortal, type FictionalReiOptions } from "./testing/fictional-rei-portal.ts";
import { privateTempRoot, removeFixture } from "./testing/private-fixture.ts";
import { loadPortalRecipePack, loadPortalRecipePackWithPaths, loadShippedPortalRecipePack } from "./portal-recipe-task.ts";
import { LEARNED_LEAK_LABEL, LEARNED_LEAK_RECIPE, publishLearnedInDataDir, saveApprovedPathInDataDir } from "./testing/learned-recipe-fixture.ts";
import { awaitPosting, captureBaseline, nextReiStep, preview, readback, w1ArtifactSha256, w1ImportProof, w1ReadbackEvent, w1ReiGrantNeeds, w1ReiPreviewProposal, type W1ReiBatch, type W1ReiContext, type W1ReiEvent } from "./w1-rei-workflow.ts";
import { parseBrowserTaskGrant, type BrowserTaskUpload } from "../shared/browser-task.ts";

const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const load = async () => fictionalReiPack();
/** ANZ's export layout (no header, 8 columns, reference in column 8), as REI reads it with File Format ANZ(csv file). */
const CSV = '25/09/2026,"540.00",FICTIONAL PAYMENT FT-BRAVO,,,,,FT-BRAVO\n26/09/2026,"360.00",FICTIONAL PAYMENT FT-CHARLIE,,,,,FT-CHARLIE\n';
const batchFor = (bytes: string, extra: Partial<W1ReiBatch> = {}): W1ReiBatch => ({
  batchId: "fictional-batch-1", version: 1, artifact: { name: "fictional-reviewed.csv", sha256: w1ArtifactSha256(bytes) },
  destination: { portal: "rei-cloud", marker: FICTIONAL_BUSINESS }, bankFormat: "ANZ(csv file)",
  rows: [{ rowId: "r1", date: "2026-09-25", reference: "FT-BRAVO", amountCents: 54000, tenant: "Fictional Tenant Bravo", tenantId: "FTN-02" }, { rowId: "r2", date: "2026-09-26", reference: "FT-CHARLIE", amountCents: 36000, tenant: "Fictional Tenant Charlie" }],
  ...extra,
});
const CONSEQUENTIAL = ["process-receipts", "receipt-all"];

const WINDOW = { from: "2026-09-25", to: "2026-10-02" };
async function fixture(portal: FictionalReiOptions = {}, task: { stage?: "preview" | "readback" | "both"; file?: string; grantFile?: BrowserTaskUpload | null; marker?: string; operations?: ConnectedAppOperationStore } = {}) {
  const root = privateTempRoot(join(tmpdir(), "rb-w1-rei-")); cleanup.push(() => removeFixture(root));
  const mock = fictionalReiPortal(portal);
  const runtime = new BrowserRuntime({ root, command: mock.command, executable: async () => "/synthetic/bsk", startDaemon: async () => {} });
  await runtime.connect(); await runtime.select("work");
  const grantId = `grant-${randomUUID()}`;
  const workroom = browserTaskWorkroom(root, grantId);
  const added = await addBrowserTaskUpload(workroom, "fictional-reviewed.csv", Buffer.from(task.file ?? CSV));
  const stage = task.stage ?? "preview";
  const parts = await Promise.all((stage === "both" ? ["preview", "readback"] as const : [stage]).map(item => w1ReiGrantNeeds(item, load)));
  const needs = { sites: [...new Set(parts.flatMap(part => part.sites))], actions: [...new Set(parts.flatMap(part => part.actions))] };
  const text = "Fictional W1 REI task";
  const grant = parseBrowserTaskGrant({ version: 1, purpose: "browser-task-grant", id: grantId, runId: `run-${randomUUID()}`, route: "schedule", request: { text, sha256: w1ArtifactSha256(text) },
    sites: needs.sites, browser: { id: "work", accountMarker: task.marker ?? FICTIONAL_BUSINESS }, actions: needs.actions, consequential: "ask-each",
    uploads: task.grantFile === null ? [] : [task.grantFile ?? added], expiresAt: null, budget: null });
  const person = vi.fn<PersonApprove>(async () => true);
  const ctx: W1ReiContext = { grant, runtime, threadId: `thread-${grantId}`, approve: person, workroom, load,
    operations: task.operations ?? new ConnectedAppOperationStore({ file: join(root, "operations.json") }),
    approvals: new BrowserApprovalStore({ file: join(root, "approvals.json") }), rules: () => [], assertCapability: () => {}, pollMs: 0 };
  return { root, mock, runtime, ctx, person, workroom };
}

// The real loaders, wrapped so a test can see which one W1 used and what it got.
vi.mock("./portal-recipe-task.ts", async importOriginal => {
  const real = await importOriginal<typeof import("./portal-recipe-task.ts")>();
  return { ...real, loadPortalRecipePack: vi.fn(real.loadPortalRecipePack), loadShippedPortalRecipePack: vi.fn(real.loadShippedPortalRecipePack),
    loadPortalRecipePackWithPaths: vi.fn(real.loadPortalRecipePackWithPaths) };
});

describe("W1 REI preview", () => {
  it("uploads the exact reviewed file after the person's once-only approval, reconciles every row and hands posting over", async () => {
    const f = await fixture();
    const batch = batchFor(CSV);
    const result = await preview(batch, f.ctx);
    expect(result.status, JSON.stringify(result.run?.detail ?? result.reconciliation?.warnings)).toBe("ready");
    expect(result.reconciliation).toMatchObject({ ready: true, totals: { expectedRows: 2, previewRows: 2, expectedCents: 90000, previewCents: 90000 } });
    expect(result.stopBefore).toEqual(expect.arrayContaining(["Process Receipts", "Receipt All"]));
    // The upload went to the person; Bud pressed nothing that posts.
    expect(f.person.mock.calls.map(call => call[0])).toContain("browser_upload");
    expect(f.mock.effects).toEqual(["upload"]);
    expect(f.mock.calls.filter(args => args[0] === "upload")).toHaveLength(1);
    const handoff = await awaitPosting(batch, result, load);
    expect(handoff).toMatchObject({ rows: 2, totalCents: 90000, artifact: batch.artifact, personActions: expect.arrayContaining(["Process Receipts", "Receipt All", "Post", "Finalise"]) });
    expect(handoff.message).toContain("Posting is yours");
    expect(nextReiStep([{ kind: "preview", status: "ready" }]).step).toBe("await-posting");
    // A handoff is refused for another batch version or file.
    await expect(awaitPosting({ ...batch, version: 2 }, result, load)).rejects.toThrow(/different batch/);
  });

  it("holds a preview that differs row by row and never re-uploads to try again", async () => {
    const f = await fixture({ previewEdit: rows => [[...rows[0].slice(0, 4), "450.00", rows[0][5]], ["25/09/2026", "UNKNOWN REF", "", "", "75.00", "Unmatched"]] });
    const batch = batchFor(CSV);
    const result = await preview(batch, f.ctx);
    expect(result.status).toBe("mismatch");
    expect(result.reconciliation?.mismatched.map(item => [item.expected.rowId, item.fields])).toEqual([["r1", ["amount"]]]);
    expect(result.reconciliation?.missing.map(row => row.rowId)).toEqual(["r2"]);
    expect(result.reconciliation?.extra.map(row => row.reference)).toEqual(["UNKNOWN REF"]);
    await expect(awaitPosting(batch, result, load)).rejects.toThrow(/does not match/);
    expect(nextReiStep([{ kind: "preview", status: "mismatch" }])).toMatchObject({ step: "hold", uploadAllowed: false });
    expect(f.mock.effects).toEqual(["upload"]);
  });

  it("refuses before the browser when the grant's file is not the reviewed artifact, or the copy changed", async () => {
    const other = await fixture({}, { grantFile: { name: "fictional-reviewed.csv", sha256: w1ArtifactSha256("different bytes") } });
    expect(await preview(batchFor(CSV), other.ctx)).toMatchObject({ status: "not-uploaded", reason: "artifact-differs" });
    const none = await fixture({}, { grantFile: null });
    expect(await preview(batchFor(CSV), none.ctx)).toMatchObject({ status: "not-uploaded", reason: "artifact-not-granted" });
    const changed = await fixture();
    const path = join(changed.workroom, "uploads", "fictional-reviewed.csv");
    chmodSync(path, 0o600); writeFileSync(path, CSV.replace('"540.00"', '"5400.00"'));
    expect(await preview(batchFor(CSV), changed.ctx)).toMatchObject({ status: "not-uploaded", reason: "artifact-changed" });
    for (const f of [other, none, changed]) { expect(f.mock.calls.some(args => args[0] === "session")).toBe(false); expect(f.mock.effects).toEqual([]); }
  });

  it("blocks a grant bound to another REI account, and stops when the business switches mid-run", async () => {
    const wrong = await fixture({}, { marker: "FICT2" });
    expect(await preview(batchFor(CSV), wrong.ctx)).toMatchObject({ status: "not-uploaded", reason: "destination-not-bound" });
    expect(wrong.mock.calls.some(args => args[0] === "session")).toBe(false);
    // Switched before the upload: nothing left RealBud.
    const before = await fixture({ switchBusinessAfterSteps: 1 });
    expect(await preview(batchFor(CSV), before.ctx)).toMatchObject({ status: "not-uploaded", reason: "account-marker-changed" });
    expect(before.mock.effects).toEqual([]);
    // Switched right after the upload: the file reached the portal, so its outcome is unknown.
    const after = await fixture({ switchBusinessAfterSteps: 3 });
    const result = await preview(batchFor(CSV), after.ctx);
    expect(after.mock.effects).toEqual(["upload"]);
    expect(result).toMatchObject({ status: "unknown-upload" });
    expect(nextReiStep([{ kind: "preview", status: "unknown-upload" }])).toMatchObject({ step: "readback", uploadAllowed: false });
  });

  it("an unknown upload result leads to a readback before any retry, never a blind re-upload", async () => {
    const operations = new ConnectedAppOperationStore({ file: join(privateTempRoot(join(tmpdir(), "rb-w1-ops-")), "operations.json") });
    const f = await fixture({ unknownUpload: true }, { operations });
    const batch = batchFor(CSV);
    const first = await preview(batch, f.ctx);
    expect(first).toMatchObject({ status: "unknown-upload", reason: "unknown-result" });
    // The same task thread refuses a second upload outright.
    expect(await preview(batch, f.ctx)).toMatchObject({ status: "unknown-upload", reason: "earlier-upload-unknown" });
    expect(f.mock.calls.filter(args => args[0] === "upload")).toHaveLength(1);
    const events = [{ kind: "preview" as const, status: first.status }];
    expect(nextReiStep(events)).toMatchObject({ step: "readback", uploadAllowed: false });
    expect(nextReiStep([...events, { kind: "retry-approved" }])).toMatchObject({ step: "readback", uploadAllowed: false });
    // An empty readback leaves the decision to the person; a partial one ends uploads for this batch.
    const empty = { kind: "readback" as const, complete: false, accepted: 0, rejected: 0, pending: 2, registerComplete: true, absent: true };
    const clear = { kind: "pending-inspection" as const, pending: 0 };
    expect(nextReiStep([...events, empty])).toMatchObject({ step: "hold", uploadAllowed: false });
    expect(nextReiStep([...events, empty, clear, { kind: "retry-approved" }])).toMatchObject({ step: "preview", uploadAllowed: true });
    expect(nextReiStep([...events, { ...empty, accepted: 1, pending: 1 }, clear, { kind: "retry-approved" }])).toMatchObject({ step: "hold", uploadAllowed: false });
  });

  it("a person-approved retry needs a complete, scoped register showing nothing and an empty pending-import inspection", () => {
    const unknown: W1ReiEvent = { kind: "preview", status: "unknown-upload" };
    const empty = { kind: "readback" as const, complete: false, accepted: 0, rejected: 0, pending: 2, registerComplete: true, absent: true };
    const retry: W1ReiEvent = { kind: "retry-approved" };
    const stays = (events: W1ReiEvent[]) => expect(nextReiStep(events)).toMatchObject({ step: "readback", uploadAllowed: false });
    stays([unknown, empty, retry]);                                                        // no pending-import inspection
    stays([unknown, empty, { kind: "pending-inspection", pending: 1 }, retry]);            // something is pending
    stays([unknown, empty, { kind: "pending-inspection", pending: null }, retry]);         // could not tell
    stays([unknown, { kind: "pending-inspection", pending: 0 }, empty, retry]);            // inspection older than the readback
    stays([unknown, { ...empty, registerComplete: false }, { kind: "pending-inspection", pending: 0 }, retry]);
    stays([unknown, { ...empty, absent: false }, { kind: "pending-inspection", pending: 0 }, retry]);
    stays([unknown, { kind: "readback", complete: false, accepted: 0, rejected: 0, pending: 2 }, { kind: "pending-inspection", pending: 0 }, retry]); // an event saved before these fields
    expect(nextReiStep([unknown, empty, { kind: "pending-inspection", pending: 0 }, retry])).toMatchObject({ step: "preview", uploadAllowed: true });
  });

  it("an upload lost before REI accepted it leaves nothing pending; one lost after leaves a pending import that persists", async () => {
    const before = await fixture({ unknownUpload: "before" });
    expect(await preview(batchFor(CSV), before.ctx)).toMatchObject({ status: "unknown-upload" });
    expect(before.mock.pendingUpload()).toBeNull();
    const after = await fixture({ unknownUpload: "after" });
    expect(await preview(batchFor(CSV), after.ctx)).toMatchObject({ status: "unknown-upload" });
    expect(after.mock.pendingUpload()?.rows.map(row => [row.reference, row.match])).toEqual([["FT-BRAVO", "Matched"], ["FT-CHARLIE", "Matched"]]);
    // An empty register is not proof of absence while the import is pending.
    after.mock.post({ date: "2026-10-01" });
    expect(after.mock.pendingUpload()).toBeNull();
  });

  it("the chosen File Format governs parsing, and ambiguous or vacated references never match", async () => {
    // RealBud's Redbark layout: quoted cells, a comma inside the narrative.
    const redbark = '"Date","Amount","Narrative","Reference"\r\n"2026-09-25","540.00","FICTIONAL PAYER, RENT","FT-BRAVO"\r\n"2026-09-26","360.00","FICTIONAL PAYER","4470003"\r\n';
    const custom = await fixture({}, { file: redbark });
    const ok = await preview(batchFor(redbark, { bankFormat: "Custom(csv file)", rows: [{ ...batchFor(CSV).rows[0] }, { ...batchFor(CSV).rows[1], reference: "4470003" }] }), custom.ctx);
    expect(ok.status, JSON.stringify(ok.reconciliation)).toBe("ready");
    const anz = await fixture({}, { file: redbark });
    const wrong = await preview(batchFor(redbark, { bankFormat: "ANZ(csv file)" }), anz.ctx);
    expect(wrong).toMatchObject({ status: "mismatch", reconciliation: { matched: [], totals: { previewRows: 0 } } });
    expect(anz.mock.pendingUpload()).toBeNull();
    // An offered format the fictional portal has no parser for is refused, never guessed.
    const westpac = await fixture({}, { file: CSV });
    expect(await preview(batchFor(CSV, { bankFormat: "Westpac(csv file)" }), westpac.ctx)).toMatchObject({ status: "mismatch", reconciliation: { totals: { previewRows: 0 } } });
    // 4470067 is shared by two active tenancies; FT-INDIA's tenancy is vacated.
    const file = '25/09/2026,"78.00",FICTIONAL PAYMENT,,,,,4470067\n26/09/2026,"60.00",FICTIONAL PAYMENT,,,,,FT-INDIA\n';
    const unclear = await fixture({}, { file });
    const held = await preview(batchFor(file, { rows: [{ rowId: "g", date: "2026-09-25", reference: "4470067", amountCents: 7800, tenant: "Fictional Tenant Golf" }, { rowId: "i", date: "2026-09-26", reference: "FT-INDIA", amountCents: 6000, tenant: "Fictional Tenant India" }] }), unclear.ctx);
    expect(held.status).toBe("mismatch");
    expect(held.reconciliation?.mismatched.map(item => [item.expected.rowId, item.fields, item.actual.match])).toEqual([["g", ["tenant"], "Ambiguous"], ["i", ["tenant"], "Vacated"]]);
  });

  it("the Ask card binds the artifact and destination", async () => {
    const batch = { ...batchFor(CSV), destination: { portal: "rei-cloud" as const, urlValue: FICTIONAL_REICID, marker: FICTIONAL_BUSINESS } };
    // A business-code-only card (no saved reicid) is accepted; the marker stays the account check.
    const markerOnly = await w1ReiPreviewProposal(batchFor(CSV), { threadId: "thread-w1", messageId: "m1" }, load);
    expect(markerOnly.recipe.account).toMatchObject({ marker: FICTIONAL_BUSINESS });
    const card = await w1ReiPreviewProposal(batch, { threadId: "thread-w1", messageId: "m1" }, load);
    expect(card.actions).toContain("upload");
    expect(card.recipe.account).toEqual({ urlValue: FICTIONAL_REICID, marker: FICTIONAL_BUSINESS });
    expect(card.recipe.runs[1].inputs).toMatchObject({ approved_file: "fictional-reviewed.csv", approved_sha256: batch.artifact.sha256, expected_rows: "2", expected_total: "900.00" });
    expect(card.request).toContain(batch.artifact.sha256);
    expect(card.request).toContain("posting stays with you");
  });
});

describe("W1 REI readback", () => {
  async function posted(status?: (row: { reference: string }) => string) {
    const f = await fixture({}, { stage: "both" });
    const batch = batchFor(CSV);
    const base = await captureBaseline(batch, f.ctx, WINDOW);
    expect(base.status, base.status === "not-read" ? base.detail : "").toBe("read");
    expect((await preview(batch, f.ctx)).status).toBe("ready");
    f.mock.post({ date: "2026-10-01", ...(status ? { status } : {}) });
    return { f, batch, baseline: base.status === "read" ? base.baseline : undefined };
  }
  it("reads the Receipt Register after the person posts and classifies each row", async () => {
    const { f, batch, baseline } = await posted(row => row.reference === "FT-CHARLIE" ? "Reversed" : "Receipted");
    const result = await readback(batch, f.ctx, WINDOW, baseline);
    expect(result.status, result.detail).toBe("read");
    expect(result.readback).toMatchObject({ scope: "verified", registerComplete: true, accepted: 1, rejected: 1, pending: 0, complete: false });
    expect(result.readback?.outcomes.map(item => [item.rowId, item.outcome])).toEqual([["r1", "accepted"], ["r2", "rejected"]]);
    expect(f.person.mock.calls.map(call => call[0])).toContain("browser_download");
    expect(f.mock.effects.filter(effect => CONSEQUENTIAL.includes(effect))).toEqual([]);
    expect(f.mock.calls.filter(args => args[0] === "upload")).toHaveLength(1);
    expect(nextReiStep([{ kind: "preview", status: "ready" }, { kind: "posting-reported", posted: true }, w1ReadbackEvent(result)]).step).toBe("hold");
    expect(() => w1ImportProof(batch, result)).toThrow(/does not show every row/);
  });

  it("a fully accepted, scoped, baselined register completes the batch and issues the import proof", async () => {
    const { f, batch, baseline } = await posted();
    const result = await readback(batch, f.ctx, WINDOW, baseline);
    expect(result.readback).toMatchObject({ accepted: 2, complete: true, historical: 1 });
    expect(result.readback?.outcomes.map(item => item.register?.receiptId)).toEqual(["FR-0004", "FR-0005"]);
    expect(nextReiStep([{ kind: "preview", status: "ready" }, { kind: "posting-reported", posted: true }, w1ReadbackEvent(result)]).step).toBe("done");
    expect(w1ImportProof(batch, result)).toEqual({ kind: "w1-rei-import-proof", batchId: batch.batchId, version: 1, artifactSha256: batch.artifact.sha256,
      destination: { portal: "rei-cloud", marker: FICTIONAL_BUSINESS }, rowIds: ["r1", "r2"] });
    expect(() => w1ImportProof({ ...batch, version: 2 }, result)).toThrow(/different batch/);
  });

  it("an older receipt with the same reference and amount never completes the batch; the register is filtered by account and date", async () => {
    // Before posting: FR-0002 (FT-BRAVO 540.00, 26 Sep) is history; FR-0003 belongs to another business; FR-0001 is outside the window.
    const f = await fixture({}, { stage: "both" });
    const batch = batchFor(CSV);
    const base = await captureBaseline(batch, f.ctx, WINDOW);
    if (base.status !== "read") throw new Error(base.detail);
    expect(base.baseline.receipts).toEqual(["id:FR-0002"]);
    const unposted = await readback(batch, f.ctx, WINDOW, base.baseline);
    expect(unposted.readback).toMatchObject({ accepted: 0, pending: 2, complete: false, absent: true, historical: 1 });
    // Without the baseline the old receipt looks like this batch: never complete, never proof of absence.
    const blind = await readback(batch, f.ctx, WINDOW);
    expect(blind.readback).toMatchObject({ accepted: 1, complete: false, absent: false });
    expect(blind.readback?.outcomes.map(item => [item.rowId, item.outcome, item.register?.receiptId ?? null])).toEqual([["r1", "accepted", "FR-0002"], ["r2", "pending", null]]);
  });

  it("does not read when the account switches, and a person who declines the export leaves the outcome unread", async () => {
    const switched = await fixture({ directBusiness: "FICT2" }, { stage: "readback" });
    expect(await readback(batchFor(CSV), switched.ctx, WINDOW)).toMatchObject({ status: "not-read", reason: "account-marker-changed" });
    const declined = await fixture({}, { stage: "readback" });
    declined.person.mockImplementation(async () => false);
    expect(await readback(batchFor(CSV), declined.ctx, WINDOW)).toMatchObject({ status: "not-read" });
    expect(await captureBaseline(batchFor(CSV), declined.ctx, WINDOW)).toMatchObject({ status: "not-read" });
    await expect(readback(batchFor(CSV), declined.ctx, { from: "2026-10-02", to: "2026-09-25" })).rejects.toThrow(/dates/);
  });
});

describe("W1 REI and watch-and-learn recipes", () => {
  it("grant needs and the preview card keep approved paths but never learned recipes when no loader is given", async () => {
    const forget = await publishLearnedInDataDir();
    const restore = await saveApprovedPathInDataDir();
    try {
      expect((await loadPortalRecipePack("rei-cloud")).recipes[LEARNED_LEAK_RECIPE]).toBeDefined();
      const shipped = await loadShippedPortalRecipePack("rei-cloud");
      vi.mocked(loadPortalRecipePack).mockClear(); vi.mocked(loadPortalRecipePackWithPaths).mockClear();
      await w1ReiGrantNeeds("preview");
      await w1ReiPreviewProposal(batchFor(CSV), { threadId: "thread-w1", messageId: "m1" });
      expect(loadPortalRecipePack).not.toHaveBeenCalled();
      expect(loadPortalRecipePackWithPaths).toHaveBeenCalledTimes(2);
      for (const { value } of vi.mocked(loadPortalRecipePackWithPaths).mock.results) {
        const used = await value;
        expect(used.recipes["tenant-list"].steps).toContainEqual({ download: { label: "Export" } }); // the approved path
        expect(Object.keys(used.recipes).filter(name => name.startsWith("learned-"))).toEqual([]);
        expect(used.labels.readSafe).toEqual(shipped.labels.readSafe);
        expect(used.labels.readSafe).not.toContain(LEARNED_LEAK_LABEL);
        expect(JSON.stringify(used)).not.toContain(LEARNED_LEAK_LABEL); // not read-safe, not a learned set, not a recipe's `confirmed`
      }
    } finally { forget(); await restore(); }
  });
});
