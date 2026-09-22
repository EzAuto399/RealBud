import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { readdir, lstat } from 'node:fs/promises';
import { openSync, writeFileSync, fsyncSync, closeSync } from 'node:fs';
import { fsyncDir } from './atomic.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { decryptJson, encryptJson, type EncryptedEnvelope } from './desk-crypto.ts';
import { privateDirectory, readPrivateJson, removePrivateJson, writePrivateJson } from './private-json.ts';

export function createPrivateVault(dataDirectory: string, key?: Buffer) {
  const directory = join(dataDirectory, 'company-installation', 'private');
  let pendingKey: Promise<Buffer> | undefined;
  const selected = () => pendingKey ??= (async () => {
    if (key) { if (key.length !== 32) throw new Error('Invalid private state key.'); return key; }
    if (process.env.REALBUD_PRODUCTION === '1') throw new Error('The installed app must provide its protected private state key.');
    await privateDirectory(directory);
    const keyPath = join(directory, 'development-key.json');
    const readKey = async () => {
      const saved = await readPrivateJson(keyPath) as { version?: number; key?: string } | undefined;
      if (saved === undefined) return undefined;
      if (!saved || saved.version !== 1 || !/^[a-f0-9]{64}$/.test(saved.key ?? '')) throw new Error('Private state key needs recovery.');
      return Buffer.from(saved.key!, 'hex');
    };
    const existing = await readKey(); if (existing) return existing;
    const entries = await readdir(directory);
    const concurrent = await readKey(); if (concurrent) return concurrent;
    if (entries.length) throw new Error('Private state key is missing. Restore it before continuing.');
    const generated = randomBytes(32);
    let fd: number;
    try { fd = openSync(keyPath, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      generated.fill(0);
      // The winner protects its file before writing it, so a concurrent loser
      // can briefly see an unprotected or still-empty key: wait that window
      // out, then treat whatever remains as damage rather than regenerating.
      for (let attempt = 0; ; attempt++) {
        try { const winner = await readKey(); if (winner) return winner; }
        catch (raceError) { if (attempt >= 50) throw raceError; }
        if (attempt >= 50) throw new Error('Private state key needs recovery.');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    // Exclusive first creation cannot replace a concurrent writer's key. An
    // interrupted initial key file fails closed; it is never regenerated. The
    // descriptor lands before the content, as every private write does.
    try {
      await windowsFilePrivacy(keyPath, 'file', true);
      writeFileSync(fd, JSON.stringify({ version: 1, key: generated.toString('hex') })); fsyncSync(fd);
    } finally { closeSync(fd); }
    fsyncDir(directory); return generated;
  })();
  const path = (name: string) => {
    if (!/^[a-z0-9-]{1,80}$/.test(name)) throw new Error('Invalid private state name.');
    return join(dataDirectory, 'company-installation', 'private', `${name}.json`);
  };
  return {
    async names(prefix: string, limit = 50): Promise<{ names: string[]; hasMore: boolean }> {
      if (!/^[a-z-]+$/.test(prefix)) throw new Error('Invalid private state prefix.');
      await privateDirectory(directory);
      const candidates = (await readdir(directory)).filter(name => name.startsWith(prefix) && /^[a-z0-9-]{1,80}\.json$/.test(name));
      const dates = await Promise.all(candidates.map(async name => ({ name, time: (await lstat(join(directory, name))).mtimeMs })));
      dates.sort((a, b) => b.time - a.time || a.name.localeCompare(b.name));
      return { names: dates.slice(0, limit).map(item => item.name.slice(0, -5)), hasMore: dates.length > limit };
    },
    async read(name: string): Promise<unknown | undefined> {
      const envelope = await readPrivateJson(path(name), 2_000_000);
      if (envelope === undefined) return undefined;
      const decoded = decryptJson(await selected(), envelope as EncryptedEnvelope) as { name?: string; value?: unknown };
      if (decoded?.name !== name) throw new Error('Private state identity needs recovery.');
      return decoded.value;
    },
    write: async (name: string, value: unknown) => writePrivateJson(path(name), encryptJson(await selected(), { name, value })),
    remove: (name: string) => removePrivateJson(path(name)),
  };
}
