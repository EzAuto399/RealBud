import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { createPrivateWorkspaceBackup, applyStagedPrivateRestore } from './private-workspace-backup.ts';
import { RedbarkCoverage } from './bank-reference-store.ts';
import { encryptJson, decryptJson } from './desk-crypto.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import type { PrivateWorkspaceBackup } from '../shared/private-workspace-backup.ts';
import { plantPrivateFiles, privateTempRoot, removeFixture } from './testing/private-fixture.ts';

const roots: string[] = [], phrase = 'Fictional coverage backup phrase';
const ACCOUNT = 'acct_FictionalTrust0001', CONNECTION = 'conn_FictionalAnz0001', PATH = 'bank-source/redbark-coverage.json';
afterEach(async () => { await Promise.all(roots.splice(0).map(root => removeFixture(root))); });
function fixture() {
  const directory = privateTempRoot(join(realpathSync(tmpdir()), 'RealBud coverage backup ')); roots.push(directory);
  const key = randomBytes(32), workspaceId = randomUUID();
  plantPrivateFiles([[join(directory, 'company-installation/workspace.json'), JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null })],
    [join(directory, 'desk.json'), JSON.stringify(encryptJson(key, emptyV3({ name: 'Fictional coverage office', timezone: 'UTC', jurisdictions: [] })))]]);
  const service = createPrivateWorkspaceBackup({ directory, key: () => key, workspaceId, epoch: () => 'fixture', assertIdle: () => {}, assertFresh: () => {} });
  return { directory, key, file: join(directory, PATH), service, coverage: new RedbarkCoverage(directory) };
}
const provenance = (from: string, to: string, ids: string[]) => ({ kind: 'redbark-api', account: ACCOUNT, connection: CONNECTION, requestedFrom: from, requestedTo: to, runDate: to, transactionIds: ids }) as never;
type Snapshot = { files: { path: string; sha256: string; bytes: number; base64: string }[] };
function alterCoverage(backup: PrivateWorkspaceBackup, change: (value: { accounts: Record<string, Record<string, unknown>> } & Record<string, unknown>) => void) {
  const key = scryptSync(phrase, Buffer.from(backup.salt, 'hex'), 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  try {
    const snapshot = decryptJson(key, backup.payload) as Snapshot, saved = snapshot.files.find(f => f.path === PATH)!;
    const value = JSON.parse(Buffer.from(saved.base64, 'base64').toString('utf8')); change(value);
    const data = Buffer.from(JSON.stringify(value));
    Object.assign(saved, { sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, base64: data.toString('base64') });
    return { ...backup, payload: encryptJson(key, snapshot) };
  } finally { key.fill(0); }
}

describe('Redbark bank coverage through private backup (fictional)', () => {
  it('round-trips the coverage cursor, confirmed ids and held rows exactly', async () => {
    const from = fixture(), to = fixture();
    await from.coverage.confirm(provenance('2026-09-30', '2026-10-02', ['txn_fk_cov-1']), 'bank:' + 'a'.repeat(64), ['2026-10-01'], 0,
      { 'txn_fk_cov-2': { date: '2026-10-02', amount: '-20.00', narrative: 'FICTIONAL BANK FEE', reference: '', heldSince: '2026-10-02' } });
    const before = readFileSync(from.file, 'utf8');
    const exported = await from.service.exportBackup(phrase);
    expect(JSON.stringify(exported.backup)).not.toContain('FICTIONAL BANK FEE');
    await to.service.stageRestore({ backup: exported.backup, passphrase: phrase, expectedDigest: exported.receipt.digest });
    await applyStagedPrivateRestore({ directory: to.directory, key: to.key });
    expect(readFileSync(to.file, 'utf8')).toBe(before);
    expect(await to.coverage.state(ACCOUNT)).toEqual(await from.coverage.state(ACCOUNT));
    // A restored cursor still refuses a batch from a different bank connection.
    await expect(to.coverage.confirm({ ...(provenance('2026-10-01', '2026-10-03', ['txn_fk_cov-3']) as object), connection: 'conn_FictionalOther001' } as never, 'bank:' + 'b'.repeat(64), ['2026-10-03'], 1))
      .rejects.toMatchObject({ status: 409 });
  });

  it('restores an older backup without the file as no confirmed coverage', async () => {
    const from = fixture(), to = fixture();
    const exported = await from.service.exportBackup(phrase);
    await to.service.stageRestore({ backup: exported.backup, passphrase: phrase, expectedDigest: exported.receipt.digest });
    await applyStagedPrivateRestore({ directory: to.directory, key: to.key });
    expect(existsSync(to.file)).toBe(false);
    expect(await to.coverage.state(ACCOUNT)).toBeNull();
  });

  it('refuses a damaged or extended coverage file at capture and at restore', async () => {
    const from = fixture(), to = fixture();
    await from.coverage.confirm(provenance('2026-09-30', '2026-10-02', ['txn_fk_cov-1']), 'bank:' + 'a'.repeat(64), ['2026-10-01'], 0);
    const exported = await from.service.exportBackup(phrase);
    const extended = alterCoverage(exported.backup, value => { value.accounts[ACCOUNT].unexpected = 'Fictional extra field'; });
    await expect(to.service.stageRestore({ backup: extended, passphrase: phrase, expectedDigest: 'x'.repeat(64) })).rejects.toThrow('Saved bank coverage needs recovery.');
    const damaged = alterCoverage(exported.backup, value => { value.accounts[ACCOUNT].coveredThrough = 'yesterday'; });
    await expect(to.service.previewBackup(damaged, phrase)).rejects.toThrow('Saved bank coverage needs recovery.');
    const saved = JSON.parse(readFileSync(from.file, 'utf8')); saved.extra = true;
    writeFileSync(from.file, JSON.stringify(saved)); chmodSync(from.file, 0o600);
    await expect(from.service.exportBackup(phrase)).rejects.toThrow('Saved bank coverage needs recovery.');
  });
});
