/** Materialize final randomized ciphertext once, before the compact stage is
 * published. Later restart recovery reads identical prepared bytes. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { privateBackupTargetPaths } from "./private-backup-capture.js";
import { privateRestoreTargetHash } from "./private-backup-cold-restore.js";
import { encryptJson } from "./desk-crypto.js";
import { WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH } from "./workflow-database.js";
import { windowsFilePrivacy } from "./windows-file-privacy.js";
import { fsyncDir } from "./atomic.js";
export const PRIVATE_BACKUP_BUILD_MAX_BYTES = 1024 ** 3;
const PAGE_BYTES = 4096;
export function privateBackupBuildStorageBudget(databaseBytes = PRIVATE_BACKUP_BUILD_MAX_BYTES) {
    if (!Number.isSafeInteger(databaseBytes) || databaseBytes < 65_536 || databaseBytes > PRIVATE_BACKUP_BUILD_MAX_BYTES || databaseBytes % PAGE_BYTES)
        fail('Invalid restore preparation capacity.', 400);
    const rollbackBytes = databaseBytes / PAGE_BYTES * (PAGE_BYTES + 8) + 2 * 65_536;
    return { databaseBytes, rollbackBytes, totalBytes: databaseBytes + rollbackBytes };
}
function fail(message = 'The private restore could not be prepared. Existing business records were preserved.', status = 503) { throw Object.assign(new Error(message), { status }); }
async function safeFolder(path) {
    const absolute = resolve(path), root = parse(absolute).root;
    let current = root;
    for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
        current = join(current, part);
        try {
            const s = await lstat(current);
            if (!s.isDirectory() || s.isSymbolicLink())
                fail();
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    const created = await mkdir(path, { recursive: true, mode: 0o700 }), stat = await lstat(path);
    if (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.()))
        fail();
    await windowsFilePrivacy(path, 'directory', created !== undefined);
}
/** Clean only this invocation's exclusively created build directory after its
 * SQLite/file handles close. Unexpected entries remain available for recovery. */
