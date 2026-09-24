/** Installation-key-authenticated cold completion, never archive-supplied.
 * The public historical receipt alone cannot authorize a workspace rebind. */
import { lstatSync, unlinkSync } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';
import { decryptJson, isEncryptedEnvelope } from './desk-crypto.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { fsyncDir } from './atomic.ts';
import { parsePrivateBackupReceipt, type PrivateBackupReceipt } from '../shared/private-workspace-backup.ts';
import { privateBackupTransferId, privateBackupTransferDigest } from '../shared/private-backup-transfers.ts';

export const PRIVATE_BACKUP_COMPLETION_FILE = 'private-workspace-restore-v2-completion.json';
export interface BackupRestoreBinding { operationId: string; previousWorkspaceId: string }
export interface BackupColdCompletion extends BackupRestoreBinding {
  version: 1; workspaceId: string; directoryId: string; storeId: string; preparedDigest: string;
  receipt: PrivateBackupReceipt; restoredAt: string;
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function validBackupRestoreBinding(v: unknown): v is BackupRestoreBinding {
  return object(v) && Object.keys(v).sort().join(',') === 'operationId,previousWorkspaceId' && privateBackupTransferId(v.operationId) && privateBackupTransferId(v.previousWorkspaceId);
}
export function parseBackupColdCompletion(v: unknown): BackupColdCompletion | null {
  if (!object(v) || Object.keys(v).sort().join(',') !== 'directoryId,operationId,preparedDigest,previousWorkspaceId,receipt,restoredAt,storeId,version,workspaceId' || v.version !== 1 ||
      !['directoryId', 'operationId', 'previousWorkspaceId', 'storeId', 'workspaceId'].every(k => privateBackupTransferId(v[k])) || !privateBackupTransferDigest(v.preparedDigest) ||
      typeof v.restoredAt !== 'string' || !Number.isFinite(Date.parse(v.restoredAt)) || new Date(v.restoredAt).toISOString() !== v.restoredAt) return null;
  const receipt = parsePrivateBackupReceipt(v.receipt);
  return receipt && receipt.workspaceId === v.workspaceId ? { ...v, receipt } as unknown as BackupColdCompletion : null;
}
function hold(): never { throw Object.assign(new Error('Backup workspace reconciliation needs verified cold-restore evidence. Existing files were preserved.'), { status: 503 }); }
async function smallPrivateFile(path: string) {
  const absolute = resolve(path), root = parse(absolute).root; let current = root;
  const identities: { path: string; ino: number; dev: number }[] = [];
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean).slice(0, -1)) {
    current = join(current, part); const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) hold(); identities.push({ path: current, ino: stat.ino, dev: stat.dev });
  }
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 || process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.())) hold();
  await windowsFilePrivacy(path, 'file');
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat(); if (opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size || opened.nlink !== 1) hold();
    const bytes = await handle.readFile(); if (bytes.length !== stat.size) hold();
    const assertCurrent = () => {
      for (const parent of identities) { const actual = lstatSync(parent.path); if (!actual.isDirectory() || actual.isSymbolicLink() || actual.ino !== parent.ino || actual.dev !== parent.dev) hold(); }
      const actual = lstatSync(path);
      if (!actual.isFile() || actual.isSymbolicLink() || actual.nlink !== 1 || actual.ino !== stat.ino || actual.dev !== stat.dev || actual.size !== stat.size || actual.mtimeMs !== stat.mtimeMs || actual.ctimeMs !== stat.ctimeMs) hold();
    };
    assertCurrent(); return { bytes, assertCurrent };
  } finally { await handle.close(); }
}
/** Verifies a journal's cold completion, including same-workspace restoration.
 * The caller holds its SQL owner transition
 * and invokes assertCurrent again immediately before committing reconciliation. */
export async function readBackupColdCompletion(directory: string, key: Buffer, workspaceId: string) {
  try {
    if (!Buffer.isBuffer(key) || key.length !== 32 || !privateBackupTransferId(workspaceId)) hold();
    const completion = await readBackupColdCompletionProof(directory, key), proof = completion?.proof;
    if (!proof || proof.workspaceId !== workspaceId) hold();
    const workspace = await verifyBackupWorkspaceIdentity(directory, workspaceId);
    const assertCurrent = () => {
      completion!.assertCurrent(); workspace.assertCurrent();
      for (const name of ['private-workspace-restore.json', 'private-workspace-restore-v2.json']) {
        try { lstatSync(join(directory, name)); hold(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
    };
    assertCurrent(); return { proof, assertCurrent, consume() { assertCurrent(); unlinkSync(join(directory, PRIVATE_BACKUP_COMPLETION_FILE)); fsyncDir(directory); } };
  } catch { return hold(); }
}

/** Cold apply can inspect the proof while its own stage still exists. It may
 * only reuse that exact proof on replay, never replace a previous operation's. */
export async function readBackupColdCompletionProof(directory: string, key: Buffer) {
  try {
    if (!Buffer.isBuffer(key) || key.length !== 32) hold();
    const file = await smallPrivateFile(join(directory, PRIVATE_BACKUP_COMPLETION_FILE));
    const envelope: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.bytes));
    if (!isEncryptedEnvelope(envelope)) hold();
    const proof = parseBackupColdCompletion(decryptJson(key, envelope)); if (!proof) hold();
    return { proof, assertCurrent: file.assertCurrent };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; return hold(); }
}

export async function verifyBackupWorkspaceIdentity(directory: string, workspaceId: string) {
  const workspace = await smallPrivateFile(join(directory, 'company-installation/workspace.json'));
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(workspace.bytes));
  if (!privateBackupTransferId(workspaceId) || !object(value) || Object.keys(value).sort().join(',') !== 'id,version,workerMemberKey' || value.version !== 1 || value.id !== workspaceId ||
      !(value.workerMemberKey === null || typeof value.workerMemberKey === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.workerMemberKey))) hold();
  return workspace;
}
