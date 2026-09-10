import { bankDigest, createBankReferenceBatch, reviewBankReferences, type BankReferenceBatch, type BankReferenceInput, type BankReferenceDecision } from "./bank-reference.ts";
import { WorkflowDatabase, workflowConflict } from "./workflow-database.ts";

export interface SavedBankBatch {
  version: 1; createdAt: number; reviewedAt?: number;
  batch: BankReferenceBatch;
  result?: ReturnType<typeof reviewBankReferences>;
}
export class BankReferenceStore {
  private db: WorkflowDatabase;
  constructor(db: WorkflowDatabase) { this.db = db; }
  settings() {
    const latest = this.db.list<SavedBankBatch>("bank")[0]?.value.batch.input;
    return latest ? { columns: latest.columns, dateFormat: latest.dateFormat, rules: latest.rules } : null;
  }
  list() { return this.db.list<SavedBankBatch>("bank").map(({ id, revision, value }) => ({ id, revision, createdAt: value.createdAt, reviewedAt: value.reviewedAt, rows: value.batch.rows.length, originalDigest: value.batch.originalDigest, outputDigest: value.result?.outputDigest })); }
  get(id: string) {
    const record = this.db.get<SavedBankBatch>("bank", id);
    if (!record) throw Object.assign(new Error("That bank review is no longer available."), { status: 404 });
    if (record.value.version !== 1) throw Object.assign(new Error("This bank review needs a newer RealBud version."), { status: 409 });
    return record;
  }
  create(input: BankReferenceInput) {
    const batch = createBankReferenceBatch(input);
    // Repeated downloads of the exact same file reuse the existing review.
    const id = `bank:${batch.originalDigest}`;
    const old = this.db.get<SavedBankBatch>("bank", id);
    if (old && bankDigest(JSON.stringify(old.value.batch.input)) !== bankDigest(JSON.stringify(batch.input))) throw Object.assign(new Error("This file already has a saved review with a different mapping. Open that review; do not create a second import copy."), { status: 409 });
    return this.db.create<SavedBankBatch>("bank", id, { version: 1, createdAt: Date.now(), batch }, 500);
  }
  review(id: string, revision: number, decisions: BankReferenceDecision[]) {
    return this.db.update<SavedBankBatch>("bank", id, revision, value => {
      if (value.result) throw workflowConflict();
      return { ...value, result: reviewBankReferences(value.batch, decisions), reviewedAt: Date.now() };
    });
  }
  export(id: string, original = false) {
    const { value } = this.get(id);
    if (original) return { csv: value.batch.input.csv, digest: value.batch.originalDigest };
    if (!value.result) throw Object.assign(new Error("Review every transaction before downloading the prepared copy."), { status: 409 });
    if (bankDigest(value.result.csv) !== value.result.outputDigest) throw Object.assign(new Error("The prepared copy failed its integrity check."), { status: 503 });
    return { csv: value.result.csv, digest: value.result.outputDigest };
  }
}
