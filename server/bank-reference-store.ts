import { bankBatchSource, bankDigest, bankImportArtifact, createBankReferenceBatch, decisionDisposition, decodeBankSource, reviewBankReferences, withTenantDirectory, type BankReferenceBatch, type BankReferenceInput, type BankReferenceUpload, type BankReferenceDecision } from "./bank-reference.ts";
import { isLocalDate, REDBARK_ACCOUNT_ID, REDBARK_CONNECTION_ID, REDBARK_TRANSACTION_ID, type BankDownloadArtifact, type RedbarkBatchProvenance } from "../shared/bank-source.ts";
import { join } from "node:path";
import { readPrivateJson, writePrivateJson } from "./private-json.ts";
import { WorkflowDatabase, workflowConflict } from "./workflow-database.ts";
import type { BankBatchSummary, BankHistoryPage, BankHistoryQuery } from '../shared/bank-reference-history.ts';
import { validateSavedBankBatch, validateBankReviewLinks, BANK_TENANT_SOURCE_KIND } from './bank-reference-validation.ts';
import { bankReviewId, bankReviewVersion, type BankReviewAmendment, type BankReviewSuccessor } from '../shared/bank-review.ts';
import type { W1ImportProof } from './w1-rei-workflow.ts';
import { bankFirstPass, jevPayerHints } from './bank-reference-match.ts';
import type { JevRequest, JevResult } from './jev-client.ts';
import type { RunUsage } from '../shared/contracts.ts';
import { countJevUsage, emptyRunUsage } from './run-cost.ts';
import { createTenantDirectoryStore, tenantDirectoryCsv, tenantListHash } from './tenant-directory.ts';

/** Where a batch's REI tenants came from, recorded when the batch is created: the office's saved REI tenant list
 * (its savedAt, and the property ids whose rules it supplied) or only the office's own rules. */
export type BankTenantSource = { source: 'bank-rules' } | { source: 'rei-directory'; savedAt: number; propertyIds: string[]; /** tenantListHash of the list used. */ hash?: string };
const TENANT_SOURCE = BANK_TENANT_SOURCE_KIND;
const OLDER_TENANT_LIST = 'This review was made with an older REI tenant list. Correct the mapping before preparing it again.';

const invalidPage = (): never => { throw Object.assign(new Error('The bank history page is invalid. Refresh the history and try again.'), { status: 400 }); };
type Cursor = { version: 1; kind: 'bank-history'; high: number; before: number };
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');

