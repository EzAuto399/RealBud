/** Installation-owned backup orchestration. HTTP callers supply IDs and bytes,
 * never keys, paths, allocation budgets, or restore authority. */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fsyncDir } from "./atomic.js";
import { windowsFilePrivacy } from "./windows-file-privacy.js";
import { createBackupOperationStore } from "./private-backup-operations.js";
import { createBackupResourceRuntime } from "./private-backup-resource-runtime.js";
import { PrivateBackupCatalog, catalogStorageBudget } from "./private-backup-catalog.js";
import { createBackupTransferStore, backupTransferStorageBudget } from "./private-backup-transfer.js";
import { capturePrivateWorkspace, verifyPrivateWorkspaceCapture } from "./private-backup-capture.js";
import { decodeBackupCatalog, encodeBackupCatalog } from "./private-backup-archive.js";
import { decodeLegacyBackupCatalog } from "./private-backup-legacy.js";
import { measurePrivateBackupRestore, transformPrivateBackupCatalog } from "./private-backup-restore-catalog.js";
import { PrivateBackupPreparedStore, preparedStorageBudget, PRIVATE_BACKUP_PREPARED_LIMITS } from "./private-backup-prepared.js";
import { preparePrivateBackupRestore, privateBackupBuildStorageBudget, PRIVATE_BACKUP_BUILD_MAX_BYTES } from "./private-backup-prepare.js";
import { stagePrivateRestoreV2 } from "./private-backup-cold-restore.js";
import { PRIVATE_BACKUP_TRANSFER_API, PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES, PRIVATE_BACKUP_TRANSFER_MAX_BYTES, privateBackupTransferDigest, privateBackupTransferId } from "../shared/private-backup-transfers.js";
const MiB = 1024 ** 2, MARKER = 8192, MARGIN = 128 * MiB;
const closed = new Set(['cancelled', 'expired', 'completed']);
const sha = (data) => createHash('sha256').update(data).digest('hex');
function fail(message, status = 409) { throw Object.assign(new Error(message), { status }); }
function passphrase(value) { if (typeof value !== 'string' || value.length < 16 || value.length > 256)
    fail('Use a backup passphrase between 16 and 256 characters.', 400); }
function capacity(value, max) { if (!Number.isSafeInteger(value) || value > max)
    fail('The restored workspace exceeds this computer’s supported backup capacity.', 413); return Math.max(65_536, Math.ceil(value / 4096) * 4096); }
