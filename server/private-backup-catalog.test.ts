import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, symlink, link, chmod } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SHARE_ENV, Worker } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { PrivateBackupCatalog, catalogStorageBudget, type CatalogRecord, type CatalogFile } from './private-backup-catalog.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { encryptJson, decryptJson } from './desk-crypto.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { SourceBillRegister, previewBillSource } from './source-bills.ts';
import { validateSourceBillRecords } from './source-bill-graph.ts';
import { JobRunStore } from './job-runs.ts';
import { validateExecutionRecords } from './execution-history-backup.ts';
import { BillReviewDraftStore } from './bill-review-drafts.ts';
import { BankReferenceStore } from './bank-reference-store.ts';
import { proposalBackupFixture } from './testing/proposal-backup-fixture.ts';
import { legacyMailBackupFixture } from './testing/mail-backup-fixture.ts';
import { createPrivateVault } from './private-vault.ts';
import { MailStorage } from './mail-storage.ts';
import { plantPrivateFile, removeFixture } from './testing/private-fixture.ts';
import type { BillMailSource } from '../shared/source-bills.ts';
import type { BillReviewDraftValue } from '../shared/bill-review-drafts.ts';
import type { Recipe } from '../shared/contracts.ts';

const roots: string[] = [], catalogs: PrivateBackupCatalog[] = [];
afterEach(async () => {
  for (const catalog of catalogs.splice(0)) catalog.close();
  await Promise.all(roots.splice(0).map(root => removeFixture(root)));
});
async function fixture(options: { workspaceId?: string; maxEntries?: number; maxBytes?: number; maxStorageBytes?: number; base?: boolean } = {}) {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'RealBud encrypted catalog ')); roots.push(root);
  const key = randomBytes(32), workspaceId = options.workspaceId ?? randomUUID();
  const catalog = await PrivateBackupCatalog.create({ directory: join(root, 'catalog'), key, workspaceId,
    maxEntries: options.maxEntries ?? 20_000, maxBytes: options.maxBytes ?? 512 * 1024 * 1024, maxStorageBytes: options.maxStorageBytes }); catalogs.push(catalog);
  if (options.base !== false) {
    catalog.addFile({ path: 'company-installation/workspace.json', encoding: 'bytes', data: Buffer.from(JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null })) });
    catalog.addFile({ path: 'desk.json', encoding: 'json', data: Buffer.from(JSON.stringify(emptyV3({ name: 'Fictional catalog office', timezone: 'UTC', jurisdictions: [] }))) });
  }
  return { root, key, workspaceId, catalog, reopen: async () => {
    catalog.close();
    const reopened = await PrivateBackupCatalog.open({ directory: catalog.directory, key, catalogId: catalog.catalogId, workspaceId }); catalogs.push(reopened); return reopened;
  } };
}
const handoff = (id = 'handoff:retained', revision = 7, detail = 'Fictional retained private evidence'): CatalogRecord => ({ id, kind: 'handoff', revision,
  value: { version: 1, runId: 'run', threadId: 'thread', botId: 'bot', detail, jobRevision: 1, reason: 'login', state: 'closed' } });
function* savedRecords(directory: string, key: Buffer): Iterable<CatalogRecord> {
  const db = new DatabaseSync(join(directory, 'workflow-state.sqlite'), { readOnly: true });
  try { for (const row of db.prepare('SELECT id,kind,revision,payload FROM workflow_records ORDER BY rowid').iterate()) {
    yield { id: String(row.id), kind: String(row.kind), revision: Number(row.revision), value: decryptJson(key, JSON.parse(String(row.payload))) };
  } } finally { db.close(); }
}
async function loadRecords(f: Awaited<ReturnType<typeof fixture>>, populate: (db: WorkflowDatabase, directory: string, key: Buffer) => unknown | Promise<unknown>) {
  const directory = join(f.root, 'source'), sourceKey = randomBytes(32), db = new WorkflowDatabase({ dir: directory, key: sourceKey });
  try { await populate(db, directory, sourceKey); } finally { db.close(); }
  return { directory, sourceKey, records: [...savedRecords(directory, sourceKey)] };
}
function draftInput(workspaceId: string): BillReviewDraftValue {
  return { workspaceId, state: 'editing', billId: null, billRevision: null, itemId: null, messageId: null, sourceDigest: null,
    fields: { propertyId: '', kind: 'Water', vendor: '', amount: '1.', invoiceDate: '2026-0', dueDate: '', note: 'Fictional unfinished review 保留' },
    billState: 'hold', reason: '', seriesId: '', arrivalDate: '', proposalRequest: null };
}
const billSource = (n: number): BillMailSource => ({ accountId: 'catalog-mail', receiptId: `receipt-${n}`, threadId: `thread-${n}`,
  message: { id: `message-${n}`, at: Date.parse('2026-09-01T00:00:00Z'), from: 'fictional@example.invalid', subject: 'Fictional bill', body: `Retained source ${n}`, attachments: [] } });