export interface SavedBankBatch {
  version: 1 | 2; createdAt: number; reviewedAt?: number;
  batch: BankReferenceBatch;
  /** Absent on historical reviews which retained only changed-row reasons. */
  decisions?: BankReferenceDecision[];
  legacyDecisionsUnavailable?: true;
  amends?: BankReviewAmendment;
  supersededBy?: BankReviewSuccessor;
  result?: Pick<ReturnType<typeof reviewBankReferences>, "csv" | "changes" | "originalDigest" | "outputDigest"> & Partial<Pick<ReturnType<typeof reviewBankReferences>, "bytesBase64" | "byteLength" | "encoding">>;
  /** Jev payer hints, asked once when the batch was imported (`addJevHints`).
   * Suggestions only: shown with hintSource "jev", never a match or an import. */
  jevHints?: BankJevHint[];
  /** The hint pass's Jev calls (Modelvia request ids, model, tokens), saved with
   * its hints so the upload's AI cost can be read; never the state or answers. */
  jevUsage?: RunUsage;
}
export interface BankJevHint { rowId: string; propertyId: string; suggestion: string }
type JevDecide = (request: JevRequest, options?: { signal?: AbortSignal; prefer?: "jev" | "luna" }) => Promise<JevResult>;
/** The whole hint pass, every row included; rows Jev has not answered by then stay unhinted. */
const JEV_HINTS_MS = 15_000;
export class BankReferenceStore {
  private db: WorkflowDatabase;
  private decide?: JevDecide;
  private jevReady: () => boolean;
  /** `decide`: Jev. `ready` is read on each hint pass (the office's model and key can
   * change after this store is made); no hint pass runs without both. */
  constructor(db: WorkflowDatabase, options: { decide?: JevDecide; ready?: () => boolean } = {}) {
    this.db = db; this.decide = options.decide; this.jevReady = options.ready ?? (() => true);
  }
  private validated(record: { id: string; revision: number; value: SavedBankBatch }) {
    if (!Number.isSafeInteger(record.revision) || record.revision < 1) throw Object.assign(new Error('This saved bank review needs recovery.'),{status:503});
    validateBankReviewLinks(record,id=>this.db.get<SavedBankBatch>('bank',id));
    return record;
  }
  settings() {
    return this.db.transaction(() => {
      return this.db.projectPage<SavedBankBatch,Pick<BankReferenceInput,'columns'|'dateFormat'|'rules'>>('bank',{limit:1},row => {
        const latest = this.validated(row).value.batch.input;
        return { columns: latest.columns, dateFormat: latest.dateFormat, rules: latest.rules };
      }).records[0] ?? null;
    });
  }
  page(query: BankHistoryQuery = {}): BankHistoryPage {
    const limit = query.limit === undefined ? 20 : query.limit;
    if (Object.keys(query).some(key => !['cursor','limit'].includes(key)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) return invalidPage();
    return this.db.transaction(() => {
      const currentHigh = this.db.highWatermark('bank');
      let cursor: Cursor = {version:1,kind:'bank-history',high:currentHigh,before:currentHigh};
      if (query.cursor !== undefined) {
        try {
          const raw = query.cursor;
          if (typeof raw !== 'string' || !raw || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw) || Buffer.from(raw,'base64url').toString('base64url') !== raw) return invalidPage();
          cursor = JSON.parse(Buffer.from(raw,'base64url').toString('utf8')) as Cursor;
          if (!cursor || Object.keys(cursor).sort().join(',') !== 'before,high,kind,version' || cursor.version !== 1 || cursor.kind !== 'bank-history' ||
              !Number.isSafeInteger(cursor.high) || !Number.isSafeInteger(cursor.before) || cursor.high < 1 || cursor.high > currentHigh || cursor.before < 1 || cursor.before > cursor.high) return invalidPage();
        } catch { return invalidPage(); }
      }
      const page = this.db.projectPage<SavedBankBatch,BankBatchSummary>('bank',{before:cursor.before,limit},record => {
        const {id,revision,value} = this.validated(record);
        return {id,revision,createdAt:value.createdAt,reviewedAt:value.reviewedAt,rows:value.batch.rows.length,originalDigest:value.batch.originalDigest,outputDigest:value.result?.outputDigest,
          ...(value.supersededBy ? {supersededBy:value.supersededBy.id} : {})};
      });
      return { version:2, batches:page.records, total:this.db.count('bank',cursor.high), nextCursor:page.next === null ? null : encode({...cursor,before:page.next}) };
    });
  }
  /** Complete compatibility reader. HTTP uses page() to keep each response bounded. */
  list(): BankBatchSummary[] {
    return this.db.transaction(() => {
      const rows: BankBatchSummary[] = [];let cursor: string | undefined;
      do { const page = this.page({cursor,limit:100}); rows.push(...page.batches); cursor = page.nextCursor ?? undefined; } while(cursor);
      return rows;
    });
  }
  get(id: string) { return this.view(this.load(id)); }
  private load(id: string) {
    const record = this.db.get<SavedBankBatch>("bank", id);
    if (!record) throw Object.assign(new Error("That bank review is no longer available."), { status: 404 });
    if (Number.isInteger(record.value?.version) && record.value.version > 2) throw Object.assign(new Error("This bank review needs a newer RealBud version."), { status: 409 });
    return this.validated(record);
  }
  /** A review as shown to the person: the saved record plus the first-pass
   * suggestions, derived from the saved batch on every read and never stored,
   * with any saved Jev hints laid on top. Reading never asks Jev. */
  private view<T extends { value: SavedBankBatch }>(record: T) {
    const firstPass = bankFirstPass(record.value.batch);
    for (const hint of record.value.jevHints ?? []) {
      const row = firstPass?.rows.find(item => item.rowId === hint.rowId);
      if (row && !row.propertyId && !row.suggestion) Object.assign(row, { propertyId: hint.propertyId, suggestion: hint.suggestion, hintSource: "jev" as const });
    }
    return { ...record, firstPass };
  }
  /** Ask Jev once for payer hints on a freshly imported, unreviewed batch and
   * save them with it; returns the batch as shown. Call before the batch is
   * handed to anyone (the saved revision moves), and only when `upload` or
   * `createFromRedbark` reported `created` (a re-upload reuses the record and is
   * never asked again). Only a record still at its
   * first revision with no hints, decisions or review is asked, so re-uploading
   * the same file never moves a revision a reviewer holds. Never throws for Jev:
   * without `decide` or readiness, on no answer or an error, the batch stays
   * unhinted; when the time budget runs out, the answers already given (and
   * billed) are kept. A batch changed meanwhile keeps no hints. */
  async addJevHints(id: string, options: { timeoutMs?: number } = {}) {
    const decide = this.decide;
    try {
      const record = this.load(id), { value } = record;
      const fresh = record.revision === 1 && !value.jevHints && !value.decisions && !value.result && !value.reviewedAt && !value.supersededBy && !value.amends;
      const pass = decide && fresh && this.jevReady() ? bankFirstPass(value.batch) : null;
      if (!decide || !pass) return this.view(record);
      const signal = AbortSignal.timeout(options.timeoutMs ?? JEV_HINTS_MS);
      let answered = 0; const usage = emptyRunUsage();
      await jevPayerHints(value.batch, pass, countJevUsage(usage, async (request: JevRequest, asked?: Parameters<JevDecide>[1]) => { const result = await decide(request, asked); if (result.ok) answered++; return result; }), { signal });
      if (!answered) return this.view(record);
      const jevHints = pass.rows.flatMap((row): BankJevHint[] => row.hintSource === "jev" ? [{ rowId: row.rowId, propertyId: row.propertyId!, suggestion: row.suggestion! }] : []);
      return this.view(this.validated(this.db.update<SavedBankBatch>("bank", id, record.revision, value => ({ ...value, jevHints, jevUsage: usage }))));
    } catch {
      // A conflict, a failed write or a Jev error: the batch as it is now, hints or not.
      return this.get(id);
    }
  }
  /** `tenantList`: an REI Tenants export (CSV text) used as this batch's directory, the
   * given rules as fallback. The merged rules are saved in the batch, so preparing the
   * same file again with a different list meets the existing-review conflict below. */
  create(input: (BankReferenceInput | BankReferenceUpload) & { tenantList?: unknown }) {
    return this.upload(input).review;
  }
  /** `create`, also saying whether this call made the record (`created`) or reused
   * the saved review of the same file. Only a created record gets the Jev hint pass. */
  upload(input: (BankReferenceInput | BankReferenceUpload) & { tenantList?: unknown }) {
    // Source provenance is set only by the server's own Redbark pull.
    if (input && typeof input === "object" && "source" in input && input.source && typeof input.source === "object" && "provenance" in input.source) {
      throw Object.assign(new Error("Choose the original bank CSV. A bank source record cannot be uploaded."), { status: 400 });
    }
    // An uploaded file is never a W1 import (W1 imports only Redbark batches), so no import holds it.
    const { record, created } = this.save(...this.withSavedTenants(input), () => false);
    return { review: this.view(record), created };
  }
  /** Without a tenant list in the request, the office's saved REI tenant list (server/tenant-directory.ts)
   * is the batch's directory, with the given rules as the fallback, exactly as an uploaded list would be. */
  private withSavedTenants<T extends { rules: BankReferenceInput['rules'] }>(input: T & { tenantList?: unknown }): [T, BankTenantSource | null] {
    if (input && typeof input === 'object' && !('tenantList' in input) && Array.isArray(input.rules)) {
      const saved = createTenantDirectoryStore(this.db).read().directory;
      if (saved) {
        const merged = withTenantDirectory({ ...input, tenantList: tenantDirectoryCsv(saved.tenants) }), references = new Set(saved.tenants.map(tenant => tenant.reference));
        return [merged, { source: 'rei-directory', savedAt: saved.savedAt, propertyIds: merged.rules.filter(rule => references.has(rule.reference)).map(rule => rule.propertyId), hash: tenantListHash(saved.tenants) }];
      }
      return [input, { source: 'bank-rules' }];
    }
    // A tenant list sent with the request has no saved date: recorded as unknown, which W1 gates like a stale list.
    return [withTenantDirectory(input), null];
  }
  /** The tenant source recorded when this batch was created; null for a batch created before sources were recorded. */
  tenantSource(id: string): BankTenantSource | null {
    return this.db.get<BankTenantSource>(TENANT_SOURCE, `${TENANT_SOURCE}:${id}`)?.value ?? null;
  }
  /** Internal: a batch generated from validated Redbark rows; `created` as in `upload`. `openImport`: whether a
   * W1 import that is not abandoned holds this batch id (a caller that can't tell is treated as yes). */
  createFromRedbark(input: BankReferenceUpload, openImport: (batchId: string) => boolean = () => true) {
    if (!input?.source?.provenance) throw Object.assign(new Error("The bank source record failed its integrity check."), { status: 400 });
    const [merged, tenantSource] = this.withSavedTenants(input);
    const { record, created } = this.save(merged, tenantSource, openImport);
    return { ...record, created };
  }
  /** The REI import file of a reviewed batch: only its import rows, with every source row's disposition. */
  importArtifact(id: string) {
    const { value } = this.load(id);
    if (!value.result) throw Object.assign(new Error("Review every transaction before preparing the REI import file."), { status: 409 });
    // Reviews that kept only changed rows: a changed reference was an assignment, everything else was kept (now: held).
    const decisions = value.decisions ?? value.batch.rows.map((row): BankReferenceDecision => {
      const change = value.result!.changes.find(item => item.rowId === row.id);
      const rule = change && value.batch.input.rules.find(item => item.reference === change.to);
      return rule ? { rowId: row.id, action: "assign", propertyId: rule.propertyId, reason: change!.reason } : { rowId: row.id, action: "keep", reason: "Earlier review kept this row." };
    });
    const result = bankImportArtifact(value.batch, decisions);
    return { ...result, artifact: result.artifact && { ...result.artifact, filename: `REI-import-${result.artifact.digest.slice(0, 12)}.csv` } };
  }
  /** The REI import of a reviewed Redbark batch was read back complete by the W1
   * workflow: advance that account's coverage. Nothing else moves it. `proof` must
   * be the host's own W1ImportProof for this batch, its import file and REI account
   * (the host hands it over only while it matches the saved account: sameW1Destination). */
  async confirmRedbarkImport(coverage: RedbarkCoverage, id: unknown, expectedRevision: unknown, proof?: W1ImportProof | null) {
    if (typeof id !== "string") throw Object.assign(new Error("Choose the reviewed bank batch whose import was confirmed."), { status: 400 });
    const { value } = this.load(id);
    const provenance = value.batch.source?.provenance;
    if (!provenance) throw Object.assign(new Error("This review did not come from the Redbark bank source."), { status: 409 });
    if (value.supersededBy) throw Object.assign(new Error("This review was replaced. Confirm the import of its newest version."), { status: 409 });
    if (!value.result) throw Object.assign(new Error("Review every transaction and prepare the REI file before confirming its import."), { status: 409 });
    const file = this.importArtifact(id);
    const imported = file.rows.filter(row => row.disposition === "import").map(row => row.rowId);
    const destination = proof?.destination;
    if (!proof || proof.kind !== "w1-rei-import-proof" || proof.batchId !== id || proof.version !== bankReviewVersion(id) || !file.artifact || proof.artifactSha256 !== file.artifact.digest ||
        destination?.portal !== "rei-cloud" || (destination.urlValue !== undefined && (typeof destination.urlValue !== "string" || !destination.urlValue.trim())) || typeof destination.marker !== "string" || !destination.marker.trim() ||
        !Array.isArray(proof.rowIds) || proof.rowIds.length !== imported.length || [...proof.rowIds].sort().join("\n") !== [...imported].sort().join("\n"))
      throw Object.assign(new Error("REI's Receipt Register has not been read back complete for this batch's import file and REI account. Coverage was not advanced."), { status: 409 });
    // Held rows stay out of the confirmed set and are carried into every later
    // pull until a person imports or excludes them, however old they get.
    const settled = value.batch.rows.flatMap((_, index) => file.rows[index].disposition === "hold" ? [] : [index]);
    const held: Record<string, RedbarkHeldRow> = {};
    value.batch.rows.forEach((row, index) => { if (file.rows[index].disposition === "hold") held[provenance.transactionIds[index]] = { date: row.date, amount: row.amount, narrative: row.narrative, reference: row.reference, heldSince: provenance.runDate }; });
    return coverage.confirm({ ...provenance, transactionIds: settled.map(index => provenance.transactionIds[index]) }, id, settled.map(index => value.batch.rows[index].date), expectedRevision, held);
  }
  private save(input: BankReferenceInput | BankReferenceUpload, tenantSource: BankTenantSource | null, openImport: (batchId: string) => boolean) {
    const batch = createBankReferenceBatch(input);
    // Repeated downloads of the exact same file reuse the existing review.
    const id = `bank:${batch.originalDigest}`;
    return this.db.transaction(() => {
      // `created`: this call made the record (only then may the caller run the Jev hint pass).
      const created = !this.db.get("bank", id);
      const saved = this.validated(this.db.create<SavedBankBatch>("bank", id, { version: 2, createdAt: Date.now(), batch }, null));
      const recorded = created ? null : this.db.get<BankTenantSource>(TENANT_SOURCE, `${TENANT_SOURCE}:${id}`);
      if (recorded?.value.source === "rei-directory" && recorded.value.hash !== undefined && tenantSource?.source === "rei-directory" && tenantSource.hash !== undefined && recorded.value.hash !== tenantSource.hash) {
        // The saved review was built from an older REI tenant list. A person's correction (a newer review) stands as it is.
        if (saved.value.supersededBy) return { record: saved, created: false };
        const value = saved.value;
        if (value.decisions || value.result || value.reviewedAt || openImport(id)) throw Object.assign(new Error(OLDER_TENANT_LIST), { status: 409 });
        // Untouched by a person and held by no open import: rebuilt from the current list as a new revision of the same
        // record. The id stays the source file's digest, so a later pull of the same rows finds it again; the revision move
        // refuses a racing writer; nobody holds the old revision. Not a new record, so Jev is not asked again (old hints
        // named the old matching and are dropped).
        const rebuilt = this.validated(this.db.update<SavedBankBatch>("bank", id, saved.revision, ({ jevHints: _, ...rest }) => ({ ...rest, batch })));
        this.db.update<BankTenantSource>(TENANT_SOURCE, recorded.id, recorded.revision, () => tenantSource);
        return { record: rebuilt, created: false };
      }
      // Compare the winning record after the database's atomic create-or-read;
      // another process can create this digest with different rules concurrently.
      if (bankDigest(JSON.stringify(saved.value.batch.input)) !== bankDigest(JSON.stringify(batch.input))) throw Object.assign(new Error("This file already has a saved review with a different mapping. Open that review and choose Correct mapping or decisions."), { status: 409 });
      // First write wins, like the batch itself: a repeat download keeps the source its review was built from.
      if (tenantSource) this.db.create<BankTenantSource>(TENANT_SOURCE, `${TENANT_SOURCE}:${id}`, tenantSource, null);
      return { record: saved, created };
    });
  }
  review(id: string, revision: number, decisions: BankReferenceDecision[]) {
    return this.db.transaction(() => {
      this.load(id);
      return this.view(this.validated(this.db.update<SavedBankBatch>("bank", id, revision, value => {
      validateSavedBankBatch(id,value);
      if (value.result || value.supersededBy) throw workflowConflict();
      const result = reviewBankReferences(value.batch, decisions);
      const byRow = new Map(decisions.map(decision => [decision.rowId, decision]));
      const retained = value.batch.rows.map(row => {
        const decision = byRow.get(row.id)!;
        // Import is saved as assign, the action earlier reviews and saved-review validation already know.
        const action = decision.action === 'import' ? 'assign' : decision.action;
        return {rowId:row.id,action,reason:decision.reason.trim(),...(decisionDisposition(action) === 'import' ? {propertyId:decision.propertyId} : {})};
      });
      return { ...value, version: 2, result, decisions: retained, reviewedAt: Date.now() };
      })));
    });
  }
  /** Atomic successor creation preserves previous artifacts. An identical retry
   * reconciles the saved successor; a competing amendment cannot create a fork. */
  amend(id: string, input: unknown) {
    const bad = (): never => { throw Object.assign(new Error('Choose the corrected mapping and give a short reason for this new review.'), {status:400}); };
    if (!input || typeof input !== 'object' || Array.isArray(input)) return bad();
    const body = input as Record<string, unknown>;
    if (Object.keys(body).sort().join(',') !== 'mapping,reason,revision' || !Number.isSafeInteger(body.revision) || Number(body.revision) < 1 ||
        typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500 || /[\x00-\x1f\x7f]/.test(body.reason) ||
        !body.mapping || typeof body.mapping !== 'object' || Array.isArray(body.mapping) || Object.keys(body.mapping).sort().join(',') !== 'columns,dateFormat,rules') return bad();
    const mapping = body.mapping as Pick<BankReferenceInput,'columns'|'dateFormat'|'rules'>;
    const reason = body.reason.trim(), revision = Number(body.revision);
    return this.db.transaction(() => {
      const parent = this.load(id), source = bankBatchSource(parent.value.batch);
      const batch = createBankReferenceBatch(parent.value.batch.version === 2 ? {...mapping,source:source.artifact} : {...mapping,csv:source.csv});
      const requestDigest = bankDigest(JSON.stringify({id,revision,reason,input:batch.input}));
      const existing = parent.value.supersededBy;
      if (existing) {
        if (existing.previousRevision !== revision || existing.requestDigest !== requestDigest || parent.revision !== revision + 1) throw workflowConflict();
        const saved = this.load(existing.id);
        if (saved.value.amends?.id !== id || saved.value.amends.revision !== revision || saved.value.amends.reason !== reason ||
            bankDigest(JSON.stringify(saved.value.batch.input)) !== bankDigest(JSON.stringify(batch.input))) throw Object.assign(new Error('This bank review history needs recovery.'), {status:503});
        return this.view(saved);
      }
      if (parent.revision !== revision) throw workflowConflict();
      const version = bankReviewVersion(id) + 1;
      if (version > 999999) throw workflowConflict();
      const nextId = bankReviewId(batch.originalDigest,version);
      if (this.db.get('bank',nextId)) throw Object.assign(new Error('This bank review history needs recovery.'), {status:503});
      const saved = this.db.create<SavedBankBatch>('bank',nextId,{version:2,createdAt:Date.now(),batch,amends:{id,revision,reason}},null);
      this.db.update<SavedBankBatch>('bank',id,revision,value => ({...value,version:2,
        ...(value.version === 1 && value.result ? {legacyDecisionsUnavailable:true as const} : {}),
        supersededBy:{id:nextId,previousRevision:revision,requestDigest}}));
      return this.view(this.validated(saved));
    });
  }
  export(id: string, original = false): BankDownloadArtifact {
    const { value } = this.load(id);
    let source: ReturnType<typeof bankBatchSource>;
    try { source = bankBatchSource(value.batch); }
    catch { throw Object.assign(new Error("The saved source failed its integrity check. Keep this review and recover the saved data."), { status: 503 }); }
    if (original) return { ...source.artifact, csv: source.csv, originalBytesCaptured: source.originalBytesCaptured };
    if (!value.result) throw Object.assign(new Error("Review every transaction before downloading the prepared copy."), { status: 409 });
    if (typeof value.result.csv !== "string" || typeof value.result.outputDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.result.outputDigest)) throw Object.assign(new Error("The prepared copy failed its integrity check."), { status: 503 });
    if (value.batch.version === 2 && typeof value.result.bytesBase64 !== "string") throw Object.assign(new Error("The prepared file bytes are missing. Keep this review and recover the saved data."), { status: 503 });
    const result = decodeBankSource({ filename: `REI-reviewed-${value.result.outputDigest.slice(0, 12)}.csv`, bytesBase64: value.result.bytesBase64 ?? Buffer.from(value.result.csv, "utf8").toString("base64") });
    if (result.csv !== value.result.csv || result.artifact.digest !== value.result.outputDigest || value.result.originalDigest !== value.batch.originalDigest ||
        (value.result.byteLength !== undefined && result.artifact.byteLength !== value.result.byteLength) ||
        (value.result.encoding !== undefined && result.artifact.encoding !== value.result.encoding)) throw Object.assign(new Error("The prepared copy failed its integrity check."), { status: 503 });
    return { ...result.artifact, csv: result.csv, originalBytesCaptured: source.originalBytesCaptured };
  }
}

