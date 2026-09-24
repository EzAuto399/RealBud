import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanyInstallation } from './company-installation.ts';
import { openOwnedPostgres } from './company/host-runtime.ts';
import { assertWindowsPostgresAdmission, WindowsPostgresAdmissionError } from './windows-postgres-admission.ts';
import { plantPrivateFile } from './testing/private-fixture.ts';

vi.mock('./windows-postgres-admission.ts', async original => ({
  ...await original<typeof import('./windows-postgres-admission.ts')>(), assertWindowsPostgresAdmission: vi.fn(),
}));
vi.mock('./company/host-runtime.ts', () => ({ openOwnedPostgres: vi.fn() }));

const roots: string[] = [];
const instances: ReturnType<typeof createCompanyInstallation>[] = [];
const admin = { headers: { 'x-test-admin': 'fictional-admin' } };
beforeEach(() => {
  vi.stubEnv('REALBUD_COMPANY_DATABASE_URL', '');
  vi.mocked(assertWindowsPostgresAdmission).mockReset().mockResolvedValue();
  vi.mocked(openOwnedPostgres).mockReset().mockRejectedValue(new Error('fictional downstream failure'));
});
afterEach(async () => {
  for (const app of instances.splice(0)) await app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function fixture(saved?: string) {
  const root = await mkdtemp(join(tmpdir(), 'realbud-company-admission-')); roots.push(root);
  const directory = join(root, 'company-installation');
  if (saved !== undefined) {
    plantPrivateFile(join(directory, 'host.json'), saved);
    plantPrivateFile(join(directory, 'postgres', 'fictional-existing-data'), 'fictional-preserved-data');
  }
  const resolveBinaryDirectory = vi.fn(async () => ({ binaryDirectory: join(root, 'fictional-bin') }));
  const app = createCompanyInstallation({ dataDirectory: root, previewEnabled: true, resolveBinaryDirectory,
    authorizeAdmin: request => request.headers['x-test-admin'] ? { ok: true, expiresAt: Date.now() + 60_000 } : { ok: false, status: 401, error: 'Admin required' },
    hasAdminSession: request => Boolean(request.headers['x-test-admin']),
  });
  instances.push(app);
  return { app, directory, resolveBinaryDirectory };
}

describe('company installation Windows launch admission', () => {
  it.each(['privileged-token', 'verification-unavailable'] as const)('returns actionable %s guidance before saving host settings or starting storage', async reason => {
    const failure = new WindowsPostgresAdmissionError(reason);
    vi.mocked(assertWindowsPostgresAdmission).mockRejectedValue(failure);
    const { app, directory, resolveBinaryDirectory } = await fixture();
    expect(await app.handle('/api/company/setup', 'POST', admin, {})).toEqual({ status: 503, body: { code: failure.code, error: failure.message } });
    await expect(access(join(directory, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(join(directory, 'postgres'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(resolveBinaryDirectory).not.toHaveBeenCalled();
    expect(openOwnedPostgres).not.toHaveBeenCalled();
  });

  it.each(['privileged-token', 'verification-unavailable'] as const)('preserves saved host and database state and exposes %s through startup status', async reason => {
    const failure = new WindowsPostgresAdmissionError(reason);
    vi.mocked(assertWindowsPostgresAdmission).mockRejectedValue(failure);
    const saved = JSON.stringify({ version: 1, databasePort: 5432 });
    const { app, directory, resolveBinaryDirectory } = await fixture(saved);
    expect(await app.handle('/api/company/status', 'GET', admin)).toMatchObject({ status: 200,
      body: { storageAvailable: false, setupError: failure.message } });
    expect(await readFile(join(directory, 'host.json'), 'utf8')).toBe(saved);
    expect(await readFile(join(directory, 'postgres', 'fictional-existing-data'), 'utf8')).toBe('fictional-preserved-data');
    expect(resolveBinaryDirectory).not.toHaveBeenCalled(); expect(openOwnedPostgres).not.toHaveBeenCalled();
    expect(await app.handle('/api/company/setup', 'POST', admin, {})).toEqual({ status: 503, body: { code: failure.code, error: failure.message } });
  });

  it('continues the existing settings and storage path after successful admission', async () => {
    const { app, directory, resolveBinaryDirectory } = await fixture();
    const response = await app.handle('/api/company/setup', 'POST', admin, {});
    expect(response.status).toBe(503); // the deliberate downstream fake failure
    expect(assertWindowsPostgresAdmission).toHaveBeenCalledOnce();
    expect(resolveBinaryDirectory).toHaveBeenCalledOnce(); expect(openOwnedPostgres).toHaveBeenCalledOnce();
    const settings = JSON.parse(await readFile(join(directory, 'host.json'), 'utf8'));
    expect(settings).toMatchObject({ version: 1, databasePort: expect.any(Number) });
    expect(vi.mocked(openOwnedPostgres).mock.calls[0]![0]).toMatchObject({ rootDirectory: join(directory, 'postgres'), port: settings.databasePort });
    expect(JSON.stringify(response)).not.toContain('fictional downstream failure');
  });

  it('keeps service administrator authorization ahead of the launch query', async () => {
    const { app, directory } = await fixture();
    expect(await app.handle('/api/company/setup', 'POST', { headers: {} }, {})).toMatchObject({ status: 401 });
    expect(assertWindowsPostgresAdmission).not.toHaveBeenCalled(); expect(openOwnedPostgres).not.toHaveBeenCalled();
    await expect(access(join(directory, 'host.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
