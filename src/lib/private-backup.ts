import { PRIVATE_BACKUP_MAX_BYTES, PRIVATE_BACKUP_MIN_PASSPHRASE, PRIVATE_BACKUP_MAX_PASSPHRASE, parsePrivateBackupReceipt, parsePrivateRestoreReceipt, type PrivateRestoreReceipt } from '@shared/private-workspace-backup';

export type BackupReceipt = import('@shared/private-workspace-backup').PrivateBackupReceipt;
export interface BackupStatus { canRestore: boolean; reason: string; staged: boolean; receipt?: BackupReceipt; bootstrap: boolean; completed?: PrivateRestoreReceipt | null; completionWarning?: string }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const bad = (): never => { throw new Error('The backup response could not be verified. Refresh before continuing.'); };
export function backupReceipt(value: unknown): BackupReceipt {
  return parsePrivateBackupReceipt(value) ?? bad();
}
export function backupStatus(value: unknown): BackupStatus {
  if (!record(value) || typeof value.canRestore !== 'boolean' || typeof value.staged !== 'boolean' || typeof value.bootstrap !== 'boolean' || typeof value.reason !== 'string') return bad();
  if (value.staged && !value.receipt) return bad();
  const completed = value.completed == null ? null : parsePrivateRestoreReceipt(value.completed);
  if (value.completed != null && (!completed || value.staged)) return bad();
  if (value.completionWarning !== undefined && (typeof value.completionWarning !== 'string' || !value.completionWarning || value.completionWarning.length > 1000 || completed || value.staged)) return bad();
  return { canRestore: value.canRestore, reason: value.reason, staged: value.staged, bootstrap: value.bootstrap, completed, ...(value.completionWarning ? { completionWarning: value.completionWarning as string } : {}), ...(value.receipt ? { receipt: backupReceipt(value.receipt) } : {}) };
}
export function validBackupPassphrase(value: string) { return value.length >= PRIVATE_BACKUP_MIN_PASSPHRASE && value.length <= PRIVATE_BACKUP_MAX_PASSPHRASE; }
export function backupEnvelope(value: unknown): Record<string, unknown> {
  const exact = (input: Record<string, unknown>, keys: string[]) => Object.keys(input).length === keys.length && keys.every(key => Object.hasOwn(input, key));
  if (!record(value) || !exact(value, ['format', 'version', 'kdf', 'salt', 'payload']) || value.format !== 'realbud-private-business' || value.version !== 1 || value.kdf !== 'scrypt-32768-8-1' || typeof value.salt !== 'string' || !/^[a-f0-9]{32}$/.test(value.salt) || !record(value.payload) || !exact(value.payload, ['v', 'alg', 'iv', 'tag', 'ct']) || value.payload.v !== 1 || value.payload.alg !== 'aes-256-gcm' || ['iv', 'tag', 'ct'].some(key => typeof (value.payload as Record<string, unknown>)[key] !== 'string')) throw new Error('Choose an encrypted RealBud private business backup. Office-host backups use a separate recovery flow.');
  return value;
}
export async function readPrivateBackup(file: Pick<File, 'size' | 'arrayBuffer'>) {
  if (!file.size || file.size > PRIVATE_BACKUP_MAX_BYTES) throw new Error(`Choose a non-empty backup smaller than ${Math.floor(PRIVATE_BACKUP_MAX_BYTES / 1024 / 1024)} MB.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length !== file.size) throw new Error('The selected file changed. Choose the backup again.');
  let value: unknown;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('The selected file is not readable backup JSON. The source file has not been changed.'); }
  return backupEnvelope(value);
}
export function privateBackupDownload(value: unknown): { backup: Record<string, unknown>; receipt: BackupReceipt; filename: string } {
  if (!record(value) || typeof value.filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.(?:json|realbud-backup)$/.test(value.filename)) return bad();
  const backup = backupEnvelope(value.backup), receipt = backupReceipt(value.receipt);
  if (new TextEncoder().encode(JSON.stringify(backup)).length > PRIVATE_BACKUP_MAX_BYTES) return bad();
  return { backup, receipt, filename: value.filename };
}
export type BackupServiceBridge = {
  serviceStatus(): Promise<{ running?: boolean; manageable?: boolean }>;
  serviceStop(): Promise<{ ok: boolean; status: { running?: boolean } }>;
  serviceStart(): Promise<{ ok: boolean; status: { running?: boolean } }>;
};
/** Only an explicit user restart calls this; ordinary window closure leaves the
 * detached service running and cannot apply a staged restore. */
export async function restartBackupService(bridge: BackupServiceBridge) {
  const status = await bridge.serviceStatus();
  if (status.running !== false && status.running !== true) throw new Error('Service ownership could not be checked. Use the RealBud service controls before restarting.');
  if (status.running) {
    if (!status.manageable) throw new Error('This window cannot stop the running service. Use its original RealBud installation to stop it, then reopen this app.');
    const result = await bridge.serviceStop();
    if (!result.ok || result.status.running !== false) throw new Error('The service did not confirm it stopped. The restore remains staged; check the service controls before retrying.');
  }
  const started = await bridge.serviceStart();
  if (!started.ok || started.status.running !== true) throw new Error('The service did not restart. The staged backup is retained. Try starting the service again or contact support.');
}
