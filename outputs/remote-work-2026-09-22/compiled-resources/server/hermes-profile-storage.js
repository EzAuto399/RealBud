// Provisioning/config I/O, separate from the unadmitted native memory journal.
// Existing ACLs are verify-only. New empty objects become private before bytes.
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeFileSync, } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fsyncDir } from "./atomic.js";
import { windowsFilePrivacySync } from "./windows-file-privacy.js";
const MAX_BYTES = 2 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
class ProfileStorageError extends Error {
    status = 409;
    constructor() { super('Bud’s private profile needs recovery before it can be changed.'); }
}
function fail() { throw new ProfileStorageError(); }
function checked(work) {
    try {
        return work();
    }
    catch (error) {
        if (error instanceof ProfileStorageError || error instanceof Error && error.name === 'WindowsFilePrivacyError')
            throw error;
        throw new ProfileStorageError();
    }
}
function pathCheck(path) {
    if (!isAbsolute(path) || path.includes('\0'))
        fail();
}
function optionalStat(path) {
    try {
        return lstatSync(path, { bigint: true });
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
function ordinary(stat, directory) {
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n))
        fail();
    if (process.platform !== 'win32' && process.getuid && stat.uid !== BigInt(process.getuid()))
        fail();
}
function same(left, right) {
    return left.dev === right.dev && left.ino === right.ino && left.isDirectory() === right.isDirectory();
}
function unchanged(left, right) {
    return same(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.nlink === right.nlink;
}
function parents(path) {
    pathCheck(path);
    const result = [];
    for (let cursor = dirname(path);; cursor = dirname(cursor)) {
        const stat = lstatSync(cursor, { bigint: true });
        // Ancestors can be owned by the OS. They must be ordinary, existing paths.
        if (stat.isSymbolicLink() || !stat.isDirectory())
            fail();
        result.push([cursor, stat]);
        if (dirname(cursor) === cursor)
            break;
    }
    return result;
}
function recheckParents(chain) {
    for (const [path, before] of chain) {
        const after = lstatSync(path, { bigint: true });
        if (after.isSymbolicLink() || !after.isDirectory() || !same(before, after))
            fail();
    }
}
/** Create missing owned directories one at a time; never repair existing ACLs. */
export function ensureProfileDirectory(path) {
    checked(() => {
        pathCheck(path);
        const missing = [];
        for (let cursor = path; !optionalStat(cursor); cursor = dirname(cursor)) {
            if (dirname(cursor) === cursor)
                fail();
            missing.push(cursor);
        }
        for (const candidate of missing.reverse()) {
            const chain = parents(candidate);
            let created = false;
            try {
                mkdirSync(candidate, { mode: 0o700 });
                created = true;
            }
            catch (error) {
                if (error.code !== 'EEXIST')
                    throw error;
            }
            const before = lstatSync(candidate, { bigint: true });
            ordinary(before, true);
            windowsFilePrivacySync(candidate, 'directory', created);
            const after = lstatSync(candidate, { bigint: true });
            ordinary(after, true);
            if (!same(before, after))
                fail();
            recheckParents(chain);
        }
        if (!missing.length)
            verifyProfileDirectory(path);
    });
}
export function verifyProfileDirectory(path) {
    checked(() => {
        const chain = parents(path);
        const before = lstatSync(path, { bigint: true });
        ordinary(before, true);
        windowsFilePrivacySync(path, 'directory');
        const after = lstatSync(path, { bigint: true });
        ordinary(after, true);
        if (!same(before, after))
            fail();
        recheckParents(chain);
    });
}
/** Missing means only a missing leaf under verified, existing ancestry. */
function readProfileSnapshot(path) {
    return checked(() => {
        const chain = parents(path);
        const before = optionalStat(path);
        if (!before) {
            recheckParents(chain);
            return null;
        }
        ordinary(before, false);
        if (before.size > BigInt(MAX_BYTES))
            fail();
        windowsFilePrivacySync(path, 'file');
        const fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
        try {
            const opened = fstatSync(fd, { bigint: true });
            ordinary(opened, false);
            if (!unchanged(before, opened))
                fail();
            const buffer = Buffer.alloc(Number(opened.size) + 1);
            let length = 0;
            while (length < buffer.length) {
                const count = readSync(fd, buffer, length, buffer.length - length, null);
                if (!count)
                    break;
                length += count;
            }
            const data = buffer.subarray(0, length);
            const after = fstatSync(fd, { bigint: true });
            ordinary(after, false);
            const named = lstatSync(path, { bigint: true });
            ordinary(named, false);
            if (!unchanged(opened, after) || !unchanged(after, named) || BigInt(data.length) !== after.size)
                fail();
            recheckParents(chain);
            return { data, stat: after };
        }
        finally {
            closeSync(fd);
        }
    });
}
export function readProfileFile(path) {
    return readProfileSnapshot(path)?.data ?? null;
}
/** Complete private stage, then publish; no truncation or copy fallback. */
export function writeProfileFile(path, content, overwrite = true, expected) {
    checked(() => {
        const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
        if (!Buffer.isBuffer(data) || data.length > MAX_BYTES)
            fail();
        verifyProfileDirectory(dirname(path));
        const chain = parents(path);
        const snapshot = readProfileSnapshot(path);
        const previous = snapshot?.data ?? null;
        if (expected !== undefined && ((expected === null) !== (previous === null) || expected && !expected.equals(previous)))
            fail();
        if (!overwrite && previous !== null)
            fail();
        const existing = snapshot?.stat ?? null;
        const temporary = join(dirname(path), `.realbud-profile-${randomUUID()}.tmp`);
        const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
        let created;
        let closed = false;
        try {
            created = fstatSync(fd, { bigint: true });
            ordinary(created, false);
            if (created.size !== 0n)
                fail();
            windowsFilePrivacySync(temporary, 'file', true);
            const restricted = lstatSync(temporary, { bigint: true });
            ordinary(restricted, false);
            if (!same(created, restricted) || restricted.size !== 0n || !same(restricted, fstatSync(fd, { bigint: true })))
                fail();
            recheckParents(chain);
            writeFileSync(fd, data);
            fsyncSync(fd);
            const written = fstatSync(fd, { bigint: true });
            ordinary(written, false);
            const named = lstatSync(temporary, { bigint: true });
            ordinary(named, false);
            if (!unchanged(written, named) || written.size !== BigInt(data.length))
                fail();
            const current = readProfileFile(path);
            const currentStat = optionalStat(path);
            if ((previous === null) !== (current === null) || previous && !previous.equals(current) ||
                existing && (!currentStat || !unchanged(existing, currentStat)))
                fail();
            recheckParents(chain);
            // CREATE_NEW publication cannot overwrite a competing first creation.
            // Both names refer to our already-private complete stage until unlink.
            if (existing === null) {
                linkSync(temporary, path);
                unlinkSync(temporary);
            }
            else
                renameSync(temporary, path);
            const published = lstatSync(path, { bigint: true });
            ordinary(published, false);
            if (!same(created, published) || published.size !== BigInt(data.length))
                fail();
            windowsFilePrivacySync(path, 'file');
            recheckParents(chain);
            closeSync(fd);
            closed = true;
            fsyncDir(dirname(path));
        }
        finally {
            if (!closed)
                closeSync(fd);
            // Delete only our still-single-linked stage. Uncertain aliases survive.
            const staged = optionalStat(temporary);
            if (created && staged && !staged.isSymbolicLink() && staged.nlink === 1n && same(created, staged))
                unlinkSync(temporary);
        }
    });
}