const billReview = (source: BillMailSource) => ({ expectedSourceDigest: previewBillSource(source).digest, sourceReviewed: true,
  facts: { propertyId: 'fictional-property', kind: 'Water', vendor: 'Fictional Water', amountCents: 123, currency: 'AUD', invoiceDate: '2026-09-01', dueDate: '2026-09-21', note: 'Checked' }, reviewReason: 'Fictional human review' });
async function billFixture(f: Awaited<ReturnType<typeof fixture>>) {
  return loadRecords(f, (db, directory) => {
    const store = new SourceBillRegister(db, { dataDir: directory }), source = billSource(1);
    const bill = store.accept(billReview(source), source, f.workspaceId);
    const series = store.approveSeries({ occurrenceId: bill.id, expectedOccurrenceRevision: bill.revision, intervalMonths: 1,
      anchorDate: '2026-09-01', windowBeforeDays: 0, windowAfterDays: 0, timeZone: 'UTC', reviewReason: 'Fictional observed pattern' }, f.workspaceId);
    store.reviseSeries(series.id, { intervalMonths: series.intervalMonths, anchorDate: series.anchorDate, windowBeforeDays: series.windowBeforeDays, windowAfterDays: series.windowAfterDays, timeZone: series.timeZone, expectedRevision: series.revision, active: false, reviewReason: 'Pattern paused; retain reservation history' }, f.workspaceId);
    const corrected = billSource(2);
    store.correct(bill.id, { ...billReview(corrected), expectedRevision: bill.revision, state: 'hold', reviewReason: 'Fictional source corrected' }, corrected, f.workspaceId);
  });
}
async function mailFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const legacy = legacyMailBackupFixture(f.workspaceId, Date.parse('2026-09-21T00:00:00Z'));
  const saved = [['mail-workspace', legacy.state], [`mail-scan-${legacy.receipt.id}`, legacy.source], ['mail-prepared-input', legacy.prepared]] as const;
  const source = await loadRecords(f, async (db, directory, key) => {
    const vault = createPrivateVault(directory, key);
    for (const [name, value] of saved) await vault.write(name, value);
    plantPrivateFile(join(directory, 'vault/workflow-inputs/accounts-inbox.json'), JSON.stringify(legacy.input));
    const storage = new MailStorage({ directory, key, workspaceId: f.workspaceId, workroomDirectory: join(directory, 'vault'), database: db });
    await storage.ready();
  });
  const files: CatalogFile[] = saved.map(([name, value]) => ({ path: `company-installation/private/${name}.json`, encoding: 'json', data: Buffer.from(JSON.stringify({ name, value })) }));
  files.push({ path: 'vault/workflow-inputs/accounts-inbox.json', encoding: 'bytes', data: Buffer.from(JSON.stringify(legacy.input)) });
  return { ...source, files, legacy };
}

