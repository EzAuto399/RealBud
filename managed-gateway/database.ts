import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonical, requireThat } from './contracts.ts';

/** A single durable gateway database; SQLite serialises reservations across processes.
 * Deploy only on a local encrypted persistent volume, never an office DB or network share.
 * Ledger UPDATE/DELETE triggers protect app mistakes; an OS/DB administrator remains trusted. */
export class LedgerDatabase {
  readonly sql: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
    this.sql = new DatabaseSync(path);
    this.sql.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
    try {
    this.transaction(()=>{
    const applicationId=this.get<{application_id:number}>('PRAGMA application_id')!.application_id;
    const version=this.get<{user_version:number}>('PRAGMA user_version')!.user_version;
    const count=this.get<{count:number}>("SELECT count(*) AS count FROM sqlite_master WHERE type='table'")!.count;
    requireThat((applicationId===0 && version===0 && count===0) || (applicationId===0x52424757 && [1,2].includes(version)),'foreign_or_unsupported_database',503);
    if (version===1) {
      // Preserve v1 bodies/events byte-for-byte. Legacy attempts cannot acquire new children.
      this.sql.exec(`ALTER TABLE requests RENAME TO requests_v1;
        CREATE TABLE requests (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, member TEXT NOT NULL, job TEXT NOT NULL, attempt TEXT NOT NULL,
          model_call TEXT NOT NULL, idem TEXT NOT NULL, kid TEXT NOT NULL, jti TEXT NOT NULL, body TEXT NOT NULL,
          UNIQUE(tenant,member,idem), UNIQUE(tenant,job,attempt,model_call), UNIQUE(kid,jti));
        INSERT INTO requests SELECT id,tenant,member,job,attempt,'legacy',idem,kid,jti,body FROM requests_v1;
        DROP TABLE requests_v1;`);
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS issuers (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, digest TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS acceptances (tenant TEXT NOT NULL, version TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(tenant,version));
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, member TEXT NOT NULL, job TEXT NOT NULL, attempt TEXT NOT NULL,
        model_call TEXT NOT NULL, idem TEXT NOT NULL, kid TEXT NOT NULL, jti TEXT NOT NULL, body TEXT NOT NULL,
        UNIQUE(tenant,member,idem), UNIQUE(tenant,job,attempt,model_call), UNIQUE(kid,jti));
      CREATE TABLE IF NOT EXISTS attempts (tenant TEXT NOT NULL, job TEXT NOT NULL, attempt TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(tenant,job,attempt));
      CREATE INDEX IF NOT EXISTS requests_attempt ON requests(tenant,job,attempt);
      CREATE TABLE IF NOT EXISTS evidence (id TEXT PRIMARY KEY, request TEXT NOT NULL, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_requests (id TEXT PRIMARY KEY, request TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, tenant TEXT NOT NULL, kind TEXT NOT NULL,
        request TEXT, at INTEGER NOT NULL, body TEXT NOT NULL, previous TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_tenant ON events(tenant,seq);
      CREATE TABLE IF NOT EXISTS invoices (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, period TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(tenant,period));
      CREATE TABLE IF NOT EXISTS invoice_events (event INTEGER PRIMARY KEY REFERENCES events(seq), invoice TEXT NOT NULL REFERENCES invoices(id));
      CREATE TABLE IF NOT EXISTS billing_sources (tenant TEXT NOT NULL, period TEXT NOT NULL, mode TEXT NOT NULL, PRIMARY KEY(tenant,period));
      CREATE TABLE IF NOT EXISTS report_key_mappings (id TEXT PRIMARY KEY, provider TEXT NOT NULL, key_ref TEXT NOT NULL, starts INTEGER NOT NULL, ends INTEGER NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS report_policies (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS report_imports (digest TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS report_rows (id TEXT PRIMARY KEY, import_digest TEXT NOT NULL REFERENCES report_imports(digest), provider TEXT NOT NULL, key_ref TEXT NOT NULL, model TEXT NOT NULL, starts INTEGER NOT NULL, ends INTEGER NOT NULL, tenant TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS square_mappings (tenant TEXT PRIMARY KEY, merchant TEXT NOT NULL, customer TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(merchant,customer));
      CREATE TABLE IF NOT EXISTS statements (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, period TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(tenant,period));
      CREATE TABLE IF NOT EXISTS statement_events (event INTEGER PRIMARY KEY REFERENCES events(seq), statement TEXT NOT NULL REFERENCES statements(id));
      CREATE TABLE IF NOT EXISTS statement_acceptances (statement TEXT PRIMARY KEY REFERENCES statements(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS square_outbox (id TEXT PRIMARY KEY, statement TEXT NOT NULL REFERENCES statements(id), operation TEXT NOT NULL, state TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(statement,operation));
      CREATE TABLE IF NOT EXISTS square_links (statement TEXT PRIMARY KEY REFERENCES statements(id), order_id TEXT NOT NULL UNIQUE, invoice_id TEXT UNIQUE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS square_events (id TEXT PRIMARY KEY, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS square_payments (id TEXT PRIMARY KEY, statement TEXT NOT NULL REFERENCES statements(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS square_refunds (id TEXT PRIMARY KEY, payment TEXT NOT NULL REFERENCES square_payments(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkouts (invoice TEXT PRIMARY KEY REFERENCES invoices(id), state TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payment_events (id TEXT PRIMARY KEY, digest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payments (id TEXT PRIMARY KEY, invoice TEXT NOT NULL UNIQUE REFERENCES invoices(id), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS refunds (id TEXT PRIMARY KEY, payment TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS refund_intents (id TEXT PRIMARY KEY, tenant TEXT NOT NULL, payment TEXT NOT NULL, credit_event INTEGER NOT NULL UNIQUE REFERENCES events(seq), body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_keys (id TEXT PRIMARY KEY, company TEXT NOT NULL, body TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS project_keys_company ON project_keys(company);
    `);
    for (const table of ['billing_sources','report_key_mappings','report_policies','report_imports','report_rows','square_mappings','statements','statement_events','statement_acceptances','square_events','square_payments','square_refunds','attempts','events','cards','acceptances','evidence','provider_requests','invoices','invoice_events','payment_events','payments','refunds','refund_intents']) {
      for (const action of ['UPDATE','DELETE']) this.sql.exec(`CREATE TRIGGER IF NOT EXISTS immutable_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'immutable_record'); END;`);
    }
    this.sql.exec('PRAGMA application_id=1380075351; PRAGMA user_version=2;');
    });
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.sql.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    this.verify();
    } catch(error) { this.sql.close(); throw error; }
  }
  close() { this.sql.close(); }
  get<T>(query: string, ...params: SQLInputValue[]): T | undefined { return this.sql.prepare(query).get(...params) as T | undefined; }
  all<T>(query: string, ...params: SQLInputValue[]): T[] { return this.sql.prepare(query).all(...params) as T[]; }
  run(query: string, ...params: SQLInputValue[]) { return this.sql.prepare(query).run(...params); }
  transaction<T>(work: () => T): T {
    this.sql.exec('BEGIN IMMEDIATE');
    try { const result = work(); requireThat(!(result instanceof Promise), 'async_transaction_forbidden', 500); this.sql.exec('COMMIT'); return result; }
    catch (error) { this.sql.exec('ROLLBACK'); throw error; }
  }
  append(tenant: string, kind: string, request: string | null, at: number, data: unknown): number {
    const previous = this.get<{hash:string}>('SELECT hash FROM events ORDER BY seq DESC LIMIT 1')?.hash ?? 'genesis';
    const body = canonical(data); const hash = createHash('sha256').update(canonical({tenant,kind,request,at,body,previous})).digest('hex');
    return Number(this.run('INSERT INTO events(tenant,kind,request,at,body,previous,hash) VALUES(?,?,?,?,?,?,?)',tenant,kind,request,at,body,previous,hash).lastInsertRowid);
  }
  verify() {
    let previous = 'genesis';
    for (const e of this.all<{tenant:string;kind:string;request:string|null;at:number;body:string;previous:string;hash:string}>('SELECT * FROM events ORDER BY seq')) {
      requireThat(e.previous === previous && e.hash === createHash('sha256').update(canonical({tenant:e.tenant,kind:e.kind,request:e.request,at:e.at,body:e.body,previous})).digest('hex'), 'ledger_integrity_failure', 503); previous = e.hash;
    }
  }
}
