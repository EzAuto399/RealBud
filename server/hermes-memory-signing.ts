/** Memory-review signing keys that survive a restore into another installation.
 *
 * Receipts, proposal journals, preview digests and proposal identities are
 * HMACs under a per workspace/profile key. That key lives encrypted in the
 * private vault (company-installation/private/memory-signing.json), which both
 * private backup formats carry and re-encrypt for the destination, so the whole
 * signed graph keeps verifying after a restore. A slot seen for the first time
 * is derived from this installation's key exactly as before, so every existing
 * record verifies unchanged. The keys never appear in worker state or logs. */
import { createHmac } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { createPrivateVault } from './private-vault.ts';

export const MEMORY_SIGNING_NAME = 'memory-signing';
const SLOT = /^([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/(property(?:-[a-z0-9-]+)?)$/, SLOTS = 64;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const unavailable = () => Object.assign(new Error('Memory review signing needs service recovery.'), { code: 'unavailable', status: 503 });

/** The saved slots, all bound to `workspaceId` when given. Throws on anything else. */
export function parseMemorySigning(value: unknown, workspaceId?: string): Record<string, string> {
  if (value === undefined) return {};
  if (!object(value) || Object.keys(value).sort().join(',') !== 'keys,version' || value.version !== 1 || !object(value.keys) || Object.keys(value.keys).length > SLOTS) throw unavailable();
  for (const [slot, key] of Object.entries(value.keys)) {
    const match = SLOT.exec(slot);
    if (!match || match[2].length > 64 || workspaceId !== undefined && match[1] !== workspaceId || typeof key !== 'string' || Buffer.from(key, 'base64').length !== 32 || Buffer.from(key, 'base64').toString('base64') !== key) throw unavailable();
  }
  return { ...value.keys as Record<string, string> };
}

const tails = new Map<string, Promise<unknown>>();
export function memorySigningKey(installationKey: Buffer, workspaceId: string, profileId: string, dataDir = DATA_DIR): Promise<Buffer> {
  const slot = `${workspaceId}/${profileId}`;
  if (!SLOT.test(slot) || !Buffer.isBuffer(installationKey) || installationKey.length !== 32) return Promise.reject(unavailable());
  const vault = createPrivateVault(dataDir, installationKey);
  const work = (tails.get(dataDir) ?? Promise.resolve()).then(async () => {
    let keys: Record<string, string>;
    try { keys = parseMemorySigning(await vault.read(MEMORY_SIGNING_NAME)); } catch { throw unavailable(); }
    if (keys[slot]) return Buffer.from(keys[slot], 'base64');
    if (Object.keys(keys).length >= SLOTS) throw unavailable();
    const derived = createHmac('sha256', installationKey).update(`realbud-memory-review-v1\0${workspaceId}\0${profileId}`).digest();
    await vault.write(MEMORY_SIGNING_NAME, { version: 1, keys: { ...keys, [slot]: derived.toString('base64') } });
    return derived;
  });
  const tail = work.then(() => undefined, () => undefined);
  tails.set(dataDir, tail); void tail.then(() => { if (tails.get(dataDir) === tail) tails.delete(dataDir); });
  return work;
}

/** Save the signing key of every profile this workspace has learning for, before a
 * backup is captured (and at boot import), so a backup made before any review still
 * carries what its signed records need. Existing slots are never changed. */
export async function ensureWorkspaceMemorySigning(installationKey: Buffer, workspaceId: string, dataDir = DATA_DIR): Promise<string[]> {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(workspaceId)) throw unavailable();
  const profiles = new Set<string>();
  const list = async (path: string) => { try { return await readdir(path, { withFileTypes: true }); } catch { return []; } };
  for (const entry of await list(join(dataDir, 'memory-learning', workspaceId))) if (entry.isDirectory() && SLOT.test(`${workspaceId}/${entry.name}`)) profiles.add(entry.name);
  for (const entry of await list(join(dataDir, 'worker-state', workspaceId))) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
    try {
      const profileId = (JSON.parse(await readFile(join(dataDir, 'worker-state', workspaceId, entry.name, 'state.json'), 'utf8')) as { profileId?: unknown }).profileId;
      if (typeof profileId === 'string' && SLOT.test(`${workspaceId}/${profileId}`)) profiles.add(profileId);
    } catch { /* unreadable scopes are held by their own owner */ }
  }
  for (const profileId of [...profiles].sort().slice(0, SLOTS)) (await memorySigningKey(installationKey, workspaceId, profileId, dataDir)).fill(0);
  return [...profiles].sort();
}
