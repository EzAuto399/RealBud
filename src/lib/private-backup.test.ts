import { describe, expect, it, vi } from 'vitest';
import { backupEnvelope, backupReceipt, backupStatus, privateBackupDownload, readPrivateBackup, restartBackupService, validBackupPassphrase } from './private-backup';
import { PRIVATE_BACKUP_MAX_BYTES } from '@shared/private-workspace-backup';
const receipt = () => ({ digest: 'a'.repeat(64), createdAt: '2026-09-21T00:00:00Z', workspaceId: '11111111-1111-4111-8111-111111111111', fileCount: 3, recordCount: 2, plainBytes: 100, included: ['Private business records'], excluded: ['Credentials'], restoreChanges: ['Review schedules again'] });
const envelope = () => ({ format: 'realbud-private-business', version: 1, kdf: 'scrypt-32768-8-1', salt: '0'.repeat(32), payload: { v: 1, alg: 'aes-256-gcm', iv: 'a', tag: 'b', ct: 'c' } });
const file = (text: string) => { const bytes = new TextEncoder().encode(text); return { size: bytes.length, arrayBuffer: async () => bytes.buffer }; };
describe('private backup file and response boundary', () => {
  it('admits the encrypted envelope and current API filename without unsealed fields', async () => {
    const backup = envelope(); expect(await readPrivateBackup(file(JSON.stringify(backup)))).toEqual(backup);
    expect(privateBackupDownload({ backup, receipt: receipt(), filename: 'RealBud-private-work-2026-09-21.realbud-backup' })).toEqual({ backup, receipt: receipt(), filename: 'RealBud-private-work-2026-09-21.realbud-backup' });
    expect(() => backupEnvelope({ ...backup, key: 'must-not-download-plaintext-key' })).toThrow(/encrypted RealBud/);
  });
  it('rejects malformed, unsupported, changing and oversized files before a preview request', async () => {
    await expect(readPrivateBackup(file('invalid JSON'))).rejects.toThrow(/not readable/);
    await expect(readPrivateBackup(file(JSON.stringify({ format: 'realbud-office' })))).rejects.toThrow(/Office-host/);
    const reader = vi.fn(); await expect(readPrivateBackup({ size: PRIVATE_BACKUP_MAX_BYTES + 1, arrayBuffer: reader })).rejects.toThrow(/96 MB/); expect(reader).not.toHaveBeenCalled();
    await expect(readPrivateBackup({ size: 5, arrayBuffer: async () => new Uint8Array(4).buffer })).rejects.toThrow(/changed/);
  });
  it('fails closed for incomplete restore state, malformed receipts or unsafe download names', () => {
    expect(backupStatus({ canRestore: true, bootstrap: true, staged: false, reason: 'Fresh workspace', receipt: null })).toMatchObject({ canRestore: true, staged: false });
    expect(() => backupStatus({ canRestore: true, bootstrap: true, staged: true, reason: 'Staged' })).toThrow(/verified/);
    expect(() => backupReceipt({ ...receipt(), recordCount: -1 })).toThrow(/verified/);
    expect(() => backupReceipt({ ...receipt(), digest: 'unknown' })).toThrow(/verified/);
    expect(() => privateBackupDownload({ backup: envelope(), receipt: receipt(), filename: '../elsewhere.json' })).toThrow(/verified/);
  });
  it('accepts only bounded passphrases without trimming meaningful spaces', () => {
    expect(validBackupPassphrase('a'.repeat(15))).toBe(false); expect(validBackupPassphrase('a'.repeat(16))).toBe(true); expect(validBackupPassphrase('a'.repeat(256))).toBe(true); expect(validBackupPassphrase('a'.repeat(257))).toBe(false);
  });
  it('shows only validated durable restore metadata and rejects contradictory or incomplete completion', () => {
    const completed = { version: 1, restoredAt: '2026-09-21T01:00:00Z', receipt: receipt(), rekeyed: true, reviewRequired: true };
    const value = { canRestore: false, bootstrap: true, staged: false, reason: 'Existing records', completed };
    expect(backupStatus(value).completed).toEqual(completed);
    expect(backupStatus({ ...value, completed: { ...completed, key: 'must-not-project', receipt: { ...receipt(), token: 'must-not-project' } } }).completed).toEqual(completed);
    expect(() => backupStatus({ ...value, completed: { ...completed, restoredAt: 'invalid' } })).toThrow(/verified/);
    expect(() => backupStatus({ ...value, completed: { ...completed, rekeyed: false } })).toThrow(/verified/);
    expect(() => backupStatus({ ...value, staged: true, receipt: receipt() })).toThrow(/verified/);
    const completionWarning = 'Previous completion cannot be confirmed. Business backup remains available.';
    expect(backupStatus({ ...value, completed: null, completionWarning })).toMatchObject({ completed: null, completionWarning });
    expect(() => backupStatus({ ...value, completionWarning })).toThrow(/verified/);
  });
});
describe('restore service restart ownership', () => {
  const bridge = (running = true, manageable = true) => ({ serviceStatus: vi.fn(async () => ({ running, manageable })), serviceStop: vi.fn(async () => ({ ok: true, status: { running: false } })), serviceStart: vi.fn(async () => ({ ok: true, status: { running: true } })) });
  it('only restarts a service after its owned stop is confirmed', async () => {
    const b = bridge(); await restartBackupService(b); expect(b.serviceStop).toHaveBeenCalledOnce(); expect(b.serviceStart).toHaveBeenCalledOnce(); expect(b.serviceStop.mock.invocationCallOrder[0]).toBeLessThan(b.serviceStart.mock.invocationCallOrder[0]);
  });
  it('refuses an external service and never sends stop or start', async () => {
    const b = bridge(true, false); await expect(restartBackupService(b)).rejects.toThrow(/original RealBud/); expect(b.serviceStop).not.toHaveBeenCalled(); expect(b.serviceStart).not.toHaveBeenCalled();
  });
  it('keeps uncertain stop or startup outcomes explicit', async () => {
    const b = bridge(); b.serviceStop.mockResolvedValue({ ok: true, status: { running: true } }); await expect(restartBackupService(b)).rejects.toThrow(/did not confirm/); expect(b.serviceStart).not.toHaveBeenCalled();
    const next = bridge(); next.serviceStart.mockResolvedValue({ ok: false, status: { running: false } }); await expect(restartBackupService(next)).rejects.toThrow(/staged backup is retained/);
  });
  it('can recover a previous failed start without stopping again', async () => {
    const b = bridge(false, false); await restartBackupService(b); expect(b.serviceStop).not.toHaveBeenCalled(); expect(b.serviceStart).toHaveBeenCalledOnce();
  });
});
