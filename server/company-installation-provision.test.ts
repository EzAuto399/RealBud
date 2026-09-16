// End-to-end proof for the "Set up this office" bar: the host must provision its
// own PostgreSQL without the staff member opening a terminal and without
// REALBUD_COMPANY_POSTGRES_BIN being set.
//
// This starts a REAL PostgreSQL 16 cluster with `initdb`, so it is skipped when
// no admitted runtime exists on the machine. It never sets the environment
// override, which is the whole point: before admission existed, this exact flow
// failed with "The service installer has not admitted the host database runtime
// on this computer."
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { createCompanyInstallation } from './company-installation.ts';
import { resolvePostgresRuntime } from './company/postgres-runtime.ts';

const roots: string[] = [];
const instances: ReturnType<typeof createCompanyInstallation>[] = [];
afterEach(async () => {
  for (const app of instances.splice(0)) await app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

const admin = { 'x-test-admin': 'yes' };

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const STAGED_RUNTIME = join(REPO_ROOT, 'dist-postgres');

/**
 * Reproduce the packaged layout (`<resources>/postgres/{bin,lib,share}`) from the
 * runtime `pnpm build:postgres` staged, so the bundled-admission path is
 * exercised rather than the developer fallback. Returns false when no runtime has
 * been staged (for example on a clone that has not packaged).
 */
async function packagedResourcesFixture(): Promise<string | null> {
  if (!existsSync(join(STAGED_RUNTIME, 'bin'))) return null;
  const resources = await mkdtemp(join(tmpdir(), 'realbud-resources-'));
  roots.push(resources);
  try {
    await symlink(STAGED_RUNTIME, join(resources, 'postgres'), 'dir');
  } catch {
    await mkdir(join(resources, 'postgres'), { recursive: true });
  }
  return resources;
}

async function admittedRuntime() {
  try {
    return await resolvePostgresRuntime();
  } catch {
    return null;
  }
}

const runtime = await admittedRuntime();
const describeProvisioning = runtime ? describe : describe.skip;

describeProvisioning('host provisioning without an environment override', () => {
  async function fixture() {
    // Prove the premise: no installer override is present for this test.
    vi.stubEnv('REALBUD_COMPANY_POSTGRES_BIN', '');
    const root = await mkdtemp(join(tmpdir(), 'realbud-provision-'));
    roots.push(root);
    const app = createCompanyInstallation({
      dataDirectory: root,
      previewEnabled: true,
      authorizeAdmin: req => (req.headers['x-test-admin'] ? { ok: true, expiresAt: Date.now() + 60_000 } : { ok: false, status: 401, error: 'Admin required' }),
      hasAdminSession: req => !!req.headers['x-test-admin'],
    });
    instances.push(app);
    return { app, root };
  }

  it('provisions owned storage from the admitted runtime and reports it available', async () => {
    const { app, root } = await fixture();
    const before = await app.handle('/api/company/status', 'GET', { headers: admin });
    expect(before.body).toMatchObject({ storageAvailable: false, configured: false, storageSetupAvailable: true });

    const setup = await app.handle('/api/company/setup', 'POST', { headers: admin }, {});
    expect(setup.status).toBe(200);

    const after = await app.handle('/api/company/status', 'GET', { headers: admin });
    expect(after.body).toMatchObject({ storageAvailable: true, transport: 'local-only' });

    // Storage really exists on disk, under the installation's private root.
    const owned = join(root, 'company-installation', 'postgres');
    const entries = await readdir(owned);
    expect(entries).toContain('ownership.json');
    const state = await lstat(owned);
    expect(state.isDirectory()).toBe(true);
    if (process.platform !== 'win32') expect(state.mode & 0o077).toBe(0);
  }, 120_000);

  it('provisions from the runtime the installer staged, not the build machine', async () => {
    const resources = await packagedResourcesFixture();
    if (!resources) return; // no staged runtime in this checkout
    // Point admission at the packaged layout. This is the real installed-app
    // path: a bundled runtime wins over anything on the build machine.
    vi.stubEnv('REALBUD_RESOURCES_DIR', resources);
    const admitted = await resolvePostgresRuntime();
    expect(admitted.source).toBe('bundled');
    expect(admitted.version).toMatch(/PostgreSQL\) 16\./);

    const { app, root } = await fixture();
    const setup = await app.handle('/api/company/setup', 'POST', { headers: admin }, {});
    expect(setup.status).toBe(200);
    expect((await app.handle('/api/company/status', 'GET', { headers: admin })).body)
      .toMatchObject({ storageAvailable: true });
    expect(await readdir(join(root, 'company-installation', 'postgres'))).toContain('ownership.json');
  }, 180_000);

  it('records which runtime source was admitted, without a terminal step', async () => {
    const { app } = await fixture();
    // The resolver is the only admission path in the installed app; a bundled
    // runtime wins, and a developer machine falls back to an installed one.
    expect(runtime && ['bundled', 'configured', 'system']).toContain(runtime!.source);
    expect(runtime!.version).toMatch(/PostgreSQL\) 16\./);
    expect((await app.handle('/api/company/setup', 'POST', { headers: admin }, {})).status).toBe(200);
  }, 120_000);
});
