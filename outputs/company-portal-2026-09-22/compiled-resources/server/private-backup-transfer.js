import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encryptJson, decryptJson, isEncryptedEnvelope } from "./desk-crypto.js";
import { windowsFilePrivacy } from "./windows-file-privacy.js";
import { fsyncDir } from "./atomic.js";
export const BACKUP_TRANSFER_CHUNK_BYTES = 1024 * 1024;
export const BACKUP_TRANSFER_MAX_BYTES = 1024 * 1024 * 1024;
export const BACKUP_TRANSFER_JOURNAL_BYTES = 64 * 1024 * 1024;
export function backupTransferStorageBudget(archiveBytes) {
    if (!Number.isSafeInteger(archiveBytes) || archiveBytes < 1 || archiveBytes > BACKUP_TRANSFER_MAX_BYTES)
        throw Object.assign(new Error('Invalid backup size.'), { status: 400 });
    const rollbackBytes = BACKUP_TRANSFER_JOURNAL_BYTES / 4096 * (4096 + 8) + 2 * 65_536;
    return { databaseBytes: BACKUP_TRANSFER_JOURNAL_BYTES, rollbackBytes, totalBytes: archiveBytes + BACKUP_TRANSFER_JOURNAL_BYTES + rollbackBytes };
}
export const BACKUP_TRANSFER_CANCEL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE = 4;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
function fail(message, status = 409) { throw Object.assign(new Error(message), { status }); }
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v, min = 0) => Number.isSafeInteger(v) && Number(v) >= min;
async function safeParents(path) {
    const absolute = resolve(path), root = parse(absolute).root;
    let current = root;
    for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
        current = join(current, part);
        try {
            const s = await lstat(current);
            if (!s.isDirectory() || s.isSymbolicLink())
                fail('Backup transfer storage needs recovery.', 503);
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
}
async function privateFolder(path) {
    await safeParents(path);
    const created = await mkdir(path, { recursive: true, mode: 0o700 }), s = await lstat(path);
    if (!s.isDirectory() || s.isSymbolicLink() || process.platform !== 'win32' && ((s.mode & 0o077) || s.uid !== process.getuid?.()))
        fail('Backup transfer storage is not private.', 503);
    await windowsFilePrivacy(path, 'directory', created !== undefined);
}
async function checkedFile(path, absent = false) {
    await safeParents(dirname(path));
    try {
        const s = await lstat(path);
        if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || process.platform !== 'win32' && ((s.mode & 0o077) || s.uid !== process.getuid?.()))
            fail('Backup transfer file needs recovery.', 503);
        await windowsFilePrivacy(path, 'file');
        return s;
    }
    catch (error) {
        if (absent && error.code === 'ENOENT')
            return null;
        throw error;
    }
}
async function checkedHandle(path, flags) {
    const before = await checkedFile(path);
    const handle = await open(path, flags | (constants.O_NOFOLLOW ?? 0));
    try {
        const after = await handle.stat();
        if (!before || before.ino !== after.ino || before.dev !== after.dev || after.nlink !== 1)
            fail('Backup transfer changed while opening.', 503);
        return handle;
    }
    catch (error) {
        await handle.close();
        throw error;
    }
}
function validChunk(value) {
    return object(value) && Object.keys(value).length === 3 && integer(value.offset) && value.offset % BACKUP_TRANSFER_CHUNK_BYTES === 0 &&
        integer(value.size, 1) && value.size <= BACKUP_TRANSFER_CHUNK_BYTES && typeof value.digest === 'string' && HASH.test(value.digest);
}
function validUpload(value, workspaceId, id) {
    if (!object(value) || Object.keys(value).sort().join(',') !== 'createdAt,digest,id,manifestDigest,offset,pending,size,state,updatedAt,version,workspaceId' || value.version !== 1 || value.id !== id || value.workspaceId !== workspaceId ||
        !integer(value.size, 1) || value.size > BACKUP_TRANSFER_MAX_BYTES || !integer(value.offset) || value.offset > value.size ||
        !integer(value.createdAt, 1) || !integer(value.updatedAt, 1) || value.updatedAt < value.createdAt ||
        typeof value.state !== 'string' || !['uploading', 'uploaded', 'staged', 'cancelled'].includes(value.state))
        return false;
    if (value.offset !== value.size && value.offset % BACKUP_TRANSFER_CHUNK_BYTES !== 0)
        return false;
    if (value.pending !== null && (!validChunk(value.pending) || value.pending.offset !== value.offset || value.pending.size !== Math.min(BACKUP_TRANSFER_CHUNK_BYTES, value.size - value.offset) || value.state !== 'uploading'))
        return false;
    const completed = value.state === 'uploaded' || value.state === 'staged';
    return completed ? value.offset === value.size && value.pending === null && typeof value.digest === 'string' && HASH.test(value.digest) && typeof value.manifestDigest === 'string' && HASH.test(value.manifestDigest)
        : value.digest === null && value.manifestDigest === null;
}
/** Fixed-size ciphertext transport only. Uploaded data remains untrusted until
 * the codec and complete business graph validate. A live process owns writes;
 * confirmed process exit, not a timeout, permits restart recovery. */
