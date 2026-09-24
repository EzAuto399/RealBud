import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, symlink, link, copyFile, rename, readdir, chmod } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { capturePrivateWorkspace, verifyPrivateWorkspaceCapture, privateBackupTargetPaths, privateBackupTargetGuard, type PrivateCaptureOptions } from './private-backup-capture.ts';
import { PrivateBackupCatalog } from './private-backup-catalog.ts';
import { encryptBytes, encryptJson } from './desk-crypto.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { legacyMailBackupFixture } from './testing/mail-backup-fixture.ts';
import { plantPrivateFile, plantPrivateFiles, privateDir, privateTempRoot, removeFixture } from './testing/private-fixture.ts';

const roots: string[] = [], catalogs: PrivateBackupCatalog[] = [];
afterEach(async () => {
  for (const catalog of catalogs.splice(0)) catalog.close();
  await Promise.all(roots.splice(0).map(root => removeFixture(root)));
});
async function save(directory: string, path: string, value: unknown) {
  plantPrivateFile(join(directory, path), Buffer.isBuffer(value) ? value : JSON.stringify(value));
}
async function fixture() {
  const root = privateTempRoot(join(realpathSync(tmpdir()), 'RealBud source capture ')); roots.push(root);
  const directory = join(root, 'source'), key = randomBytes(32), targetKey = randomBytes(32), workspaceId = randomUUID();
  privateDir(directory);
  const workspace = { version: 1, id: workspaceId, workerMemberKey: null };
  const desk = emptyV3({ name: 'Fictional captured office', timezone: 'UTC', jurisdictions: [] });
  await save(directory, 'company-installation/workspace.json', workspace); await save(directory, 'desk.json', encryptJson(key, desk));
  const catalog = await PrivateBackupCatalog.create({ directory: join(root, 'catalog'), key: targetKey, workspaceId, maxEntries: 20_000, maxBytes: 512 * 1024 * 1024 }); catalogs.push(catalog);
  const assertLease = vi.fn(), options: PrivateCaptureOptions = { directory, key, workspaceId, catalog, assertLease };
  return { root, directory, key, targetKey, workspaceId, workspace, desk, catalog, options, assertLease };
}
function seedDatabase(directory: string, key: Buffer, count = 3, detail = 'Fictional retained work') {
  const database = new WorkflowDatabase({ dir: directory, key }); database.close();
  const db = new DatabaseSync(join(directory, 'workflow-state.sqlite'));
  const value = { version: 1, runId: 'retained-run', threadId: 'retained-thread', botId: 'retained-bud', jobRevision: 2, reason: 'login', state: 'closed', detail };
  const payload = JSON.stringify(encryptJson(key, value));
  try {
    db.exec('BEGIN IMMEDIATE');
    const insert = db.prepare('INSERT INTO workflow_records(rowid,id,kind,revision,payload) VALUES (?,?,?,?,?)');
    for (let i = 0; i < count; i++) insert.run(i * 3 + 2, `handoff:retained-${i}`, 'handoff', i + 7, payload);
    db.exec('COMMIT');
  } finally { db.close(); }
  return value;
}

