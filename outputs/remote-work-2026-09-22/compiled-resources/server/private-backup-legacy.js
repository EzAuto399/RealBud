/** Authenticated v1 archives enter the same target-key catalog path as v2.
 * This is a bounded compatibility reader, not a second restore implementation. */
import { createHash } from 'node:crypto';
import { PrivateBackupCatalog, catalogStorageBudget } from "./private-backup-catalog.js";
import { visitLegacyPrivateBackup } from "./private-workspace-backup.js";
import { PRIVATE_BACKUP_MAX_BYTES, PRIVATE_BACKUP_MAX_FILES, PRIVATE_BACKUP_MAX_RECORDS } from "../shared/private-workspace-backup.js";
function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
export async function decodeLegacyBackupCatalog(input, options) {
    if (typeof options.expectedArchiveDigest !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedArchiveDigest))
        fail('The uploaded backup digest is missing.');
    if (!Buffer.isBuffer(options.key) || options.key.length !== 32)
        fail('A protected installation key is required.');
    // Legacy validation bounds individual entries and file contents separately.
    // Keep this aggregate ceiling large enough for its bounded encrypted records.
    const limits = { maxEntries: options.catalogMaxEntries ?? PRIVATE_BACKUP_MAX_FILES + PRIVATE_BACKUP_MAX_RECORDS, maxBytes: options.catalogMaxBytes ?? PRIVATE_BACKUP_MAX_BYTES,
        maxStorageBytes: options.catalogMaxStorageBytes };
    catalogStorageBudget(limits);
    const chunks = [];
    let bytes, block, used = 0, archiveBytes = 0, catalog;
    let metadata;
    try {
        options.signal?.throwIfAborted();
        const hash = createHash('sha256');
        for await (const chunk of input) {
            options.signal?.throwIfAborted();
            if (!(chunk instanceof Uint8Array))
                fail('The backup upload contains invalid bytes.');
            archiveBytes += chunk.byteLength;
            if (archiveBytes > PRIVATE_BACKUP_MAX_BYTES)
                fail('Choose a legacy private backup no larger than 96 MB.', 413);
            // Keep the retained buffer count bounded even for tiny input chunks.
            // The legacy format still requires its bounded JSON payload in memory.
            for (let offset = 0; offset < chunk.byteLength;) {
                if (!block) {
                    block = Buffer.alloc(64 * 1024);
                    chunks.push(block);
                    used = 0;
                }
                const take = Math.min(block.length - used, chunk.byteLength - offset);
                block.set(chunk.subarray(offset, offset + take), used);
                hash.update(block.subarray(used, used + take));
                offset += take;
                used += take;
                if (used === block.length)
                    block = undefined;
            }
        }
        options.signal?.throwIfAborted();
        const archiveDigest = hash.digest('hex');
        if (archiveDigest !== options.expectedArchiveDigest)
            fail('The complete backup differs from the uploaded copy. Preview it again.');
        bytes = Buffer.concat(chunks, archiveBytes);
        for (const chunk of chunks)
            chunk.fill(0);
        chunks.length = 0;
        let value;
        try {
            value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        }
        catch {
            fail('This is not a supported private business backup.');
        }
        bytes.fill(0);
        bytes = undefined;
        const legacy = await visitLegacyPrivateBackup(value, options.passphrase, {
            async begin(meta) {
                options.signal?.throwIfAborted();
                metadata = { version: 1, ...meta };
                // Await creation directly: cancellation cannot escape while an owned
                // catalog is still being created in the background.
                catalog = await PrivateBackupCatalog.create({ directory: options.directory, key: options.key, workspaceId: meta.workspaceId, ...limits });
                options.signal?.throwIfAborted();
            },
            file(file) { options.signal?.throwIfAborted(); catalog.addFile(file); },
            record(record) { options.signal?.throwIfAborted(); catalog.addRecord(record); },
        }, options.signal);
        options.signal?.throwIfAborted();
        if (!catalog || !metadata)
            fail('The backup could not be checked.');
        const summary = catalog.seal();
        options.signal?.throwIfAborted();
        if (summary.files + Number(metadata.databasePresent) !== legacy.fileCount || summary.records !== legacy.recordCount)
            fail('The backup catalog is incomplete.');
        // v1's historical receipt hashed canonical JSON. A formatted upload can
        // contain the same archive but have different bytes: bind the actual file.
        return { formatVersion: 1, catalog, metadata, archiveBytes, archiveDigest, receipt: { ...legacy, digest: archiveDigest } };
    }
    catch (error) {
        catalog?.close();
        throw error;
    }
    finally {
        bytes?.fill(0);
        for (const chunk of chunks)
            chunk.fill(0);
    }
}
