import { bankBatchSource, bankDigest, createBankReferenceBatch, decodeBankSource, reviewBankReferences, type BankReferenceBatch, type BankReferenceInput, type BankReferenceUpload, type BankReferenceDecision } from "./bank-reference.ts";
import type { BankDownloadArtifact } from "../shared/bank-source.ts";
import { WorkflowDatabase, workflowConflict } from "./workflow-database.ts";
import type { BankBatchSummary, BankHistoryPage, BankHistoryQuery } from '../shared/bank-reference-history.ts';
import { validateSavedBankBatch, validateBankReviewLinks } from './bank-reference-validation.ts';
import { bankReviewId, bankReviewVersion, type BankReviewAmendment, type BankReviewSuccessor } from '../shared/bank-review.ts';

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
}
export class BankReferenceStore {
  private db: WorkflowDatabase;
  constructor(db: WorkflowDatabase) { this.db = db; }
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
  get(id: string) {
    const record = this.db.get<SavedBankBatch>("bank", id);
    if (!record) throw Object.assign(new Error("That bank review is no longer available."), { status: 404 });
    if (Number.isInteger(record.value?.version) && record.value.version > 2) throw Object.assign(new Error("This bank review needs a newer RealBud version."), { status: 409 });
    return this.validated(record);
  }
  create(input: BankReferenceInput | BankReferenceUpload) {
    const batch = createBankReferenceBatch(input);
    // Repeated downloads of the exact same file reuse the existing review.
    const id = `bank:${batch.originalDigest}`;
    return this.db.transaction(() => {
      const saved = this.validated(this.db.create<SavedBankBatch>("bank", id, { version: 2, createdAt: Date.now(), batch }, null));
      // Compare the winning record after the database's atomic create-or-read;
      // another process can create this digest with different rules concurrently.
      if (bankDigest(JSON.stringify(saved.value.batch.input)) !== bankDigest(JSON.stringify(batch.input))) throw Object.assign(new Error("This file already has a saved review with a different mapping. Open that review and choose Correct mapping or decisions."), { status: 409 });
      return saved;
    });
  }
  review(id: string, revision: number, decisions: BankReferenceDecision[]) {
    return this.db.transaction(() => {
      this.get(id);
      return this.validated(this.db.update<SavedBankBatch>("bank", id, revision, value => {
      validateSavedBankBatch(id,value);
      if (value.result || value.supersededBy) throw workflowConflict();
      const result = reviewBankReferences(value.batch, decisions);
      const byRow = new Map(decisions.map(decision => [decision.rowId, decision]));
      const retained = value.batch.rows.map(row => {
        const decision = byRow.get(row.id)!;
        return {rowId:row.id,action:decision.action,reason:decision.reason.trim(),...(decision.action === 'assign' ? {propertyId:decision.propertyId} : {})};
      });
      return { ...value, version: 2, result, decisions: retained, reviewedAt: Date.now() };
      }));
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
      const parent = this.get(id), source = bankBatchSource(parent.value.batch);
      const batch = createBankReferenceBatch(parent.value.batch.version === 2 ? {...mapping,source:source.artifact} : {...mapping,csv:source.csv});
      const requestDigest = bankDigest(JSON.stringify({id,revision,reason,input:batch.input}));
      const existing = parent.value.supersededBy;
      if (existing) {
        if (existing.previousRevision !== revision || existing.requestDigest !== requestDigest || parent.revision !== revision + 1) throw workflowConflict();
        const saved = this.get(existing.id);
        if (saved.value.amends?.id !== id || saved.value.amends.revision !== revision || saved.value.amends.reason !== reason ||
            bankDigest(JSON.stringify(saved.value.batch.input)) !== bankDigest(JSON.stringify(batch.input))) throw Object.assign(new Error('This bank review history needs recovery.'), {status:503});
        return saved;
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
      return this.validated(saved);
    });
  }
  export(id: string, original = false): BankDownloadArtifact {
    const { value } = this.get(id);
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
