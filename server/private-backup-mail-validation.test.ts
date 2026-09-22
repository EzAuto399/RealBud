import { afterEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMailIngestionService, type MailAuthority } from './mail-ingestion.ts';
import { createPrivateVault } from './private-vault.ts';
import { legacyMailBackupFixture } from './testing/mail-backup-fixture.ts';
import { decryptJson, encryptJson } from './desk-crypto.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { validateBackupMail } from './private-backup-mail-validation.ts';
import { applyStagedPrivateRestore, createPrivateWorkspaceBackup } from './private-workspace-backup.ts';
import { plantPrivateFile, plantPrivateFiles, privateTempRoot, removeFixture } from './testing/private-fixture.ts';

const directories: string[] = [], services: ReturnType<typeof createMailIngestionService>[] = [];
afterEach(async () => { for (const service of services.splice(0)) await service.close(); await Promise.all(directories.splice(0).map(removeFixture)); });
const now = Date.parse('2026-09-21T00:00:00Z'), prefix = 'company-installation/private/';
type Files = { path: string; base64: string }[];
async function directory() { const value = privateTempRoot(join(realpathSync(tmpdir()), 'rb-backup-mail-')); directories.push(value); return value; }
async function fixture() {
  const root = await directory(), key = Buffer.alloc(32, 19), workspaceId = randomUUID();
  const legacy = legacyMailBackupFixture(workspaceId, now);
  const authority: MailAuthority = { accountId: 'fictional-mail', bindingRevision: 'a'.repeat(64), settingsRevision: 1, settings: legacy.settings };
  const options = { directory: root, key, workspaceId, workroomDirectory: join(root, 'vault'), now: () => now,
    authorize: async () => structuredClone(authority),
    scan: async () => structuredClone(legacy.data),
  };
  const vault = createPrivateVault(root, key);
  await vault.write('mail-workspace', legacy.state);
  await vault.write(`mail-scan-${legacy.receipt.id}`, legacy.source);
  await vault.write('mail-prepared-input', legacy.prepared);
  plantPrivateFile(join(root, 'vault/workflow-inputs/accounts-inbox.json'), JSON.stringify(legacy.input));
  const service = createMailIngestionService(options), snapshot = legacy.state;
  services.push(service);
  const files = async (): Promise<Files> => [...await Promise.all((await readdir(join(root, prefix))).map(async name => ({ path: prefix + name, base64: (await readFile(join(root, prefix, name))).toString('base64') }))), { path: 'vault/workflow-inputs/accounts-inbox.json', base64: (await readFile(join(root, 'vault/workflow-inputs/accounts-inbox.json'))).toString('base64') }];
  return { root, key, workspaceId, options, service, snapshot, files, vault: createPrivateVault(root, key), scanName: `mail-scan-${snapshot.latestScan!.id}` };
}
function alter(files: Files, key: Buffer, name: string, update: (value: any) => void) {
  const file = files.find(file => file.path === `${prefix}${name}.json`)!;
  const envelope = decryptJson(key, JSON.parse(Buffer.from(file.base64, 'base64').toString('utf8'))) as { name: string; value: unknown };
  update(envelope.value); file.base64 = Buffer.from(JSON.stringify(encryptJson(key, envelope))).toString('base64');
}
async function writeIdentity(root: string, key: Buffer, workspaceId: string) {
  plantPrivateFiles([[join(root, 'company-installation/workspace.json'), JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null })],
    [join(root, 'desk.json'), JSON.stringify(encryptJson(key, emptyV3({ name: 'Fictional practice', timezone: 'Australia/Brisbane', jurisdictions: [] })))]]);
}

