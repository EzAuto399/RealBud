export const PRIVATE_BACKUP_MAX_BYTES = 96 * 1024 * 1024;
export const PRIVATE_BACKUP_MAX_RECORDS = 5000;
export const PRIVATE_BACKUP_MAX_CONTENT_BYTES = 48 * 1024 * 1024;
export const PRIVATE_BACKUP_MAX_FILES = 3000;
export const PRIVATE_BACKUP_MIN_PASSPHRASE = 16;
export const PRIVATE_BACKUP_MAX_PASSPHRASE = 256;
const record = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
/** Return only public receipt fields, never arbitrary persisted/API properties. */
export function parsePrivateBackupReceipt(value) {
    if (!record(value) || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest) || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.workspaceId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.workspaceId))
        return null;
    for (const key of ['fileCount', 'recordCount', 'plainBytes'])
        if (!Number.isSafeInteger(value[key]) || Number(value[key]) < 0)
            return null;
    for (const key of ['included', 'excluded', 'restoreChanges'])
        if (!Array.isArray(value[key]) || value[key].length > 100 || value[key].some(v => typeof v !== 'string' || v.length > 1000))
            return null;
    return { digest: value.digest, createdAt: value.createdAt, workspaceId: value.workspaceId, fileCount: value.fileCount, recordCount: value.recordCount, plainBytes: value.plainBytes, included: [...value.included], excluded: [...value.excluded], restoreChanges: [...value.restoreChanges] };
}
export function parsePrivateRestoreReceipt(value) {
    if (!record(value) || value.version !== 1 || value.rekeyed !== true || value.reviewRequired !== true || typeof value.restoredAt !== 'string' || !Number.isFinite(Date.parse(value.restoredAt)))
        return null;
    const receipt = parsePrivateBackupReceipt(value.receipt);
    return receipt ? { version: 1, restoredAt: value.restoredAt, receipt, rekeyed: true, reviewRequired: true } : null;
}
