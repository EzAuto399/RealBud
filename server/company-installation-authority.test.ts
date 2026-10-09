import { afterEach, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privateTempRoot, removeFixture } from './testing/private-fixture.ts';
const state = vi.hoisted(() => ({ role: 'owner', revoked: false, adminActive: true, wait: null as null | Promise<void>, entered: () => {}, kernel: null as any, closes: 0 }));
vi.mock('pg', () => ({ Pool: class { on() {} async query() { return { rows: [] }; } async end() {} } }));
vi.mock('./company/host-runtime.ts', () => ({ openOwnedPostgres: async () => ({ applicationUrl: 'fictional', adminUrl: 'fictional', stop: async () => {} }) }));
vi.mock('./company/index.ts', async original => ({ ...await original<any>(), createCompanyKernel: () => state.kernel }));
vi.mock('./company-host.ts', async original => ({ ...await original<any>(), configuredCompanyKernel: () => ({ kernel: null, close: async () => {} }) }));
vi.mock('./company/host-transport.ts', async original => ({ ...await original<any>(), startCompanyTransport: async () => ({ port: 9443, close: async () => { state.closes++; } }) }));
vi.mock('./company/host-certificate.ts', async original => {
  const actual = await original<any>();
  return { ...actual, createHostCertificate: async (hostname: string) => {
    if (state.wait) { state.entered(); await state.wait; }
    return actual.createHostCertificate(hostname);
  } };
});
import { createCompanyInstallation } from './company-installation.ts';
import { CompanyError } from './company/index.ts';
const roots: string[] = [], apps: ReturnType<typeof createCompanyInstallation>[] = [];
afterEach(async () => {
  state.wait = null;
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) await removeFixture(root);
});
it.each(['demotion', 'revocation', 'admin-revocation'] as const)('refuses %s during certificate preparation without publishing or stranding the old network', async change => {
  state.role = 'owner'; state.revoked = false; state.adminActive = true; state.closes = 0;
  state.kernel = {
    getBootstrapState: async () => ({ companies: [{ companyId: '11111111-1111-4111-8111-111111111111', name: 'Fictional Office' }] }),
    authenticateSession: async () => {
      if (state.revoked) throw new CompanyError('unauthenticated');
      return { companyId: '11111111-1111-4111-8111-111111111111', memberId: '33333333-3333-4333-8333-333333333333', role: state.role };
    },
    withOwnerAuthority: async (_token: string, commit: () => Promise<unknown>) => {
      const actor = await state.kernel.authenticateSession();
      if (actor.role !== 'owner') throw new CompanyError('forbidden');
      return commit();
    },
  };
  const root = privateTempRoot(join(tmpdir(), 'rb-network-authority-')); roots.push(root);
  const app = createCompanyInstallation({ dataDirectory: root, binaryDirectory: '/fictional/no-runtime-execution', previewEnabled: true,
    authorizeAdmin: () => state.adminActive ? { ok: true, expiresAt: Date.now() + 60000 } : { ok: false, status: 401, error: 'Fictional local administration revoked' }, hasAdminSession: () => state.adminActive }); apps.push(app);
  const req = { headers: { 'x-realbud-member-session': 'a'.repeat(43) } };
  expect((await app.handle('/api/company/setup', 'POST', req, {})).status).toBe(200);
  expect((await app.handle('/api/company/network', 'POST', req, { hostname: '127.0.0.1' })).status).toBe(200);
  const before = await readFile(join(root, 'company-installation/host.json'), 'utf8');
  let release!: () => void, enter!: () => void;
  state.wait = new Promise<void>(done => { release = done; });
  const prepared = new Promise<void>(done => { enter = done; }); state.entered = enter;
  const renewal = app.handle('/api/company/network', 'POST', req, { hostname: '127.0.0.1', renewIdentity: true });
  await prepared;
  if (change === 'demotion') state.role = 'member';
  else if (change === 'revocation') state.revoked = true;
  else state.adminActive = false;
  release();
  const result = await renewal;
  if (change === 'admin-revocation') console.log(JSON.stringify({ authorityProbe: change, response: result.status,
    certificateChanged: (await readFile(join(root, 'company-installation/host.json'), 'utf8')) !== before, transportClosed: state.closes }));
  expect(result.status).toBe(change === 'demotion' ? 403 : 401);
  expect(await readFile(join(root, 'company-installation/host.json'), 'utf8')).toBe(before);
  expect(state.closes).toBe(0);
  // Both queues are released on refusal; a current owner can explicitly retry.
  state.role = 'owner'; state.revoked = false; state.adminActive = true; state.wait = null;
  expect((await app.handle('/api/company/network', 'POST', req, { hostname: '127.0.0.1', renewIdentity: true })).status).toBe(200);
  expect(await readFile(join(root, 'company-installation/host.json'), 'utf8')).not.toBe(before);
  expect(state.closes).toBe(1);
});
