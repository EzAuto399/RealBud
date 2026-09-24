export const PRIVATE_BACKUP_MAX_BYTES = 96 * 1024 * 1024;
export const PRIVATE_BACKUP_MAX_RECORDS = 5000;
export const PRIVATE_BACKUP_MAX_CONTENT_BYTES = 48 * 1024 * 1024;
export const PRIVATE_BACKUP_MAX_FILES = 3000;
export const PRIVATE_BACKUP_MIN_PASSPHRASE = 16;
export const PRIVATE_BACKUP_MAX_PASSPHRASE = 256;

export interface PrivateWorkspaceBackup {
  format: 'realbud-private-business';
  version: 1;
  kdf: 'scrypt-32768-8-1';
  salt: string;
  payload: { v: 1; alg: 'aes-256-gcm'; iv: string; tag: string; ct: string };
}
export interface PrivateBackupReceipt {
  digest: string;
  createdAt: string;
  workspaceId: string;
  fileCount: number;
  recordCount: number;
  plainBytes: number;
  included: string[];
  excluded: string[];
  restoreChanges: string[];
}
export interface PrivateRestoreStatus {
  state: 'none' | 'staged' | 'applying';
  receipt: PrivateBackupReceipt | null;
  completed?: PrivateRestoreReceipt | null;
  completionWarning?: string;
}
export interface PrivateRestoreReceipt {
  version: 1;
  restoredAt: string;
  receipt: PrivateBackupReceipt;
  rekeyed: true;
  reviewRequired: true;
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Return only public receipt fields, never arbitrary persisted/API properties. */
export function parsePrivateBackupReceipt(value: unknown): PrivateBackupReceipt | null {
  if (!record(value) || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.workspaceId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.workspaceId)) return null;
  for (const key of ['fileCount', 'recordCount', 'plainBytes']) if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0) return null;
  for (const key of ['included', 'excluded', 'restoreChanges']) if (!Array.isArray(value[key]) || value[key].length > 100 || value[key].some(v => typeof v !== 'string' || v.length > 1000)) return null;
  return { digest: value.digest, createdAt: value.createdAt, workspaceId: value.workspaceId, fileCount: value.fileCount as number, recordCount: value.recordCount as number, plainBytes: value.plainBytes as number, included: [...value.included as string[]], excluded: [...value.excluded as string[]], restoreChanges: [...value.restoreChanges as string[]] };
}
export function parsePrivateRestoreReceipt(value: unknown): PrivateRestoreReceipt | null {
  if (!record(value) || value.version !== 1 || value.rekeyed !== true || value.reviewRequired !== true || typeof value.restoredAt !== 'string' || !Number.isFinite(Date.parse(value.restoredAt))) return null;
  const receipt = parsePrivateBackupReceipt(value.receipt);
  return receipt ? { version: 1, restoredAt: value.restoredAt, receipt, rekeyed: true, reviewRequired: true } : null;
}
export interface PrivateBackupStatus extends PrivateRestoreStatus {
  canRestore: boolean;
  detail: string;
}