export async function createPrivateBackupCoordinator(host) {
    const directory = resolve(host.directory), root = join(directory, 'private-backup-v2'), key = Buffer.from(host.key), now = host.now ?? Date.now;
    const journal = await createBackupOperationStore({ directory: join(root, 'operations'), key, workspaceId: host.workspaceId, restoreDirectory: directory, now });
    const runtime = createBackupResourceRuntime({ journal, directory: root, key });
    const tasks = new Map(), tickets = new Map();
    let closing = false, closedService = false, restoring = null;
    const edit = (id, change) => journal.update(id, journal.get(id).revision, change);
    const operation = (id, kind) => { const record = journal.get(id); if (kind && record.operation.kind !== kind)
        fail('This backup operation was not found.', 404); return record; };
    const check = (id) => { if (closing || closed.has(operation(id).operation.phase))
        fail('This backup operation is closed.'); };
    function heldOperation() {
        let after;
        do {
            const page = journal.list({ after });
            const held = page.items.find(r => r.restoreHeld && r.operation.phase !== 'completed');
            if (held)
                return held;
            after = page.next ?? undefined;
        } while (after);
        return null;
    }
    function writable() { if (restoring || heldOperation())
        fail('Finish the held restore before starting another backup action.'); }
    async function publishStage(id) {
        return runtime.run(id, async (work) => {
            const record = operation(id), ref = record.references.prepared;
            if (!record.restoreHeld || !ref || !record.operation.preview || !['staging', 'failed'].includes(record.operation.phase))
                fail('The restore requires recovery.', 503);
            await work.access('prepared');
            host.assertFresh();
            host.assertIdle();
            host.beginRestore();
            await stagePrivateRestoreV2({ directory, key, directoryId: ref.directoryId, storeId: ref.storeId, workspaceId: ref.workspaceId, expectedPreparedDigest: ref.digest, receipt: record.operation.preview, assertFresh: host.assertFresh, assertIdle: host.assertIdle, epoch: host.epoch, operation: { operationId: id, previousWorkspaceId: host.workspaceId } });
            return edit(id, next => { next.operation.phase = 'staged'; delete next.operation.error; }).operation;
        });
    }
    async function free() { if (host.freeBytes)
        return host.freeBytes(); const stat = await statfs(directory); return stat.bavail * stat.bsize; }
    async function admit(bytes) {
        if (closing)
            fail('Backup storage is closing.');
        const available = await free();
        if (!Number.isFinite(available) || available < journal.usage().reservedBytes + bytes + MARGIN)
            fail('This computer needs more free space before the backup can continue.', 507);
    }
    async function allocation(id, work, role, bytes) {
        check(id);
        let record = operation(id);
        const existing = record.allocations?.find(a => a.role === role && a.state !== 'removed');
        if (existing)
            return work.claim(role, existing.bytes);
        const required = record.allocations.reduce((sum, a) => sum + (a.state === 'removed' ? 0 : a.bytes), bytes + MARKER);
        if (required > record.reservedBytes) {
            await admit(required - record.reservedBytes);
            work.signal.throwIfAborted();
            check(id);
            record = operation(id);
            if (record.restoreHeld)
                fail('Restore storage must stay reserved.');
            edit(id, next => { next.reservedBytes = Math.max(next.reservedBytes, required); });
        }
        return work.claim(role, bytes + MARKER);
    }
    function failed(id, error) {
        const record = operation(id);
        if (closed.has(record.operation.phase) || record.restoreHeld)
            return;
        if (['ready', 'reviewed'].includes(record.operation.phase)) {
            edit(id, next => { next.operation.error = { code: 'recovery-required' }; next.operation.requiresPassphrase = false; });
            return;
        }
        const status = error?.status;
        host.diagnostic?.({ phase: record.operation.phase, status: status ?? 503, locations: (error?.stack ?? '').split('\n').slice(1).flatMap(line => { const match = /server\/([A-Za-z0-9_.-]+\.ts:\d+:\d+)/.exec(line); return match ? [match[1]] : []; }).slice(0, 8) });
        const code = status === 413 || status === 507 ? 'insufficient-space' : status === 400 ? 'invalid-backup' : status === 409 ? 'workspace-busy' : 'storage-unavailable';
        edit(id, next => {
            next.operation.phase = 'failed';
            next.operation.error = { code };
            delete next.operation.preview;
            next.operation.requiresPassphrase = next.operation.kind === 'export' || next.operation.receivedBytes === next.operation.progress.totalBytes;
        });
    }
    function launch(id, task) {
        if (closing || tasks.has(id))
            fail('This backup operation is busy.');
        const pending = Promise.resolve().then(task).catch(error => { failed(id, error); }).finally(() => { tasks.delete(id); });
        tasks.set(id, pending);
        void pending.catch(() => { });
    }
    async function input(work, path, size) {
        const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
        work.own(() => handle.close());
        const original = await handle.stat();
        if (!original.isFile() || original.nlink !== 1 || original.size !== size)
            fail('Backup bytes need recovery.', 503);
        async function* stream(expectedDigest) {
            const hash = expectedDigest ? createHash('sha256') : undefined;
            const buffer = Buffer.alloc(PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES);
            let offset = 0, tail;
            try {
                while (offset < size) {
                    work.signal.throwIfAborted();
                    const read = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
                    work.signal.throwIfAborted();
                    if (!read.bytesRead)
                        fail('The backup file changed.', 503);
                    offset += read.bytesRead;
                    const chunk = Buffer.from(buffer.subarray(0, read.bytesRead));
                    hash?.update(chunk);
                    // Content-Length clients can accept completion before the generator
                    // returns. Keep the final bytes until this exact pass is verified.
                    if (offset === size)
                        tail = chunk;
                    else
                        yield chunk;
                }
                const final = await handle.stat();
                if (final.size !== original.size || final.mtimeMs !== original.mtimeMs || final.ctimeMs !== original.ctimeMs || expectedDigest && hash.digest('hex') !== expectedDigest)
                    fail('The backup file changed.', 503);
                work.signal.throwIfAborted();
                if (tail)
                    yield tail;
            }
            finally {
                buffer.fill(0);
            }
        }
        return { handle, stream };
    }
    function reconcile(id, status) {
        const record = operation(id, 'upload');
        if (closed.has(record.operation.phase) || record.restoreHeld)
            return record.operation;
        if (status.size !== record.operation.progress.totalBytes || status.offset < record.operation.receivedBytes)
            fail('Backup upload records need recovery.', 503);
        if (status.state === 'cancelled' || status.state === 'staged')
            fail('Backup upload authority needs recovery.', 503);
        if (status.offset === record.operation.receivedBytes && status.prefixDigest === record.operation.prefixCommitment && (status.state !== 'uploaded' || record.operation.artifact))
            return record.operation;
        return edit(id, next => {
            next.operation.receivedBytes = status.offset;
            next.operation.prefixCommitment = status.prefixDigest;
            next.operation.progress.completedBytes = status.offset;
            if (status.state === 'uploaded') {
                next.operation.artifact = { archiveBytes: status.size, archiveDigest: status.digest };
                next.operation.phase = 'uploaded';
                next.operation.requiresPassphrase = true;
                delete next.operation.preview;
                delete next.operation.error;
            }
        }).operation;
    }
    async function transfer(id, create, task) {
        return runtime.run(id, async (work) => {
            const record = operation(id, 'upload');
            const path = create ? (await allocation(id, work, 'upload', backupTransferStorageBudget(record.operation.progress.totalBytes).totalBytes)).directory : await work.access('upload');
            const store = await createBackupTransferStore({ directory: path, key, workspaceId: host.workspaceId, now });
            work.own(() => store.close());
            return task(store);
        });
    }
    async function uploadStatus(id) {
        const record = operation(id);
        if (record.operation.kind !== 'upload' || tasks.has(id) || runtime.busy(id) || closed.has(record.operation.phase) || record.restoreHeld || !record.allocations?.some(a => a.role === 'upload' && a.state === 'allocated'))
            return record.operation;
        return transfer(id, false, async (store) => reconcile(id, await store.status(id)));
    }
    function freshRecord(id, kind, totalBytes) {
        if (!privateBackupTransferId(id))
            fail('Invalid backup operation.', 400);
        const at = now();
        return { version: 2, id, workspaceId: host.workspaceId, kind, phase: kind === 'export' ? 'capturing' : 'uploading', createdAt: at, updatedAt: at, expiresAt: null,
            progress: { completedBytes: 0, totalBytes }, canCancel: true, requiresPassphrase: false,
            ...(kind === 'upload' ? { receivedBytes: 0, prefixCommitment: sha('[]') } : {}) };
    }
    async function maybeCreate(id, kind, size, reservation) {
        try {
            const current = operation(id, kind);
            if (kind === 'upload' && current.operation.progress.totalBytes !== size)
                fail('This identifier belongs to another upload.');
            return current;
        }
        catch (error) {
            if (error.status !== 404)
                throw error;
        }
        await admit(reservation);
        return journal.create(freshRecord(id, kind, size), reservation, { trackResources: true });
    }
    async function previewWork(id, phrase, digest) {
        return runtime.run(id, async (work) => {
            const upload = await work.access('upload'), store = await createBackupTransferStore({ directory: upload, key, workspaceId: host.workspaceId, now });
            work.own(() => store.close());
            const artifact = await store.artifact(id);
            if (artifact.digest !== digest)
                fail('The reviewed backup changed.');
            const file = await input(work, artifact.path, artifact.size), magic = Buffer.alloc(8);
            await file.handle.read(magic, 0, 8, 0);
            const v2 = magic.equals(Buffer.from('RBUDPV2\0')), limits = { maxEntries: Math.min(v2 ? 99_999 : 8000, Math.max(1, Math.floor(artifact.size / 64))), maxBytes: artifact.size };
            const decoded = await allocation(id, work, 'decoded', catalogStorageBudget(limits).totalBytes);
            const options = { directory: decoded.directory, key, passphrase: phrase, expectedArchiveDigest: digest, signal: work.signal,
                catalogMaxEntries: limits.maxEntries, catalogMaxBytes: limits.maxBytes, catalogMaxStorageBytes: catalogStorageBudget(limits).databaseBytes };
            const result = v2 ? await decodeBackupCatalog(file.stream(), options) : await decodeLegacyBackupCatalog(file.stream(), options);
            work.own(() => result.catalog.close());
            work.signal.throwIfAborted();
            const at = now(), measured = measurePrivateBackupRestore({ source: result.catalog, at }), targetLimits = { maxEntries: Math.max(1, measured.entries), maxBytes: Math.max(1, measured.plainBytes) };
            const target = await allocation(id, work, 'preview', catalogStorageBudget(targetLimits).totalBytes);
            const catalog = await PrivateBackupCatalog.create({ directory: target.directory, key, workspaceId: result.metadata.workspaceId, ...targetLimits });
            work.own(() => catalog.close());
            const summary = transformPrivateBackupCatalog({ source: result.catalog, destination: catalog, at });
            work.signal.throwIfAborted();
            if (summary.plainBytes !== measured.plainBytes || summary.entries !== measured.entries)
                fail('Restore preparation changed.', 503);
            edit(id, next => {
                next.references.preview = { directoryId: target.binding.allocation.id, catalogId: catalog.catalogId, workspaceId: catalog.workspaceId, digest: summary.digest, createdAt: result.metadata.createdAt, databasePresent: result.metadata.databasePresent };
                next.operation.phase = 'reviewed';
                next.operation.preview = result.receipt;
                next.operation.requiresPassphrase = false;
                delete next.operation.error;
            });
        });
    }
    const service = {
        async list(options) {
            const after = options.cursor;
            if (after && !privateBackupTransferId(after))
                fail('Invalid backup page.', 400);
            const page = journal.list({ limit: options.limit, after });
            return { version: 2, workspaceId: host.workspaceId, limits: { archiveBytes: PRIVATE_BACKUP_TRANSFER_MAX_BYTES, chunkBytes: PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES }, items: page.items.map(r => r.operation), total: page.total, nextCursor: page.next };
        },
        get: uploadStatus,
        async startUpload(id, totalBytes) {
            writable();
            const record = await maybeCreate(id, 'upload', totalBytes, backupTransferStorageBudget(totalBytes).totalBytes + MARKER);
            if (closed.has(record.operation.phase) || record.restoreHeld || tasks.has(id))
                return record.operation;
            return transfer(id, true, async (store) => reconcile(id, await store.start(id, totalBytes)));
        },
        async appendUpload(id, offset, bytes, digest) {
            const record = operation(id, 'upload');
            if (!['uploading', 'interrupted'].includes(record.operation.phase))
                fail('This upload no longer accepts chunks.');
            if (record.operation.phase === 'interrupted')
                edit(id, next => { next.operation.phase = 'uploading'; delete next.operation.error; });
            return transfer(id, false, async (store) => reconcile(id, await store.append(id, offset, bytes, digest)));
        },
        async sealUpload(id, totalBytes, commitment) {
            const record = operation(id, 'upload');
            if (record.operation.progress.totalBytes !== totalBytes || !['uploading', 'uploaded', 'interrupted'].includes(record.operation.phase))
                fail('Check the saved upload before finishing.');
            return transfer(id, false, async (store) => reconcile(id, await store.seal(id, commitment)));
        },
        async preview(id, phrase, digest) {
            writable();
            passphrase(phrase);
            const record = operation(id, 'upload');
            if (!privateBackupTransferDigest(digest) || record.operation.artifact?.archiveDigest !== digest)
                fail('The selected backup changed.');
            if (tasks.has(id) && record.operation.phase === 'checking' || record.operation.phase === 'reviewed')
                return record.operation;
            if (!['uploaded', 'interrupted', 'failed'].includes(record.operation.phase) || record.restoreHeld)
                fail('This backup cannot be checked again.');
            // Mark reversible work failed before discarding old provisional resources;
            // checking is entered only after their handles and cleanup have drained.
            if (record.operation.phase === 'uploaded')
                edit(id, next => { next.operation.phase = 'failed'; });
            await runtime.discard(id, ['decoded', 'preview', 'prepared', 'build']);
            edit(id, next => { next.operation.phase = 'checking'; next.operation.requiresPassphrase = false; delete next.operation.error; });
            launch(id, () => previewWork(id, phrase, digest));
            return operation(id).operation;
        },
        async startExport(id, phrase) {
            writable();
            passphrase(phrase);
            const limits = host.captureLimits ?? { maxEntries: 99_999, maxBytes: PRIVATE_BACKUP_TRANSFER_MAX_BYTES };
            const record = await maybeCreate(id, 'export', null, catalogStorageBudget(limits).totalBytes + MARKER);
            if (tasks.has(id) || record.operation.phase === 'ready' || closed.has(record.operation.phase))
                return record.operation;
            if (!['capturing', 'failed', 'interrupted'].includes(record.operation.phase))
                fail('Check the saved backup operation before retrying.');
            launch(id, async () => {
                if (record.operation.phase !== 'capturing') {
                    await runtime.discard(id, ['capture', 'archive']);
                    edit(id, next => { next.operation.phase = 'capturing'; next.operation.requiresPassphrase = false; delete next.operation.error; });
                }
                await runtime.run(id, async (work) => {
                    const target = await allocation(id, work, 'capture', catalogStorageBudget(limits).totalBytes);
                    const catalog = await PrivateBackupCatalog.create({ directory: target.directory, key, workspaceId: host.workspaceId, ...limits });
                    work.own(() => catalog.close());
                    const lease = await host.snapshotLease();
                    let released = false;
                    const release = () => { if (!released) {
                        released = true;
                        lease.release();
                    } };
                    work.own(release);
                    const createdAt = new Date(now()).toISOString();
                    const captureOptions = { directory, key, workspaceId: host.workspaceId, catalog, assertLease: () => lease.assertCurrent(), signal: work.signal };
                    const captured = await capturePrivateWorkspace(captureOptions);
                    await verifyPrivateWorkspaceCapture(captureOptions, captured);
                    lease.assertCurrent();
                    const summary = catalog.seal();
                    edit(id, next => { next.references.capture = { directoryId: target.binding.allocation.id, catalogId: catalog.catalogId, workspaceId: host.workspaceId, digest: summary.digest, createdAt, databasePresent: captured.databasePresent }; next.operation.phase = 'sealing'; });
                    release();
                    const archive = await allocation(id, work, 'archive', PRIVATE_BACKUP_TRANSFER_MAX_BYTES);
                    await mkdir(archive.directory, { mode: 0o700 });
                    await windowsFilePrivacy(archive.directory, 'directory', true);
                    const path = join(archive.directory, 'archive.realbud-backup'), file = await open(path, 'wx', 0o600);
                    work.own(() => file.close());
                    await windowsFilePrivacy(path, 'file', true);
                    let bytes = 0, receipt;
                    for await (const chunk of encodeBackupCatalog(catalog, { passphrase: phrase, createdAt, databasePresent: captured.databasePresent, signal: work.signal, onComplete(value) { receipt = value; } })) {
                        let offset = 0;
                        while (offset < chunk.length) {
                            work.signal.throwIfAborted();
                            const write = await file.write(chunk, offset, chunk.length - offset);
                            if (!write.bytesWritten)
                                fail('Backup storage is unavailable.', 503);
                            offset += write.bytesWritten;
                            bytes += write.bytesWritten;
                        }
                    }
                    await file.sync();
                    fsyncDir(archive.directory);
                    work.signal.throwIfAborted();
                    if (!receipt || receipt.transport.archiveBytes !== bytes)
                        fail('The backup did not finish.', 503);
                    const completed = receipt;
                    edit(id, next => { next.operation.phase = 'ready'; delete next.operation.error; next.operation.artifact = { archiveBytes: bytes, archiveDigest: completed.transport.archiveDigest }; next.operation.preview = completed.receipt; next.operation.progress = { completedBytes: bytes, totalBytes: bytes }; });
                });
            });
            return operation(id).operation;
        },
        async stage(id, digest) {
            if (restoring)
                fail('Another restore is already being prepared.');
            restoring = id;
            try {
                const record = operation(id, 'upload');
                if (record.operation.artifact?.archiveDigest !== digest || !privateBackupTransferDigest(digest))
                    fail('The reviewed backup changed.');
                if (['staged', 'applying', 'completed'].includes(record.operation.phase))
                    return record.operation;
                if (record.restoreHeld && record.references.prepared && ['staging', 'failed'].includes(record.operation.phase))
                    return await publishStage(id);
                if (record.operation.phase !== 'reviewed' || tasks.has(id) || record.restoreHeld || !record.references.preview)
                    fail('Review this complete backup before restoring.');
                const held = heldOperation();
                if (held && held.operation.id !== id)
                    fail('Finish the held restore before preparing another.');
                host.assertFresh();
                host.assertIdle();
                await runtime.discard(id, ['prepared', 'build']);
                return await runtime.run(id, async (work) => {
                    const current = operation(id, 'upload');
                    if (current.operation.phase !== 'reviewed' || current.restoreHeld || current.operation.artifact?.archiveDigest !== digest)
                        fail('The reviewed restore changed.');
                    const lease = await host.snapshotLease();
                    work.own(() => lease.release());
                    lease.assertCurrent();
                    host.assertFresh();
                    const reference = operation(id).references.preview;
                    const source = await PrivateBackupCatalog.open({ directory: await work.access('preview'), key, catalogId: reference.catalogId, workspaceId: reference.workspaceId });
                    work.own(() => source.close());
                    const summary = source.validate();
                    if (!summary.sealed || summary.digest !== reference.digest)
                        fail('The reviewed backup needs recovery.', 503);
                    let filesBytes = 0, protectedFiles = 0, recordBytes = 0;
                    for (const file of source.iterateFiles()) {
                        filesBytes += file.data.length;
                        if (file.encoding === 'json')
                            protectedFiles++;
                    }
                    for (const row of source.iterateRecords())
                        recordBytes += Buffer.byteLength(JSON.stringify(row.value));
                    const databaseBytes = capacity(256 * 1024 + summary.records * 16 * 1024 + 2 * recordBytes, PRIVATE_BACKUP_BUILD_MAX_BYTES);
                    const bytes = capacity(2 * filesBytes + 1024 * protectedFiles + (reference.databasePresent ? databaseBytes : 0), PRIVATE_BACKUP_PREPARED_LIMITS.bytes);
                    const preparedLimits = { bytes, sqliteBytes: capacity(256 * 1024 + 2 * bytes + 16 * 1024 * (summary.files + 1), PRIVATE_BACKUP_PREPARED_LIMITS.sqliteBytes) };
                    const preparedAllocation = await allocation(id, work, 'prepared', preparedStorageBudget(preparedLimits).totalBytes);
                    const build = reference.databasePresent ? await allocation(id, work, 'build', privateBackupBuildStorageBudget(databaseBytes).totalBytes) : undefined;
                    const prepared = await PrivateBackupPreparedStore.create({ directory: preparedAllocation.directory, key, workspaceId: reference.workspaceId, limits: preparedLimits });
                    work.own(() => prepared.close());
                    const result = await preparePrivateBackupRestore({ directory, key, source, prepared, databasePresent: reference.databasePresent, databaseBytes, buildDirectoryId: build?.binding.allocation.id, assertLease: () => lease.assertCurrent(), signal: work.signal });
                    await prepared.close();
                    work.signal.throwIfAborted();
                    lease.assertCurrent();
                    host.assertFresh();
                    host.assertIdle();
                    edit(id, next => {
                        next.restoreHeld = true;
                        next.operation.phase = 'staging';
                        next.operation.canCancel = false;
                        next.references.prepared = { directoryId: preparedAllocation.binding.allocation.id, storeId: prepared.storeId, workspaceId: reference.workspaceId, digest: result.digest };
                    });
                    host.beginRestore();
                    await stagePrivateRestoreV2({ directory, key, directoryId: preparedAllocation.binding.allocation.id, storeId: prepared.storeId, workspaceId: reference.workspaceId, expectedPreparedDigest: result.digest, receipt: operation(id).operation.preview, assertFresh: host.assertFresh, assertIdle: host.assertIdle, epoch: host.epoch, operation: { operationId: id, previousWorkspaceId: host.workspaceId } });
                    return edit(id, next => { next.operation.phase = 'staged'; delete next.operation.error; }).operation;
                });
            }
            finally {
                restoring = null;
            }
        },
        async cancel(id) { for (const [token, saved] of tickets)
            if (saved.id === id)
                tickets.delete(token); return (await runtime.cancel(id)).operation; },
        async downloadTicket(id, digest) {
            const record = operation(id, 'export');
            if (tasks.has(id) || runtime.busy(id) || record.operation.phase !== 'ready' || record.operation.artifact?.archiveDigest !== digest)
                fail('Create or check the completed backup before downloading.');
            for (const [token, saved] of tickets)
                if (saved.ticket.expiresAt <= now())
                    tickets.delete(token);
            if (tickets.size >= 16)
                fail('Finish an existing backup download first.');
            const token = randomBytes(32).toString('base64url'), ticket = { ...record.operation.artifact, expiresAt: now() + 5 * 60_000, filename: `RealBud-private-work-${new Date(record.operation.createdAt).toISOString().slice(0, 10)}.realbud-backup`, url: `${PRIVATE_BACKUP_TRANSFER_API}/downloads/${token}` };
            tickets.set(token, { id, ticket });
            return ticket;
        },
        /** Single-use, session-protected host streaming. Sink must finish/drain before
         * resolving. Never return a server file path to the browser. */
        async download(token, sink) {
            const saved = tickets.get(token);
            tickets.delete(token);
            if (!saved || saved.ticket.expiresAt <= now())
                fail('This download link has expired.', 404);
            const record = operation(saved.id, 'export');
            if (record.operation.phase !== 'ready' || record.operation.artifact?.archiveDigest !== saved.ticket.archiveDigest)
                fail('This backup is no longer available.', 404);
            await runtime.run(saved.id, async (work) => {
                const path = join(await work.access('archive'), 'archive.realbud-backup'), file = await input(work, path, saved.ticket.archiveBytes), hash = createHash('sha256');
                for await (const chunk of file.stream())
                    hash.update(chunk);
                if (hash.digest('hex') !== saved.ticket.archiveDigest)
                    fail('The backup copy changed.', 503);
                await sink(saved.ticket, file.stream(saved.ticket.archiveDigest), work.signal);
            });
            // An earlier close failure stays visible until a new read and all of its
            // handle closes have actually succeeded after recovery.
            if (operation(saved.id).operation.error)
                edit(saved.id, next => { delete next.operation.error; });
        },
        async settled(id) { await tasks.get(id); return operation(id).operation; },
        heldOperation() { return heldOperation()?.operation ?? null; },
        async close() { if (closedService)
            return; closing = true; tickets.clear(); await runtime.close(); await Promise.allSettled(tasks.values()); journal.close(); key.fill(0); closedService = true; },
    };
    try {
        await runtime.recover();
        const held = heldOperation();
        if (held) {
            host.beginRestore();
            if (held.operation.phase === 'staging') {
                try {
                    await publishStage(held.operation.id);
                }
                catch {
                    edit(held.operation.id, next => { next.operation.error = { code: 'recovery-required' }; });
                }
            }
        }
    }
    catch (error) {
        await service.close();
        throw error;
    }
    return service;
}