/** One REI account: the same top-bar business code, and the same reicid or none on both. */
export const sameW1Destination = (a: { urlValue?: string; marker: string }, b: { urlValue?: string; marker: string }) =>
  a.marker === b.marker && (a.urlValue ?? "") === (b.urlValue ?? "");

/** Days re-read before the confirmed coverage, for late postings. */
export const REDBARK_OVERLAP_DAYS = 3;
/** First pull for an account, before any import is confirmed. */
export const REDBARK_FIRST_RUN_DAYS = 2;
const RETAIN_CONFIRMED_DAYS = REDBARK_OVERLAP_DAYS + 7;
export interface RedbarkCoverageState {
  connection: string;
  /** Last requested `to` date of a confirmed import (inclusive). */
  coveredThrough: string;
  revision: number;
  confirmedAt: string;
  lastBatchId: string;
  /** Redbark ids already imported that a later overlapping window can return,
   * with their row date; older entries are pruned. */
  confirmed: Record<string, string>;
  /** Rows a person held, kept with their bank data until imported or excluded (absent on older files). */
  held?: Record<string, RedbarkHeldRow>;
}
/** A held Redbark row as it appeared in its review batch; `heldSince` is that batch's run date. */
export interface RedbarkHeldRow { date: string; amount: string; narrative: string; reference: string; heldSince: string }
const HELD_AMOUNT = /^-?(?:0|[1-9]\d{0,11})\.\d{2}$/;
const heldText = (v: unknown, max: number) => typeof v === "string" && v.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v);
interface CoverageFile { version: 1; kind: "redbark-coverage"; accounts: Record<string, RedbarkCoverageState> }
export const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
const coverageHold = (): never => { throw Object.assign(new Error("The saved bank coverage needs recovery. No coverage was changed."), { status: 503 }); };

