import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile, symlink, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createPrivateWorkspaceBackup, applyStagedPrivateRestore, PRIVATE_RESTORE_STAGE_FILE, PRIVATE_RESTORE_RECEIPT_FILE } from './private-workspace-backup.ts';
import { encryptJson, decryptJson } from './desk-crypto.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { defaultAgencySettings } from './agency-setup.ts';
import { createMailIngestionService } from './mail-ingestion.ts';
import { BankReferenceStore } from './bank-reference-store.ts';
import { DeskStore, emptyV2 } from './desk-store.ts';
import { fixtureBook } from './desk-evaluate.ts';
import { migrateV2ToV3 } from './desk-v3-migrate.ts';
import { decodeDeskV3 } from './desk-v3-decode.ts';
import type { PrivateWorkspaceBackup } from '../shared/private-workspace-backup.ts';
import { JobRunStore } from './job-runs.ts';
import { LoopManager } from './routines.ts';
import type { Recipe } from '../shared/contracts.ts';
import { proposalBackupFixture } from './testing/proposal-backup-fixture.ts';
import { WorkspaceActivityGate } from './workspace-activity.ts';
import { batchBackupFixture, verifyRestoredBatchReader } from './testing/batch-backup-fixture.ts';
import { plantPrivateFile, privateTempRoot, removeFixture } from './testing/private-fixture.ts';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => removeFixture(dir))); });
const passphrase = 'Fictional long backup passphrase';
const writeJson = async (dir: string, path: string, value: unknown) => { plantPrivateFile(join(dir, path), JSON.stringify(value)); };
async function fixture() {
  const directory = privateTempRoot(join(realpathSync(tmpdir()), 'rb-private-backup-')); dirs.push(directory);
  const key = Buffer.from(randomUUID().replaceAll('-', ''), 'utf8'), workspaceId = randomUUID();
  await writeJson(directory, 'company-installation/workspace.json', { version: 1, id: workspaceId, workerMemberKey: null });
  const book = emptyV3({ name: 'Fictional agency', timezone: 'Australia/Brisbane', jurisdictions: [] });
  await writeJson(directory, 'desk.json', encryptJson(key, book));
  const assertIdle = vi.fn(), assertFresh = vi.fn(); let generation = 0;
  const at = Date.now();
  const options = { directory, key: () => key, workspaceId, epoch: () => String(generation), assertIdle, assertFresh, now: () => at };
  return { ...options, key, book, service: createPrivateWorkspaceBackup(options), change: () => { generation++; }, options };
}
function openBackup(backup: PrivateWorkspaceBackup) {
  const key = scryptSync(passphrase, Buffer.from(backup.salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { key, value: decryptJson(key, backup.payload) as { files: { path: string; bytes: number; base64: string; sha256: string }[]; keyHex: string; workspaceId: string; records: Record<string, unknown>[] } };
}
function changedBackup(backup: PrivateWorkspaceBackup, update: (value: ReturnType<typeof openBackup>['value']) => void): PrivateWorkspaceBackup {
  const { key, value } = openBackup(backup); update(value); try { return { ...backup, payload: encryptJson(key, value) }; } finally { key.fill(0); }
}
async function populated() {
  const f = await fixture();
  await writeJson(f.directory, 'config.json', { composio: { key: 'excluded-provider-credential' }, xai: { key: 'excluded-vendor-credential' } });
  await writeJson(f.directory, 'company-installation/enrollment.json', { memberToken: 'excluded-member-token' });
  const settings = { ...defaultAgencySettings(), gmailAccountId: 'selected-mail', agencyName: 'Fictional agency', timeZone: 'Australia/Brisbane' };
  await writeJson(f.directory, 'agency-setup.json', { version: 1, workspaceId: f.workspaceId, revision: 2, updatedAt: 1, settings, reviews: { 'morning-priorities': { settingsRevision: 2, evidenceDigest: 'a'.repeat(64), reviewedAt: 1, actorId: f.workspaceId } } });
  const spec = { title: 'Fictional plan', description: 'Prepare saved evidence.', steps: ['Review supplied data'], evidence: 'Saved evidence', allowedOrigins: [], capabilities: ['analyse'], limits: { maxRuntimeMinutes: 2, maxTurns: 6 } };
  await writeJson(f.directory, 'recipes.json', { recipes: [{ ...spec, id: 'wf-example', revision: 3, createdAt: 1, updatedAt: 1, status: 'active', schedule: { time: '08:00', weekdays: [1] }, planApprovedAt: 1, approvedRevision: 3, attachment: { attachedAt: 1 }, submitAcknowledgedAt: 1 }] });
  const job = { jobId: 'wf-example', jobTitle: spec.title, jobRevision: 3, mode: 'prepare', trigger: 'manual', scheduledFor: 1, createdAt: 1, attempt: 1, detail: '', evidence: [], approvalRequests: [], spec };
  await writeJson(f.directory, 'job-runs.json', { version: 1, runs: [{ ...job, id: 'job-1', idempotencyKey: 'one', status: 'running' }, { ...job, id: 'job-2', idempotencyKey: 'two', status: 'completed', evidence: [{ kind: 'note', at: 1, note: 'Retained evidence' }] }] });
  await writeJson(f.directory, 'loops.json', { version: 3, timezone: 'Australia/Brisbane', state: { 'inbound-triage': { enabled: true, handledThrough: 0 } }, runs: [{ id: 'loop-1', loopId: 'inbound-triage', loopName: 'Morning priorities', createdAt: 1, scheduledFor: 1, manual: true, status: 'queued' }] });
  await writeJson(f.directory, 'workspace-views/tabs.json', { workspaceId: f.workspaceId, state: { version: 1, revision: 1, tabs: [] } });
  const mail = createMailIngestionService({ directory: f.directory, workspaceId: f.workspaceId, key: f.key, workroomDirectory: join(f.directory, 'vault'), now: f.now,
    authorize: async () => ({ accountId: 'selected-mail', bindingRevision: 'a'.repeat(64), settings, settingsRevision: 2 }),
    scan: async (_authority, request) => ({ accountId: 'selected-mail', windowStartAt: request.windowStartAt, windowEndAt: request.windowEndAt, pages: 1, paginationComplete: true, gaps: [], threads: [{ id: 'ab12', historyComplete: true, messages: [{ id: 'cd34', threadId: 'ab12', at: request.windowEndAt - 1000, direction: 'incoming', from: 'fictional@example.invalid', to: 'office@example.invalid', subject: 'Fictional bill', body: 'Fictional original saved source', bodyTruncated: false, attachments: [] }] }] }),
  });
  const mailState = await mail.collect(), receiptId = mailState.latestScan!.id, mailItem = (await mail.page({ group: 'all' })).items[0];
  await mail.update(mailItem.id, { expectedRevision: mailItem.revision, note: 'Retained human correction' });
  await mail.close();
  const db = new WorkflowDatabase({ dir: f.directory, key: f.key });
  db.create('bill-register', 'source-bills', { version: 1, occurrences: [], series: [] });
  await proposalBackupFixture(db, f.directory);
  const bankBytes = Buffer.from('\uFEFFDate,Amount,Description,Reference\r\n2026-01-01,10.00,Fictional rent,\r\n');
  const bank = new BankReferenceStore(db), batch = bank.create({ source: { filename: 'fictional.csv', bytesBase64: bankBytes.toString('base64') }, columns: { date: 'Date', amount: 'Amount', narrative: 'Description', reference: 'Reference' }, dateFormat: 'YYYY-MM-DD', rules: [] });
  bank.review(batch.id, batch.revision, [{ rowId: batch.value.batch.rows[0].id, action: 'keep', reason: 'Fictional review retained' }]);
  db.create('handoff', 'handover:example', { version: 1, runId: 'run-example', threadId: 'thread-example', botId: 'bot-example', jobRevision: 3, reason: 'login', detail: 'Fictional sign-in receipt', state: 'verified', binding: { accountMarker: 'Fictional account' } }); db.close();
  return { ...f, receiptId, bankId: batch.id, bankBytes, mailItemId: mailItem.id };
}

describe('portable private business backup', () => {
  it('retains portfolio sources and completed results across different-key restore without automatic dispatch', async () => {
    const source = await fixture(), target = await fixture();
    const original = JSON.stringify(batchBackupFixture(), null, 2) + '\n';
    plantPrivateFile(join(source.directory, 'work-batches.json'), original);
    const { backup, receipt } = await source.service.exportBackup(passphrase);
    expect(await readFile(join(source.directory, 'work-batches.json'), 'utf8')).toBe(original);
    const saved = openBackup(backup); try { expect(saved.value.files.some(file => file.path === 'work-batches.json')).toBe(true); } finally { saved.key.fill(0); }
    await target.service.stageRestore({ backup, passphrase, expectedDigest: receipt.digest });
    await applyStagedPrivateRestore({ directory: target.directory, key: target.key });
    await verifyRestoredBatchReader(target.directory, target.key);
  });

  it.each(['malformed', 'oversized'])('refuses a %s portfolio file instead of silently omitting it', async kind => {
    const source = await fixture(), path = join(source.directory, 'work-batches.json');
    const original = kind === 'malformed' ? '[{"id":"broken"}]' : ' '.repeat(8 * 1024 * 1024 + 1);
    await writeFile(path, original, { mode: 0o600 });
    await expect(source.service.exportBackup(passphrase)).rejects.toThrow(kind === 'malformed' ? /batch history needs recovery/ : /too large/);
    expect(await readFile(path, 'utf8')).toBe(original);
  });

  it.each(['revision', 'timestamp', 'expanded-size'])('refuses unrestorable batch %s before publishing a cold stage', async field => {
    const source = await fixture(), target = await fixture(), batches = batchBackupFixture();
    if (field === 'revision') batches[0].revision = Number.MAX_SAFE_INTEGER;
    if (field === 'timestamp') batches[0].updatedAt = Number.MAX_VALUE;
    if (field === 'expanded-size') {
      Object.assign(batches[0], { legacyNote: '' });
      Object.assign(batches[0], { legacyNote: 'x'.repeat(8 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(batches))) });
    }
    const original = JSON.stringify(batches); await writeFile(join(source.directory, 'work-batches.json'), original, { mode: 0o600 });
    const before = await readFile(join(target.directory, 'desk.json')), { backup, receipt } = await source.service.exportBackup(passphrase);
    await expect(target.service.stageRestore({ backup, passphrase, expectedDigest: receipt.digest })).rejects.toMatchObject({ status: field === 'expanded-size' ? 413 : 400 });
    expect((await target.service.status()).state).toBe('none'); expect(await readFile(join(target.directory, 'desk.json'))).toEqual(before);
    expect(await readFile(join(source.directory, 'work-batches.json'), 'utf8')).toBe(original);
  });

  it('includes destination batch removal in a legacy archive restore when the source had no batch file', async () => {
    const source = await fixture(), target = await fixture(), { backup, receipt } = await source.service.exportBackup(passphrase);
    // The fixture controls freshness separately so this checks removal mechanics;
    // the real host rejects restoring over an occupied business workspace.
    await writeJson(target.directory, 'work-batches.json', batchBackupFixture());
    await target.service.stageRestore({ backup, passphrase, expectedDigest: receipt.digest });
    await applyStagedPrivateRestore({ directory: target.directory, key: target.key });
    await expect(readFile(join(target.directory, 'work-batches.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('releases its temporary lease on success, invalid passphrase and key-read failure', async () => {
    const f = await fixture(), gate = new WorkspaceActivityGate();
    const service = createPrivateWorkspaceBackup({ ...f.options, snapshotLease: () => gate.pause() });
    await service.exportBackup(passphrase); expect(gate.paused).toBe(false);
    await expect(service.exportBackup('short')).rejects.toThrow(); expect(gate.paused).toBe(false);
    const broken = createPrivateWorkspaceBackup({ ...f.options, snapshotLease: () => gate.pause(), key() { throw new Error('fixture key unavailable'); } });
    await expect(broken.exportBackup(passphrase)).rejects.toThrow('fixture key unavailable'); expect(gate.paused).toBe(false);
  });
  it('exports a migrated legacy array without rewriting its bytes and normalizes only the restored projection', async () => {
    const source = await populated(), target = await fixture();
    const runs = JSON.parse(await readFile(join(source.directory, 'job-runs.json'), 'utf8')).runs.map((run: Record<string, unknown>) => ({ ...run, status: 'completed' }));
    const original = JSON.stringify(runs) + '\n'; await writeFile(join(source.directory, 'job-runs.json'), original, { mode: 0o600 });
    const database = new WorkflowDatabase({ dir: source.directory, key: source.key }), jobs = new JobRunStore({ file: join(source.directory, 'job-runs.json'), database });
    try {
      expect(jobs.recovery.active).toBe(false);
      const { backup, receipt } = await source.service.exportBackup(passphrase);
      expect(await readFile(join(source.directory, 'job-runs.json'), 'utf8')).toBe(original);
      await target.service.stageRestore({ backup, passphrase, expectedDigest: receipt.digest }); await applyStagedPrivateRestore({ directory: target.directory, key: target.key });
      expect(JSON.parse(await readFile(join(target.directory, 'job-runs.json'), 'utf8'))).toMatchObject({ version: 1, executionHistory: 1, runs: [{ id: 'job-1' }, { id: 'job-2' }] });
    } finally { jobs.close(); database.close(); }
  });
  it('retains evicted execution identities across encrypted backup, different-key restore and both production readers', async () => {
    const source = await fixture(), target = await fixture();
    const spec = { title: 'Fictional history', description: 'Review fictional evidence', steps: ['Review supplied data'], evidence: 'Fictional receipt', allowedOrigins: [], capabilities: ['analyse'] as const, limits: { maxRuntimeMinutes: 2, maxTurns: 6 } };
    const recipe: Recipe = { ...spec, capabilities: [...spec.capabilities], id: 'fixture-history', revision: 1, createdAt: 1, updatedAt: 1, status: 'shadow', schedule: null, planApprovedAt: null, approvedRevision: null, attachment: null, submitAcknowledgedAt: null };
    const runs = Array.from({ length: 1000 }, (_, i) => ({ id: `historical-${i}`, jobId: recipe.id, jobTitle: spec.title, jobRevision: 1, spec, mode: 'shadow', trigger: 'manual', status: 'completed', scheduledFor: i + 1, createdAt: i + 1, finishedAt: i + 2, attempt: 1, detail: 'Fictional completion', evidence: [], approvalRequests: [], idempotencyKey: `history-${i}` }));
    const loopRequest = randomUUID();
    await writeJson(source.directory, 'job-runs.json', { version: 1, runs });
    await writeJson(source.directory, 'loops.json', { version: 3, timezone: 'Australia/Brisbane', state: {}, runs: [{ id: 'historical-loop', loopId: 'inbound-triage', loopName: 'Fictional morning', createdAt: 1, scheduledFor: 1, manual: true, status: 'completed', requestId: loopRequest, loopRevision: 1 }] });
    const database = new WorkflowDatabase({ dir: source.directory, key: source.key });
    const jobs = new JobRunStore({ file: join(source.directory, 'job-runs.json'), database });
    const execute = vi.fn(async () => ({ ok: true, detail: 'Unexpected dispatch' }));
    const loops = new LoopManager({ file: join(source.directory, 'loops.json'), database, execute });
    try {
      expect(jobs.recovery.active).toBe(false); expect(loops.recovery.active).toBe(false);
      const next = jobs.enqueue(recipe, { mode: 'shadow', trigger: 'manual', idempotencyKey: 'history-newest' }); jobs.start(next.run.id); jobs.settle(next.run.id, { status: 'completed', detail: 'Fictional newest completion' });
      expect(jobs.list().some(run => run.id === runs[0].id)).toBe(false);
      expect(jobs.getByIdempotencyKey('history-0')?.id).toBe(runs[0].id);
      const historyOrder = jobs.history({ limit: 200 }).runs.map(run => run.id);
      const { backup, receipt } = await source.service.exportBackup(passphrase);
      const missingRequest = changedBackup(backup, snapshot => { const index = snapshot.records.findIndex(row => row.kind === 'execution-request'); expect(index).toBeGreaterThanOrEqual(0); snapshot.records.splice(index, 1); });
      await expect(target.service.previewBackup(missingRequest, passphrase)).rejects.toThrow(/Execution history needs recovery/);
      const missingLedger = changedBackup(backup, snapshot => { snapshot.records = snapshot.records.filter(row => !String(row.kind).startsWith('execution-')); });
      await expect(target.service.previewBackup(missingLedger, passphrase)).rejects.toThrow(/Execution history needs recovery/);
      await target.service.stageRestore({ backup, passphrase, expectedDigest: receipt.digest });
      await applyStagedPrivateRestore({ directory: target.directory, key: target.key });
      const restoredDatabase = new WorkflowDatabase({ dir: target.directory, key: target.key });
      const restoredJobs = new JobRunStore({ file: join(target.directory, 'job-runs.json'), database: restoredDatabase });
      const restoredLoops = new LoopManager({ file: join(target.directory, 'loops.json'), database: restoredDatabase, execute });
      try {
        expect(restoredJobs.recovery.active).toBe(false); expect(restoredLoops.recovery.active).toBe(false);
        expect(restoredJobs.enqueue(recipe, { mode: 'shadow', trigger: 'manual', idempotencyKey: 'history-0' })).toMatchObject({ created: false, run: { id: runs[0].id, status: 'completed' } });
        expect(restoredLoops.runNow('inbound-triage', { requestId: loopRequest, expectedRevision: 1 })).toMatchObject({ id: 'historical-loop', status: 'completed' });
        expect(restoredLoops.listLoops().every(loop => !loop.enabled)).toBe(true); expect(execute).not.toHaveBeenCalled();
        expect(restoredJobs.history({ limit: 200 }).runs.map(run => run.id)).toEqual(historyOrder);
      } finally { restoredJobs.close(); restoredLoops.close(); restoredDatabase.close(); }
    } finally { jobs.close(); loops.close(); database.close(); }
  });
  it('encrypts the source key, includes complete recognized workflow records and excludes provider/company credentials', async () => {
    const f = await populated(), { backup, receipt } = await f.service.exportBackup(passphrase);
    expect(receipt.recordCount).toBe(9); expect(receipt.workspaceId).toBe(f.workspaceId);
    const { value, key } = openBackup(backup); key.fill(0);
    expect(value.keyHex).toBe(f.key.toString('hex')); expect(value.records.some(entry => entry.kind === 'mail-source' && entry.id === `mail-source:${f.receiptId}`)).toBe(true);
    expect(value.files.some(f => /config|enrollment/.test(f.path))).toBe(false);
    expect(JSON.stringify(backup)).not.toContain(f.key.toString('hex')); expect(JSON.stringify(backup)).not.toContain('Fictional');
    expect(JSON.stringify(value)).not.toContain('excluded-provider-credential'); expect(JSON.stringify(value)).not.toContain('excluded-member-token');
    expect(await f.service.previewBackup(backup, passphrase)).toEqual(receipt);
  });
  it('stages without replacing files then restores to a different key with schedules and approvals held', async () => {
    const source = await populated(), target = await fixture(), { backup, receipt } = await source.service.exportBackup(passphrase);
    const before = await readFile(join(target.directory, 'desk.json'));
    expect(await target.service.stageRestore({ backup, passphrase, expectedDigest: receipt.digest })).toMatchObject({ needsRestart: true });
    expect(await readFile(join(target.directory, 'desk.json'))).toEqual(before);
    expect((await target.service.status()).state).toBe('staged');
    const stageText = await readFile(join(target.directory, PRIVATE_RESTORE_STAGE_FILE), 'utf8'); expect(stageText).not.toContain(source.key.toString('hex')); expect(stageText).not.toContain('Fictional original');
    await applyStagedPrivateRestore({ directory: target.directory, key: target.key });
    const restoredDesk = JSON.parse(await readFile(join(target.directory, 'desk.json'), 'utf8'));
    expect(decryptJson(target.key, restoredDesk)).toMatchObject({ ...source.book, revision: 2, hands: 'held', handsDetail: 'Private workspace restored. Reconnect sources and review work before running.' }); expect(() => decryptJson(source.key, restoredDesk)).toThrow();
    const reopened = new DeskStore({ file: join(target.directory, 'desk.json'), key: target.key, book: { properties: [], ledger: [] } }); expect(reopened.recovery.active).toBe(false); expect(reopened.data.hands).toBe('held');
    expect(JSON.parse(await readFile(join(target.directory, 'company-installation/workspace.json'), 'utf8')).id).toBe(source.workspaceId);
    const agency = JSON.parse(await readFile(join(target.directory, 'agency-setup.json'), 'utf8')); expect(agency.settings.gmailAccountId).toBeNull(); expect(agency.reviews).toEqual({}); expect(agency.revision).toBe(3);
    const recipe = JSON.parse(await readFile(join(target.directory, 'recipes.json'), 'utf8')).recipes[0]; expect(recipe).toMatchObject({ revision: 4, status: 'paused', schedule: null, approvedRevision: null, attachment: null });
    const loops = JSON.parse(await readFile(join(target.directory, 'loops.json'), 'utf8')); expect(Object.values(loops.state).every((s: unknown) => (s as { enabled: boolean }).enabled === false)).toBe(true); expect(loops.runs[0].status).toBe('interrupted');
    const runs = JSON.parse(await readFile(join(target.directory, 'job-runs.json'), 'utf8')).runs; expect(runs[0].status).toBe('interrupted'); expect(runs[1].evidence[0].note).toBe('Retained evidence');
    const restoredMail = createMailIngestionService({ directory: target.directory, key: target.key, workspaceId: source.workspaceId, workroomDirectory: join(target.directory, 'vault'),
      authorize: async () => { throw new Error('Restored source access must not grant provider authority.'); }, scan: async () => { throw new Error('Restored source access must not call a provider.'); } });
    try {
      expect(await restoredMail.source(source.mailItemId)).toMatchObject({ thread: { messages: [{ body: 'Fictional original saved source' }] } });
      expect((await restoredMail.getItem(source.mailItemId)).note).toBe('Retained human correction');
    } finally { await restoredMail.close(); }
    const db = new WorkflowDatabase({ dir: target.directory, key: target.key }); try { expect(Buffer.from(new BankReferenceStore(db).export(source.bankId, true).bytesBase64, 'base64')).toEqual(source.bankBytes); expect(db.get('handoff', 'handover:example')?.value).toMatchObject({ state: 'closed' }); expect(db.list('bill-proposal')).toHaveLength(1); } finally { db.close(); }
    expect(await target.service.status()).toMatchObject({ state: 'none', receipt: null, completed: { version: 1, receipt, rekeyed: true, reviewRequired: true } });
    const reopenedBackup = createPrivateWorkspaceBackup(target.options);
    expect((await reopenedBackup.status()).completed).toEqual((await target.service.status()).completed);
    expect(JSON.parse(await readFile(join(target.directory, PRIVATE_RESTORE_RECEIPT_FILE), 'utf8'))).toMatchObject({ rekeyed: true, reviewRequired: true });
  });
  it('does not invent completion for a fresh workspace and preserves malformed completion receipts', async () => {
    const f = await fixture();
    expect(await f.service.status()).toEqual({ state: 'none', receipt: null, completed: null });
    const invalid = '{"version":1,"restoredAt":"not-a-date","receipt":{}}';
    await writeFile(join(f.directory, PRIVATE_RESTORE_RECEIPT_FILE), invalid, { mode: 0o600 });
    expect(await f.service.status()).toMatchObject({ state: 'none', completed: null, completionWarning: expect.stringContaining('completion cannot be confirmed') });
    expect((await f.service.exportBackup(passphrase)).receipt.fileCount).toBeGreaterThan(0);
    expect(await readFile(join(f.directory, PRIVATE_RESTORE_RECEIPT_FILE), 'utf8')).toBe(invalid);
    await writeFile(join(f.directory, PRIVATE_RESTORE_STAGE_FILE), invalid, { mode: 0o600 });
    await expect(f.service.status()).rejects.toMatchObject({ status: 503 });
  });
  it('rejects wrong passphrases, changed ciphertext and stale preview digests without replacing target files', async () => {
    const f = await fixture(), { backup } = await f.service.exportBackup(passphrase);
    await expect(f.service.previewBackup(backup, 'Incorrect long passphrase')).rejects.toMatchObject({ status: 400 });
    const changed = Buffer.from(backup.payload.ct, 'base64'); changed[0] ^= 1;
    await expect(f.service.previewBackup({ ...backup, payload: { ...backup.payload, ct: changed.toString('base64') } }, passphrase)).rejects.toMatchObject({ status: 400 });
    await expect(f.service.stageRestore({ backup, passphrase, expectedDigest: '0'.repeat(64) })).rejects.toMatchObject({ status: 409 });
    expect((await f.service.status()).state).toBe('none');
  });
  it.each(['../config.json', '/tmp/config.json', 'C:\\config.json', 'vault/workflow-inputs/CON.json', 'company-installation/enrollment.json', 'workflow-state.sqlite'])('rejects uploaded path %s and arbitrary SQLite before staging', async path => {
    const f = await fixture(), { backup } = await f.service.exportBackup(passphrase);
    const malicious = changedBackup(backup, value => { value.files[0].path = path; });
    await expect(f.service.previewBackup(malicious, passphrase)).rejects.toMatchObject({ status: 400 });
  });
  it('rejects duplicate paths, forged content, foreign identity and the wrong source key', async () => {
    const f = await fixture(), { backup } = await f.service.exportBackup(passphrase);
    for (const change of [
      (value: ReturnType<typeof openBackup>['value']) => { value.files.push(value.files[0]); },
      (value: ReturnType<typeof openBackup>['value']) => { value.files[0].base64 = Buffer.from('{}').toString('base64'); },
      (value: ReturnType<typeof openBackup>['value']) => { value.workspaceId = randomUUID(); },
      (value: ReturnType<typeof openBackup>['value']) => { value.keyHex = '1'.repeat(64); },
    ]) await expect(f.service.previewBackup(changedBackup(backup, change), passphrase)).rejects.toMatchObject({ status: 400 });
  });
  it('holds linked source files without reading their content', async () => {
    const f = await fixture(); await mkdir(join(f.directory, 'vault/properties'), { recursive: true, mode: 0o700 });
    await symlink(join(f.directory, 'desk.json'), join(f.directory, 'vault/properties/linked.md'));
    await expect(f.service.exportBackup(passphrase)).rejects.toThrow(/linked|invalid/);
  });
  it('refuses unknown record kinds and executable uploaded database schema rather than silently dropping history', async () => {
    const f = await fixture(), db = new WorkflowDatabase({ dir: f.directory, key: f.key }); db.create('future-business-record', 'future:one', { value: 'Keep me' }); db.close();
    await expect(f.service.exportBackup(passphrase)).rejects.toThrow(/Unknown/);
    const sql = new DatabaseSync(join(f.directory, 'workflow-state.sqlite')); sql.exec("DELETE FROM workflow_records; CREATE TRIGGER unexpected AFTER INSERT ON workflow_records BEGIN DELETE FROM workflow_records; END;"); sql.close();
    await expect(f.service.exportBackup(passphrase)).rejects.toThrow(/schema/);
  });
  it('holds changed source generation and blocks concurrent backup operations', async () => {
    const f = await fixture(), first = f.service.exportBackup(passphrase);
    await expect(f.service.exportBackup(passphrase)).rejects.toThrow(/in progress/); f.change(); await expect(first).rejects.toThrow(/changed/);
  });
  it('enforces the host fresh and idle checks before staging any restore', async () => {
    const f = await fixture(), { backup, receipt } = await f.service.exportBackup(passphrase);
    f.assertFresh.mockImplementation(() => { throw Object.assign(new Error('Existing real business records'), { status: 409 }); });
    await expect(f.service.stageRestore({ backup, passphrase, expectedDigest: receipt.digest })).rejects.toThrow(/Existing real/);
    expect((await f.service.status()).state).toBe('none');
  });
  it('holds a changed target at restart before any replacement', async () => {
    const source = await populated(), target = await fixture(), { backup, receipt } = await source.service.exportBackup(passphrase);
    await target.service.stageRestore({ backup, passphrase, expectedDigest: receipt.digest });
    const before = await readFile(join(target.directory, 'desk.json')); await writeJson(target.directory, 'agency-setup.json', { newBusiness: true });
    await expect(applyStagedPrivateRestore({ directory: target.directory, key: target.key })).rejects.toMatchObject({ status: 503 });
    expect(await readFile(join(target.directory, 'desk.json'))).toEqual(before); expect((await target.service.status()).state).toBe('staged');
  });
  it('holds new company state created after staging before starting any private restore', async () => {
    const source = await fixture(), target = await fixture(), { backup, receipt } = await source.service.exportBackup(passphrase);
    await target.service.stageRestore({ backup, passphrase, expectedDigest: receipt.digest });
    await mkdir(join(target.directory, 'company-installation/postgres'), { mode: 0o700 });
    await expect(applyStagedPrivateRestore({ directory: target.directory, key: target.key })).rejects.toMatchObject({ status: 503 });
    expect((await target.service.status()).state).toBe('staged');
  });
  it('invalidates live Desk handoffs while preserving used receipts and reopening through the production store', async () => {
    const source = await fixture(), target = await fixture(), legacy = emptyV2(fixtureBook());
    const capability = { id: 'cap-unused', workItemId: 'work-1', revision: 1, proposalHash: 'h', propertyId: 'prop-oak', recipeId: 'fake-building-portal', recipeVersion: 1, operation: 'prefill-courtesy' as const, approver: 'pm', expiresAt: source.now() + 60_000 };
    legacy.capabilities.push(capability, { ...capability, id: 'cap-used', workItemId: 'work-2', usedAt: 1000 });
    const book = migrateV2ToV3(legacy, source.now());
    delete book.handoffs[0].invalidatedAt; delete book.handoffs[0].verification; decodeDeskV3(book);
    await writeJson(source.directory, 'desk.json', encryptJson(source.key, book));
    const { backup, receipt } = await source.service.exportBackup(passphrase); await target.service.stageRestore({ backup, passphrase, expectedDigest: receipt.digest });
    await applyStagedPrivateRestore({ directory: target.directory, key: target.key });
    const restored = decodeDeskV3(decryptJson(target.key, JSON.parse(await readFile(join(target.directory, 'desk.json'), 'utf8'))));
    expect(restored.handoffs.find(h => h.id === 'cap-unused')).toMatchObject({ invalidatedAt: target.now(), verification: 'invalidated', authorization: { expiresAt: 0 } });
    expect(restored.handoffs.find(h => h.id === 'cap-used')).toEqual(book.handoffs.find(h => h.id === 'cap-used'));
    expect(new DeskStore({ file: join(target.directory, 'desk.json'), key: target.key, book: fixtureBook() }).recovery.active).toBe(false);
  });
  it.each(['agency-setup.json','recipes.json','job-runs.json','loops.json','expected-bills.json','customer-packs.json'])('rejects corrupt business schema in %s instead of exporting a falsely usable backup', async path => {
    const f = await fixture(); await writeJson(f.directory, path, {});
    await expect(f.service.exportBackup(passphrase)).rejects.toThrow(/recovery|workspace/);
  });
  it('resumes an interrupted multi-file restore idempotently and holds tampered staged bytes', async () => {
    const source = await populated(), target = await fixture(), { backup, receipt } = await source.service.exportBackup(passphrase);
    await target.service.stageRestore({ backup, passphrase, expectedDigest: receipt.digest });
    await expect(applyStagedPrivateRestore({ directory: target.directory, key: target.key, afterWrite: () => { throw new Error('Simulated power interruption'); } })).rejects.toThrow(/power/);
    expect((await target.service.status()).state).toBe('applying');
    expect(await applyStagedPrivateRestore({ directory: target.directory, key: target.key })).toMatchObject({ restored: true });
    expect(await applyStagedPrivateRestore({ directory: target.directory, key: target.key })).toEqual({ restored: false });
    expect((await readdir(target.directory)).some(name => name.startsWith('.private-restore-database-'))).toBe(false);
    await writeJson(target.directory, PRIVATE_RESTORE_STAGE_FILE, { broken: true });
    await expect(applyStagedPrivateRestore({ directory: target.directory, key: target.key })).rejects.toMatchObject({ status: 503 });
  });
});