describe('backup mail source graph', () => {
  it('accepts exact legacy collected/prepared/manual projections and opens them after export, rekey and cold restore', async () => {
    const f = await fixture();
    const files = await f.files(); expect(() => validateBackupMail(files, f.key, f.workspaceId)).not.toThrow();
    await writeIdentity(f.root, f.key, f.workspaceId);
    const target = await directory(), targetKey = Buffer.alloc(32, 23), targetId = randomUUID(); await writeIdentity(target, targetKey, targetId);
    const make = (root: string, key: Buffer, workspaceId: string) => createPrivateWorkspaceBackup({ directory: root, key: () => key, workspaceId, epoch: () => 'stable', assertIdle: () => {}, assertFresh: () => {}, now: () => now });
    const passphrase = 'Synthetic private backup phrase', { backup, receipt } = await make(f.root, f.key, f.workspaceId).exportBackup(passphrase);
    await make(target, targetKey, targetId).stageRestore({ backup, passphrase, expectedDigest: receipt.digest });
    await applyStagedPrivateRestore({ directory: target, key: targetKey });
    const restored = createMailIngestionService({ ...f.options, directory: target, key: targetKey, workroomDirectory: join(target, 'vault') });
    services.push(restored);
    expect((await restored.page({ group: 'all' })).items).toEqual(f.snapshot.items);
    expect(await restored.source(f.snapshot.items[0].id)).toEqual(await f.service.source(f.snapshot.items[0].id));
    expect((await restored.page({ group: 'all' })).items[0]).toMatchObject({ status: 'done', priority: 'high', note: 'Keep this human decision.' });
  });

  it.each([
    ['foreign workspace', (value: any) => { value.workspaceId = randomUUID(); }],
    ['missing request', (value: any) => { delete value.request; }],
    ['malformed provider data', (value: any) => { value.data.threads[0].messages = []; }],
    ['changed message body', (value: any) => { value.data.threads[0].messages[0].body = 'Unrecorded changed evidence'; }],
    ['wrong account', (value: any) => { value.data.accountId = 'another-mail'; }],
    ['wrong historical settings', (value: any) => { value.settings.gmailAccountId = 'another-mail'; }],
    ['missing settings', (value: any) => { delete value.settings; }],
    ['unbound request scope', (value: any) => { value.request.includeSent = false; }],
  ] as const)('rejects %s even when source encryption and envelope identity are valid', async (_label, update) => {
    const f = await fixture(), files = await f.files(); alter(files, f.key, f.scanName, update);
    expect(() => validateBackupMail(files, f.key, f.workspaceId)).toThrow(/Saved mail evidence needs recovery/);
    expect((await f.service.page({ group: 'all' })).items).toEqual(f.snapshot.items);
  });

  it.each([
    ['item identity', (value: any) => { value.items[0].id = 'b'.repeat(64); }],
    ['item evidence digest', (value: any) => { value.items[0].sourceDigest = 'b'.repeat(64); }],
    ['item message identities', (value: any) => { value.items[0].sourceMessageIds = ['bb']; }],
    ['receipt input digest', (value: any) => { value.receipts[0].inputDigest = 'b'.repeat(64); value.latestScan = structuredClone(value.receipts[0]); }],
    ['receipt record missing', (value: any) => { value.receipts = []; value.latestScan = null; }],
    ['latest receipt mismatch', (value: any) => { value.latestScan.pages++; }],
    ['malformed decisions', (value: any) => { value.items[0].status = 'auto-send'; }],
  ] as const)('rejects broken %s without normalizing away the mismatch', async (_label, update) => {
    const f = await fixture(), files = await f.files(); alter(files, f.key, 'mail-workspace', update);
    expect(() => validateBackupMail(files, f.key, f.workspaceId)).toThrow(/Saved mail evidence needs recovery/);
  });

  it('rejects missing evidence, orphan journals, wrong keys, wrong envelopes and oversized private files', async () => {
    const f = await fixture(), files = await f.files();
    expect(() => validateBackupMail(files.filter(file => !file.path.includes(f.scanName)), f.key, f.workspaceId)).toThrow();
    expect(() => validateBackupMail(files.filter(file => !file.path.endsWith('/mail-workspace.json')), f.key, f.workspaceId)).toThrow();
    expect(() => validateBackupMail(files, Buffer.alloc(32, 25), f.workspaceId)).toThrow();
    const replaced = structuredClone(files); replaced[0].base64 = Buffer.from(JSON.stringify(encryptJson(f.key, { name: 'another-name', value: {} }))).toString('base64');
    expect(() => validateBackupMail(replaced, f.key, f.workspaceId)).toThrow();
    const large = structuredClone(files); large[0].base64 = Buffer.alloc(2_000_001, 32).toString('base64');
    expect(() => validateBackupMail(large, f.key, f.workspaceId)).toThrow();
    expect(() => validateBackupMail([], f.key, f.workspaceId)).not.toThrow();
  });

  it('preserves valid older sources and a failed attempt written before its final journal commit', async () => {
    const f = await fixture(), files = await f.files(), secondId = randomUUID();
    const original = files.find(file => file.path.includes(f.scanName))!;
    const envelope = decryptJson(f.key, JSON.parse(Buffer.from(original.base64, 'base64').toString('utf8'))) as any;
    envelope.name = `mail-scan-${secondId}`;
    files.push({ path: `${prefix}${envelope.name}.json`, base64: Buffer.from(JSON.stringify(encryptJson(f.key, envelope))).toString('base64') });
    alter(files, f.key, 'mail-workspace', value => { const failed = { ...value.latestScan, id: secondId, status: 'failed', inputDigest: null }; value.receipts.push(failed); value.latestScan = failed; });
    expect(() => validateBackupMail(files, f.key, f.workspaceId)).not.toThrow();
  });

  it('accepts a recoverable interrupted intent without requiring nonexistent provider evidence', async () => {
    const f = await fixture(), files = await f.files();
    alter(files, f.key, 'mail-workspace', value => {
      const pending = { ...value.latestScan, id: randomUUID(), status: 'running', completedAt: null, inputDigest: null, messageCount: 0, threadCount: 0, pages: 0, gaps: [] };
      value.receipts.push(pending); value.latestScan = pending;
    });
    expect(() => validateBackupMail(files, f.key, f.workspaceId)).not.toThrow();
  });

  it('rejects a prepared review marker bound to another source', async () => {
    const f = await fixture(), files = await f.files(); alter(files, f.key, 'mail-prepared-input', value => { value.receiptId = randomUUID(); });
    expect(() => validateBackupMail(files, f.key, f.workspaceId)).toThrow();
  });

  it('rejects a forged prepared digest or a missing original input even with intact encryption', async () => {
    const f = await fixture(), files = await f.files();
    expect(() => validateBackupMail(files.filter(file => file.path !== 'vault/workflow-inputs/accounts-inbox.json'), f.key, f.workspaceId)).toThrow();
    alter(files, f.key, 'mail-prepared-input', value => { value.digest = 'f'.repeat(64); });
    expect(() => validateBackupMail(files, f.key, f.workspaceId)).toThrow();
  });
});
