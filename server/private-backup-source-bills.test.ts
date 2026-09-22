import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPrivateWorkspaceBackup, applyStagedPrivateRestore } from './private-workspace-backup.ts';
import { encryptJson, decryptJson, type EncryptedEnvelope } from './desk-crypto.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { previewBillSource, SourceBillRegister } from './source-bills.ts';
import { validateSourceBillRecords } from './source-bill-graph.ts';
import type { BillMailSource, SourceBillOccurrence } from '../shared/source-bills.ts';
import type { PrivateWorkspaceBackup } from '../shared/private-workspace-backup.ts';

const roots: string[] = [], phrase = 'Fictional bill retention backup phrase';
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'RealBud bill backup ')); roots.push(directory);
  const key = randomBytes(32), workspaceId = randomUUID();
  await mkdir(join(directory, 'company-installation'), { mode: 0o700 });
  await writeFile(join(directory, 'company-installation/workspace.json'), JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null }), { mode: 0o600 });
  await writeFile(join(directory, 'desk.json'), JSON.stringify(encryptJson(key, emptyV3({ name: 'Fictional retention office', timezone: 'UTC', jurisdictions: [] }))), { mode: 0o600 });
  const service = createPrivateWorkspaceBackup({ directory, key: () => key, workspaceId, epoch: () => 'fixture', assertIdle: () => {}, assertFresh: () => {} });
  return { directory, key, workspaceId, service };
}
const source = (number: number): BillMailSource => ({ accountId: 'fictional-retention-account', receiptId: `fictional-receipt-${number}`, threadId: `thread-${number}`,
  message: { id: `message-${number}`, at: Date.parse('2026-09-01T08:00:00Z'), from: 'fictional@example.invalid', subject: `Fictional bill ${number}`, body: `Fictional original source ${number}`, attachments: [] } });
const review = (mail: BillMailSource, number: number) => ({ expectedSourceDigest: previewBillSource(mail).digest, sourceReviewed: true,
  facts: { propertyId: `property-${number}`, kind: 'Water', vendor: 'Fictional Water', amountCents: 12345, currency: 'AUD', invoiceDate: '2026-09-01', dueDate: '2026-09-21', note: 'Fictional reviewed record' }, reviewReason: 'Fictional source and mapping checked' });
