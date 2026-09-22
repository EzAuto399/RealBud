/** Transport only. Successful decoding does not validate a business graph or
 * authorize preview, staging, restore, or access to any filesystem path. */
export const PRIVATE_BACKUP_V2_VERSION = 2;
export const PRIVATE_BACKUP_V2_HEADER_BYTES = 64;
export const PRIVATE_BACKUP_V2_FRAME_HEADER_BYTES = 16;
export const PRIVATE_BACKUP_V2_TAG_BYTES = 16;
export const PRIVATE_BACKUP_V2_LIMITS = Object.freeze({
    archiveBytes: 1024 * 1024 * 1024,
    entryBytes: 16 * 1024 * 1024,
    entryCount: 100_000,
    frameBytes: 1024 * 1024,
    nameBytes: 1024,
});