export function validateCoverage(value: unknown): CoverageFile {
  const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!object(value) || Object.keys(value).sort().join(",") !== "accounts,kind,version" || value.version !== 1 || value.kind !== "redbark-coverage" || !object(value.accounts)) return coverageHold();
  for (const [account, state] of Object.entries(value.accounts)) {
    if (!REDBARK_ACCOUNT_ID.test(account) || !object(state) || Object.keys(state).filter(key => key !== "held").sort().join(",") !== "confirmed,confirmedAt,connection,coveredThrough,lastBatchId,revision" ||
        typeof state.connection !== "string" || !REDBARK_CONNECTION_ID.test(state.connection) || !isLocalDate(state.coveredThrough) ||
        !Number.isSafeInteger(state.revision) || Number(state.revision) < 1 || typeof state.confirmedAt !== "string" || Number.isNaN(Date.parse(state.confirmedAt)) ||
        typeof state.lastBatchId !== "string" || !/^bank:[a-f0-9]{64}(?::r\d{1,6})?$/.test(state.lastBatchId) || !object(state.confirmed) ||
        Object.entries(state.confirmed).some(([id, date]) => !REDBARK_TRANSACTION_ID.test(id) || !isLocalDate(date)) ||
        ("held" in state && (!object(state.held) || Object.entries(state.held).some(([id, row]) => !REDBARK_TRANSACTION_ID.test(id) || !object(row) ||
          Object.keys(row).sort().join(",") !== "amount,date,heldSince,narrative,reference" || !isLocalDate(row.date) || !isLocalDate(row.heldSince) ||
          typeof row.amount !== "string" || !HELD_AMOUNT.test(row.amount) || !heldText(row.narrative, 5000) || !heldText(row.reference, 500))))) return coverageHold();
  }
  return value as unknown as CoverageFile;
}