export async function createBackupTransferStore(options) {
    if (options.key.length !== 32 || !UUID.test(options.workspaceId))
        fail('Invalid backup transfer installation.', 400);
    const directory = resolve(options.directory), now = options.now ?? Date.now;
    const nonce = randomUUID(), pid = process.pid;
    await privateFolder(directory);
    const journal = join(directory, 'transfers.sqlite');
    const existing = await checkedFile(journal, true);
    if (existing && existing.size > BACKUP_TRANSFER_JOURNAL_BYTES)
        fail('Backup transfer journal needs size recovery. Existing copies were preserved.', 503);
    if (!existing) {
        const file = await open(journal, 'wx', 0o600);
        try {
            await windowsFilePrivacy(journal, 'file', true);
            await file.sync();
        }
        finally {
            await file.close();
        }
        fsyncDir(directory);
    }
    const key = Buffer.from(options.key);
    let db;
    try {
        db = new DatabaseSync(journal);
    }
    catch (error) {
        key.fill(0);
        throw error;
    }
    let closed = false, closing = false, queued = 0, tail = Promise.resolve();
    const transact = (fn) => { db.exec('BEGIN IMMEDIATE'); try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    }
    catch (error) {
        try {
            db.exec('ROLLBACK');
        }
        catch { /* SQLITE_FULL may already have rolled back. */ }
        throw error;
    } };
    const encode = (value) => JSON.stringify(encryptJson(key, value));
    const decode = (payload) => { try {
        const v = JSON.parse(String(payload));
        if (!isEncryptedEnvelope(v))
            throw new Error();
        return decryptJson(key, v);
    }
    catch {
        return fail('Backup transfer journal needs recovery.', 503);
    } };
    try {
        db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1500; PRAGMA temp_store=MEMORY; PRAGMA cache_spill=OFF;');
        if (db.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode !== 'delete' || db.prepare('PRAGMA cache_spill').get()?.cache_spill !== 0)
            fail('Backup transfer storage policy needs recovery.', 503);
        const schema = db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
        if (existing && schema.some(row => row.type !== 'table' || !['owner', 'operations', 'chunks'].includes(String(row.name))))
            fail('Backup transfer schema needs recovery.', 503);
        if (existing && Number(db.prepare('PRAGMA user_version').get()?.user_version) !== 1)
            fail('Backup transfer version needs recovery.', 503);
        if (!existing)
            db.exec('CREATE TABLE owner (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL); CREATE TABLE operations (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE chunks (id TEXT NOT NULL, offset INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id,offset)); PRAGMA user_version=1;');
        const pageBytes = Number(db.prepare('PRAGMA page_size').get()?.page_size);
        if (pageBytes !== 4096)
            fail('Backup transfer page size needs recovery.', 503);
        if (db.prepare(`PRAGMA max_page_count=${BACKUP_TRANSFER_JOURNAL_BYTES / pageBytes}`).get()?.max_page_count !== BACKUP_TRANSFER_JOURNAL_BYTES / pageBytes)
            fail('Backup transfer storage reached its capacity.', 413);
        transact(() => {
            const previous = db.prepare('SELECT payload FROM owner WHERE id=1').get();
            if (previous) {
                const owner = decode(previous.payload);
                if (!object(owner) || Object.keys(owner).sort().join(',') !== 'nonce,pid,workspaceId' || owner.workspaceId !== options.workspaceId || !integer(owner.pid, 1) || typeof owner.nonce !== 'string' || !UUID.test(owner.nonce))
                    fail('Backup transfer ownership needs recovery.', 503);
                try {
                    process.kill(owner.pid, 0);
                    fail('Another running service owns these backup transfers.');
                }
                catch (error) {
                    if (error.code !== 'ESRCH')
                        throw error;
                }
            }
            db.prepare('INSERT OR REPLACE INTO owner VALUES(1,?)').run(encode({ pid, nonce, workspaceId: options.workspaceId }));
        });
    }
    catch (error) {
        db.close();
        key.fill(0);
        throw error;
    }
    const assertOwner = () => {
        if (closed)
            fail('Backup transfers are closed.');
        const row = db.prepare('SELECT payload FROM owner WHERE id=1').get(), owner = row && decode(row.payload);
        if (!object(owner) || owner.pid !== pid || owner.nonce !== nonce || owner.workspaceId !== options.workspaceId)
            fail('Backup transfer ownership changed.', 503);
    };
    const run = (work) => {
        if (closing || closed || queued >= 8)
            return Promise.reject(Object.assign(new Error('Backup transfer is busy or closing. Check its saved status before retrying.'), { status: 409 }));
        queued++;
        const task = tail.then(async () => { assertOwner(); return work(); }).finally(() => { queued--; });
        tail = task.catch(() => { });
        return task;
    };
    const read = (id) => {
        if (typeof id !== 'string' || !UUID.test(id))
            fail('Invalid backup transfer.', 400);
        const row = db.prepare('SELECT payload FROM operations WHERE id=?').get(id);
        if (!row)
            fail('This backup transfer was not found.', 404);
        const value = decode(row.payload);
        if (!validUpload(value, options.workspaceId, id))
            fail('Backup transfer receipt needs recovery.', 503);
        return value;
    };
    const save = (value) => {
        if (!validUpload(value, options.workspaceId, value.id))
            fail('Backup transfer transition needs recovery.', 503);
        assertOwner();
        db.prepare('INSERT OR REPLACE INTO operations VALUES(?,?)').run(value.id, encode(value));
    };
    const publicStatus = ({ version: _version, workspaceId: _workspace, pending: _pending, ...status }) => {
        const manifest = [];
        for (let offset = 0; offset < status.offset; offset += BACKUP_TRANSFER_CHUNK_BYTES) {
            const chunk = readChunk(status.id, offset);
            if (!chunk || chunk.size !== Math.min(BACKUP_TRANSFER_CHUNK_BYTES, status.size - offset))
                fail('The saved upload prefix needs recovery.', 503);
            manifest.push([chunk.offset, chunk.size, chunk.digest]);
        }
        return { ...status, prefixDigest: hash(JSON.stringify(manifest)) };
    };
    const artifactPath = (id) => join(directory, `${id}.ciphertext`);
    const readChunk = (id, offset) => {
        const row = db.prepare('SELECT payload FROM chunks WHERE id=? AND offset=?').get(id, offset);
        if (!row)
            return null;
        const value = decode(row.payload);
        if (!object(value) || value.id !== id || !validChunk(value.chunk) || value.chunk.offset !== offset || Object.keys(value).length !== 2)
            fail('Backup chunk receipt needs recovery.', 503);
        return value.chunk;
    };
    const commitChunk = (upload, chunk) => transact(() => {
        db.prepare('INSERT INTO chunks VALUES(?,?,?)').run(upload.id, chunk.offset, encode({ id: upload.id, chunk }));
        upload.offset += chunk.size;
        upload.pending = null;
        upload.updatedAt = Math.max(now(), upload.createdAt);
        save(upload);
    });
    async function reconcile(upload) {
        if (upload.state === 'cancelled') {
            if (await checkedFile(artifactPath(upload.id), true)) {
                await unlink(artifactPath(upload.id));
                fsyncDir(directory);
            }
            return upload;
        }
        const stat = await checkedFile(artifactPath(upload.id), true);
        // Admission writes its receipt before exclusive file creation. A missing
        // zero-length upload can be recreated; partial/missing data cannot.
        if (!stat && upload.offset === 0 && !upload.pending && upload.state === 'uploading') {
            const handle = await open(artifactPath(upload.id), 'wx', 0o600);
            try {
                await windowsFilePrivacy(artifactPath(upload.id), 'file', true);
                await handle.sync();
            }
            finally {
                await handle.close();
            }
            fsyncDir(directory);
            return upload;
        }
        if (!stat)
            fail('Backup transfer data is missing. Keep the original backup and contact support.', 503);
        if (!upload.pending) {
            if (stat.size !== upload.offset)
                fail('Backup transfer data changed unexpectedly.', 503);
            return upload;
        }
        const pending = upload.pending;
        if (stat.size === upload.offset) {
            upload.pending = null;
            save(upload);
            return upload;
        }
        if (stat.size !== upload.offset + pending.size)
            fail('An interrupted backup chunk needs recovery. The original backup is unchanged.', 503);
        const handle = await checkedHandle(artifactPath(upload.id), constants.O_RDWR);
        try {
            const data = Buffer.alloc(pending.size);
            const result = await handle.read(data, 0, data.length, pending.offset);
            if (result.bytesRead !== data.length || hash(data) !== pending.digest)
                fail('An interrupted backup chunk failed its integrity check.', 503);
            // A previous full write may have died before fsync. Bytes visible in the
            // page cache are not a durable receipt until recovery syncs them too.
            options.fault?.('recovery-before-sync', upload.id);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        commitChunk(upload, pending);
        return upload;
    }
    async function append(id, offset, data, digest) {
        if (!(data instanceof Uint8Array) || !integer(offset) || !HASH.test(digest) || data.length < 1 || data.length > BACKUP_TRANSFER_CHUNK_BYTES || hash(data) !== digest)
            fail('The backup chunk is invalid.', 400);
        const upload = await reconcile(read(id));
        if (upload.state !== 'uploading')
            fail('This transfer no longer accepts upload chunks.');
        const chunk = { offset, size: data.length, digest }, prior = readChunk(id, offset);
        if (prior) {
            if (prior.size !== chunk.size || prior.digest !== chunk.digest)
                fail('This chunk differs from its saved receipt.');
            return publicStatus(upload);
        }
        if (offset !== upload.offset || data.length !== Math.min(BACKUP_TRANSFER_CHUNK_BYTES, upload.size - upload.offset))
            fail('Resume from the saved upload position with the original file.');
        upload.pending = chunk;
        save(upload);
        options.fault?.('intent-saved', id);
        const handle = await checkedHandle(artifactPath(id), constants.O_RDWR);
        try {
            let written = 0;
            while (written < data.length) {
                const part = await handle.write(data, written, data.length - written, offset + written);
                if (!part.bytesWritten)
                    fail('Backup storage did not accept the chunk.', 503);
                written += part.bytesWritten;
            }
            options.fault?.('data-written', id);
            await handle.sync();
        }
        finally {
            await handle.close();
        }
        options.fault?.('data-synced', id);
        commitChunk(upload, chunk);
        options.fault?.('receipt-saved', id);
        return publicStatus(upload);
    }
    async function verifyArtifact(upload) {
        const handle = await checkedHandle(artifactPath(upload.id), constants.O_RDONLY), whole = createHash('sha256');
        try {
            const before = await handle.stat(), buffer = Buffer.alloc(BACKUP_TRANSFER_CHUNK_BYTES);
            for (let offset = 0; offset < upload.size;) {
                const part = await handle.read(buffer, 0, Math.min(buffer.length, upload.size - offset), offset);
                if (!part.bytesRead)
                    fail('The completed backup is truncated.', 503);
                whole.update(buffer.subarray(0, part.bytesRead));
                offset += part.bytesRead;
            }
            const after = await handle.stat();
            if (before.size !== upload.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || whole.digest('hex') !== upload.digest)
                fail('The completed backup bytes changed. Keep the original file and copy it again.', 503);
        }
        finally {
            await handle.close();
        }
    }
    async function pruneCancelled() {
        let removed = 0;
        // Only terminal transport receipts expire. Business history and staged or
        // otherwise active copies are never removed by this retention policy.
        for (const row of db.prepare('SELECT id FROM operations').iterate()) {
            const upload = read(String(row.id));
            if (upload.state !== 'cancelled' || now() - upload.updatedAt < BACKUP_TRANSFER_CANCEL_RETENTION_MS)
                continue;
            await reconcile(upload);
            transact(() => { db.prepare('DELETE FROM chunks WHERE id=?').run(upload.id); db.prepare('DELETE FROM operations WHERE id=?').run(upload.id); });
            removed++;
        }
        return removed;
    }
    return {
        start(id, size) {
            return run(async () => {
                if (typeof id !== 'string' || !UUID.test(id) || !integer(size, 1) || size > BACKUP_TRANSFER_MAX_BYTES)
                    fail('Choose a non-empty backup up to 1 GiB.', 400);
                if (db.prepare('SELECT id FROM operations WHERE id=?').get(id)) {
                    const current = await reconcile(read(id));
                    if (current.size !== size || current.state === 'cancelled')
                        fail('This upload identifier is already bound to another request.');
                    return publicStatus(current);
                }
                await pruneCancelled();
                let active = 0;
                for (const row of db.prepare('SELECT id FROM operations').iterate())
                    if (read(String(row.id)).state !== 'cancelled')
                        active++;
                if (active >= MAX_ACTIVE)
                    fail('Finish or remove an earlier backup transfer before starting another.');
                const at = now(), value = { version: 1, workspaceId: options.workspaceId, id, size, offset: 0, state: 'uploading', createdAt: at, updatedAt: at, digest: null, manifestDigest: null, pending: null };
                save(value);
                await reconcile(value);
                return publicStatus(value);
            });
        },
        status(id) { return run(async () => publicStatus(await reconcile(read(id)))); },
        append(id, offset, data, digest) {
            // Own the bounded bytes before entering the queue; callers cannot mutate
            // an admitted buffer while a previous operation is completing.
            if (!(data instanceof Uint8Array) || data.length > BACKUP_TRANSFER_CHUNK_BYTES)
                return Promise.reject(Object.assign(new Error('The backup chunk is too large.'), { status: 413 }));
            if (queued >= 8 || closing || closed)
                return Promise.reject(Object.assign(new Error('Check the saved transfer status before retrying.'), { status: 409 }));
            const owned = Buffer.from(data);
            return run(() => append(id, offset, owned, digest));
        },
        seal(id, manifestDigest) {
            return run(async () => {
                if (!HASH.test(manifestDigest))
                    fail('Check the complete upload before finishing.', 400);
                const upload = await reconcile(read(id));
                if (upload.state === 'uploaded' || upload.state === 'staged') {
                    if (upload.manifestDigest !== manifestDigest)
                        fail('The completed upload does not match this file.');
                    await verifyArtifact(upload);
                    return publicStatus(upload);
                }
                if (upload.state !== 'uploading' || upload.offset !== upload.size)
                    fail('The upload has not finished.');
                const manifest = [], whole = createHash('sha256');
                const handle = await checkedHandle(artifactPath(id), constants.O_RDONLY);
                try {
                    for (let offset = 0; offset < upload.size; offset += BACKUP_TRANSFER_CHUNK_BYTES) {
                        const chunk = readChunk(id, offset), size = Math.min(BACKUP_TRANSFER_CHUNK_BYTES, upload.size - offset);
                        if (!chunk || chunk.size !== size)
                            fail('The complete upload is missing a chunk receipt.', 503);
                        const data = Buffer.alloc(size), read = await handle.read(data, 0, size, offset);
                        if (read.bytesRead !== size || hash(data) !== chunk.digest)
                            fail('The uploaded backup failed its chunk check.', 503);
                        whole.update(data);
                        manifest.push([offset, size, chunk.digest]);
                    }
                    if ((await handle.stat()).size !== upload.size || hash(JSON.stringify(manifest)) !== manifestDigest)
                        fail('The complete uploaded backup differs from the selected file.');
                }
                finally {
                    await handle.close();
                }
                upload.state = 'uploaded';
                upload.digest = whole.digest('hex');
                upload.manifestDigest = manifestDigest;
                upload.updatedAt = Math.max(now(), upload.createdAt);
                save(upload);
                return publicStatus(upload);
            });
        },
        /** Internal only: the host must never return this server-generated path. */
        artifact(id) { return run(async () => { const upload = await reconcile(read(id)); if (!['uploaded', 'staged'].includes(upload.state))
            fail('The backup upload is not complete.'); await verifyArtifact(upload); return { path: artifactPath(id), size: upload.size, digest: upload.digest }; }); },
        markStaged(id, digest) { return run(async () => { const upload = await reconcile(read(id)); if (!['uploaded', 'staged'].includes(upload.state) || upload.digest !== digest)
            fail('The reviewed backup changed.'); await verifyArtifact(upload); upload.state = 'staged'; upload.updatedAt = Math.max(now(), upload.createdAt); save(upload); return publicStatus(upload); }); },
        cancel(id) { return run(async () => { const upload = read(id); if (upload.state === 'staged')
            fail('This backup is staged for restore and must be retained for restart recovery.'); upload.state = 'cancelled'; upload.pending = null; upload.digest = null; upload.manifestDigest = null; upload.updatedAt = Math.max(now(), upload.createdAt); save(upload); options.fault?.('cancel-saved', id); await reconcile(upload); return publicStatus(upload); }); },
        pruneCancelled() { return run(pruneCancelled); },
        async close() {
            closing = true;
            await tail;
            if (closed)
                return;
            try {
                assertOwner();
                transact(() => { db.prepare('DELETE FROM owner WHERE id=1').run(); });
            }
            finally {
                closed = true;
                db.close();
                key.fill(0);
            }
        },
    };
}