async function removeBuild(directory, identity) {
    const sameDirectory = async () => {
        const stat = await lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino)
            fail('Restore preparation storage changed; its files need recovery.');
    };
    await sameDirectory();
    const names = await readdir(directory);
    if (names.some(name => !['workflow-state.sqlite', 'workflow-state.sqlite-journal'].includes(name)))
        fail('Restore preparation contains unexpected files; they were preserved for recovery.');
    const files = [];
    for (const name of names) {
        const path = join(directory, name), stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.()))
            fail('Restore preparation contains linked or unverified files; they were preserved.');
        await windowsFilePrivacy(path, 'file');
        files.push({ path, stat });
    }
    for (const file of files) {
        await sameDirectory();
        const current = await lstat(file.path);
        if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== file.stat.dev || current.ino !== file.stat.ino || current.size !== file.stat.size || current.mtimeMs !== file.stat.mtimeMs || current.ctimeMs !== file.stat.ctimeMs)
            fail('Restore preparation storage changed; its files need recovery.');
        await unlink(file.path);
    }
    await sameDirectory();
    await rmdir(directory);
    fsyncDir(dirname(directory));
}
async function* chunks(bytes) { try {
    for (let offset = 0; offset < bytes.length; offset += 1024 * 1024)
        yield bytes.subarray(offset, offset + 1024 * 1024);
}
finally {
    bytes.fill(0);
} }
export async function preparePrivateBackupRestore(options) {
    if (!Buffer.isBuffer(options.key) || options.key.length !== 32)
        fail();
    if (options.buildDirectoryId !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options.buildDirectoryId))
        fail('The restore preparation allocation is invalid.', 400);
    const databaseBytes = options.databaseBytes ?? PRIVATE_BACKUP_BUILD_MAX_BYTES;
    if (!Number.isSafeInteger(databaseBytes) || databaseBytes < 65_536 || databaseBytes > PRIVATE_BACKUP_BUILD_MAX_BYTES || databaseBytes % PAGE_BYTES)
        fail('The restore preparation capacity is invalid.', 400);
    const key = Buffer.from(options.key), directory = resolve(options.directory);
    const assert = () => {
        options.signal?.throwIfAborted();
        const result = options.assertLease();
        if (result !== undefined) {
            if (result && typeof result === 'object' && 'then' in result)
                void Promise.resolve(result).catch(() => { });
            fail('The snapshot lease assertion must complete synchronously.', 500);
        }
    };
    let scratch, scratchIdentity;
    try {
        assert();
        const source = options.source.summary(), target = options.prepared.summary();
        if (!source.sealed || target.sealed || target.entries || target.workspaceId !== source.workspaceId || !options.databasePresent && source.records)
            fail();
        options.source.validate();
        const remaining = new Set(await privateBackupTargetPaths(directory));
        assert();
        let files = 0, bytes = 0;
        const added = async (size) => { files++; bytes += size; assert(); await options.onProgress?.({ files, bytes }); assert(); };
        for (const file of options.source.iterateFiles()) {
            assert();
            // JSON encoding is confined by catalog validation to Desk and the legacy
            // private-vault envelopes; all ordinary business bytes remain exact.
            const content = file.encoding === 'json' ? Buffer.from(JSON.stringify(encryptJson(key, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.data))))) : Buffer.from(file.data);
            const size = content.length, before = await privateRestoreTargetHash(join(directory, file.path));
            assert();
            await options.prepared.addFile(file.path, before, chunks(content), { signal: options.signal });
            assert();
            remaining.delete(file.path);
            await added(size);
        }
        if (options.databasePresent) {
            const parent = join(directory, 'private-backup-v2', 'build');
            await safeFolder(parent);
            assert();
            const candidate = join(parent, options.buildDirectoryId ?? randomUUID());
            await mkdir(candidate, { mode: 0o700 }); // Never claim or clean an existing allocation.
            scratch = candidate;
            scratchIdentity = await lstat(scratch);
            await windowsFilePrivacy(scratch, 'directory', true);
            const database = join(scratch, 'workflow-state.sqlite');
            const created = await open(database, 'wx', 0o600);
            await created.close();
            await windowsFilePrivacy(database, 'file', true);
            assert();
            const db = new DatabaseSync(database);
            try {
                db.exec(`PRAGMA trusted_schema=OFF; PRAGMA page_size=${PAGE_BYTES}; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA cache_size=-2048; PRAGMA temp_store=MEMORY; PRAGMA cache_spill=OFF;`);
                if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete' || db.prepare('PRAGMA cache_spill').get()?.cache_spill !== 0 || db.prepare('PRAGMA page_size').get()?.page_size !== PAGE_BYTES || db.prepare(`PRAGMA max_page_count=${databaseBytes / PAGE_BYTES}`).get()?.max_page_count !== databaseBytes / PAGE_BYTES)
                    fail('Restore preparation storage reached its capacity.', 413);
                db.exec('CREATE TABLE workflow_records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL); PRAGMA user_version=1; BEGIN IMMEDIATE;');
                const insert = db.prepare('INSERT INTO workflow_records VALUES(?,?,?,?)');
                // The whole private build is provisional until closed and copied. Small
                // transactions bound non-spilling memory without publishing partial work.
                let batchBytes = 0, batchRows = 0;
                for (const row of options.source.iterateRecords()) {
                    assert();
                    const payload = JSON.stringify(encryptJson(key, row.value));
                    if (payload.length > WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH)
                        fail('A restored workflow record exceeds its storage limit. No restore was staged.');
                    insert.run(row.id, row.kind, row.revision, payload);
                    batchBytes += Buffer.byteLength(payload);
                    batchRows++;
                    if (batchBytes >= 8 * 1024 * 1024 || batchRows >= 128) {
                        db.exec('COMMIT; BEGIN IMMEDIATE;');
                        batchBytes = 0;
                        batchRows = 0;
                    }
                }
                db.exec('COMMIT');
            }
            catch (error) {
                // SQLITE_FULL may already have rolled back. Closing discards any
                // remaining transaction; no incomplete database enters the prepared store.
                if (error.errcode === 13)
                    fail('Restore preparation storage reached its capacity. No restore was staged.', 413);
                throw error;
            }
            finally {
                db.close();
            }
            const handle = await open(database, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
            try {
                const before = await handle.stat();
                if (before.size > databaseBytes || !before.isFile() || before.nlink !== 1)
                    fail();
                const baseline = await privateRestoreTargetHash(join(directory, 'workflow-state.sqlite'));
                assert();
                async function* stream() {
                    const buffer = Buffer.alloc(1024 * 1024);
                    let offset = 0;
                    try {
                        while (offset < before.size) {
                            assert();
                            const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
                            assert();
                            if (!result.bytesRead)
                                fail();
                            offset += result.bytesRead;
                            yield buffer.subarray(0, result.bytesRead);
                        }
                        const after = await handle.stat();
                        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
                            fail();
                    }
                    finally {
                        buffer.fill(0);
                    }
                }
                await options.prepared.addFile('workflow-state.sqlite', baseline, stream(), { signal: options.signal });
                assert();
                remaining.delete('workflow-state.sqlite');
                await added(before.size);
            }
            finally {
                await handle.close();
            }
        }
        for (const path of remaining) {
            assert();
            const before = await privateRestoreTargetHash(join(directory, path));
            assert();
            if (before === null)
                fail();
            await options.prepared.addRemoval(path, before);
            assert();
        }
        const final = options.source.validate();
        if (final.digest !== source.digest || final.entries !== source.entries)
            fail();
        assert();
        const sealed = await options.prepared.seal({ signal: options.signal });
        assert();
        return sealed;
    }
    finally {
        key.fill(0);
        if (scratch && scratchIdentity)
            await removeBuild(scratch, scratchIdentity);
    }
}
