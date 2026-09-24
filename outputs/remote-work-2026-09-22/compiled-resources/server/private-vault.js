import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readdir, lstat } from 'node:fs/promises';
import { openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { fsyncDir } from "./atomic.js";
import { windowsFilePrivacy } from "./windows-file-privacy.js";
import { decryptJson, encryptJson } from "./desk-crypto.js";
import { privateDirectory, readPrivateJson, removePrivateJson, writePrivateJson } from "./private-json.js";
export function createPrivateVault(dataDirectory, key) {
    const directory = join(dataDirectory, 'company-installation', 'private');
    let pendingKey;
    const selected = () => pendingKey ??= (async () => {
        if (key) {
            if (key.length !== 32)
                throw new Error('Invalid private state key.');
            return key;
        }
        if (process.env.REALBUD_PRODUCTION === '1')
            throw new Error('The installed app must provide its protected private state key.');
        await privateDirectory(directory);
        const keyPath = join(directory, 'development-key.json');
        const readKey = async () => {
            const saved = await readPrivateJson(keyPath);
            if (saved === undefined)
                return undefined;
            if (!saved || saved.version !== 1 || !/^[a-f0-9]{64}$/.test(saved.key ?? ''))
                throw new Error('Private state key needs recovery.');
            return Buffer.from(saved.key, 'hex');
        };
        const existing = await readKey();
        if (existing)
            return existing;
        const entries = await readdir(directory);
        const concurrent = await readKey();
        if (concurrent)
            return concurrent;
        if (entries.length)
            throw new Error('Private state key is missing. Restore it before continuing.');
        const generated = randomBytes(32);
        let fd;
        try {
            fd = openSync(keyPath, 'wx', 0o600);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const winner = await readKey();
            if (!winner)
                throw new Error('Private state key needs recovery.');
            generated.fill(0);
            return winner;
        }
        // Exclusive first creation cannot replace a concurrent writer's key. An
        // interrupted initial key file fails closed; it is never regenerated.
        try {
            writeFileSync(fd, JSON.stringify({ version: 1, key: generated.toString('hex') }));
            fsyncSync(fd);
        }
        finally {
            closeSync(fd);
        }
        fsyncDir(directory);
        await windowsFilePrivacy(keyPath, 'file', true);
        return generated;
    })();
    const path = (name) => {
        if (!/^[a-z0-9-]{1,80}$/.test(name))
            throw new Error('Invalid private state name.');
        return join(dataDirectory, 'company-installation', 'private', `${name}.json`);
    };
    return {
        async names(prefix, limit = 50) {
            if (!/^[a-z-]+$/.test(prefix))
                throw new Error('Invalid private state prefix.');
            await privateDirectory(directory);
            const candidates = (await readdir(directory)).filter(name => name.startsWith(prefix) && /^[a-z0-9-]{1,80}\.json$/.test(name));
            const dates = await Promise.all(candidates.map(async (name) => ({ name, time: (await lstat(join(directory, name))).mtimeMs })));
            dates.sort((a, b) => b.time - a.time || a.name.localeCompare(b.name));
            return { names: dates.slice(0, limit).map(item => item.name.slice(0, -5)), hasMore: dates.length > limit };
        },
        async read(name) {
            const envelope = await readPrivateJson(path(name), 2_000_000);
            if (envelope === undefined)
                return undefined;
            const decoded = decryptJson(await selected(), envelope);
            if (decoded?.name !== name)
                throw new Error('Private state identity needs recovery.');
            return decoded.value;
        },
        write: async (name, value) => writePrivateJson(path(name), encryptJson(await selected(), { name, value })),
        remove: (name) => removePrivateJson(path(name)),
    };
}