/** Per-account Redbark coverage cursor. Kept as a private 0600 file beside the
 * workflow database (a new workflow record kind would need backup admission
 * first). Writes are serialized in this process; the server is the only writer. */
export class RedbarkCoverage {
  private path: string;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(directory: string) { this.path = join(directory, "bank-source", "redbark-coverage.json"); }
  private async load(): Promise<CoverageFile> {
    const saved = await readPrivateJson(this.path, 2_000_000);
    return saved === undefined ? { version: 1, kind: "redbark-coverage", accounts: {} } : validateCoverage(saved);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => {});
    return next;
  }
  async state(account: string): Promise<RedbarkCoverageState | null> {
    return (await this.load()).accounts[account] ?? null;
  }
  /** cursor − overlap … today; a missed run simply widens it. */
  window(state: RedbarkCoverageState | null, today: string): { from: string; to: string } {
    if (!isLocalDate(today)) throw Object.assign(new Error("The office date is invalid."), { status: 400 });
    const from = state ? addDays(state.coveredThrough, -REDBARK_OVERLAP_DAYS) : addDays(today, -REDBARK_FIRST_RUN_DAYS);
    return { from: from > today ? today : from, to: today };
  }
  /** `held`: this batch's held rows. Its other rows (provenance.transactionIds) are settled and stop being carried. */
  confirm(provenance: RedbarkBatchProvenance, batchId: string, rowDates: string[], expectedRevision: unknown, held: Record<string, RedbarkHeldRow> = {}) {
    return this.serial(async () => {
      const file = await this.load();
      const current = file.accounts[provenance.account] ?? null;
      // An identical retry after a lost reply reconciles to the saved result.
      if (current?.lastBatchId === batchId) return { reused: true, account: provenance.account, ...current };
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== (current?.revision ?? 0)) throw Object.assign(new Error("The bank coverage changed. Refresh it before confirming this import."), { status: 409 });
      if (current && current.connection !== provenance.connection) throw Object.assign(new Error("This batch came from a different bank connection for this account. Review it before confirming."), { status: 409 });
      if (current && provenance.requestedFrom > addDays(current.coveredThrough, 1)) throw Object.assign(new Error("This batch starts after the confirmed coverage, so it would leave a gap. Pull a new batch instead."), { status: 409 });
      const coveredThrough = current && current.coveredThrough > provenance.requestedTo ? current.coveredThrough : provenance.requestedTo;
      const keepFrom = addDays(coveredThrough, -RETAIN_CONFIRMED_DAYS);
      const confirmed: Record<string, string> = {};
      const merged: [string, string][] = [...Object.entries(current?.confirmed ?? {}), ...provenance.transactionIds.map((id, index): [string, string] => [id, rowDates[index]])];
      for (const [id, date] of merged) if (date >= keepFrom) confirmed[id] = date;
      const stillHeld: Record<string, RedbarkHeldRow> = { ...current?.held };
      for (const [id, row] of Object.entries(held)) stillHeld[id] = { ...row, heldSince: stillHeld[id]?.heldSince ?? row.heldSince };
      for (const id of provenance.transactionIds) delete stillHeld[id];
      const next: RedbarkCoverageState = { connection: provenance.connection, coveredThrough, revision: (current?.revision ?? 0) + 1,
        confirmedAt: new Date().toISOString(), lastBatchId: batchId, confirmed, ...(Object.keys(stillHeld).length ? { held: stillHeld } : {}) };
      await writePrivateJson(this.path, { ...file, accounts: { ...file.accounts, [provenance.account]: next } }, { maxBytes: 2_000_000, validate: validateCoverage });
      return { reused: false, account: provenance.account, ...next };
    });
  }
}
