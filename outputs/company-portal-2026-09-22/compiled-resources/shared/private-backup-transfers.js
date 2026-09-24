import { parsePrivateBackupReceipt } from "./private-workspace-backup.js";
/** Public transport projections only. Never include scratch paths, keys,
 * passphrases, raw exceptions, or uploaded business values here. */
export const PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES = 1024 * 1024;
export const PRIVATE_BACKUP_TRANSFER_MAX_BYTES = 1024 * 1024 * 1024;
export const PRIVATE_BACKUP_TRANSFER_MAX_ITEMS = 20;
export const PRIVATE_BACKUP_TRANSFER_API = '/api/private-backup/v2';
export const PRIVATE_BACKUP_TRANSFER_PHASES = [
    'capturing', 'sealing', 'ready', 'uploading', 'uploaded', 'checking', 'reviewed',
    'staging', 'staged', 'applying', 'completed', 'interrupted', 'failed', 'cancelled', 'expired',
];
export const PRIVATE_BACKUP_TRANSFER_ERRORS = {
    interrupted: 'This backup operation was interrupted. Check its saved progress before continuing.',
    'invalid-backup': 'This file could not be verified as a complete supported backup. Keep the original file.',
    'incorrect-passphrase': 'The backup could not be opened with that passphrase. Check it and try again.',
    'storage-unavailable': 'Backup storage is unavailable. Keep the original file and check this computer.',
    'insufficient-space': 'This computer needs more free space before the backup can continue.',
    'workspace-busy': 'Finish the current work before continuing this backup operation.',
    'restore-unavailable': 'This workspace is not ready to restore this backup.',
    'recovery-required': 'This backup operation needs recovery. Keep its files and contact support.',
    expired: 'This saved transfer has expired. Keep the original backup file.',
};
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v, required, optional = []) => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const integer = (v, min = 0) => Number.isSafeInteger(v) && Number(v) >= min;
export const privateBackupTransferId = (v) => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export const privateBackupTransferDigest = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function artifact(v) {
    return object(v) && keys(v, ['archiveBytes', 'archiveDigest']) && integer(v.archiveBytes, 1) && v.archiveBytes <= PRIVATE_BACKUP_TRANSFER_MAX_BYTES && privateBackupTransferDigest(v.archiveDigest)
        ? { archiveBytes: v.archiveBytes, archiveDigest: v.archiveDigest } : null;
}
function receipt(v) {
    if (!object(v) || !keys(v, ['digest', 'createdAt', 'workspaceId', 'fileCount', 'recordCount', 'plainBytes', 'included', 'excluded', 'restoreChanges']))
        return null;
    const parsed = parsePrivateBackupReceipt(v);
    if (!parsed || parsed.createdAt.length > 40)
        return null;
    // Human-readable category labels, not filenames, evidence bodies, or errors.
    if ([parsed.included, parsed.excluded, parsed.restoreChanges].some(list => list.length > 20 || list.some(s => !s.trim() || new TextEncoder().encode(s).length > 300 || /[\u0000-\u001f\u007f]/.test(s))))
        return null;
    return parsed;
}
export function parsePrivateBackupTransferOperation(v) {
    if (!object(v) || !keys(v, ['version', 'id', 'workspaceId', 'kind', 'phase', 'createdAt', 'updatedAt', 'expiresAt', 'progress', 'canCancel', 'requiresPassphrase'], ['receivedBytes', 'prefixCommitment', 'artifact', 'preview', 'error']) ||
        v.version !== 2 || !privateBackupTransferId(v.id) || !privateBackupTransferId(v.workspaceId) || typeof v.kind !== 'string' || !['export', 'upload'].includes(v.kind) ||
        !PRIVATE_BACKUP_TRANSFER_PHASES.includes(v.phase) || !integer(v.createdAt, 1) || !integer(v.updatedAt, v.createdAt) ||
        !(v.expiresAt === null || integer(v.expiresAt, v.createdAt)) || typeof v.canCancel !== 'boolean' || typeof v.requiresPassphrase !== 'boolean' ||
        !object(v.progress) || !keys(v.progress, ['completedBytes', 'totalBytes']) || !integer(v.progress.completedBytes) ||
        !(v.progress.totalBytes === null || integer(v.progress.totalBytes, v.progress.completedBytes)))
        return null;
    const phase = v.phase;
    if (['staging', 'staged', 'applying', 'completed', 'cancelled', 'expired'].includes(phase) && v.canCancel)
        return null;
    if (v.requiresPassphrase && !['interrupted', 'failed', 'uploaded'].includes(phase))
        return null;
    if (v.kind === 'upload') {
        const size = v.progress.totalBytes;
        if (!integer(size, 1) || size > PRIVATE_BACKUP_TRANSFER_MAX_BYTES || !integer(v.receivedBytes) || v.receivedBytes > size ||
            v.receivedBytes !== size && v.receivedBytes % PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES !== 0 || !privateBackupTransferDigest(v.prefixCommitment) ||
            ['capturing', 'ready'].includes(phase))
            return null;
        if (['uploaded', 'checking', 'reviewed', 'staging', 'staged', 'applying', 'completed'].includes(phase) && v.receivedBytes !== size)
            return null;
        if (v.requiresPassphrase && v.receivedBytes !== size)
            return null;
    }
    else if (Object.hasOwn(v, 'receivedBytes') || Object.hasOwn(v, 'prefixCommitment') || ['uploading', 'uploaded', 'checking', 'reviewed', 'staging', 'staged', 'applying'].includes(phase))
        return null;
    const parsedArtifact = v.artifact === undefined ? undefined : artifact(v.artifact);
    if (parsedArtifact === null || parsedArtifact && v.kind === 'upload' && parsedArtifact.archiveBytes !== v.progress.totalBytes)
        return null;
    if (parsedArtifact && ['capturing', 'uploading', 'cancelled', 'expired'].includes(phase))
        return null;
    if (['ready', 'uploaded', 'checking', 'reviewed', 'staging', 'staged', 'applying', 'completed'].includes(phase) && !parsedArtifact)
        return null;
    const parsedPreview = v.preview === undefined ? undefined : receipt(v.preview);
    if (parsedPreview === null || parsedPreview && (!parsedArtifact || !['ready', 'reviewed', 'staging', 'staged', 'applying', 'completed'].includes(phase)))
        return null;
    if (parsedPreview && parsedPreview.digest !== parsedArtifact?.archiveDigest)
        return null;
    if (['reviewed', 'staging', 'staged', 'applying'].includes(phase) && !parsedPreview)
        return null;
    if (v.error !== undefined && (!object(v.error) || !keys(v.error, ['code']) || typeof v.error.code !== 'string' || !Object.hasOwn(PRIVATE_BACKUP_TRANSFER_ERRORS, v.error.code)))
        return null;
    return {
        version: 2, id: v.id, workspaceId: v.workspaceId, kind: v.kind, phase,
        createdAt: v.createdAt, updatedAt: v.updatedAt, expiresAt: v.expiresAt,
        progress: { completedBytes: v.progress.completedBytes, totalBytes: v.progress.totalBytes },
        canCancel: v.canCancel, requiresPassphrase: v.requiresPassphrase,
        ...(v.kind === 'upload' ? { receivedBytes: v.receivedBytes, prefixCommitment: v.prefixCommitment } : {}),
        ...(parsedArtifact ? { artifact: parsedArtifact } : {}), ...(parsedPreview ? { preview: parsedPreview } : {}),
        ...(v.error ? { error: { code: v.error.code } } : {}),
    };
}
export function parsePrivateBackupTransferResponse(v) {
    return object(v) && keys(v, ['operation']) ? parsePrivateBackupTransferOperation(v.operation) : null;
}
export function parsePrivateBackupTransferPage(v) {
    if (!object(v) || !keys(v, ['version', 'workspaceId', 'limits', 'items', 'total', 'nextCursor']) || v.version !== 2 || !privateBackupTransferId(v.workspaceId) ||
        !object(v.limits) || !keys(v.limits, ['archiveBytes', 'chunkBytes']) || !integer(v.limits.archiveBytes, 1) || v.limits.archiveBytes > PRIVATE_BACKUP_TRANSFER_MAX_BYTES || v.limits.chunkBytes !== PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES ||
        !Array.isArray(v.items) || v.items.length > PRIVATE_BACKUP_TRANSFER_MAX_ITEMS || !integer(v.total, v.items.length) ||
        !(v.nextCursor === null || typeof v.nextCursor === 'string' && /^[a-zA-Z0-9_-]{1,512}$/.test(v.nextCursor)))
        return null;
    const items = v.items.map(parsePrivateBackupTransferOperation);
    if (items.some(item => !item || item.workspaceId !== v.workspaceId) || new Set(items.map(item => item?.id)).size !== items.length)
        return null;
    return { version: 2, workspaceId: v.workspaceId, limits: { archiveBytes: v.limits.archiveBytes, chunkBytes: PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES }, items: items, total: v.total, nextCursor: v.nextCursor };
}
export function parsePrivateBackupDownloadTicket(v) {
    if (!object(v) || !keys(v, ['url', 'filename', 'expiresAt', 'archiveBytes', 'archiveDigest']) || typeof v.url !== 'string' ||
        !/^\/api\/private-backup\/v2\/downloads\/[A-Za-z0-9_-]{32,128}$/.test(v.url) || typeof v.filename !== 'string' ||
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.realbud-backup$/.test(v.filename) || !integer(v.expiresAt, 1))
        return null;
    const a = artifact({ archiveBytes: v.archiveBytes, archiveDigest: v.archiveDigest });
    return a ? { ...a, url: v.url, filename: v.filename, expiresAt: v.expiresAt } : null;
}
