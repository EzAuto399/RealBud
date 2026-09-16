import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCompanyInstallation } from './company-installation.ts';

const roots: string[] = [];
const instances: ReturnType<typeof createCompanyInstallation>[] = [];
afterEach(async () => { for (const app of instances.splice(0)) await app.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs(); });
async function fixture(saved?: string) {
  vi.stubEnv('REALBUD_COMPANY_DATABASE_URL', '');
  const root = await mkdtemp(join(tmpdir(), 'realbud-pairing-')); roots.push(root);
  if (saved !== undefined) { await mkdir(join(root, 'company-installation'), { mode: 0o700 }); await writeFile(join(root, 'company-installation/host.json'), saved, { mode: 0o600 }); }
  const app = createCompanyInstallation({ dataDirectory: root, previewEnabled: true,
    authorizeAdmin: req => req.headers['x-test-admin'] ? { ok: true, expiresAt: Date.now() + 60_000 } : { ok: false, status: 401, error: 'Admin required' },
    hasAdminSession: req => !!req.headers['x-test-admin'],
  }); instances.push(app); return { app, root };
}

describe('native companion setup boundary', () => {
  it('offers joining without administrator keys or a local Postgres dependency', async () => {
    const { app } = await fixture();
    const status = await app.handle('/api/company/status', 'GET', { headers: {} });
    expect(status).toMatchObject({ status: 200, body: { remoteJoinAvailable: true, storageAvailable: false, storageSetupAvailable: false } });
    expect((await app.handle('/api/company/setup', 'POST', { headers: {} }, {})).status).toBe(401);
    expect((await app.handle('/api/company/credentials', 'POST', { headers: {} }, {})).status).toBe(503);
  });
  it('shows host setup to a signed-in administrator without an env-var binary path', async () => {
    const { app } = await fixture();
    expect((await app.handle('/api/company/status', 'GET', { headers: { 'x-test-admin': 'yes' } })).body).toMatchObject({
      storageSetupAvailable: true, remoteJoinAvailable: true, storageAvailable: false,
    });
  });
  it('never overwrites malformed saved host settings while retrying as administrator', async () => {
    const saved = '{"version":999,"databasePort":5432}';
    const { app, root } = await fixture(saved);
    expect((await app.handle('/api/company/status', 'GET', { headers: { 'x-test-admin': 'yes' } })).body).toMatchObject({ storageSetupAvailable: false, remoteJoinAvailable: false, setupError: expect.any(String) });
    expect((await app.handle('/api/company/setup', 'POST', { headers: { 'x-test-admin': 'yes' } }, {})).status).toBe(409);
    expect(await readFile(join(root, 'company-installation/host.json'), 'utf8')).toBe(saved);
  });
  it('does not save an invalid pairing and leaves a valid retry possible', async () => {
    const { app, root } = await fixture();
    expect(await app.handle('/api/company/connect-host', 'POST', { headers: {} }, { hostCode: 'RB1.invalid' })).toMatchObject({ status: 400, body: { code: 'invalid_host_code' } });
    await expect(readFile(join(root, 'company-installation/peer.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await app.handle('/api/company/status', 'GET', { headers: {} })).body).toMatchObject({ remoteJoinAvailable: true });
  });
  it('denies all work once shutdown starts', async () => {
    const { app } = await fixture(); await app.close();
    expect((await app.handle('/api/company/status', 'GET', { headers: {} })).status).toBe(503);
  });
});