const pattern = { intervalMonths: 1, anchorDate: '2026-09-01', windowBeforeDays: 0, windowAfterDays: 0, timeZone: 'UTC', reviewReason: 'Fictional arrival observed and approved' };
type Snapshot = { records: { kind: string; id: string; revision: number; payload: EncryptedEnvelope }[] };
function alterBackup(backup: PrivateWorkspaceBackup, change: (snapshot: Snapshot) => void) {
  const key = scryptSync(phrase, Buffer.from(backup.salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try { const snapshot = decryptJson(key, backup.payload) as Snapshot; change(snapshot); return { ...backup, payload: encryptJson(key, snapshot) }; }
  finally { key.fill(0); }
}

describe('source-bill retention through private backup', () => {
  it('refuses an otherwise valid imported bill head larger than the live encrypted record ceiling', async () => {
    const from = await fixture(), to = await fixture();
    const database = new WorkflowDatabase({ dir: from.directory, key: from.key });
    const register = new SourceBillRegister(database, { dataDir: from.directory });
    register.accept(review(source(1), 1), source(1), from.workspaceId); database.close();
    const exported = await from.service.exportBackup(phrase);
    const large = source(1); large.message.body = '漢'.repeat(12000);
    large.message.attachments = Array.from({ length: 100 }, (_, n) => ({ id: `${n}${'漢'.repeat(500)}`, name: '漢'.repeat(255), mimeType: '漢'.repeat(120), size: 1 }));
    const oversized = alterBackup(exported.backup, snapshot => {
      const row = snapshot.records.find(row => row.kind === 'bill-occurrence')!;
      const bill = decryptJson(from.key, row.payload) as SourceBillOccurrence;
      bill.source = previewBillSource(large);
      const { id: _id, createdAt: _at, history: _history, ...version } = bill;
      bill.history = Array.from({ length: 24 }, (_, index) => ({ ...version, revision: index + 1 }));
      bill.revision = 25; row.revision = 25; row.payload = encryptJson(from.key, bill);
      expect(Buffer.byteLength(JSON.stringify(bill))).toBeLessThan(8 * 1024 * 1024);
      expect(JSON.stringify(row.payload).length).toBeGreaterThan(8_000_000);
      // Prove this is a size rejection, not a broken source, history or lookup graph.
      expect(() => validateSourceBillRecords(snapshot.records.map(record => ({ ...record, value: decryptJson(from.key, record.payload) })))).not.toThrow();
    });
    const before = await readFile(join(to.directory, 'desk.json'));
    await expect(to.service.previewBackup(oversized, phrase)).rejects.toThrow(/encrypted workflow record.*limit/i);
    await expect(to.service.stageRestore({ backup: oversized, passphrase: phrase, expectedDigest: exported.receipt.digest })).rejects.toThrow(/encrypted workflow record.*limit/i);
    expect(await readFile(join(to.directory, 'desk.json'))).toEqual(before);
    await expect(readFile(join(to.directory, 'private-workspace-restore.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('roundtrips more than 500 bills and 100 patterns, old aliases, reviews and pages under a different key', async () => {
    const from = await fixture(), to = await fixture();
    const database = new WorkflowDatabase({ dir: from.directory, key: from.key });
    const register = new SourceBillRegister(database, { dataDir: from.directory });
    try {
      const accepted: SourceBillOccurrence[] = [];
      for (let index = 0; index < 501; index++) {
        const mail = source(index), bill = register.accept(review(mail, index), mail, from.workspaceId); accepted.push(bill);
        if (index < 101) register.approveSeries({ ...pattern, occurrenceId: bill.id, expectedOccurrenceRevision: bill.revision }, from.workspaceId);
      }
      const founding = register.getSeriesForOccurrence(accepted[0].id)!;
      register.reviseSeries(founding.id, { ...pattern, expectedRevision: founding.revision, active: false, reviewReason: 'Fictional staff paused the pattern' }, from.workspaceId);
      const correctedSource = source(9501), corrected = register.correct(accepted[500].id, {
        ...review(correctedSource, 500), expectedRevision: accepted[500].revision, state: 'hold', reviewReason: 'Fictional corrected source, retaining old identity',
      }, correctedSource, from.workspaceId);
      const cancelled = register.correct(accepted[499].id, { ...review(source(499), 499), expectedRevision: accepted[499].revision, state: 'cancelled', reviewReason: 'Fictional duplicate cancelled without deleting evidence' }, source(499), from.workspaceId);
      const beforeCounts = register.counts(), beforePage = register.occurrencePage({ limit: 20 });
      const calendar = register.calendarPage({ from: '2026-09-01', to: '2026-11-01', propertyId: 'property-1', limit: 20 });
      const exported = await from.service.exportBackup(phrase);
      expect(exported.receipt.recordCount).toBeGreaterThan(602);
      expect(JSON.stringify(exported.backup)).not.toContain('Fictional original source');
      const incomplete = alterBackup(exported.backup, snapshot => {
        const index = snapshot.records.findIndex(row => row.kind !== 'bill-register');
        expect(index).toBeGreaterThanOrEqual(0); snapshot.records.splice(index, 1);
      });
      await expect(to.service.previewBackup(incomplete, phrase)).rejects.toThrow(/recovery|incomplete|invalid/i);
      await to.service.stageRestore({ backup: exported.backup, passphrase: phrase, expectedDigest: exported.receipt.digest });
      await applyStagedPrivateRestore({ directory: to.directory, key: to.key });
      const restoredDatabase = new WorkflowDatabase({ dir: to.directory, key: to.key });
      try {
        const restored = new SourceBillRegister(restoredDatabase, { dataDir: to.directory });
        expect(restored.counts()).toEqual(beforeCounts);
        expect(restored.getOccurrence(corrected.id)).toEqual(corrected);
        expect(restored.getOccurrence(cancelled.id)).toEqual(cancelled);
        expect(restored.findBySourceIdentity(previewBillSource(source(500)).identity)?.id).toBe(corrected.id);
        expect(restored.findBySourceIdentity(previewBillSource(correctedSource).identity)?.id).toBe(corrected.id);
        expect(restored.getSeries(founding.id)).toMatchObject({ active: false, revision: 2, history: [{ active: true }] });
        expect(restored.occurrencePage({ limit: 20 }).items.map(row => row.id)).toEqual(beforePage.items.map(row => row.id));
        expect(restored.calendarPage({ from: '2026-09-01', to: '2026-11-01', propertyId: 'property-1', limit: 20 })).toEqual(calendar);
        expect(restored.accept(review(source(499), 499), source(499), to.workspaceId).id).toBe(cancelled.id);
        expect(() => restored.accept(review(source(500), 500), source(500), to.workspaceId)).toThrow(/already|correction/i);
      } finally { restoredDatabase.close(); }
    } finally { database.close(); }
  }, 30_000);

  it('keeps legacy bill bytes valid for import and migrates only when the restored register is opened', async () => {
    const from = await fixture(), to = await fixture();
    const database = new WorkflowDatabase({ dir: from.directory, key: from.key });
    database.create('bill-register', 'source-bills', { version: 1, occurrences: [], series: [] }); database.close();
    const exported = await from.service.exportBackup(phrase);
    await to.service.stageRestore({ backup: exported.backup, passphrase: phrase, expectedDigest: exported.receipt.digest });
    await applyStagedPrivateRestore({ directory: to.directory, key: to.key });
    const restored = new WorkflowDatabase({ dir: to.directory, key: to.key });
    try {
      expect(restored.get('bill-register', 'source-bills')?.value).toEqual({ version: 1, occurrences: [], series: [] });
      const register = new SourceBillRegister(restored, { dataDir: to.directory });
      expect(register.counts()).toMatchObject({ occurrences: 0, series: 0, activeSeries: 0 });
      expect(register.accept(review(source(1), 1), source(1), to.workspaceId).source).toEqual(previewBillSource(source(1)));
    } finally { restored.close(); }
  });

  it('refuses an orphaned stored graph without rewriting its database', async () => {
    const f = await fixture(), database = new WorkflowDatabase({ dir: f.directory, key: f.key });
    const register = new SourceBillRegister(database, { dataDir: f.directory });
    const bill = register.accept(review(source(1), 1), source(1), f.workspaceId);
    database.close();
    const raw = new DatabaseSync(join(f.directory, 'workflow-state.sqlite'));
    try { expect(raw.prepare('DELETE FROM workflow_records WHERE id=?').run(bill.id).changes).toBe(1); } finally { raw.close(); }
    const before = await readFile(join(f.directory, 'workflow-state.sqlite'));
    await expect(f.service.exportBackup(phrase)).rejects.toThrow(/recovery|incomplete|invalid/i);
    expect(await readFile(join(f.directory, 'workflow-state.sqlite'))).toEqual(before);
  });

  it('reports the remaining version-one backup record ceiling instead of exporting partial history', async () => {
    const f = await fixture(), database = new WorkflowDatabase({ dir: f.directory, key: f.key }); database.close();
    const raw = new DatabaseSync(join(f.directory, 'workflow-state.sqlite'));
    try {
      raw.exec('BEGIN IMMEDIATE');
      const insert = raw.prepare('INSERT INTO workflow_records VALUES (?,?,?,?)');
      for (let index = 0; index < 5001; index++) insert.run(`fictional-${index}`, 'fixture-only-unknown', 1, '{}');
      raw.exec('COMMIT');
    } finally { raw.close(); }
    const before = await readFile(join(f.directory, 'workflow-state.sqlite'));
    await expect(f.service.exportBackup(phrase)).rejects.toThrow(/5,000-record.*assisted backup/);
    expect(await readFile(join(f.directory, 'workflow-state.sqlite'))).toEqual(before);
  });
});
