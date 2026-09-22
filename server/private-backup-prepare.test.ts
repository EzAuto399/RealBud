import { afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyV3 } from '../shared/desk-v3.ts';
import { encryptJson } from './desk-crypto.ts';
import { PrivateBackupCatalog } from './private-backup-catalog.ts';
import { PrivateBackupPreparedStore } from './private-backup-prepared.ts';
import { preparePrivateBackupRestore } from './private-backup-prepare.ts';

const roots: string[] = [], catalogs: PrivateBackupCatalog[] = [], prepared: PrivateBackupPreparedStore[] = [];
afterEach(async () => {
  for (const s of prepared.splice(0)) await s.close();
  for (const c of catalogs.splice(0)) c.close();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(records = 0) {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'RealBud preparation capacity ')); roots.push(root);
  const directory = join(root, 'target'); await mkdir(directory, { mode: 0o700 });
  const key = randomBytes(32), workspaceId = randomUUID(), book = emptyV3({ name: 'Fictional preparation office', timezone: 'UTC', jurisdictions: [] });
  const original = Buffer.from(JSON.stringify(encryptJson(key, book)));
  await writeFile(join(directory, 'desk.json'), original, { mode: 0o600 });
  const source = await PrivateBackupCatalog.create({ directory: join(root, 'source'), key, workspaceId, maxEntries: 100, maxBytes: 1024 ** 2 }); catalogs.push(source);
  source.addFile({ path: 'company-installation/workspace.json', encoding: 'bytes', data: Buffer.from(JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null })) });
  source.addFile({ path: 'desk.json', encoding: 'json', data: Buffer.from(JSON.stringify(book)) });
  for (let n = 0; n < records; n++) source.addRecord({ id: `handoff:${n}`, kind: 'handoff', revision: 1,
    value: { version: 1, runId: 'run', threadId: 'thread', botId: 'bot', detail: 'Retained fictional evidence '.repeat(600), jobRevision: 1, reason: 'login', state: 'closed' } });
  source.seal();
  async function destination() {
    const store = await PrivateBackupPreparedStore.create({ directory: join(root, randomUUID()), key, workspaceId }); prepared.push(store); return store;
  }
  const target = await destination();
  return { directory, key, source, target, original, destination, options: { directory, key, source, prepared: target, databasePresent: records > 0, assertLease() {} } };
}

describe('bounded restore database preparation', () => {
  it('hits an actual SQLite page cap without staging partial database bytes, then retries into a fresh prepared store', async () => {
    const f = await fixture(12), before = f.source.summary();
    await expect(preparePrivateBackupRestore({ ...f.options, databaseBytes: 65_536 })).rejects.toMatchObject({ status: 413 });
    expect(f.target.summary()).toMatchObject({ sealed: false, entries: 2 });
    expect(f.source.validate()).toEqual(before);
    expect(await readFile(join(f.directory, 'desk.json'))).toEqual(f.original);
    expect(await readdir(join(f.directory, 'private-backup-v2', 'build'))).toEqual([]);
    expect((await readdir(f.directory)).some(name => name.includes('restore-v2.json'))).toBe(false);
    const retry = await f.destination();
    await expect(preparePrivateBackupRestore({ ...f.options, prepared: retry, databaseBytes: 512 * 1024 })).resolves.toMatchObject({ sealed: true, entries: 3 });
    expect([...retry.entries()].find(entry => entry.path === 'workflow-state.sqlite')!.bytes).toBeGreaterThan(65_536);
    expect(await readFile(join(f.directory, 'desk.json'))).toEqual(f.original);
  });
  it('preserves a pre-existing build allocation when exclusive creation fails', async () => {
    const f = await fixture(1), buildDirectoryId = randomUUID();
    const existing = join(f.directory, 'private-backup-v2', 'build', buildDirectoryId);
    await mkdir(existing, { recursive: true, mode: 0o700 });
    await writeFile(join(existing, 'retained.txt'), 'Earlier interrupted fixture', { mode: 0o600 });
    await expect(preparePrivateBackupRestore({ ...f.options, buildDirectoryId })).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(join(existing, 'retained.txt'), 'utf8')).toBe('Earlier interrupted fixture');
    expect(f.target.summary().sealed).toBe(false);
    expect(await readFile(join(f.directory, 'desk.json'))).toEqual(f.original);
  });
  it('holds unexpected files in its own build allocation instead of recursively deleting them', async () => {
    const f = await fixture(1), buildDirectoryId = randomUUID();
    const build = join(f.directory, 'private-backup-v2', 'build', buildDirectoryId);
    await expect(preparePrivateBackupRestore({ ...f.options, buildDirectoryId, async onProgress(value) {
      if (value.files === 3) {
        await writeFile(join(build, 'unattributed.txt'), 'Preserve this fixture', { mode: 0o600 });
        throw new Error('Interrupted after build');
      }
    } })).rejects.toThrow('unexpected files');
    expect(await readFile(join(build, 'unattributed.txt'), 'utf8')).toBe('Preserve this fixture');
    expect(await readdir(build)).toContain('workflow-state.sqlite');
    expect(f.target.summary().sealed).toBe(false);
    expect(await readFile(join(f.directory, 'desk.json'))).toEqual(f.original);
  });
  it.each(['../other', '/tmp/other', 'unknown'])('rejects invalid build allocation %s before preparation', async buildDirectoryId => {
    const f = await fixture();
    await expect(preparePrivateBackupRestore({ ...f.options, buildDirectoryId })).rejects.toMatchObject({ status: 400 });
    expect(f.target.summary()).toMatchObject({ entries: 0, sealed: false });
  });
  it.each([0, 65_537, 2 ** 40, NaN])('rejects invalid internal byte capacity %s before writing', async databaseBytes => {
    const f = await fixture();
    await expect(preparePrivateBackupRestore({ ...f.options, databaseBytes })).rejects.toMatchObject({ status: 400 });
    expect(f.target.summary()).toMatchObject({ entries: 0, sealed: false });
    expect(await readFile(join(f.directory, 'desk.json'))).toEqual(f.original);
  });
  it('does not accept an asynchronous lease assertion as successful admission', async () => {
    const f = await fixture();
    await expect(preparePrivateBackupRestore({ ...f.options, assertLease: async () => { throw new Error('held'); } })).rejects.toMatchObject({ status: 500 });
    expect(f.target.summary()).toMatchObject({ entries: 0, sealed: false });
  });
  it('awaits progress persistence and rechecks admission before publishing a seal', async () => {
    const f = await fixture(); let held = true, progressCalls = 0;
    await expect(preparePrivateBackupRestore({ ...f.options, assertLease() { if (!held) throw new Error('lease released'); },
      async onProgress() { progressCalls++; await new Promise(resolve => setTimeout(resolve, 1)); held = false; },
    })).rejects.toThrow('lease released');
    expect(progressCalls).toBe(1);
    expect(f.target.summary()).toMatchObject({ entries: 1, sealed: false });
    expect(await readFile(join(f.directory, 'desk.json'))).toEqual(f.original);
  });
  it('propagates failed progress persistence without sealing or publishing a restore', async () => {
    const f = await fixture();
    await expect(preparePrivateBackupRestore({ ...f.options, async onProgress() { throw new Error('journal write failed'); } })).rejects.toThrow('journal write failed');
    expect(f.target.summary()).toMatchObject({ entries: 1, sealed: false });
    expect(await readFile(join(f.directory, 'desk.json'))).toEqual(f.original);
  });
});