describe('target-key encrypted private backup catalog', () => {
  it('preserves exact ordinary bytes, logical ordering, revision and insertion order across restart and a different key', async () => {
    const f = await fixture(), original = Buffer.from('\uFEFFDate,Description,Reference\r\n2026-09-21,"保留, exact",0012\r\n');
    f.catalog.addFile({ path: 'vault/workflow-inputs/original.csv', encoding: 'bytes', data: original });
    const first = handoff('handoff:first', 17), second = handoff('handoff:second', 2);
    f.catalog.addRecord(first); f.catalog.addRecord(second);
    const before = f.catalog.validate();
    const other = await fixture({ workspaceId: f.workspaceId, base: false });
    for (const file of f.catalog.iterateFiles()) other.catalog.addFile(file);
    for (const record of f.catalog.iterateRecords()) other.catalog.addRecord(record);
    expect(other.catalog.validate()).toMatchObject({ files: before.files, records: before.records, plainBytes: before.plainBytes });
    const restarted = await other.reopen();
    expect(restarted.getFile('vault/workflow-inputs/original.csv')!.data).toEqual(original);
    expect([...restarted.iterateRecords()]).toEqual([first, second]);
    expect(restarted.getRecord('bank', first.id)).toBeUndefined();
    expect(restarted.countRecords('handoff')).toBe(2);
    const bytes = await readFile(join(restarted.directory, 'catalog.sqlite'));
    expect(bytes.includes(Buffer.from('Fictional retained private evidence'))).toBe(false);
    expect(bytes.includes(Buffer.from(first.id))).toBe(false);
    expect(bytes.includes(f.key)).toBe(false); expect(bytes.includes(other.key)).toBe(false);
  });
  it('does not trust a collection missing required identity or Desk records', async () => {
    const f = await fixture({ base: false });
    expect(() => f.catalog.validate()).toThrow(/identity and Desk/);
  });
  it.each(['../config.json', '/tmp/payload', 'C:\\payload', 'vault/workflow-inputs/CON.json', 'workflow-state.sqlite', 'config.json'])('rejects unapproved file identity %s', async path => {
    const f = await fixture();
    expect(() => f.catalog.addFile({ path, encoding: 'bytes', data: Buffer.from('{}') })).toThrow();
    expect(f.catalog.validate().files).toBe(2);
  });
  it('rejects duplicate/case-folded file paths and global workflow identities atomically', async () => {
    const f = await fixture();
    f.catalog.addFile({ path: 'vault/properties/Fictional.md', encoding: 'bytes', data: Buffer.from('Original') });
    const before = f.catalog.summary();
    expect(() => f.catalog.addFile({ path: 'vault/properties/fictional.md', encoding: 'bytes', data: Buffer.from('Changed') })).toThrow(/duplicate/);
    expect(f.catalog.summary()).toEqual(before);
    f.catalog.addRecord(handoff('source-bills'));
    expect(() => f.catalog.addRecord({ id: 'source-bills', kind: 'bill-register', revision: 1, value: { version: 1, occurrences: [], series: [] } })).toThrow(/duplicate/);
    expect(f.catalog.countRecords()).toBe(1);
  });
  it('enforces encoding, workspace and declared capacity without partial admission', async () => {
    const f = await fixture({ maxEntries: 3 });
    expect(() => f.catalog.addFile({ path: 'desk.json', encoding: 'bytes', data: Buffer.from('{}') })).toThrow();
    expect(() => f.catalog.addFile({ path: 'agency-setup.json', encoding: 'json', data: Buffer.from('{}') })).toThrow();
    expect(() => f.catalog.addFile({ path: 'company-installation/workspace.json', encoding: 'bytes', data: Buffer.from(JSON.stringify({ version: 1, id: randomUUID(), workerMemberKey: null })) })).toThrow();
    f.catalog.addRecord(handoff());
    expect(() => f.catalog.addRecord(handoff('handoff:later'))).toThrow(/capacity/);
    expect(f.catalog.validate().entries).toBe(3);
    const small = await fixture({ base: false, maxBytes: 12 });
    expect(() => small.catalog.addRecord(handoff())).toThrow(/capacity/);
    expect(small.catalog.summary().entries).toBe(0);
  });
  it('refuses unknown kinds, invalid revisions and closed oversized drafts before insertion', async () => {
    const f = await fixture();
    expect(() => f.catalog.addRecord({ ...handoff(), kind: 'unknown' })).toThrow();
    expect(() => f.catalog.addRecord({ ...handoff(), revision: 0 })).toThrow();
    const source = await loadRecords(f, db => new BillReviewDraftStore(db, { workspaceId: f.workspaceId }).create(randomUUID(), null, { ...draftInput(f.workspaceId), state: 'discarded' }));
    const row = source.records[0], value = structuredClone(row.value) as any;
    // Legal individual string lengths can still exceed the encrypted 64 KiB
    // envelope through JSON's surrogate escaping and base64 expansion.
    value.fields.note = '\ud800'.repeat(8000); value.reason = 'x'.repeat(1000);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(65_536);
    expect(Buffer.byteLength(JSON.stringify(encryptJson(f.key, value)))).toBeGreaterThan(65_536);
    expect(() => f.catalog.addRecord({ ...row, value })).toThrow();
    expect(f.catalog.countRecords()).toBe(0);
  });
  it('retains exact bank original and reviewed artifact bytes', async () => {
    const f = await fixture(), original = Buffer.from('\uFEFFDate,Amount,Description,Reference\r\n2026-09-21,10.00,"Fictional rent, 保留",0012\r\n');
    const source = await loadRecords(f, db => {
      const bank = new BankReferenceStore(db), saved = bank.create({ source: { filename: 'original.csv', bytesBase64: original.toString('base64') }, columns: { date: 'Date', amount: 'Amount', narrative: 'Description', reference: 'Reference' }, dateFormat: 'YYYY-MM-DD', rules: [] });
      bank.review(saved.id, saved.revision, [{ rowId: saved.value.batch.rows[0].id, action: 'keep', reason: 'Human checked exact reference' }]);
    });
    for (const row of source.records) f.catalog.addRecord(row);
    f.catalog.validate();
    expect([...f.catalog.iterateRecords('bank')]).toEqual(source.records);
    expect(Buffer.from(JSON.stringify(source.records)).includes(Buffer.from(original.toString('base64')))).toBe(true);
  });
  it('requires the owned identity and unchanged installation key on reopen', async () => {
    const f = await fixture(); f.catalog.close();
    for (const change of [{ key: randomBytes(32) }, { catalogId: randomUUID() }, { workspaceId: randomUUID() }]) {
      await expect(PrivateBackupCatalog.open({ directory: f.catalog.directory, key: f.key, catalogId: f.catalog.catalogId, workspaceId: f.workspaceId, ...change })).rejects.toThrow();
    }
    expect((await f.reopen()).validate().files).toBe(2);
  });
  it('seals atomically and refuses mutations from a stale independent worker and reopened handle', async () => {
    const f = await fixture(), barrier = new SharedArrayBuffer(4), state = new Int32Array(barrier);
    // A worker's default env is a plain, case-sensitive copy; on Windows the product's
    // ACL helper reads SystemRoot, so the worker shares the real environment instead.
    const worker = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      (async () => {
        const { PrivateBackupCatalog } = await import(workerData.module);
        const catalog = await PrivateBackupCatalog.open({ ...workerData.options, key: Buffer.from(workerData.key) });
        parentPort.postMessage({ ready: true });
        Atomics.wait(new Int32Array(workerData.barrier), 0, 0);
        try { catalog.addRecord(workerData.record); parentPort.postMessage({ status: 200 }); }
        catch (error) { parentPort.postMessage({ status: error.status, sealed: catalog.summary().sealed }); }
        finally { catalog.close(); }
      })().catch(error => { parentPort.postMessage({ failure: error.message }); process.exitCode = 1; });
    `, { eval: true, env: SHARE_ENV, workerData: {
      module: new URL('./private-backup-catalog.ts', import.meta.url).href, key: f.key, barrier, record: handoff(),
      options: { directory: f.catalog.directory, catalogId: f.catalog.catalogId, workspaceId: f.workspaceId },
    } });
    try {
      await new Promise<void>((resolve, reject) => {
        worker.once('message', message => message.ready ? resolve() : reject(new Error(message.failure ?? 'Worker failed before admission')));
        worker.once('error', reject);
      });
      const sealed = f.catalog.seal(); expect(sealed.sealed).toBe(true);
      const answered = new Promise<any>((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
      Atomics.store(state, 0, 1); Atomics.notify(state, 0);
      expect(await answered).toEqual({ status: 409, sealed: true });
      expect(f.catalog.seal()).toEqual(sealed);
      const restarted = await f.reopen();
      expect(restarted.validate()).toEqual(sealed);
      expect(() => restarted.addRecord(handoff())).toThrow(/sealed/);
      expect(() => restarted.addFile({ path: 'vault/properties/later.md', encoding: 'bytes', data: Buffer.from('Later') })).toThrow(/sealed/);
    } finally { await worker.terminate(); }
  });
  it('does not publish a seal for an incomplete graph and rejects invalid UTF-8 JSON', async () => {
    const f = await fixture({ base: false });
    expect(() => f.catalog.seal()).toThrow(); expect(f.catalog.summary().sealed).toBe(false);
    const malformed = Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    expect(() => f.catalog.addFile({ path: 'vault/workflow-inputs/bad.json', encoding: 'bytes', data: malformed })).toThrow(/malformed/);
    f.catalog.addFile({ path: 'vault/workflow-inputs/arbitrary.csv', encoding: 'bytes', data: malformed });
    expect(f.catalog.getFile('vault/workflow-inputs/arbitrary.csv')!.data).toEqual(malformed);
  });
  it('refuses preexisting directories, links and unrecognized internal schema', async () => {
    const f = await fixture();
    await expect(PrivateBackupCatalog.create({ directory: f.catalog.directory, key: f.key, workspaceId: f.workspaceId, maxEntries: 10, maxBytes: 1000 })).rejects.toThrow();
    const linked = join(f.root, 'linked'); await symlink(f.catalog.directory, linked);
    await expect(PrivateBackupCatalog.open({ directory: linked, key: f.key, catalogId: f.catalog.catalogId, workspaceId: f.workspaceId })).rejects.toThrow(/linked/);
    f.catalog.close();
    const db = new DatabaseSync(join(f.catalog.directory, 'catalog.sqlite'));
    db.exec('CREATE TABLE unexpected (data TEXT)'); db.close();
    await expect(f.reopen()).rejects.toThrow(/recovery/);
  });
  it('refuses hardlinked or broadened catalog permissions without repairing them', async () => {
    const f = await fixture(); f.catalog.close();
    const path = join(f.catalog.directory, 'catalog.sqlite'), alias = join(f.root, 'hardlink'); await link(path, alias);
    await expect(f.reopen()).rejects.toThrow(); await rm(alias);
    if (process.platform !== 'win32') {
      await chmod(path, 0o644); await expect(f.reopen()).rejects.toThrow();
      await chmod(path, 0o600);
    }
    expect((await f.reopen()).validate().files).toBe(2);
  });
  it.each(['delete', 'payload-swap', 'metadata-swap'])('detects authenticated entry corruption: %s', async attack => {
    const f = await fixture(); f.catalog.addRecord(handoff('handoff:a')); f.catalog.addRecord(handoff('handoff:b', 2, 'Other original')); f.catalog.close();
    const db = new DatabaseSync(join(f.catalog.directory, 'catalog.sqlite'));
    if (attack === 'delete') db.exec('DELETE FROM catalog_entries WHERE sequence=4');
    else { const column = attack === 'payload-swap' ? 'payload' : 'metadata'; db.exec(`UPDATE catalog_entries SET ${column}=(SELECT ${column} FROM catalog_entries WHERE sequence=3) WHERE sequence=4`); }
    db.close();
    const reopened = await f.reopen(); expect(() => reopened.validate()).toThrow(/recovery/);
  });
});

describe('complete bounded business graph validation', () => {
  it('retains historical bill aliases, inactive patterns and reservations, using the same v1 invariant', async () => {
    const f = await fixture(), source = await billFixture(f);
    expect(() => validateSourceBillRecords(source.records)).not.toThrow();
    for (const row of source.records) f.catalog.addRecord(row);
    expect(f.catalog.validate().records).toBe(source.records.length);
    expect([...f.catalog.iterateRecords()]).toEqual(source.records);
  });
  it.each(['bill-source-alias', 'bill-pattern-slot', 'bill-arrival-slot', 'bill-origin', 'bill-occurrence', 'bill-register'])('rejects an individually readable bill graph missing %s', async kind => {
    const f = await fixture(), source = await billFixture(f);
    const omitted = source.records.find(row => row.kind === kind); expect(omitted).toBeDefined();
    for (const row of source.records) if (row !== omitted) f.catalog.addRecord(row);
    expect(() => f.catalog.validate()).toThrow(/recovery/);
  });
  it('validates normalized and inert legacy mail with exact origin-era ordering and prepared input', async () => {
    const f = await fixture(), source = await mailFixture(f);
    for (const file of source.files) f.catalog.addFile(file);
    for (const row of source.records) f.catalog.addRecord(row);
    expect(f.catalog.validate().records).toBe(source.records.length);
    const restored = await fixture({ workspaceId: f.workspaceId, base: false });
    for (const file of f.catalog.iterateFiles()) restored.catalog.addFile(file);
    for (const row of f.catalog.iterateRecords()) restored.catalog.addRecord(row);
    expect(restored.catalog.validate().records).toBe(source.records.length);
    expect(restored.catalog.getFile(`company-installation/private/mail-scan-${source.legacy.receipt.id}.json`)!.data).toEqual(source.files[1].data);
  });
  it.each(['all-legacy', 'mail-source', 'mail-receipt', 'mail-item', 'ordered-origin'])('holds missing/conflicting mail evidence: %s', async attack => {
    const f = await fixture(), source = await mailFixture(f);
    for (const file of source.files) {
      if (attack === 'all-legacy' && file.path.startsWith('company-installation/private/')) continue;
      if (attack === 'ordered-origin' && file.path.endsWith('mail-workspace.json')) {
        const value = JSON.parse(file.data.toString('utf8'));
        value.value = Object.fromEntries(Object.entries(value.value).reverse());
        f.catalog.addFile({ ...file, data: Buffer.from(JSON.stringify(value)) });
      } else f.catalog.addFile(file);
    }
    for (const row of source.records) if (row.kind !== attack) f.catalog.addRecord(row);
    expect(() => f.catalog.validate()).toThrow(/mail evidence.*recovery/i);
  });
  it('accepts an unrelated workroom input without inventing mail state', async () => {
    const f = await fixture();
    f.catalog.addFile({ path: 'vault/workflow-inputs/accounts-inbox.json', encoding: 'bytes', data: Buffer.from('{"manual":"fixture"}') });
    expect(f.catalog.validate().records).toBe(0);
  });
  it('preserves every draft state and checks optional-present proposal links before preview', async () => {
    const f = await fixture();
    const source = await loadRecords(f, async (db, directory) => {
      const proposal = await proposalBackupFixture(db, directory), store = new BillReviewDraftStore(db, { workspaceId: f.workspaceId, now: () => 100 });
      for (const state of ['editing', 'saved', 'accepted', 'discarded'] as const) {
        store.create(randomUUID(), null, { ...draftInput(f.workspaceId), state });
      }
      store.create(randomUUID(), null, { ...draftInput(f.workspaceId), itemId: proposal.request.itemId, messageId: proposal.request.messageId,
        sourceDigest: proposal.request.expectedSourceDigest, proposalRequest: proposal.request });
      store.create(randomUUID(), null, { ...draftInput(f.workspaceId), itemId: 'a'.repeat(64), messageId: 'ab12', sourceDigest: 'b'.repeat(64),
        proposalRequest: { requestId: randomUUID(), itemId: 'a'.repeat(64), messageId: 'ab12', expectedSourceDigest: 'b'.repeat(64) } });
    });
    for (const row of source.records) f.catalog.addRecord(row);
    expect(f.catalog.validate().records).toBe(source.records.length);
    expect([...f.catalog.iterateRecords('bill-review-draft')].map(row => (row.value as any).fields.amount)).toEqual(Array(6).fill('1.'));
    const bad = await fixture({ workspaceId: f.workspaceId });
    for (const row of source.records) {
      const value = structuredClone(row.value) as any;
      if (row.kind === 'bill-review-draft' && value.proposalRequest?.requestId === (source.records.find(r => r.kind === 'bill-proposal')!.id.slice(14))) {
        value.sourceDigest = 'c'.repeat(64); value.proposalRequest.expectedSourceDigest = value.sourceDigest;
      }
      bad.catalog.addRecord({ ...row, value });
    }
    expect(() => bad.catalog.validate()).toThrow(/recovery/);
  });
  it('retains permanent execution/request/checkpoint bindings and rejects missing retry receipts', async () => {
    const f = await fixture();
    const source = await loadRecords(f, (db, directory) => {
      const store = new JobRunStore({ file: join(directory, 'job-runs.json'), database: db });
      const recipe: Recipe = { id: 'fictional', revision: 1, createdAt: 1, updatedAt: 1, title: 'Fictional plan', description: 'Review', steps: ['Review'], evidence: 'Evidence', allowedOrigins: [], capabilities: ['analyse'], limits: { maxRuntimeMinutes: 2, maxTurns: 3 }, status: 'shadow', schedule: null, planApprovedAt: null, approvedRevision: null, attachment: null, submitAcknowledgedAt: null };
      const saved = store.enqueue(recipe, { mode: 'shadow', trigger: 'manual', idempotencyKey: 'retained-request' });
      store.start(saved.run.id); store.settle(saved.run.id, { status: 'completed', detail: 'Fictional completed work' }); store.close();
    });
    const file: CatalogFile = { path: 'job-runs.json', encoding: 'bytes', data: await readFile(join(source.directory, 'job-runs.json')) };
    expect(() => validateExecutionRecords(source.records, { 'job-runs.json': file.data.toString('utf8') })).not.toThrow();
    f.catalog.addFile(file); for (const row of source.records) f.catalog.addRecord(row);
    expect(f.catalog.validate().records).toBe(source.records.length);
    const bad = await fixture({ workspaceId: f.workspaceId }); bad.catalog.addFile(file);
    for (const row of source.records) if (row.kind !== 'execution-request') bad.catalog.addRecord(row);
    expect(() => bad.catalog.validate()).toThrow(/Execution history needs recovery/);
  });
  it('retains more than 5,000 records and 96 MiB without full-history record reads', async () => {
    const f = await fixture(), detail = `Fictional multilingual retained evidence ${'保留完整紀錄'.repeat(1100)}`;
    for (let i = 0; i < 5_101; i++) f.catalog.addRecord(handoff(`handoff:retained-${i}`, i + 1, detail));
    const summary = f.catalog.validate();
    expect(summary.records).toBe(5_101); expect(summary.plainBytes).toBeGreaterThan(96 * 1024 * 1024);
    expect(f.catalog.getRecord('handoff', 'handoff:retained-0')?.revision).toBe(1);
    expect(f.catalog.getRecord('handoff', 'handoff:retained-5100')?.revision).toBe(5_101);
    const restarted = await f.reopen();
    expect(restarted.validate()).toEqual(summary);
    let count = 0; for (const row of restarted.iterateRecords('handoff')) { expect(row.revision).toBe(++count); }
    expect(count).toBe(5_101);
    // Each entry is its own fully synced SQLite commit: about 216 s on a Windows runner.
  }, process.platform === 'win32' ? 600_000 : 60_000);
  // Each file is its own fully synced SQLite commit: about 130 s on a Windows runner.
  it('admits more than the v1 3,000-file ceiling and enumerates names without dropping any file', process.platform === 'win32' ? { timeout: 400_000 } : {}, async () => {
    const f = await fixture(), data = Buffer.from('Fictional retained property note 保留');
    for (let i = 0; i < 3_101; i++) f.catalog.addFile({ path: `vault/properties/retained-${i}.md`, encoding: 'bytes', data });
    expect(f.catalog.seal()).toMatchObject({ files: 3_103, records: 0, sealed: true });
    let count = 0; for (const _path of f.catalog.filePaths()) count++;
    expect(count).toBe(3_103);
    expect(f.catalog.getFile('vault/properties/retained-3100.md')!.data).toEqual(data);
  });
});

describe('physical sqlite storage bounds', () => {
  it('hits sqlite page limits, preserves admitted rows across reopen, and reapplies the cap', async () => {
    const limits = { maxEntries: 200, maxBytes: 10_000_000, maxStorageBytes: 256 * 1024 };
    const budget = catalogStorageBudget(limits);
    expect(budget.totalBytes).toBe(budget.databaseBytes + budget.rollbackBytes);
    const f = await fixture(limits);
    let extra = 0;
    try {
      for (let i = 0; i < 200; i++) {
        f.catalog.addRecord(handoff(`handoff:physical-${i}`, i + 1, `Fictional physical bound 保留 ${i}`));
        extra++;
      }
      throw new Error('expected the sqlite page cap to reject further admission');
    } catch (error) {
      expect(error).toMatchObject({ status: 413 });
      expect((error as Error).message).toMatch(/capacity/);
    }
    expect(extra).toBeGreaterThan(0);
    expect(extra).toBeLessThan(200);
    const summary = f.catalog.summary();
    expect(summary.records).toBe(extra);
    expect(summary.sealed).toBe(false);
    expect(f.catalog.validate()).toMatchObject({ entries: summary.entries, records: extra, files: summary.files, sealed: false });
    expect((await readFile(join(f.catalog.directory, 'catalog.sqlite'))).byteLength).toBeLessThanOrEqual(budget.databaseBytes);
    const restarted = await f.reopen();
    expect(restarted.validate().records).toBe(extra);
    expect([...restarted.iterateRecords('handoff')].map(row => row.id)).toEqual(Array.from({ length: extra }, (_, i) => `handoff:physical-${i}`));
    expect(() => restarted.addRecord(handoff('handoff:after-reopen'))).toThrow(/capacity/);
    expect(restarted.summary().records).toBe(extra);
    expect(restarted.summary().sealed).toBe(false);
  });
  it('commits and reopens the full 8 MiB supported entry with cache spilling disabled', async () => {
    const f = await fixture({ maxEntries: 20, maxBytes: 16 * 1024 ** 2, maxStorageBytes: 32 * 1024 ** 2 });
    const body = randomBytes(8 * 1024 ** 2);
    f.catalog.addFile({ path: 'vault/workflow-inputs/maximum.csv', encoding: 'bytes', data: body });
    const sealed = f.catalog.seal(), reopened = await f.reopen();
    expect(reopened.validate()).toEqual(sealed);
    expect(reopened.getFile('vault/workflow-inputs/maximum.csv')!.data).toEqual(body);
  });
  it('recovers a real killed writer and its hot rollback journal before applying the persisted cap', async () => {
    const f = await fixture({ maxStorageBytes: 2 * 1024 * 1024 });
    const retained = Buffer.from('Fictional retained bytes '.repeat(12_000));
    f.catalog.addFile({ path: 'vault/properties/retained.md', encoding: 'bytes', data: retained });
    const summary = f.catalog.validate(), directory = f.catalog.directory, path = join(directory, 'catalog.sqlite');
    f.catalog.close(); const original = await readFile(path);
    // A pre-upgrade writer with spilling enabled produces a real hot journal.
    // The parent does not fabricate or modify its recovery bytes.
    const program = `import { DatabaseSync } from 'node:sqlite'; let path=''; for await(const c of process.stdin) path+=c;
      const db=new DatabaseSync(path); db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA cache_size=4; PRAGMA cache_spill=ON; BEGIN IMMEDIATE;');
      db.prepare('UPDATE catalog_header SET payload=? WHERE id=1').run('uncommitted fixture');
      db.prepare('UPDATE catalog_entries SET payload=?').run('invalid fixture '.repeat(40_000));
      process.stdout.write('dirty\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);`;
    const envModule: string = '../scripts/service-smoke-env.mjs'; const { serviceSmokeEnv } = await import(envModule);
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], { env: serviceSmokeEnv({ executable: process.execPath, home: f.root, data: f.root, scratch: f.root, port: 0 }), stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', timer: ReturnType<typeof setTimeout> | undefined;
    const closed = new Promise<void>((resolve, reject) => { child.once('close', () => resolve()); child.once('error', reject); });
    child.stderr.on('data', c => { errors = (errors + c).slice(-1500); });
    const ready = new Promise<void>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Fixture did not write: ${errors}`)), 5000);
      child.stdout.on('data', c => { output = (output + c).slice(-100); if (output.includes('dirty')) resolve(); });
      void closed.then(() => reject(new Error(`Fixture exited: ${errors}`)), reject);
    });
    child.stdin.end(path);
    try {
      await ready;
      expect((await readFile(path)).equals(original)).toBe(false);
      expect((await readFile(path + '-journal')).byteLength).toBeGreaterThan(512);
    } finally { clearTimeout(timer); if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await closed; }
    const restored = await PrivateBackupCatalog.open({ directory, key: f.key, catalogId: f.catalog.catalogId, workspaceId: f.workspaceId }); catalogs.push(restored);
    expect(restored.validate()).toEqual(summary);
    expect(restored.getFile('vault/properties/retained.md')!.data).toEqual(retained);
    expect(await readFile(path)).toEqual(original);
    await expect(readFile(path + '-journal')).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);
  it('opens legacy maxEntries/maxBytes headers without rewriting them', async () => {
    const f = await fixture({ maxEntries: 20, maxBytes: 64 * 1024 });
    f.catalog.addRecord(handoff());
    const summary = f.catalog.validate();
    const directory = f.catalog.directory, key = f.key, catalogId = f.catalog.catalogId, workspaceId = f.workspaceId;
    f.catalog.close();
    const db = new DatabaseSync(join(directory, 'catalog.sqlite'));
    const stored = decryptJson(key, JSON.parse(String(db.prepare('SELECT payload FROM catalog_header WHERE id=1').get()?.payload))) as { limits: Record<string, unknown> } & Record<string, unknown>;
    expect(stored.limits.maxStorageBytes).toBe(catalogStorageBudget({ maxEntries: 20, maxBytes: 64 * 1024 }).databaseBytes);
    const { maxStorageBytes: _omit, ...legacyLimits } = stored.limits;
    stored.limits = legacyLimits;
    db.prepare('UPDATE catalog_header SET payload=? WHERE id=1').run(JSON.stringify(encryptJson(key, stored)));
    db.close();
    const reopened = await PrivateBackupCatalog.open({ directory, key, catalogId, workspaceId }); catalogs.push(reopened);
    expect(reopened.validate()).toEqual(summary);
    reopened.close();
    const verify = new DatabaseSync(join(directory, 'catalog.sqlite'), { readOnly: true });
    try {
      const header = decryptJson(key, JSON.parse(String(verify.prepare('SELECT payload FROM catalog_header WHERE id=1').get()?.payload))) as { limits: Record<string, unknown> };
      expect(Object.keys(header.limits).sort()).toEqual(['maxBytes', 'maxEntries']);
    } finally { verify.close(); }
  });
  it('rejects an oversized physical catalog file and leaves the original bytes in place', async () => {
    const f = await fixture({ maxEntries: 20, maxBytes: 1024 * 1024, maxStorageBytes: 256 * 1024 });
    const directory = f.catalog.directory, key = f.key, catalogId = f.catalog.catalogId, workspaceId = f.workspaceId;
    const path = join(directory, 'catalog.sqlite');
    f.catalog.close();
    const original = await readFile(path);
    const oversized = Buffer.concat([original, Buffer.alloc(256 * 1024)]);
    await writeFile(path, oversized);
    await expect(PrivateBackupCatalog.open({ directory, key, catalogId, workspaceId })).rejects.toThrow(/recovery/);
    expect(await readFile(path)).toEqual(oversized);
  });
  it('rejects explicit storage caps outside the documented range', async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), 'RealBud encrypted catalog ')); roots.push(root);
    const key = randomBytes(32), workspaceId = randomUUID();
    await expect(PrivateBackupCatalog.create({ directory: join(root, 'high'), key, workspaceId, maxEntries: 10, maxBytes: 1000, maxStorageBytes: 64 * 1024 ** 3 + 4096 })).rejects.toThrow(/limits/);
    await expect(PrivateBackupCatalog.create({ directory: join(root, 'low'), key, workspaceId, maxEntries: 10, maxBytes: 1000, maxStorageBytes: 4095 })).rejects.toThrow(/limits/);
  });
});
