import { afterEach, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capturePrivateWorkspace, verifyPrivateWorkspaceCapture, privateBackupTargetPaths } from './private-backup-capture.ts';
import { PrivateBackupCatalog } from './private-backup-catalog.ts';
import { encryptJson } from './desk-crypto.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { plantPrivateFile, plantPrivateFiles, privateDir, privateTempRoot, removeFixture } from './testing/private-fixture.ts';
import type { WindowsFilePrivacyOperation } from './windows-file-privacy.ts';

// Each Windows admission batch is one cold powershell.exe (4-20 s on a slow
// host) inside the snapshot pause, so the number of launches must not grow
// with the number of files a small office keeps.
const batches = vi.hoisted(() => ({ calls: [] as WindowsFilePrivacyOperation[][], refuse: null as null | ((batch: WindowsFilePrivacyOperation[]) => Error | null) }));
vi.mock('./windows-file-privacy.ts', async original => {
  const real = await original<typeof import('./windows-file-privacy.ts')>();
  return { ...real, windowsFilePrivacyBatch: vi.fn(async (operations: WindowsFilePrivacyOperation[]) => {
    batches.calls.push(operations.map(operation => ({ ...operation })));
    const refusal = batches.refuse?.(operations); if (refusal) throw refusal;
    return real.windowsFilePrivacyBatch(operations);
  }) };
});

const roots: string[] = [], catalogs: PrivateBackupCatalog[] = [];
afterEach(async () => {
  batches.calls.length = 0; batches.refuse = null;
  for (const catalog of catalogs.splice(0)) catalog.close();
  await Promise.all(roots.splice(0).map(root => removeFixture(root)));
});
async function fixture(files: number) {
  const root = privateTempRoot(join(realpathSync(tmpdir()), 'RealBud capture privacy ')); roots.push(root);
  const directory = join(root, 'source'), key = randomBytes(32), workspaceId = randomUUID();
  privateDir(directory);
  plantPrivateFile(join(directory, 'company-installation/workspace.json'), JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null }));
  plantPrivateFile(join(directory, 'desk.json'), JSON.stringify(encryptJson(key, emptyV3({ name: 'Fictional office', timezone: 'UTC', jurisdictions: [] }))));
  plantPrivateFiles(Array.from({ length: files }, (_, i) => [join(directory, `vault/properties/fictional-${i}.md`), Buffer.from(`Fictional note ${i}`)] as const));
  const catalog = await PrivateBackupCatalog.create({ directory: join(root, 'catalog'), key: randomBytes(32), workspaceId, maxEntries: 20_000, maxBytes: 64 * 1024 * 1024 }); catalogs.push(catalog);
  return { directory, catalog, options: { directory, key, workspaceId, catalog, assertLease: vi.fn() } };
}

it.each([24, 60])('admits every read path of %i files in one batch per pass', async files => {
  const f = await fixture(files);
  const receipt = await capturePrivateWorkspace(f.options);
  expect(batches.calls).toHaveLength(1);
  const captured = batches.calls[0]!;
  expect(captured.every(operation => operation.action === 'verify')).toBe(true);
  // Every file read and every directory listed is admitted, each exactly once.
  expect(captured.filter(operation => operation.kind === 'file').map(operation => operation.path))
    .toEqual(expect.arrayContaining([join(f.directory, 'desk.json'), join(f.directory, `vault/properties/fictional-${files - 1}.md`)]));
  expect(captured.filter(operation => operation.kind === 'file' && operation.path.startsWith(join(f.directory, 'vault', 'properties')))).toHaveLength(files);
  expect(captured).toContainEqual({ path: join(f.directory, 'vault/properties'), kind: 'directory', action: 'verify' });
  expect(new Set(captured.map(operation => `${operation.kind}:${operation.path}`)).size).toBe(captured.length);
  await verifyPrivateWorkspaceCapture(f.options, receipt);
  expect(batches.calls).toHaveLength(2);
  expect(batches.calls[1]).toEqual(captured);
  await privateBackupTargetPaths(f.directory);
  expect(batches.calls).toHaveLength(3);
});

it('splits a long list into bounded batches in the original order', async () => {
  const f = await fixture(150);
  await capturePrivateWorkspace(f.options);
  expect(batches.calls.map(batch => batch.length).every(length => length <= 64)).toBe(true);
  expect(batches.calls).toHaveLength(Math.ceil(batches.calls.flat().length / 64));
  expect(batches.calls.flat().filter(operation => operation.path.includes(join('vault', 'properties')) && operation.kind === 'file')).toHaveLength(150);
});

it('fails the pass closed when an admission refuses, with no receipt and no sealed catalog', async () => {
  const f = await fixture(24);
  batches.refuse = () => Object.assign(new Error('Windows file privacy could not be verified. [windows-acl:grant-not-allowed; exit=3; operation=5/30]'), { operationIndex: 5 });
  await expect(capturePrivateWorkspace(f.options)).rejects.toMatchObject({ operationIndex: 5, message: expect.stringContaining('grant-not-allowed') });
  expect(f.catalog.summary().sealed).toBe(false);
  await expect(privateBackupTargetPaths(f.directory)).rejects.toThrow(/grant-not-allowed/);
});
