/** Ownership of provisional backup files. The operation journal allocates each
 * resource before claim(); callers persist cleanup intent and drain writers
 * before remove(). This module never touches ordinary business directories. */
import { constants, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';
import { decryptJson, encryptJson, isEncryptedEnvelope } from './desk-crypto.ts';
import { fsyncDir } from './atomic.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { privateBackupTransferId } from '../shared/private-backup-transfers.ts';
import type { BackupResourceAllocation } from './private-backup-operations.ts';

export interface BackupResourceBinding { operationId: string; workspaceId: string; allocation: BackupResourceAllocation }
export interface PrivateBackupResourcesOptions {
  /** Installation-owned private-backup-v2 root, never an HTTP path. */
  directory: string; key: Buffer;
  /** Re-read the journal allocation and owner synchronously. For remove, also
   * verify cleanup eligibility, persisted deleting state and drained writers. */
  assertCurrent(binding: BackupResourceBinding, action: 'read' | 'claim' | 'remove'): void;
  /** Local fault seam; no serialized input selects it. */
  fault?(point: 'claim-ready' | 'claim-linked' | 'file-removed' | 'directory-removed' | 'claim-removed'): void;
}
const PARENTS = { capture: 'capture', decoded: 'decoded', preview: 'preview', prepared: 'prepared', archive: 'exports', build: 'build', upload: 'uploads' } as const;
const MARKER_BYTES = 4096;
const MAX_BYTES = 32 * 1024 ** 3;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function fail(message = 'Backup temporary storage needs recovery. Its files were preserved.', status = 503): never { throw Object.assign(new Error(message), { status }); }
const identity = (s: Stats, other: Stats) => s.dev === other.dev && s.ino === other.ino;
const sameFile = (s: Stats, other: Stats) => identity(s, other) && s.size === other.size && s.mtimeMs === other.mtimeMs && s.ctimeMs === other.ctimeMs;
function privateMode(s: Stats) { if (process.platform !== 'win32' && ((s.mode & 0o077) || s.uid !== process.getuid?.())) fail(); }
function binding(value: BackupResourceBinding): BackupResourceBinding {
  const a = value?.allocation;
  if (!object(value) || Object.keys(value).sort().join(',') !== 'allocation,operationId,workspaceId' || !privateBackupTransferId(value?.operationId) || !privateBackupTransferId(value?.workspaceId) || !object(a) ||
      Object.keys(a).sort().join(',') !== 'bytes,id,nonce,role,state' || !privateBackupTransferId(a.id) || !privateBackupTransferId(a.nonce) ||
      typeof a.role !== 'string' || !Object.hasOwn(PARENTS, a.role) || !Number.isSafeInteger(a.bytes) || Number(a.bytes) < 1 || Number(a.bytes) > MAX_BYTES ||
      !['allocated', 'deleting', 'removed'].includes(String(a.state))) fail('The backup allocation is invalid.', 400);
  return structuredClone(value);
}
function marker(b: BackupResourceBinding) {
  const { id, nonce, role, bytes } = b.allocation;
  return { version: 1, operationId: b.operationId, workspaceId: b.workspaceId, allocation: { id, nonce, role, bytes } };
}
function names(b: BackupResourceBinding): string[] {
  switch (b.allocation.role) {
    case 'capture': case 'decoded': case 'preview': return ['catalog.sqlite', 'catalog.sqlite-journal'];
    case 'prepared': return ['prepared.sqlite', 'prepared.sqlite-journal'];
    case 'build': return ['workflow-state.sqlite', 'workflow-state.sqlite-journal'];
    case 'archive': return ['archive.realbud-backup'];
    case 'upload': return ['transfers.sqlite', 'transfers.sqlite-journal', `${b.operationId}.ciphertext`];
  }
}
async function optionalStat(path: string): Promise<Stats | null> {
  try { return await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function ancestors(directory: string, missing = false) {
  const root = parse(directory).root; let current = root;
  for (const part of directory.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part); const s = await optionalStat(current);
    if (!s && missing) continue;
    if (!s?.isDirectory() || s.isSymbolicLink()) fail();
  }
}
async function privateFolder(path: string, create: boolean): Promise<void> {
  await ancestors(path, create);
  let created: string | undefined;
  if (create) created = await mkdir(path, { recursive: true, mode: 0o700 });
  const s = await lstat(path); if (!s.isDirectory() || s.isSymbolicLink()) fail(); privateMode(s);
  await windowsFilePrivacy(path, 'directory', created !== undefined);
}
function ordinary(s: Stats, links = 1) {
  if (!s.isFile() || s.isSymbolicLink() || s.nlink !== links || !Number.isSafeInteger(s.size) || s.size < 0) fail(); privateMode(s);
}

export function createPrivateBackupResources(options: PrivateBackupResourcesOptions) {
  if (!Buffer.isBuffer(options.key) || options.key.length !== 32) fail('A protected installation key is required.', 400);
  const directory = resolve(options.directory), claims = join(directory, 'claims'), key = Buffer.from(options.key);
  let closed = false, closing = false, queued = 0, tail: Promise<unknown> = Promise.resolve();
  const paths = (b: BackupResourceBinding) => ({ parent: join(directory, PARENTS[b.allocation.role]), data: join(directory, PARENTS[b.allocation.role], b.allocation.id),
    claim: join(claims, `${b.allocation.id}.json`), candidate: join(claims, `.${b.allocation.id}.${b.allocation.nonce}.tmp`) });
  const check = (b: BackupResourceBinding, action: 'read' | 'claim' | 'remove') => {
    if (closed) fail('Backup resource storage is closed.', 409);
    const result: unknown = options.assertCurrent(b, action);
    if (result !== undefined) {
      if (result && typeof result === 'object' && 'then' in result) void Promise.resolve(result).catch(() => {});
      fail('Backup ownership assertions must finish synchronously.', 500);
    }
  };
  const run = <T>(input: BackupResourceBinding, action: 'read' | 'claim' | 'remove', work: (b: BackupResourceBinding, assert: () => void) => Promise<T>): Promise<T> => {
    if (closing || closed || queued >= 16) return Promise.reject(Object.assign(new Error('Backup storage is busy or closing. Check its saved progress.'), { status: 409 }));
    const b = binding(input); queued++;
    const result = tail.then(() => { const assert = () => check(b, action); assert(); return work(b, assert); }).finally(() => { queued--; });
    tail = result.catch(() => {}); return result;
  };
  async function readClaim(path: string, b: BackupResourceBinding, assert: () => void, extraLink = false) {
    const before = await optionalStat(path); assert(); if (!before) return null;
    ordinary(before, extraLink && before.nlink === 2 ? 2 : 1); if (before.size < 1 || before.size > MARKER_BYTES) fail();
    await windowsFilePrivacy(path, 'file'); assert();
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const opened = await file.stat(); assert(); if (!sameFile(before, opened)) fail();
      const bytes = Buffer.alloc(before.size); let offset = 0;
      while (offset < bytes.length) { const read = await file.read(bytes, offset, bytes.length - offset, offset); assert(); if (!read.bytesRead) fail(); offset += read.bytesRead; }
      if (!sameFile(opened, await file.stat())) fail(); assert();
      let value: unknown;
      try { const envelope: unknown = JSON.parse(bytes.toString('utf8')); if (!isEncryptedEnvelope(envelope)) fail(); value = decryptJson(key, envelope); }
      catch { fail('The backup ownership record could not be verified. Its files were preserved.'); }
      if (JSON.stringify(value) !== JSON.stringify(marker(b))) fail('The backup ownership record belongs to a different allocation.');
      const named = await lstat(path); assert(); if (!sameFile(opened, named)) fail();
      return named;
    } finally { await file.close(); }
  }
  async function reconcileLink(b: BackupResourceBinding, assert: () => void) {
    const p = paths(b), fixed = await readClaim(p.claim, b, assert, true); if (!fixed || fixed.nlink === 1) return fixed;
    const candidate = await lstat(p.candidate); assert(); ordinary(candidate, 2);
    if (!identity(candidate, fixed)) fail();
    try { assert(); await unlink(p.candidate); }
    catch (error) {
      const now = await lstat(p.claim);
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !identity(now, fixed) || now.nlink !== 1) throw error;
    }
    fsyncDir(claims); assert(); return readClaim(p.claim, b, assert);
  }
  async function inspectData(b: BackupResourceBinding, assert: () => void) {
    const p = paths(b);
    if (await optionalStat(p.parent)) await privateFolder(p.parent, false); assert();
    const dir = await optionalStat(p.data); assert();
    if (!dir) return { dir: null, files: [] as { path: string; stat: Stats }[], bytes: 0 };
    if (!dir.isDirectory() || dir.isSymbolicLink()) fail(); privateMode(dir); await windowsFilePrivacy(p.data, 'directory'); assert();
    const entries = await readdir(p.data); assert(); const allowed = names(b);
    if (entries.length > allowed.length || entries.some(name => !allowed.includes(name))) fail('Backup storage contains unexpected files. They were preserved.');
    const files: { path: string; stat: Stats }[] = []; let bytes = 0;
    for (const name of entries) {
      const path = join(p.data, name), stat = await lstat(path); assert(); ordinary(stat); await windowsFilePrivacy(path, 'file'); assert();
      bytes += stat.size; if (!Number.isSafeInteger(bytes)) fail(); files.push({ path, stat });
    }
    const after = await lstat(p.data); assert(); if (!identity(dir, after) || !after.isDirectory() || after.isSymbolicLink()) fail();
    return { dir, files, bytes };
  }
  return {
    /** Internal fixed path only. Existing data never becomes owned from this getter. */
    path(input: BackupResourceBinding) { const b = binding(input); check(b, 'read'); return paths(b).data; },
    claim(input: BackupResourceBinding) { return run(input, 'claim', async (b, assert) => {
      if (b.allocation.state !== 'allocated') fail('This allocation no longer accepts new files.', 409);
      const p = paths(b); await privateFolder(directory, true); assert(); await privateFolder(claims, true); assert(); await privateFolder(p.parent, true); assert();
      if (await reconcileLink(b, assert)) { await inspectData(b, assert); return { directory: p.data, existing: true }; }
      if (await optionalStat(p.data)) fail('An unclaimed backup directory already exists. It was preserved.'); assert();
      const candidate = await readClaim(p.candidate, b, assert);
      if (!candidate) {
        const file = await open(p.candidate, 'wx', 0o600);
        try {
          await windowsFilePrivacy(p.candidate, 'file', true); assert();
          const bytes = Buffer.from(JSON.stringify(encryptJson(key, marker(b)))); if (bytes.length > MARKER_BYTES) fail();
          let offset = 0; while (offset < bytes.length) { const written = await file.write(bytes, offset, bytes.length - offset); assert(); if (!written.bytesWritten) fail(); offset += written.bytesWritten; }
          await file.sync(); assert();
        } finally { await file.close(); }
      }
      if (candidate) {
        // A dead writer may have written the full marker without syncing it.
        const file = await open(p.candidate, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
        try { if (!sameFile(candidate, await file.stat())) fail(); assert(); await file.sync(); assert(); } finally { await file.close(); }
      }
      options.fault?.('claim-ready'); assert();
      try { await link(p.candidate, p.claim); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      fsyncDir(claims); options.fault?.('claim-linked'); assert();
      const saved = await reconcileLink(b, assert); if (!saved) fail();
      return { directory: p.data, existing: false };
    }); },
    inspect(input: BackupResourceBinding) { return run(input, 'read', async (b, assert) => {
      const p = paths(b); await ancestors(directory, true); assert();
      if (!await optionalStat(directory)) { assert(); return { claimed: false, dataPresent: false, dataBytes: 0, markerBytes: 0, files: 0, exceedsAllocation: false }; }
      await privateFolder(directory, false); assert();
      const claim = await optionalStat(claims); assert();
      if (claim) await privateFolder(claims, false); assert();
      const fixed = claim ? await reconcileLink(b, assert) : null;
      const candidate = claim ? await readClaim(p.candidate, b, assert) : null;
      const data = await inspectData(b, assert);
      if (!fixed && data.dir) fail('Backup files have no verified ownership record. They were preserved.');
      return { claimed: !!fixed, dataPresent: !!data.dir, dataBytes: data.bytes, markerBytes: (fixed?.size ?? 0) + (candidate?.size ?? 0), files: data.files.length,
        exceedsAllocation: data.bytes + (fixed?.size ?? 0) + (candidate?.size ?? 0) > b.allocation.bytes };
    }); },
    remove(input: BackupResourceBinding) { return run(input, 'remove', async (b, assert) => {
      if (b.allocation.state !== 'deleting') fail('Save cleanup intent before removing backup files.', 409);
      const p = paths(b); await ancestors(directory, true); assert();
      if (!await optionalStat(directory)) { assert(); return; }
      await privateFolder(directory, false); assert();
      if (await optionalStat(claims)) await privateFolder(claims, false); assert();
      const fixed = await reconcileLink(b, assert), candidate = await readClaim(p.candidate, b, assert), data = await inspectData(b, assert);
      if (!fixed && data.dir) fail('Backup files have no verified ownership record. They were preserved.');
      for (const file of data.files) {
        assert(); const dir = await lstat(p.data), now = await lstat(file.path); assert();
        if (!data.dir || !identity(dir, data.dir) || !dir.isDirectory() || dir.isSymbolicLink() || !sameFile(now, file.stat)) fail(); ordinary(now);
        await unlink(file.path); fsyncDir(p.data); options.fault?.('file-removed'); assert();
      }
      if (data.dir) {
        const now = await lstat(p.data); assert(); if (!identity(now, data.dir) || !now.isDirectory() || now.isSymbolicLink()) fail();
        await rmdir(p.data); fsyncDir(p.parent); options.fault?.('directory-removed'); assert();
      }
      if (candidate) { const now = await readClaim(p.candidate, b, assert); if (!now || !sameFile(now, candidate)) fail(); await unlink(p.candidate); fsyncDir(claims); assert(); }
      if (fixed) { const now = await readClaim(p.claim, b, assert); if (!now || !sameFile(now, fixed)) fail(); await unlink(p.claim); fsyncDir(claims); options.fault?.('claim-removed'); assert(); }
      if (await optionalStat(p.data) || await optionalStat(p.claim) || await optionalStat(p.candidate)) fail(); assert();
    }); },
    async close() { closing = true; await tail; if (!closed) { closed = true; key.fill(0); } },
  };
}
