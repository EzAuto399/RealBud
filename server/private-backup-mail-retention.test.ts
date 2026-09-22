import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPrivateWorkspaceBackup, applyStagedPrivateRestore, PRIVATE_RESTORE_STAGE_FILE } from './private-workspace-backup.ts';
import { encryptJson, decryptJson, type EncryptedEnvelope } from './desk-crypto.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { createPrivateVault } from './private-vault.ts';
import { createMailIngestionService, type MailAuthority } from './mail-ingestion.ts';
import { MailStorage } from './mail-storage.ts';
import { legacyMailBackupFixture } from './testing/mail-backup-fixture.ts';
import { mailEvidenceHash } from './mail-workspace-integrity.ts';
import type { PrivateWorkspaceBackup } from '../shared/private-workspace-backup.ts';
import type { MailScanReceipt } from '../shared/mail-ingestion.ts';

const roots: string[] = [], services: ReturnType<typeof createMailIngestionService>[] = [];
const phrase = 'Fictional retained mail backup passphrase', at = Date.parse('2026-09-21T00:00:00Z');
afterEach(async () => {
  for (const service of services.splice(0)) await service.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function writeJson(directory: string, path: string, value: unknown) {
  await mkdir(join(directory, path, '..'), { recursive: true, mode: 0o700 });
  await writeFile(join(directory, path), JSON.stringify(value), { mode: 0o600 });
}
async function fixture() {
  const directory = await mkdtemp(join(realpathSync(tmpdir()), 'RealBud retained mail backup ')); roots.push(directory);
  const key = randomBytes(32), workspaceId = randomUUID(), legacy = legacyMailBackupFixture(workspaceId, at);
  await writeJson(directory, 'company-installation/workspace.json', { version: 1, id: workspaceId, workerMemberKey: null });
  await writeJson(directory, 'desk.json', encryptJson(key, emptyV3({ name: 'Fictional retained mail office', timezone: 'Australia/Brisbane', jurisdictions: [] })));
  const backup = createPrivateWorkspaceBackup({ directory, key: () => key, workspaceId, epoch: () => 'fixture', assertIdle: () => {}, assertFresh: () => {}, now: () => at });
  return { directory, key, workspaceId, legacy, backup };
}
async function seedLegacy(f: Awaited<ReturnType<typeof fixture>>, receiptCount = 1) {
  const { legacy } = f, vault = createPrivateVault(f.directory, f.key);
  for (let index = 1; index < receiptCount; index++) {
    const failed: MailScanReceipt = { ...legacy.receipt, id: randomUUID(), status: 'failed', inputDigest: null, pages: 0, messageCount: 0, threadCount: 0, gaps: ['Fictional historical provider failure.'] };
    legacy.state.receipts.push(failed); legacy.state.latestScan = failed;
  }
  await vault.write('mail-workspace', legacy.state);
  await vault.write(`mail-scan-${legacy.receipt.id}`, legacy.source);
  await vault.write('mail-prepared-input', legacy.prepared);
  await writeJson(f.directory, 'vault/workflow-inputs/accounts-inbox.json', legacy.input);
  const names = ['mail-workspace', `mail-scan-${legacy.receipt.id}`, 'mail-prepared-input'];
  return Promise.all(names.map(async name => ({ path: join(f.directory, 'company-installation/private', `${name}.json`), bytes: await readFile(join(f.directory, 'company-installation/private', `${name}.json`)) })));
}
function mail(f: Awaited<ReturnType<typeof fixture>>, batchSize = 1, workspaceId = f.workspaceId) {
  let time = at, batch = 0;
  const authority: MailAuthority = { accountId: 'fictional-mail', bindingRevision: 'a'.repeat(64), settingsRevision: 1, settings: f.legacy.settings };
  const service = createMailIngestionService({ directory: f.directory, workspaceId, key: f.key, workroomDirectory: join(f.directory, 'vault'), now: () => time,
    authorize: async () => structuredClone(authority),
    scan: async (_authority, request) => ({ accountId: authority.accountId, windowStartAt: request.windowStartAt, windowEndAt: request.windowEndAt,
      pages: 1, paginationComplete: true, gaps: [], threads: Array.from({ length: batchSize }, (_, index) => {
        const id = (0x100000 + batch * 100 + index).toString(16), messageId = (0x500000 + batch * 100 + index).toString(16);
        return { id, historyComplete: true, messages: [{ ...f.legacy.data.threads[0].messages[0], id: messageId, threadId: id, at: time - 1,
          subject: `Fictional retained conversation ${batch}-${index}`, body: `Fictional source ${batch}-${index}. 保留每個來源；保留人工決定。` }] };
      }) }),
  });
  services.push(service);
  return { service, next: () => { batch++; time += 1000; } };
}
type Snapshot = { files: { path: string; bytes: number; sha256: string; base64: string }[]; records: { kind: string; id: string; revision: number; payload: EncryptedEnvelope }[] };
function alterBackup(backup: PrivateWorkspaceBackup, change: (snapshot: Snapshot) => void) {
  const key = scryptSync(phrase, Buffer.from(backup.salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try { const snapshot = decryptJson(key, backup.payload) as Snapshot; change(snapshot); return { ...backup, payload: encryptJson(key, snapshot) }; }
  finally { key.fill(0); }
}
async function expectRefusalUnchanged(target: Awaited<ReturnType<typeof fixture>>, backup: PrivateWorkspaceBackup, digest: string) {
  const before = await readFile(join(target.directory, 'desk.json'));
  await expect(target.backup.previewBackup(backup, phrase)).rejects.toThrow(/mail evidence.*recovery/i);
  await expect(target.backup.stageRestore({ backup, passphrase: phrase, expectedDigest: digest })).rejects.toThrow(/mail evidence.*recovery/i);
  expect(await readFile(join(target.directory, 'desk.json'))).toEqual(before);
  await expect(readFile(join(target.directory, PRIVATE_RESTORE_STAGE_FILE))).rejects.toMatchObject({ code: 'ENOENT' });
}

describe('normalized mail retention through private backup', () => {
  it('roundtrips over 2,000 tasks and 1,000 receipts, old source/manual decisions and overwritten prepared input under a different key', async () => {
    const from = await fixture(), to = await fixture(), originals = await seedLegacy(from, 1000);
    await writeJson(from.directory, 'agency-setup.json', { version: 1, workspaceId: from.workspaceId, revision: 1, updatedAt: at,
      settings: from.legacy.settings, reviews: { 'morning-priorities': { settingsRevision: 1, evidenceDigest: 'a'.repeat(64), reviewedAt: at, actorId: from.workspaceId } } });
    await writeJson(from.directory, 'loops.json', { version: 3, timezone: 'Australia/Brisbane', state: { 'inbound-triage': { enabled: true, handledThrough: at } }, runs: [] });
    const source = mail(from, 100);
    expect((await source.service.page({ group: 'all' })).items).toEqual(from.legacy.state.items);
    for (let index = 0; index < 21; index++) { source.next(); await source.service.collect(); }
    await source.service.prepareInput();
    const before = await source.service.get(), oldSource = await source.service.source(from.legacy.item.id);
    expect(before.counts.total).toBe(2101); expect((await source.service.scanHistory({ limit: 20 })).total).toBe(1021);
    expect((await source.service.getItem(from.legacy.item.id))).toEqual(from.legacy.item);
    for (const original of originals) expect(await readFile(original.path)).toEqual(original.bytes);
    const database = new WorkflowDatabase({ dir: from.directory, key: from.key });
    const prepared = database.list<any>('mail-prepared');
    expect(database.count('mail-item')).toBe(2101); expect(database.count('mail-receipt')).toBe(1021); expect(database.count('mail-source')).toBe(22);
    expect(database.get<any>('mail-origin', 'mail-origin:workspace')!.value.legacyPreparedInput).toEqual(from.legacy.input);
    database.close();
    expect(prepared).toHaveLength(1);
    expect(prepared[0].value.input.sourceReference).not.toBe(from.legacy.input.sourceReference);
    const exported = await from.backup.exportBackup(phrase);
    expect(exported.receipt.recordCount).toBe(3147);
    expect(JSON.stringify(exported.backup)).not.toContain('Fictional source');
    await to.backup.stageRestore({ backup: exported.backup, passphrase: phrase, expectedDigest: exported.receipt.digest });
    await applyStagedPrivateRestore({ directory: to.directory, key: to.key });
    const restored = mail(to, 1, from.workspaceId).service;
    expect(await restored.get()).toEqual(before);
    expect(await restored.getItem(from.legacy.item.id)).toEqual(from.legacy.item);
    expect(await restored.source(from.legacy.item.id)).toEqual(oldSource);
    expect((await restored.scanHistory({ limit: 20 })).total).toBe(1021);
    const restoredDatabase = new WorkflowDatabase({ dir: to.directory, key: to.key });
    try { expect(restoredDatabase.list('mail-prepared')).toEqual(prepared); } finally { restoredDatabase.close(); }
    const vault = createPrivateVault(to.directory, to.key);
    expect(await vault.read('mail-workspace')).toEqual(from.legacy.state);
    expect(await vault.read(`mail-scan-${from.legacy.receipt.id}`)).toEqual(from.legacy.source);
    expect(await vault.read('mail-prepared-input')).toEqual(from.legacy.prepared);
    const agency = JSON.parse(await readFile(join(to.directory, 'agency-setup.json'), 'utf8'));
    expect(agency.settings.gmailAccountId).toBeNull(); expect(agency.reviews).toEqual({});
    const loops = JSON.parse(await readFile(join(to.directory, 'loops.json'), 'utf8'));
    expect(Object.values(loops.state).every(value => !(value as { enabled: boolean }).enabled)).toBe(true);
    const sourceEnvelope = JSON.parse(await readFile(join(to.directory, 'company-installation/private', `mail-scan-${from.legacy.receipt.id}.json`), 'utf8'));
    expect(() => decryptJson(from.key, sourceEnvelope)).toThrow();
  }, 60_000);

  it('restores normalized records from a fresh workspace with no legacy private mail files', async () => {
    const from = await fixture(), to = await fixture(), source = mail(from).service;
    await source.collect(); await source.prepareInput();
    const first = (await source.page({ group: 'all' })).items[0], before = await source.source(first.id);
    const exported = await from.backup.exportBackup(phrase);
    alterBackup(exported.backup, snapshot => expect(snapshot.files.some(file => file.path.startsWith('company-installation/private/mail-'))).toBe(false));
    await to.backup.stageRestore({ backup: exported.backup, passphrase: phrase, expectedDigest: exported.receipt.digest });
    await applyStagedPrivateRestore({ directory: to.directory, key: to.key });
    const restored = mail(to, 1, from.workspaceId).service;
    expect(await restored.getItem(first.id)).toEqual(first); expect(await restored.source(first.id)).toEqual(before);
  });

  it('preserves a standalone workroom input without inventing a missing mail journal', async () => {
    const f = await fixture();
    await writeJson(f.directory, 'vault/workflow-inputs/accounts-inbox.json', f.legacy.input);
    const exported = await f.backup.exportBackup(phrase);
    expect(exported.receipt.recordCount).toBe(0);
    expect(await f.backup.previewBackup(exported.backup, phrase)).toEqual(exported.receipt);
  });

  it('interrupts an imported acquisition lease atomically while retaining the preceding source and tasks', async () => {
    const from = await fixture(), to = await fixture(), source = mail(from).service;
    await source.collect(); const item = (await source.page({ group: 'all' })).items[0], original = await source.source(item.id);
    const pendingId = randomUUID(), database = new WorkflowDatabase({ dir: from.directory, key: from.key });
    try {
      const completed = database.list<MailScanReceipt>('mail-receipt')[0].value;
      database.create('mail-receipt', `mail-receipt:${pendingId}`, { ...completed, id: pendingId, status: 'running', completedAt: null, inputDigest: null, messageCount: 0, threadCount: 0, pages: 0, gaps: [] }, null);
      const register = database.get<any>('mail-register', 'mail-register:workspace')!;
      database.update<any>('mail-register', register.id, register.revision, value => ({ ...value, revision: value.revision + 1, latestScanId: pendingId,
        activeScan: { receiptId: pendingId, ownerPid: process.pid, ownerToken: randomUUID() } }));
    } finally { database.close(); }
    // Deliberately exercise an imported durable intent at the backup-library
    // boundary. The live HTTP host's separate idle admission denies live scans.
    const exported = await from.backup.exportBackup(phrase);
    await to.backup.stageRestore({ backup: exported.backup, passphrase: phrase, expectedDigest: exported.receipt.digest });
    await applyStagedPrivateRestore({ directory: to.directory, key: to.key });
    const restored = mail(to, 1, from.workspaceId).service;
    expect((await restored.get()).latestScan).toMatchObject({ id: pendingId, status: 'interrupted', completedAt: at });
    expect(await restored.getItem(item.id)).toEqual(item); expect(await restored.source(item.id)).toEqual(original);
    const reopened = new WorkflowDatabase({ dir: to.directory, key: to.key });
    try { expect(reopened.get<any>('mail-register', 'mail-register:workspace')!.value.activeScan).toBeNull(); } finally { reopened.close(); }
  });

  it.each([false, true])('preserves legacy running intent and restores effective interrupted work (already migrated: %s)', async migrated => {
    const from = await fixture(), to = await fixture(), pending: MailScanReceipt = { ...from.legacy.receipt, id: randomUUID(), status: 'running',
      completedAt: null, inputDigest: null, messageCount: 0, threadCount: 0, pages: 0, gaps: ['Fictional acquisition started before interruption.'] };
    from.legacy.state.receipts.push(pending); from.legacy.state.latestScan = pending;
    const originals = await seedLegacy(from);
    if (migrated) {
      // Exercise the durable migration boundary before a service startup has
      // recovered this imported intent. Both representations remain on disk.
      const storage = new MailStorage({ directory: from.directory, key: from.key, workspaceId: from.workspaceId, workroomDirectory: join(from.directory, 'vault') });
      try { await storage.ready(); expect(storage.register().latestScanId).toBe(pending.id); expect(storage.receipt(pending.id)?.status).toBe('running'); }
      finally { storage.close(); }
    }
    const exported = await from.backup.exportBackup(phrase);
    for (const original of originals) expect(await readFile(original.path)).toEqual(original.bytes);
    await to.backup.stageRestore({ backup: exported.backup, passphrase: phrase, expectedDigest: exported.receipt.digest });
    await applyStagedPrivateRestore({ directory: to.directory, key: to.key });
    const legacyRestored = await createPrivateVault(to.directory, to.key).read('mail-workspace');
    expect(legacyRestored).toEqual(from.legacy.state);
    const restored = mail(to, 1, from.workspaceId).service;
    expect((await restored.get()).latestScan).toMatchObject({ id: pending.id, status: 'interrupted', completedAt: at,
      gaps: expect.arrayContaining(['Fictional acquisition started before interruption.']) });
    expect(await restored.getItem(from.legacy.item.id)).toEqual(from.legacy.item);
    expect((await restored.source(from.legacy.item.id)).thread).toEqual(from.legacy.data.threads[0]);
    const service = createPrivateWorkspaceBackup({ directory: to.directory, key: () => to.key, workspaceId: from.workspaceId,
      epoch: () => 'restored-fixture', assertIdle: () => {}, assertFresh: () => {}, now: () => at });
    const reexported = await service.exportBackup(phrase);
    expect(await service.previewBackup(reexported.backup, phrase)).toEqual(reexported.receipt);
    expect(await createPrivateVault(to.directory, to.key).read('mail-workspace')).toEqual(legacyRestored);
  });

  it('rejects incomplete and forged normalized graphs before preview or target mutation', async () => {
    const from = await fixture(), to = await fixture(), source = mail(from).service;
    await source.collect(); await source.prepareInput();
    const exported = await from.backup.exportBackup(phrase);
    for (const kind of ['mail-register', 'mail-origin', 'mail-item', 'mail-receipt', 'mail-source']) {
      const damaged = alterBackup(exported.backup, snapshot => { const index = snapshot.records.findIndex(row => row.kind === kind); expect(index).toBeGreaterThanOrEqual(0); snapshot.records.splice(index, 1); });
      await expectRefusalUnchanged(to, damaged, exported.receipt.digest);
    }
    for (const [kind, change] of [
      ['mail-source', (value: any) => { value.data.threads[0].messages[0].body = 'Unrecorded changed source'; }],
      ['mail-item', (value: any) => { value.sourceMessageIds = ['bbbb']; }],
      ['mail-prepared', (value: any) => { value.digest = 'f'.repeat(64); }],
      ['mail-prepared', (value: any) => { value.input.reviewBatch.pendingThreadCount = 2; value.digest = mailEvidenceHash(value.input); }],
      ['mail-origin', (value: any) => { value.legacyDigest = 'e'.repeat(64); }],
    ] as const) {
      const damaged = alterBackup(exported.backup, snapshot => { const row = snapshot.records.find(row => row.kind === kind)!; const value = decryptJson(from.key, row.payload); change(value); row.payload = encryptJson(from.key, value); });
      await expectRefusalUnchanged(to, damaged, exported.receipt.digest);
    }
  });

  it('rejects altered inert legacy bytes alongside migrated records without rewriting local files', async () => {
    const from = await fixture(); await seedLegacy(from); await mail(from).service.get();
    const vault = createPrivateVault(from.directory, from.key), changed = structuredClone(from.legacy.state); changed.items[0].note = 'Conflicting legacy manual decision';
    await vault.write('mail-workspace', changed);
    const legacyPath = join(from.directory, 'company-installation/private/mail-workspace.json'), databasePath = join(from.directory, 'workflow-state.sqlite');
    const legacyBefore = await readFile(legacyPath), databaseBefore = await readFile(databasePath);
    await expect(from.backup.exportBackup(phrase)).rejects.toThrow(/mail evidence.*recovery/i);
    expect(await readFile(legacyPath)).toEqual(legacyBefore); expect(await readFile(databasePath)).toEqual(databaseBefore);
  });

  it('rejects a normalized graph that drops the complete migrated legacy lineage', async () => {
    const from = await fixture(), to = await fixture(); await seedLegacy(from);
    const source = mail(from); await source.service.get(); source.next(); await source.service.collect(); await source.service.prepareInput();
    const exported = await from.backup.exportBackup(phrase);
    const removed = new Set([`mail-item:${from.legacy.item.id}`, `mail-receipt:${from.legacy.receipt.id}`, `mail-source:${from.legacy.receipt.id}`]);
    const damaged = alterBackup(exported.backup, snapshot => { snapshot.records = snapshot.records.filter(row => !removed.has(row.id)); });
    await expectRefusalUnchanged(to, damaged, exported.receipt.digest);
  });

  it('keeps the explicit version-one 5,000-record refusal instead of exporting partial mail history', async () => {
    const from = await fixture(); await mail(from).service.collect();
    const database = new WorkflowDatabase({ dir: from.directory, key: from.key }); database.close();
    const raw = new DatabaseSync(join(from.directory, 'workflow-state.sqlite'));
    try {
      const count = Number((raw.prepare('SELECT COUNT(*) count FROM workflow_records').get() as { count: number }).count);
      raw.exec('BEGIN IMMEDIATE'); const insert = raw.prepare('INSERT INTO workflow_records VALUES (?,?,?,?)');
      for (let index = count; index < 5001; index++) insert.run(`fixture-unvalidated-${index}`, 'mail-receipt', 1, '{}');
      raw.exec('COMMIT');
    } finally { raw.close(); }
    const before = await readFile(join(from.directory, 'workflow-state.sqlite'));
    await expect(from.backup.exportBackup(phrase)).rejects.toThrow(/5,000-record.*assisted backup/);
    expect(await readFile(join(from.directory, 'workflow-state.sqlite'))).toEqual(before);
  });
});
