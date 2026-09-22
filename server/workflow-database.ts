// Prepared workflow state belongs to RealBud, outside any engine profile.
// SQLite provides cross-process compare-and-swap; payloads reuse Desk encryption.
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decryptJson, encryptJson, isEncryptedEnvelope } from "./desk-crypto.ts";
import { loadDeskKey } from "./desk-key.ts";

export interface WorkflowRecord<T> { id: string; revision: number; value: T }
export const WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH = 8_000_000;
export const workflowConflict = () => Object.assign(new Error("This work changed. Refresh it before continuing."), { status: 409 });
const unavailable = () => Object.assign(new Error("Saved workflow data needs recovery. No work was dispatched. Check storage and restore the existing data and key together."), { status: 503 });
const identity = (value: string) => {
  if (!/^[a-zA-Z0-9:_-]{1,180}$/.test(value)) throw Object.assign(new Error("Invalid workflow identity."), { status: 400 });
};

export class WorkflowDatabase {
  private db!: DatabaseSync;
  private key: Buffer;
  private transactionDepth = 0;
  private writeEpoch = 0;
  constructor(options: { dir: string; key?: Buffer }) {
    mkdirSync(options.dir, { recursive: true });
    const file = join(options.dir, "workflow-state.sqlite");
    const keyFile = join(options.dir, "desk.key");
    // loadDeskKey's development fallback must not replace a lost/corrupt key
    // under existing encrypted workflow data.
    if (!options.key && !process.env.REALBUD_DESK_KEY) {
      if (existsSync(file) && !existsSync(keyFile)) throw unavailable();
      if (existsSync(keyFile)) {
        const raw = readFileSync(keyFile);
        if (raw.length !== 32 && !(raw.length === 64 && /^[a-fA-F0-9]{64}$/.test(raw.toString("utf8")))) throw unavailable();
      }
    }
    if (options.key && options.key.length !== 32) throw unavailable();
    if (process.env.REALBUD_DESK_KEY && !/^[a-fA-F0-9]{64}$/.test(process.env.REALBUD_DESK_KEY)) throw unavailable();
    this.key = loadDeskKey(options).key;
    try {
      this.db = new DatabaseSync(file);
      chmodSync(file, 0o600);
      this.db.exec("PRAGMA busy_timeout=1500; PRAGMA synchronous=FULL;");
      const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version > 1) throw unavailable();
      this.db.exec("CREATE TABLE IF NOT EXISTS workflow_records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL); PRAGMA user_version=1;");
    } catch { this.db?.close(); throw unavailable(); }
  }
  close(): void { this.db.close(); }
  hasRecords(): boolean {
    try { return !!this.db.prepare('SELECT 1 AS present FROM workflow_records LIMIT 1').get(); }
    catch { throw unavailable(); }
  }
  /** Invalidates readers on this handle's writes (including rollback) and other handles' commits. */
  changeToken(): string {
    try { return `${this.writeEpoch}:${(this.db.prepare('PRAGMA data_version').get() as { data_version: number }).data_version}`; }
    catch { throw unavailable(); }
  }
  count(kind: string, before = Number.MAX_SAFE_INTEGER): number {
    identity(kind);
    if (!Number.isSafeInteger(before) || before < 1) throw workflowConflict();
    try { return Number((this.db.prepare('SELECT count(*) AS count FROM workflow_records WHERE kind=? AND rowid<?').get(kind, before) as { count: number }).count); }
    catch { throw unavailable(); }
  }
  highWatermark(kind: string): number {
    identity(kind);
    try { return Number((this.db.prepare('SELECT coalesce(max(rowid),0) AS sequence FROM workflow_records WHERE kind=?').get(kind) as { sequence: number }).sequence) + 1; }
    catch { throw unavailable(); }
  }
  private decode<T>(row: Record<string, unknown>): WorkflowRecord<T> {
    try {
      const envelope = JSON.parse(String(row.payload));
      if (!isEncryptedEnvelope(envelope)) throw unavailable();
      return { id: String(row.id), revision: Number(row.revision), value: decryptJson(this.key, envelope) as T };
    } catch { throw unavailable(); }
  }
  get<T>(kind: string, id: string): WorkflowRecord<T> | undefined {
    identity(kind); identity(id);
    try {
      const row = this.db.prepare("SELECT id, revision, payload FROM workflow_records WHERE kind=? AND id=?").get(kind, id);
      return row ? this.decode<T>(row) : undefined;
    } catch { throw unavailable(); }
  }
  list<T>(kind: string): WorkflowRecord<T>[] {
    identity(kind);
    try { return this.db.prepare("SELECT id, revision, payload FROM workflow_records WHERE kind=? ORDER BY rowid DESC LIMIT 500").all(kind).map(row => this.decode<T>(row)); }
    catch { throw unavailable(); }
  }
  /** Serializes cross-process admission and all of its encrypted receipt writes. */
  transaction<T>(operation: () => T): T {
    if (this.transactionDepth) return operation();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      this.transactionDepth++;
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may not have started */ }
      this.writeEpoch++; // Nested readers may have observed writes that were just rolled back.
      if ((error as { status?: number }).status) throw error;
      throw unavailable();
    } finally { this.transactionDepth = 0; }
  }
  /** Stable descending insertion cursor. New rows never shift an existing page. */
  page<T>(kind: string, options: { before?: number; limit?: number; prefix?: string } = {}): { records: WorkflowRecord<T>[]; sequences: number[]; next: number | null } {
    identity(kind);
    const limit = options.limit ?? 50, before = options.before ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(before) || before < 1) throw workflowConflict();
    const prefix = options.prefix ?? '';
    if (prefix && !/^[a-zA-Z0-9:-]{1,160}$/.test(prefix)) throw workflowConflict();
    try {
      const rows = this.db.prepare("SELECT rowid AS sequence, id, revision, payload FROM workflow_records WHERE kind=? AND rowid<? AND substr(id,1,?)=? ORDER BY rowid DESC LIMIT ?").all(kind, before, prefix.length, prefix, limit + 1);
      return { records: rows.slice(0, limit).map(row => this.decode<T>(row)), sequences: rows.slice(0, limit).map(row => Number(row.sequence)), next: rows.length > limit ? Number(rows[limit - 1]!.sequence) : null };
    } catch { throw unavailable(); }
  }
  /**
   * The same insertion cursor as page(), retaining only one decoded record and
   * the projected results. project must be synchronous and read-only; return a
   * small summary rather than retaining the source record. Use transaction()
   * around this call when additional reads must share its database snapshot.
   */
  projectPage<T, R>(kind: string, options: { before?: number; limit?: number; prefix?: string }, project: (record: WorkflowRecord<T>) => R): { records: R[]; sequences: number[]; next: number | null } {
    identity(kind);
    const limit = options.limit ?? 50, before = options.before ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(before) || before < 1) throw workflowConflict();
    const prefix = options.prefix ?? '';
    if (prefix && !/^[a-zA-Z0-9:-]{1,160}$/.test(prefix)) throw workflowConflict();
    try {
      const rows = this.db.prepare("SELECT rowid AS sequence, id, revision, payload FROM workflow_records WHERE kind=? AND rowid<? AND substr(id,1,?)=? ORDER BY rowid DESC LIMIT ?").iterate(kind, before, prefix.length, prefix, limit + 1);
      const records: R[] = [], sequences: number[] = [];
      // for-of closes the SQLite iterator on an early return or a projection
      // exception, so neither a lookahead nor a rejected record retains a lock.
      for (const row of rows) {
        if (records.length === limit) return { records, sequences, next: sequences[sequences.length - 1]! };
        records.push(project(this.decode<T>(row)));
        sequences.push(Number(row.sequence));
      }
      return { records, sequences, next: null };
    } catch (error) {
      if (error && typeof error === 'object' && 'status' in error && typeof error.status === 'number') throw error;
      throw unavailable();
    }
  }
  /** null means permanent retention, bounded by disk and each payload's size. */
  create<T>(kind: string, id: string, value: T, limit: number | null = 100): WorkflowRecord<T> {
    identity(kind); identity(id);
    const encoded = JSON.stringify(encryptJson(this.key, value));
    if (encoded.length > WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH) throw Object.assign(new Error("This workflow is too large. Use a smaller batch."), { status: 413 });
    return this.transaction(() => {
      const old = this.get<T>(kind, id);
      if (old) return old;
      if (limit !== null) {
        const count = this.db.prepare("SELECT count(*) AS count FROM workflow_records WHERE kind=?").get(kind) as { count: number };
        if (count.count >= limit) throw Object.assign(new Error("The workflow history limit is reached. Ask your RealBud administrator to export and retain the history before starting more."), { status: 409 });
      }
      this.db.prepare("INSERT INTO workflow_records VALUES (?, ?, 1, ?)").run(id, kind, encoded);
      this.writeEpoch++;
      return { id, revision: 1, value: structuredClone(value) };
    });
  }
  update<T>(kind: string, id: string, expectedRevision: number, update: (value: T) => T): WorkflowRecord<T> {
    identity(kind); identity(id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw workflowConflict();
    return this.transaction(() => {
      const current = this.get<T>(kind, id);
      if (!current || current.revision !== expectedRevision) throw workflowConflict();
      const next = update(current.value);
      const payload = JSON.stringify(encryptJson(this.key, next));
      if (payload.length > WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH) throw Object.assign(new Error("This workflow is too large."), { status: 413 });
      this.db.prepare("UPDATE workflow_records SET revision=revision+1, payload=? WHERE id=? AND kind=? AND revision=?").run(payload, id, kind, expectedRevision);
      this.writeEpoch++;
      return { id, revision: expectedRevision + 1, value: structuredClone(next) };
    });
  }
}
