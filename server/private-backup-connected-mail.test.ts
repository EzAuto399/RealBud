import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privateTempRoot, plantPrivateFile, removeFixture } from './testing/private-fixture.ts';
import { connectedAppCanonical, type ConnectedMailReview } from '../shared/connected-app-binding.ts';
import { ConnectedAppOperationStore } from './connected-app-operations.ts';
import { createConnectedMailReviewArtifacts } from './connected-app-recovery.ts';
import { createPrivateVault } from './private-vault.ts';
import { createPrivateWorkspaceBackup, applyStagedPrivateRestore, visitLegacyPrivateBackup, isPrivateBackupPath } from './private-workspace-backup.ts';
import { PrivateBackupCatalog } from './private-backup-catalog.ts';
import { transformPrivateBackupCatalog } from './private-backup-restore-catalog.ts';
import { encryptJson } from './desk-crypto.ts';
import { emptyV3 } from '../shared/desk-v3.ts';

const roots: string[] = [], catalogs: PrivateBackupCatalog[] = [];
const phrase = 'Fictional exact connected mail backup passphrase';
const digest = (value: unknown) => createHash('sha256').update(connectedAppCanonical(value)).digest('hex');
afterEach(async () => { for (const c of catalogs.splice(0)) c.close(); await Promise.all(roots.splice(0).map(removeFixture)); });
function fixture(workspaceId = randomUUID()) {
  const directory = privateTempRoot(join(tmpdir(), 'realbud-connected-mail-backup-')); roots.push(directory);
  const key = randomBytes(32), book = emptyV3({ name: 'Fictional mail backup office', timezone: 'UTC', jurisdictions: [] });
  plantPrivateFile(join(directory, 'company-installation/workspace.json'), JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null }));
  plantPrivateFile(join(directory, 'desk.json'), JSON.stringify(encryptJson(key, book)));
  const store = new ConnectedAppOperationStore({ file: join(directory, 'connected-app-operations.json'), now: () => 100 });
  const reviews = createConnectedMailReviewArtifacts(createPrivateVault(directory, key));
  const backup = createPrivateWorkspaceBackup({ directory, key: () => key, workspaceId, epoch: () => 'fictional', assertIdle() {}, assertFresh() {}, now: () => 200 });
  return { directory, key, workspaceId, book, store, reviews, backup };
}
async function seed(f: ReturnType<typeof fixture>, finish = true) {
  const binding = { provider: 'gmail' as const, accountId: 'account-a', companyId: 'company-a', emailAddress: 'verified@example.test', generation: 'a'.repeat(64) };
  const gatewayOrigin = 'https://gateway.example.test';
  const card = 'To: contractor@example.test\nSubject: Original repair\nMessage: SYNTHETIC EXACT PRIVATE ORIGINAL';
  const exact = '{"name":"GMAIL_SEND_EMAIL","arguments":{"body":"SYNTHETIC EXACT PRIVATE ORIGINAL"}}', approvalId = 'f'.repeat(32);
  const review: ConnectedMailReview = { version: 1, gatewayOrigin, workspaceDigest: f.store.workspaceDigest, accountDigest: digest({ provider: binding.provider, accountId: binding.accountId, companyId: binding.companyId, gatewayOrigin }),
    bindingDigest: binding.generation, binding, card, exact, approvalId, reviewDigest: digest({ summary: card, detail: exact, approvalId }), approvedAt: 50 };
  await f.reviews.write(review);
  const row = f.store.start({ threadId: 'original-thread', toolName: 'GMAIL_SEND_EMAIL', toolSlugs: [], workspaceDigest: review.workspaceDigest, accountDigest: review.accountDigest,
    realmDigest: digest({ companyId: binding.companyId, gatewayOrigin }), bindingDigest: review.bindingDigest, effectDigest: 'e'.repeat(64), reviewDigest: review.reviewDigest });
  if (finish) f.store.finish(row.id, 'unknown');
  return { review, row, path: `company-installation/private/mail-review-${review.reviewDigest}.json` };
}
async function catalog(root: string, name: string, key: Buffer, workspaceId: string) {
  const c = await PrivateBackupCatalog.create({ directory: join(root, name), key, workspaceId, maxEntries: 100, maxBytes: 8 * 1024 ** 2 }); catalogs.push(c); return c;
}
async function captured(f: ReturnType<typeof fixture>) {
  const exported = await f.backup.exportBackup(phrase), c = await catalog(f.directory, 'source-catalog', f.key, f.workspaceId);
  await visitLegacyPrivateBackup(exported.backup, phrase, { begin() {}, file(file) { c.addFile(file); }, record(row) { c.addRecord(row); } });
  c.seal(); return { exported, c };
}
describe('connected mail paired evidence survives private backup and restore', () => {
  it.each(['unknown', 'started'] as const)('v1 restore retains the %s receipt and protected exact review, and never makes an uncertain effect replayable', async status => {
    const source = fixture(), original = await seed(source, status === 'unknown'), target = fixture();
    const exported = await source.backup.exportBackup(phrase);
    expect(JSON.stringify(exported.backup)).not.toContain('SYNTHETIC EXACT PRIVATE ORIGINAL');
    expect(exported.receipt.included.join('\n')).toContain('protected approval');
    await target.backup.stageRestore({ backup: exported.backup, passphrase: phrase, expectedDigest: exported.receipt.digest });
    await applyStagedPrivateRestore({ directory: target.directory, key: target.key });
    const store = new ConnectedAppOperationStore({ file: join(target.directory, 'connected-app-operations.json') });
    const restored = store.list().find(row => row.id === original.row.id)!;
    expect(restored.status).toBe('unknown'); expect(restored.effectDigest).toBe('e'.repeat(64)); expect(restored.workspaceDigest).toBe(original.review.workspaceDigest);
    expect(restored.accountDigest).toBe(original.review.accountDigest); expect(restored.realmDigest).toBe(digest({ companyId: original.review.binding.companyId, gatewayOrigin: original.review.gatewayOrigin }));
    const reviews = createConnectedMailReviewArtifacts(createPrivateVault(target.directory, target.key));
    expect(await reviews.read(original.review.reviewDigest)).toEqual(original.review);
    expect(readFileSync(join(target.directory, original.path), 'utf8')).not.toContain('SYNTHETIC EXACT PRIVATE ORIGINAL');
    expect(() => store.priorMailEffect('e'.repeat(64))).toThrow(/unresolved/);
    // A copied foreign receipt cannot authorize this target identity. No receipt
    // or original review is rewritten to manufacture fresh account/effect scope.
    const foreignId = randomUUID();
    writeFileSync(join(target.directory, 'company-installation/workspace.json'), JSON.stringify({ version: 1, id: foreignId, workerMemberKey: null }), { mode: 0o600 });
    expect(() => store.priorMailEffect('f'.repeat(64))).toThrow(/another private workspace/);
  });
  it.each(['missing', 'tampered', 'foreign'] as const)('refuses a v1 export with %s original approval evidence rather than dropping the unknown outcome', async damage => {
    const source = fixture(), original = await seed(source);
    if (damage === 'missing') unlinkSync(join(source.directory, original.path));
    else {
      const review = { ...original.review, ...(damage === 'foreign' ? { workspaceDigest: 'c'.repeat(64) } : { card: 'changed original' }) };
      plantPrivateFile(join(source.directory, original.path), JSON.stringify(encryptJson(source.key, { name: `mail-review-${review.reviewDigest}`, value: review })));
    }
    await expect(source.backup.exportBackup(phrase)).rejects.toThrow(/mail evidence needs recovery/);
    expect(source.store.list()[0].status).toBe('unknown');
  });
  it.each(['company', 'issuer', 'receipt-realm', 'missing-realm'] as const)('refuses a paired backup with %s drift even when the account ID/address remain equal', async change => {
    const source = fixture(), original = await seed(source);
    if (change === 'company' || change === 'issuer') {
      const binding = { ...original.review.binding, ...(change === 'company' ? { companyId: 'company-b' } : {}) };
      const gatewayOrigin = change === 'issuer' ? 'https://another-gateway.example.test' : original.review.gatewayOrigin;
      const review = { ...original.review, binding, gatewayOrigin, accountDigest: digest({ provider: binding.provider, accountId: binding.accountId, companyId: binding.companyId, gatewayOrigin }) };
      plantPrivateFile(join(source.directory, original.path), JSON.stringify(encryptJson(source.key, { name: `mail-review-${review.reviewDigest}`, value: review })));
    } else {
      const path = join(source.directory, 'connected-app-operations.json'), saved = JSON.parse(readFileSync(path, 'utf8'));
      if (change === 'missing-realm') delete saved.operations[0].realmDigest;
      else saved.operations[0].realmDigest = digest({ companyId: 'company-b', gatewayOrigin: original.review.gatewayOrigin });
      plantPrivateFile(path, JSON.stringify(saved));
    }
    await expect(source.backup.exportBackup(phrase)).rejects.toThrow(/mail evidence needs recovery/);
    expect(source.store.list()[0].status).toBe('unknown');
  });
  it('v2 catalog admission and restore keep receipt→review identity, encryption and interrupted outcome together', async () => {
    const source = fixture(), original = await seed(source, false), { c } = await captured(source);
    expect(c.getFile(original.path)?.encoding).toBe('json');
    expect(c.summary().sealed).toBe(true);
    const target = await catalog(source.directory, 'target-catalog', randomBytes(32), source.workspaceId);
    transformPrivateBackupCatalog({ source: c, destination: target, at: 300 });
    const rows = JSON.parse(target.getFile('connected-app-operations.json')!.data.toString()).operations;
    expect(rows[0]).toMatchObject({ id: original.row.id, status: 'unknown', effectDigest: 'e'.repeat(64), reviewDigest: original.review.reviewDigest, workspaceDigest: original.review.workspaceDigest,
      accountDigest: original.review.accountDigest, realmDigest: digest({ companyId: original.review.binding.companyId, gatewayOrigin: original.review.gatewayOrigin }) });
    expect(JSON.parse(target.getFile(original.path)!.data.toString()).value).toEqual(original.review);
    const broken = await catalog(source.directory, 'broken-catalog', source.key, source.workspaceId);
    for (const file of c.iterateFiles()) if (file.path !== original.path) broken.addFile(file);
    expect(() => broken.seal()).toThrow(/mail evidence needs recovery/);
  });
  it('admits only the exact reviewed-mail namespace and conservatively retains legacy unknown rows', async () => {
    const f = fixture(); const row = f.store.start({ threadId: 'legacy', toolName: 'GMAIL_SEND_EMAIL', toolSlugs: [] }); f.store.finish(row.id, 'unknown');
    expect(isPrivateBackupPath(`company-installation/private/mail-review-${'a'.repeat(64)}.json`)).toBe(true);
    for (const path of ['company-installation/private/mail-review-anything.json', 'company-installation/private/mail-review-../secret.json', 'company-installation/private/development-key.json']) expect(isPrivateBackupPath(path)).toBe(false);
    const { c } = await captured(f); expect(c.getFile('connected-app-operations.json')).toBeDefined();
    expect(() => f.store.priorMailEffect('a'.repeat(64))).toThrow(/older/);
  });
});
