/** Cold restore coordinator. Only internally prepared artifacts are accepted;
 * this module never opens an uploaded database or retains an archive password.
 * Invoke apply before application stores, clocks or bridges are imported. */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encryptJson, decryptJson, isEncryptedEnvelope } from "./desk-crypto.js";
import { fsyncDir } from "./atomic.js";
import { windowsFilePrivacy } from "./windows-file-privacy.js";
import { PrivateBackupPreparedStore } from "./private-backup-prepared.js";
import { privateBackupTargetPaths, privateBackupTargetGuard } from "./private-backup-capture.js";
import { PRIVATE_RESTORE_STAGE_FILE, PRIVATE_RESTORE_RECEIPT_FILE } from "./private-workspace-backup.js";
import { parsePrivateBackupReceipt } from "../shared/private-workspace-backup.js";
import { PRIVATE_BACKUP_COMPLETION_FILE, validBackupRestoreBinding, parseBackupColdCompletion, readBackupColdCompletionProof, verifyBackupWorkspaceIdentity } from "./private-backup-completion.js";
export const PRIVATE_RESTORE_V2_STAGE_FILE = 'private-workspace-restore-v2.json';
const MAX_STAGE = 64 * 1024;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
function hold(message = 'The prepared restore needs recovery. Startup is held and existing files are preserved.') {
    throw Object.assign(new Error(message), { status: 503 });
}
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
async function parents(path) {
    const absolute = resolve(path), root = parse(absolute).root;
    let current = root;
    for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
        current = join(current, part);
        try {
            const s = await lstat(current);
            if (!s.isDirectory() || s.isSymbolicLink())
                hold();
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
}
async function fileHandle(path) {
    await parents(dirname(path));
    let before;
    try {
        before = await lstat(path);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
        hold();
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
        const after = await handle.stat();
        if (after.ino !== before.ino || after.dev !== before.dev || after.nlink !== 1)
            hold();
        return handle;
    }
    catch (error) {
        await handle.close();
        throw error;
    }
}
async function withRestoreLock(directory, work, fault) {
    const folder = join(resolve(directory), 'private-backup-v2');
    await parents(folder);
    const created = await mkdir(folder, { recursive: true, mode: 0o700 }), folderStat = await lstat(folder);
    if (process.platform !== 'win32' && ((folderStat.mode & 0o077) || folderStat.uid !== process.getuid?.()))
        hold();
    await windowsFilePrivacy(folder, 'directory', created !== undefined);
    const path = join(folder, 'restore-lock.sqlite');
    let first = false;
    try {
        const handle = await open(path, 'wx', 0o600);
        await handle.close();
        first = true;
    }
    catch (error) {
        if (error.code !== 'EEXIST')
            throw error;
    }
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 64 * 1024 || process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.()))
        hold();
    await windowsFilePrivacy(path, 'file', first);
    if (first)
        fault?.('created');
    const db = new DatabaseSync(path);
    let locked = false;
    try {
        db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0; PRAGMA synchronous=FULL;');
        try {
            db.exec('BEGIN IMMEDIATE');
            locked = true;
        }
        catch {
            hold('Another process is preparing or applying a private restore. Wait for it to finish before retrying.');
        }
        let schema = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 2").all();
        const version = db.prepare('PRAGMA user_version').get()?.user_version;
        // This file contains only an OS-released mutex, never operation history or
        // recovery records. An empty first creation can be initialized under the
        // actual SQLite lock; unknown nonempty files remain held and untouched.
        if (stat.size === 0 && schema.length === 0 && version === 0) {
            db.exec('CREATE TABLE restore_owner (id INTEGER PRIMARY KEY CHECK(id=1)); PRAGMA user_version=1;');
            fault?.('initializing');
            db.exec('COMMIT');
            locked = false;
            try {
                db.exec('BEGIN IMMEDIATE');
                locked = true;
            }
            catch {
                hold('Another process is preparing or applying a private restore. Wait for it to finish before retrying.');
            }
            schema = db.prepare("SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 2").all();
        }
        if (schema.length !== 1 || schema[0].sql !== 'CREATE TABLE restore_owner (id INTEGER PRIMARY KEY CHECK(id=1))' || db.prepare('PRAGMA user_version').get()?.user_version !== 1)
            hold();
        return await work();
    }
    finally {
        try {
            if (locked)
                db.exec('ROLLBACK');
        }
        finally {
            db.close();
        }
    }
}
export async function privateRestoreTargetHash(path) {
    const handle = await fileHandle(path);
    if (!handle)
        return null;
    try {
        const before = await handle.stat(), hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024);
        if (before.size > 1024 ** 3)
            hold('The restore target exceeds its supported size. Existing files were preserved.');
        let offset = 0;
        while (offset < before.size) {
            const part = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset);
            if (!part.bytesRead)
                hold();
            hash.update(buffer.subarray(0, part.bytesRead));
            offset += part.bytesRead;
        }
        const after = await handle.stat(), named = await lstat(path);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.ino !== after.ino || named.dev !== after.dev || named.nlink !== 1 || named.isSymbolicLink())
            hold();
        return hash.digest('hex');
    }
    finally {
        await handle.close();
    }
}
const fileHash = privateRestoreTargetHash;
async function readStage(directory, key) {
    const handle = await fileHandle(join(directory, PRIVATE_RESTORE_V2_STAGE_FILE));
    if (!handle)
        return null;
    try {
        if ((await handle.stat()).size > MAX_STAGE)
            hold();
        const bytes = await handle.readFile();
        if (bytes.length > MAX_STAGE)
            hold();
        const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!isEncryptedEnvelope(envelope))
            hold();
        const value = decryptJson(key, envelope);
        if (!object(value) || Object.keys(value).filter(k => k !== 'operation').sort().join(',') !== 'directoryId,preparedDigest,receipt,state,storeId,targetGuard,version,workspaceId' || value.version !== 2 ||
            Object.hasOwn(value, 'operation') && !validBackupRestoreBinding(value.operation) ||
            !['staged', 'applying'].includes(value.state) ||
            !['directoryId', 'storeId', 'workspaceId'].every(k => typeof value[k] === 'string' && UUID.test(value[k])) ||
            !['preparedDigest', 'targetGuard'].every(k => typeof value[k] === 'string' && HASH.test(value[k])))
            hold();
        const receipt = parsePrivateBackupReceipt(value.receipt);
        if (!receipt || receipt.workspaceId !== value.workspaceId)
            hold();
        return { ...value, receipt };
    }
    catch {
        return hold();
    }
    finally {
        await handle.close();
    }
}
async function atomicBytes(path, input, expected, beforePublish, scratchDirectory = dirname(path)) {
    await parents(dirname(path));
    const created = await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await windowsFilePrivacy(dirname(path), 'directory', created !== undefined);
    await parents(scratchDirectory);
    const scratchCreated = await mkdir(scratchDirectory, { recursive: true, mode: 0o700 });
    await windowsFilePrivacy(scratchDirectory, 'directory', scratchCreated !== undefined);
    if ((await lstat(scratchDirectory)).dev !== (await lstat(dirname(path))).dev)
        hold('Restore staging and business files must be on the same local filesystem.');
    // Business replacements live in the private staging area so creating a
    // temporary file cannot change the guarded company-membership directory.
    const temporary = join(scratchDirectory, `.realbud-restore-${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600), hash = createHash('sha256');
    let bytes = 0;
    try {
        await windowsFilePrivacy(temporary, 'file', true);
        for await (const chunk of input) {
            if (!(chunk instanceof Uint8Array) || chunk.length > 1024 * 1024)
                hold();
            bytes += chunk.length;
            if (bytes > (expected?.bytes ?? MAX_STAGE))
                hold();
            hash.update(chunk);
            let offset = 0;
            while (offset < chunk.length) {
                const result = await handle.write(chunk, offset, chunk.length - offset);
                if (!result.bytesWritten)
                    hold();
                offset += result.bytesWritten;
            }
        }
        if (expected && (bytes !== expected.bytes || hash.digest('hex') !== expected.digest))
            hold('A prepared restore file failed verification. The target file was preserved.');
        await handle.sync();
        await handle.close();
        await beforePublish?.();
        await rename(temporary, path);
        fsyncDir(dirname(path));
    }
    finally {
        await handle.close().catch(() => { });
        await unlink(temporary).catch(error => { if (error.code !== 'ENOENT')
            throw error; });
    }
}
async function saveStage(directory, key, stage) {
    const bytes = Buffer.from(JSON.stringify(encryptJson(key, stage)));
    if (bytes.length > MAX_STAGE)
        hold();
    await atomicBytes(join(directory, PRIVATE_RESTORE_V2_STAGE_FILE), (async function* () { yield bytes; })());
}
function preparedDirectory(directory, directoryId) { return join(directory, 'private-backup-v2', 'prepared', directoryId); }
async function inspectTarget(directory, store, stage) {
    if (await privateBackupTargetGuard(directory) !== stage.targetGuard)
        hold('The installation settings changed after restore preparation. Startup is held.');
    const paths = new Set(await privateBackupTargetPaths(directory));
    for (const entry of store.entries()) {
        const actual = await fileHash(join(directory, entry.path));
        if (stage.state === 'staged' ? actual !== entry.beforeHash : actual !== entry.beforeHash && actual !== entry.intendedHash)
            hold('The restore target changed after preparation. Startup is held; no further files were replaced.');
        paths.delete(entry.path);
    }
    if (paths.size)
        hold('New business files appeared after restore preparation. Startup is held.');
}
async function noV1Stage(directory) { if (await fileHash(join(directory, PRIVATE_RESTORE_STAGE_FILE)) !== null)
    hold('Another restore is already staged. Recover it before preparing another restore.'); }
/** Host must hold its installation write barrier throughout this call. */
async function stagePrivateRestoreV2Unlocked(options) {
    if (!Buffer.isBuffer(options.key) || options.key.length !== 32 || ![options.directoryId, options.storeId, options.workspaceId].every(v => typeof v === 'string' && UUID.test(v)) || !HASH.test(options.expectedPreparedDigest))
        hold();
    if (options.operation !== undefined && !validBackupRestoreBinding(options.operation))
        hold();
    const receipt = parsePrivateBackupReceipt(options.receipt);
    if (!receipt || receipt.workspaceId !== options.workspaceId)
        hold();
    const directory = resolve(options.directory), key = Buffer.from(options.key);
    let store;
    try {
        options.assertIdle();
        options.assertFresh();
        const epoch = options.epoch();
        await noV1Stage(directory);
        const existing = await readStage(directory, key);
        if (existing) {
            if (existing.directoryId !== options.directoryId || existing.storeId !== options.storeId || existing.preparedDigest !== options.expectedPreparedDigest || JSON.stringify(existing.receipt) !== JSON.stringify(receipt) || JSON.stringify(existing.operation) !== JSON.stringify(options.operation))
                hold('A different restore is already staged.');
            return { needsRestart: true, receipt: existing.receipt };
        }
        if (await fileHash(join(directory, PRIVATE_BACKUP_COMPLETION_FILE)) !== null)
            hold('Finish recording the previous restore before preparing another restore.');
        const ownership = options.operation ? await verifyBackupWorkspaceIdentity(directory, options.operation.previousWorkspaceId) : undefined;
        store = await PrivateBackupPreparedStore.open({ directory: preparedDirectory(directory, options.directoryId), key, storeId: options.storeId, workspaceId: options.workspaceId });
        const summary = await store.validate();
        if (!summary.sealed || summary.digest !== options.expectedPreparedDigest)
            hold();
        const stage = { version: 2, state: 'staged', directoryId: options.directoryId, storeId: options.storeId, workspaceId: options.workspaceId,
            preparedDigest: summary.digest, receipt, targetGuard: await privateBackupTargetGuard(directory), ...(options.operation ? { operation: { ...options.operation } } : {}) };
        await inspectTarget(directory, store, stage);
        options.assertIdle();
        options.assertFresh();
        if (options.epoch() !== epoch)
            hold('The target changed while preparing restoration. No restore was staged.');
        ownership?.assertCurrent();
        await saveStage(directory, key, stage);
        return { needsRestart: true, receipt };
    }
    finally {
        try {
            await store?.close();
        }
        finally {
            key.fill(0);
        }
    }
}
async function applyStagedPrivateRestoreV2Unlocked(options) {
    const directory = resolve(options.directory), key = Buffer.from(options.key);
    let store;
    try {
        const stage = await readStage(directory, key);
        if (!stage)
            return { restored: false };
        await noV1Stage(directory);
        const priorCompletion = await readBackupColdCompletionProof(directory, key);
        if (priorCompletion) {
            const proof = priorCompletion.proof;
            if (!stage.operation || proof.operationId !== stage.operation.operationId || proof.previousWorkspaceId !== stage.operation.previousWorkspaceId ||
                proof.workspaceId !== stage.workspaceId || proof.directoryId !== stage.directoryId || proof.storeId !== stage.storeId ||
                proof.preparedDigest !== stage.preparedDigest || JSON.stringify(proof.receipt) !== JSON.stringify(stage.receipt))
                hold('The previous restore must be recorded before applying another one.');
        }
        store = await PrivateBackupPreparedStore.open({ directory: preparedDirectory(directory, stage.directoryId), key, storeId: stage.storeId, workspaceId: stage.workspaceId });
        const summary = await store.validate();
        if (!summary.sealed || summary.digest !== stage.preparedDigest)
            hold();
        await inspectTarget(directory, store, stage);
        if (stage.state === 'staged') {
            stage.state = 'applying';
            await saveStage(directory, key, stage);
        }
        for (const entry of store.entries()) {
            if (await privateBackupTargetGuard(directory) !== stage.targetGuard)
                hold();
            const target = join(directory, entry.path), actual = await fileHash(target);
            if (actual !== entry.beforeHash && actual !== entry.intendedHash)
                hold();
            if (actual !== entry.intendedHash) {
                if (entry.intendedHash === null) {
                    await unlink(target);
                    fsyncDir(dirname(target));
                }
                else
                    await atomicBytes(target, store.readFile(entry.path), { bytes: entry.bytes, digest: entry.intendedHash }, async () => {
                        if (await privateBackupTargetGuard(directory) !== stage.targetGuard || await fileHash(target) !== actual)
                            hold('The target changed while its replacement was prepared. Its file was preserved.');
                    }, join(directory, 'private-backup-v2', 'apply'));
            }
            options.afterWrite?.(entry.path);
        }
        await inspectTarget(directory, store, stage);
        for (const entry of store.entries())
            if (await fileHash(join(directory, entry.path)) !== entry.intendedHash)
                hold();
        const restoredAt = priorCompletion?.proof.restoredAt ?? new Date().toISOString();
        if (priorCompletion)
            priorCompletion.assertCurrent();
        else if (stage.operation) {
            const proof = parseBackupColdCompletion({ version: 1, ...stage.operation, workspaceId: stage.workspaceId, directoryId: stage.directoryId,
                storeId: stage.storeId, preparedDigest: stage.preparedDigest, receipt: stage.receipt, restoredAt });
            if (!proof)
                hold();
            const bytes = Buffer.from(JSON.stringify(encryptJson(key, proof)));
            await atomicBytes(join(directory, PRIVATE_BACKUP_COMPLETION_FILE), (async function* () { yield bytes; })());
        }
        const completed = Buffer.from(JSON.stringify({ version: 1, restoredAt, receipt: stage.receipt, rekeyed: true, reviewRequired: true }));
        await atomicBytes(join(directory, PRIVATE_RESTORE_RECEIPT_FILE), (async function* () { yield completed; })());
        await unlink(join(directory, PRIVATE_RESTORE_V2_STAGE_FILE));
        fsyncDir(directory);
        return { restored: true, receipt: stage.receipt };
    }
    finally {
        try {
            await store?.close();
        }
        finally {
            key.fill(0);
        }
    }
}
export function stagePrivateRestoreV2(options) { return withRestoreLock(options.directory, () => stagePrivateRestoreV2Unlocked(options), options.lockFault); }
export function applyStagedPrivateRestoreV2(options) { return withRestoreLock(options.directory, () => applyStagedPrivateRestoreV2Unlocked(options), options.lockFault); }