describe('bounded immutable live-source capture', () => {
  it.each(['malformed', 'oversized'])('refuses %s portfolio history instead of sealing an incomplete backup', async kind => {
    const f = await fixture(), original = Buffer.from(kind === 'malformed' ? '[{"id":"broken"}]' : ' '.repeat(8 * 1024 * 1024 + 1));
    await save(f.directory, 'work-batches.json', original);
    await expect(capturePrivateWorkspace(f.options)).rejects.toThrow(kind === 'malformed' ? /batch history needs recovery/ : /limit|too large/i);
    expect(f.catalog.summary().sealed).toBe(false);
    expect(await readFile(join(f.directory, 'work-batches.json'))).toEqual(original);
  });
  it('captures exact bytes and ordered revisions into a different-key catalog, verifies source twice, and leaves business bytes unchanged', async () => {
    const f = await fixture(), original = Buffer.from('\uFEFFDate,Description,Reference\r\n2026-09-21,"保留, exact",0012\r\n');
    await save(f.directory, 'vault/workflow-inputs/original.csv', original);
    await save(f.directory, 'config.json', { fictionalProviderSecret: 'THIS-MUST-NEVER-ENTER-CATALOG' });
    await save(f.directory, 'company-installation/host.json', { fictionalMembershipSecret: 'DO-NOT-EXPORT-MEMBERSHIP' });
    seedDatabase(f.directory, f.key);
    const before = await readFile(join(f.directory, 'workflow-state.sqlite')), desk = await readFile(join(f.directory, 'desk.json'));
    const receipt = await capturePrivateWorkspace(f.options);
    expect(receipt).toMatchObject({ version: 1, databasePresent: true, fileCount: 3, recordCount: 3, catalogEntries: 6 });
    expect(f.catalog.summary().sealed).toBe(false);
    await verifyPrivateWorkspaceCapture(f.options, receipt);
    expect(f.catalog.seal()).toMatchObject({ files: 3, records: 3, sealed: true });
    expect(f.catalog.getFile('vault/workflow-inputs/original.csv')!.data).toEqual(original);
    expect(JSON.parse(f.catalog.getFile('desk.json')!.data.toString('utf8'))).toEqual(f.desk);
    expect([...f.catalog.iterateRecords()].map(record => [record.id, record.revision])).toEqual([['handoff:retained-0', 7], ['handoff:retained-1', 8], ['handoff:retained-2', 9]]);
    expect(f.catalog.getFile('config.json')).toBeUndefined(); expect(f.catalog.getFile('company-installation/host.json')).toBeUndefined();
    expect(await readFile(join(f.directory, 'workflow-state.sqlite'))).toEqual(before); expect(await readFile(join(f.directory, 'desk.json'))).toEqual(desk);
    const bytes = await readFile(join(f.catalog.directory, 'catalog.sqlite'));
    for (const secret of [f.key, f.targetKey, Buffer.from('THIS-MUST-NEVER-ENTER-CATALOG'), Buffer.from('DO-NOT-EXPORT-MEMBERSHIP')]) expect(bytes.includes(secret)).toBe(false);
    expect(JSON.stringify(receipt)).not.toContain(f.key.toString('hex')); expect(f.assertLease.mock.calls.length).toBeGreaterThan(20);
  });
  it('keeps legacy mail JSON property order and original prepared input without copying protected envelopes', async () => {
    const f = await fixture(), legacy = legacyMailBackupFixture(f.workspaceId, Date.parse('2026-09-21T00:00:00Z'));
    for (const [name, value] of [['mail-workspace', legacy.state], [`mail-scan-${legacy.receipt.id}`, legacy.source], ['mail-prepared-input', legacy.prepared]] as const) {
      await save(f.directory, `company-installation/private/${name}.json`, encryptJson(f.key, { name, value }));
    }
    await save(f.directory, 'vault/workflow-inputs/accounts-inbox.json', legacy.input);
    const receipt = await capturePrivateWorkspace(f.options); await verifyPrivateWorkspaceCapture(f.options, receipt);
    expect(f.catalog.seal().files).toBe(6);
    const saved = f.catalog.getFile(`company-installation/private/mail-scan-${legacy.receipt.id}.json`)!;
    expect(saved.encoding).toBe('json'); expect(saved.data.toString('utf8')).toBe(JSON.stringify({ name: `mail-scan-${legacy.receipt.id}`, value: legacy.source }));
    expect(receipt.databasePresent).toBe(false);
  });
  it.each(['file-update', 'new-file', 'config-update', 'join-office', 'new-company-entry', 'database-update', 'database-created'])('holds changed source evidence before lease release: %s', async change => {
    const f = await fixture(); if (change !== 'database-created') seedDatabase(f.directory, f.key);
    const receipt = await capturePrivateWorkspace(f.options);
    if (change === 'file-update') await save(f.directory, 'desk.json', encryptJson(f.key, { ...f.desk, revision: 2 }));
    if (change === 'new-file') await save(f.directory, 'vault/properties/later.md', Buffer.from('New retained note'));
    if (change === 'config-update') await save(f.directory, 'config.json', { fictionalNewProvider: true });
    if (change === 'join-office') await save(f.directory, 'company-installation/enrollment.json', { fictionalMembership: true });
    if (change === 'new-company-entry') await mkdir(join(f.directory, 'company-installation/new-office-directory'), { mode: 0o700 });
    if (change === 'database-update') {
      const db = new DatabaseSync(join(f.directory, 'workflow-state.sqlite')); db.exec('UPDATE workflow_records SET revision=revision+1'); db.close();
    }
    if (change === 'database-created') seedDatabase(f.directory, f.key);
    await expect(verifyPrivateWorkspaceCapture(f.options, receipt)).rejects.toThrow(/changed/);
    expect(f.catalog.summary().sealed).toBe(false);
  });
  it('detects a source changed after its capture read, even when every individual read was valid', async () => {
    const f = await fixture(); let changed = false;
    const options = { ...f.options, onProgress: async (progress: { phase: string; fileCount: number }) => {
      if (!changed && progress.phase === 'files' && progress.fileCount === 1) {
        changed = true; await save(f.directory, 'company-installation/workspace.json', { ...f.workspace, workerMemberKey: 'new-member' });
      }
    } };
    const receipt = await capturePrivateWorkspace(options);
    await expect(verifyPrivateWorkspaceCapture(f.options, receipt)).rejects.toThrow(/changed/);
  });
  it('rejects catalog mutation between capture and source verification', async () => {
    const f = await fixture(), receipt = await capturePrivateWorkspace(f.options);
    f.catalog.addFile({ path: 'vault/properties/not-captured.md', encoding: 'bytes', data: Buffer.from('Not in the source snapshot') });
    const progress = vi.fn();
    await expect(verifyPrivateWorkspaceCapture({ ...f.options, onProgress: progress }, receipt)).rejects.toThrow(/changed/);
    expect(progress).not.toHaveBeenCalled();
  });
  it('checks cancellation and lease revocation after callbacks without sealing partial work', async () => {
    for (const stop of ['abort', 'lease'] as const) {
      const f = await fixture(), controller = new AbortController(); let held = true;
      const options = { ...f.options, signal: controller.signal, assertLease: () => { if (!held) throw new Error('Snapshot lease was revoked'); },
        onProgress: () => { if (stop === 'abort') controller.abort(); else held = false; } };
      await expect(capturePrivateWorkspace(options)).rejects.toThrow(stop === 'abort' ? /cancelled/ : /lease was revoked/);
      expect(f.catalog.summary().sealed).toBe(false); expect(f.catalog.countRecords()).toBe(0);
    }
  });
  it('rejects source database replacement during its readonly iteration', async () => {
    const f = await fixture(); seedDatabase(f.directory, f.key, 75); let replaced = false;
    if (process.platform === 'win32') {
      // Windows refuses to replace a database file the capture holds open, so
      // the swap cannot happen there; the capture continues over unchanged bytes.
      let refused: unknown;
      await expect(capturePrivateWorkspace({ ...f.options, onProgress: async progress => {
        if (!replaced && progress.phase === 'records') {
          replaced = true; const path = join(f.directory, 'workflow-state.sqlite'), replacement = join(f.root, 'replacement.sqlite');
          await copyFile(path, replacement); refused = await rename(replacement, path).then(() => null, error => error);
        }
      } })).resolves.toBeDefined();
      expect(replaced).toBe(true); expect(refused).toMatchObject({ code: expect.stringMatching(/^(EBUSY|EPERM|EACCES)$/) });
      return;
    }
    await expect(capturePrivateWorkspace({ ...f.options, onProgress: async progress => {
      if (!replaced && progress.phase === 'records') {
        replaced = true; const path = join(f.directory, 'workflow-state.sqlite'), replacement = join(f.directory, 'replacement.sqlite');
        await copyFile(path, replacement); await chmod(replacement, 0o600); await rename(replacement, path);
      }
    } })).rejects.toThrow(/changed/);
    expect(replaced).toBe(true);
  });
  it.each(['symlink-file', 'hardlink-file', 'symlink-directory', 'symlink-database'])('refuses linked source storage: %s', async type => {
    const f = await fixture();
    if (type === 'symlink-file' || type === 'hardlink-file') {
      privateDir(join(f.directory, 'vault/properties'));
      const target = join(f.directory, 'vault/properties/linked.md');
      if (type === 'symlink-file') await symlink(join(f.directory, 'desk.json'), target); else await link(join(f.directory, 'desk.json'), target);
    } else if (type === 'symlink-directory') {
      await mkdir(join(f.directory, 'vault'), { mode: 0o700 }); await symlink(f.root, join(f.directory, 'vault/properties'));
    } else {
      seedDatabase(f.directory, f.key); await rename(join(f.directory, 'workflow-state.sqlite'), join(f.root, 'real.sqlite'));
      await symlink(join(f.root, 'real.sqlite'), join(f.directory, 'workflow-state.sqlite'));
    }
    await expect(capturePrivateWorkspace(f.options)).rejects.toThrow(/linked|invalid/);
  });
  it('bounds all visited directory entries including excluded names', async () => {
    const f = await fixture();
    privateDir(join(f.directory, 'vault/properties'));
    for (let i = 0; i < 6; i++) await save(f.directory, `vault/properties/excluded-${i}.bin`, Buffer.from('Excluded'));
    await expect(capturePrivateWorkspace({ ...f.options, limits: { maxDirectoryEntries: 5 } })).rejects.toMatchObject({ status: 413 });
    await expect(privateBackupTargetPaths(f.directory, { limits: { maxDirectoryEntries: 5 } })).rejects.toMatchObject({ status: 413 });
  });
  it.each(['-wal', '-shm', '-journal'])('holds source and cold target when a database sidecar remains: %s', async suffix => {
    const f = await fixture(); seedDatabase(f.directory, f.key);
    await save(f.directory, `workflow-state.sqlite${suffix}`, Buffer.from('Retained unfinished state'));
    await expect(capturePrivateWorkspace(f.options)).rejects.toThrow(/journal or WAL/);
    await expect(privateBackupTargetPaths(f.directory)).rejects.toThrow(/journal or WAL/);
    await expect(privateBackupTargetGuard(f.directory)).rejects.toThrow(/journal or WAL/);
    expect((await readFile(join(f.directory, `workflow-state.sqlite${suffix}`))).toString()).toBe('Retained unfinished state');
  });
  it('rejects clean WAL mode before SQLite can create sidecars and refuses async lease assertions', async () => {
    const f = await fixture(); seedDatabase(f.directory, f.key);
    const db = new DatabaseSync(join(f.directory, 'workflow-state.sqlite')); db.exec('PRAGMA journal_mode=WAL'); db.close();
    const before = (await readdir(f.directory)).sort();
    await expect(capturePrivateWorkspace(f.options)).rejects.toThrow(/rollback-journal mode/);
    expect((await readdir(f.directory)).sort()).toEqual(before);
    const other = await fixture();
    await expect(capturePrivateWorkspace({ ...other.options, assertLease: async () => { throw new Error('Lease absent'); } })).rejects.toThrow(/synchronously/);
    expect(other.catalog.summary().entries).toBe(0);
  });
  it.each(['new-table', 'trigger', 'column', 'version', 'unknown-kind', 'bad-payload', 'bad-revision'])('refuses incompatible schema or malformed workflow records: %s', async change => {
    const f = await fixture(); seedDatabase(f.directory, f.key);
    const db = new DatabaseSync(join(f.directory, 'workflow-state.sqlite'));
    if (change === 'new-table') db.exec('CREATE TABLE other (value TEXT)');
    if (change === 'trigger') db.exec('CREATE TRIGGER unwanted AFTER INSERT ON workflow_records BEGIN SELECT 1; END');
    if (change === 'column') db.exec('ALTER TABLE workflow_records ADD COLUMN hidden TEXT');
    if (change === 'version') db.exec('PRAGMA user_version=2');
    if (change === 'unknown-kind') db.exec("UPDATE workflow_records SET kind='unknown'");
    if (change === 'bad-payload') db.exec("UPDATE workflow_records SET payload='broken'");
    if (change === 'bad-revision') db.exec('UPDATE workflow_records SET revision=0');
    db.close(); const before = await readFile(join(f.directory, 'workflow-state.sqlite'));
    await expect(capturePrivateWorkspace(f.options)).rejects.toThrow();
    expect(await readFile(join(f.directory, 'workflow-state.sqlite'))).toEqual(before);
  });
  it('rejects wrong keys, malformed UTF-8, oversized files and unknown mail names', async () => {
    const wrong = await fixture(); await expect(capturePrivateWorkspace({ ...wrong.options, key: randomBytes(32) })).rejects.toThrow(/key/);
    const malformed = await fixture();
    await save(malformed.directory, 'desk.json', encryptBytes(malformed.key, Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xff]), Buffer.from('"}')])));
    await expect(capturePrivateWorkspace(malformed.options)).rejects.toThrow(/JSON record needs recovery/);
    const large = await fixture(); await save(large.directory, 'vault/properties/large.md', Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(capturePrivateWorkspace(large.options)).rejects.toThrow(/entity limit/);
    const mail = await fixture(); await save(mail.directory, 'company-installation/private/mail-unknown.json', {});
    await expect(capturePrivateWorkspace(mail.options)).rejects.toThrow(/Unrecognized mail evidence/);
  });
  it('supports cold target names and authority-only guards without a source key or catalog', async () => {
    const f = await fixture(); seedDatabase(f.directory, f.key);
    const paths = await privateBackupTargetPaths(f.directory);
    expect(paths).toEqual(['company-installation/workspace.json', 'desk.json', 'workflow-state.sqlite']);
    const guard = await privateBackupTargetGuard(f.directory);
    await save(f.directory, 'desk.json', Buffer.from('Business content can change during cold apply'));
    expect(await privateBackupTargetGuard(f.directory)).toBe(guard);
    await save(f.directory, 'config.json', { fictionalNewAuthority: true });
    expect(await privateBackupTargetGuard(f.directory)).not.toBe(guard);
  });
  // Windows: capture and recheck admit each of the ~3,100 files separately (about 6,300
  // PowerShell launches, ~30 min on a runner); the bounded-read proof is OS-independent.
  it.skipIf(process.platform === 'win32')('captures and rechecks more than 5,000 records and 3,000 files with bounded source reads', async () => {
    const f = await fixture(), detail = 'Fictional permanent source '.repeat(500);
    seedDatabase(f.directory, f.key, 5_101, detail);
    plantPrivateFiles(Array.from({ length: 3_101 }, (_, i) => [join(f.directory, `vault/properties/retained-${i}.md`), Buffer.from(`Fictional note ${i} 保留`)] as const));
    const receipt = await capturePrivateWorkspace(f.options);
    expect(receipt).toMatchObject({ fileCount: 3_103, recordCount: 5_101, databasePresent: true });
    expect(receipt.sourceBytes).toBeGreaterThan(48 * 1024 * 1024);
    await verifyPrivateWorkspaceCapture(f.options, receipt);
    expect(f.catalog.seal()).toMatchObject({ files: 3_103, records: 5_101, sealed: true });
    expect(f.catalog.getRecord('handoff', 'handoff:retained-5100')?.revision).toBe(5_107);
    expect(f.catalog.getFile('vault/properties/retained-3100.md')!.data.toString('utf8')).toContain('3100');
    expect((await readdir(f.directory)).sort()).toEqual(['company-installation', 'desk.json', 'vault', 'workflow-state.sqlite']);
  }, 90_000);
});
