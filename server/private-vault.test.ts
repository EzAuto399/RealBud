import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrivateVault } from './private-vault.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const value = await mkdtemp(join(tmpdir(), 'rb-vault-')); roots.push(value); return value; }
describe('encrypted lifecycle state', () => {
  it('survives restart without placing private content or tokens in plaintext', async () => {
    const directory = await root(); const payload = { token: 'sensitive-fixture', summary: 'private-example' };
    await createPrivateVault(directory).write('outbox', payload);
    const raw = await readFile(join(directory, 'company-installation/private/outbox.json'), 'utf8');
    expect(raw).not.toContain(payload.token); expect(raw).not.toContain(payload.summary);
    expect(await createPrivateVault(directory).read('outbox')).toEqual(payload);
  });
  it('shares one development key under concurrent first use without replacing it', async () => {
    const directory = await root();
    await Promise.all([createPrivateVault(directory).write('one', { value: 1 }), createPrivateVault(directory).write('two', { value: 2 })]);
    expect(await createPrivateVault(directory).read('one')).toEqual({ value: 1 });
    expect(await createPrivateVault(directory).read('two')).toEqual({ value: 2 });
  });
  it('refuses missing keys and swapped state files without replacing data', async () => {
    const directory = await root(); const vault = createPrivateVault(directory);
    await vault.write('departure', { secret: 'fixture' });
    const raw = await readFile(join(directory, 'company-installation/private/departure.json'));
    await writeFile(join(directory, 'company-installation/private/outbox.json'), raw, { mode: 0o600 });
    // A planted file inherits its directory's descriptor; Windows admission requires its own.
    await windowsFilePrivacy(join(directory, 'company-installation/private/outbox.json'), 'file', true);
    await expect(vault.read('outbox')).rejects.toThrow(/identity needs recovery/);
    await rm(join(directory, 'company-installation/private/development-key.json'));
    await expect(createPrivateVault(directory).read('departure')).rejects.toThrow(/key is missing/);
    expect(await readFile(join(directory, 'company-installation/private/departure.json'))).toEqual(raw);
  });
});
