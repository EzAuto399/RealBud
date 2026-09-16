// Prepared workflow state belongs to RealBud, outside any engine profile.
// SQLite provides cross-process compare-and-swap; payloads reuse Desk encryption.
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { decryptJson, encryptJson, isEncryptedEnvelope } from "./desk-crypto.ts";
import { loadDeskKey } from "./desk-key.ts";

export interface WorkflowRecord<T> { id: string; revision: number; value: T }
export const workflowConflict = () => Object.assign(new Error("This work changed. Refresh it before continuing."), { status: 409 });
const unavailable = () => Object.assign(new Error("Saved workflow data needs recovery. No work was dispatched. Check storage and restore the existing data and key together."), { status: 503 });
const identity = (value: string) => {
  if (!/^[a-zA-Z0-9:_-]{1,180}$/.test(value)) throw Object.assign(new Error("Invalid workflow identity."), { status: 400 });
};

export class WorkflowDatabase {
  private db!: DatabaseSync;
  private key: Buffer;
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
  create<T>(kind: string, id: string, value: T, limit = 100): WorkflowRecord<T> {
    identity(kind); identity(id);
    const encoded = JSON.stringify(encryptJson(this.key, value));
    if (encoded.length > 8_000_000) throw Object.assign(new Error("This workflow is too large. Use a smaller batch."), { status: 413 });
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const old = this.get<T>(kind, id);
      if (old) { this.db.exec("COMMIT"); return old; }
      const count = this.db.prepare("SELECT count(*) AS count FROM workflow_records WHERE kind=?").get(kind) as { count: number };
      if (count.count >= limit) throw Object.assign(new Error("The workflow history limit is reached. Ask your RealBud administrator to export and retain the history before starting more."), { status: 409 });
      this.db.prepare("INSERT INTO workflow_records VALUES (?, ?, 1, ?)").run(id, kind, encoded);
      this.db.exec("COMMIT");
      return { id, revision: 1, value: structuredClone(value) };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may not have started */ }
      if ((error as { status?: number }).status) throw error;
      throw unavailable();
    }
  }
  update<T>(kind: string, id: string, expectedRevision: number, update: (value: T) => T): WorkflowRecord<T> {
    identity(kind); identity(id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw workflowConflict();
    try {
      this.db.exec("BEGIN IMMEDIATE");
      const current = this.get<T>(kind, id);
      if (!current || current.revision !== expectedRevision) throw workflowConflict();
      const next = update(current.value);
      const payload = JSON.stringify(encryptJson(this.key, next));
      if (payload.length > 8_000_000) throw Object.assign(new Error("This workflow is too large."), { status: 413 });
      this.db.prepare("UPDATE workflow_records SET revision=revision+1, payload=? WHERE id=? AND kind=? AND revision=?").run(payload, id, kind, expectedRevision);
      this.db.exec("COMMIT");
      return { id, revision: expectedRevision + 1, value: structuredClone(next) };
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch { /* transaction may not have started */ }
      if ((error as { status?: number }).status) throw error;
      throw unavailable();
    }
  }
}
