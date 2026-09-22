import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
vi.mock('./company/host-transport.ts', () => ({ requestCompanyHost: vi.fn(), startCompanyTransport: vi.fn() }));
import { requestCompanyHost } from './company/host-transport.ts';
import { createHostCertificate, encodeCompanyPairing } from './company/host-certificate.ts';
import { createCompanyInstallation } from './company-installation.ts';
import { createPrivateVault } from './private-vault.ts';

const companyId = '11111111-1111-4111-8111-111111111111';
const otherCompanyId = '22222222-2222-4222-8222-222222222222';
const token = 'fixture_only_session_12345678901234567890123';
const response = (id = companyId, memberId = 'fixture-member-1') => ({ status: 200, body: {
  company: { id, name: 'Example Office' }, member: { id: memberId, displayName: 'Example Person', role: 'member' }, memberToken: token,
} });
let hostCode: string;
let otherHostCode: string;
const roots: string[] = [];
const instances: ReturnType<typeof createCompanyInstallation>[] = [];
beforeAll(async () => {
  const { cert } = await createHostCertificate('127.0.0.1');
  hostCode = encodeCompanyPairing({ version: 1, origin: 'https://127.0.0.1:9443', certificatePem: cert, companyId });
  otherHostCode = encodeCompanyPairing({ version: 1, origin: 'https://127.0.0.1:9443', certificatePem: cert, companyId: otherCompanyId });
});
afterEach(async () => {
  for (const app of instances.splice(0)) await app.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  vi.resetAllMocks(); vi.unstubAllEnvs();
});
async function fixture(paired = true) {
  vi.stubEnv('REALBUD_COMPANY_DATABASE_URL', '');
  const root = await mkdtemp(join(tmpdir(), 'realbud-binding-')); roots.push(root);
  await mkdir(join(root, 'company-installation'), { mode: 0o700 });
  if (paired) await writeFile(join(root, 'company-installation/peer.json'), JSON.stringify(hostCode), { mode: 0o600 });
  const onSeatIdentity = vi.fn();
  const app = createCompanyInstallation({ dataDirectory: root, previewEnabled: true, onSeatIdentity,
    authorizeAdmin: () => ({ ok: false, status: 401, error: 'Admin required' }), hasAdminSession: () => false,
  }); instances.push(app);
  return { app, root, onSeatIdentity };
}

describe('office identity before session adoption', () => {
  it.each(['create', 'join', 'sign-in', 'recover-member'])('rejects a different office on %s without returning a token or writing identity', async path => {
    const { app, root, onSeatIdentity } = await fixture();
    vi.mocked(requestCompanyHost).mockResolvedValue(response(otherCompanyId));
    const result = await app.handle(`/api/company/${path}`, 'POST', { headers: {} }, { loginName: 'fixture' });
    expect(result).toMatchObject({ status: 409, body: { code: 'host_identity_mismatch' } });
    expect(JSON.stringify(result)).not.toContain(token);
    await expect(readFile(join(root, 'company-installation/seat.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(onSeatIdentity).not.toHaveBeenCalled();
  });

  it('rejects a successful session without a company identity', async () => {
    const { app } = await fixture();
    vi.mocked(requestCompanyHost).mockResolvedValue({ status: 200, body: { member: response().body.member, memberToken: token } });
    expect(await app.handle('/api/company/sign-in', 'POST', { headers: {} }, { loginName: 'fixture' })).toMatchObject({ status: 409, body: { code: 'host_identity_mismatch' } });
    expect(await app.seatIdentity()).toBeNull();
  });

  it('adopts the matching office once and refuses a different person without replacing saved work identity', async () => {
    const { app, root, onSeatIdentity } = await fixture();
    vi.mocked(requestCompanyHost).mockResolvedValue(response());
    expect((await app.handle('/api/company/sign-in', 'POST', { headers: {} }, { loginName: 'fixture' })).status).toBe(200);
    const saved = await readFile(join(root, 'company-installation/seat.json'), 'utf8');
    expect(await app.seatIdentity()).toBe('fixture-member-1');
    await app.handle('/api/company/sign-in', 'POST', { headers: {} }, { loginName: 'fixture' });
    expect(onSeatIdentity).toHaveBeenCalledTimes(1);
    vi.mocked(requestCompanyHost).mockResolvedValue(response(companyId, 'fixture-member-2'));
    const result = await app.handle('/api/company/sign-in', 'POST', { headers: {} }, { loginName: 'fixture' });
    expect(result).toMatchObject({ status: 409, body: { code: 'seat_identity_conflict' } });
    expect(JSON.stringify(result)).not.toContain(token);
    expect(await readFile(join(root, 'company-installation/seat.json'), 'utf8')).toBe(saved);
  });

  it('does not adopt a member from an unauthenticated host connection check', async () => {
    const { app, onSeatIdentity } = await fixture(false);
    vi.mocked(requestCompanyHost).mockResolvedValue({ status: 200, body: { configured: true, ...response().body } });
    expect((await app.handle('/api/company/connect-host', 'POST', { headers: {} }, { hostCode })).status).toBe(200);
    expect(await app.seatIdentity()).toBeNull();
    expect(onSeatIdentity).not.toHaveBeenCalled();
  });
});

describe('durable membership recovery', () => {
  const credentials = { loginName: 'fixture', password: 'Synthetic-password' };
  async function reopen(root: string) {
    const app = createCompanyInstallation({ dataDirectory: root, previewEnabled: true,
      authorizeAdmin: () => ({ ok: false, status: 401, error: 'Admin required' }), hasAdminSession: () => false });
    instances.push(app); return app;
  }
  it('keeps an uncertain department update encrypted across restart and blocks departure until reconciled', async () => {
    const { app, root } = await fixture();
    const memberId = '33333333-3333-4333-8333-333333333333';
    vi.mocked(requestCompanyHost).mockResolvedValue(response(companyId, memberId));
    await app.handle('/api/company/sign-in', 'POST', { headers: {} }, credentials);
    const path = '/api/company/departments/cases/create';
    const input = { departmentId: '44444444-4444-4444-8444-444444444444', requestId: '55555555-5555-4555-8555-555555555555', title: 'Fictional department recovery', description: 'Private fictional case description', assigneeMemberId: memberId };
    const request = { headers: { 'x-realbud-member-session': token } };
    let committed = false, loseReply = true;
    vi.mocked(requestCompanyHost).mockImplementation(async args => {
      if (args.path === '/api/company/me') return response(companyId, memberId);
      if (args.path === path) {
        expect(args.body).toEqual(input);
        const replayed = committed; committed = true;
        if (loseReply) { loseReply = false; throw new Error('Fictional response lost after commit'); }
        return { status: 200, body: { item: { id: input.requestId }, receiptId: input.requestId, replayed } };
      }
      throw new Error('Unexpected remote operation');
    });
    expect((await app.handle(path, 'POST', request, input)).status).toBe(503);
    expect((await app.handle('/api/company/local-state', 'GET', request)).body).toMatchObject({ pendingDepartmentOperation: { requestId: input.requestId, phase: 'pending' } });
    const bytes = await readFile(join(root, 'company-installation/private/department-outbox.json'), 'utf8');
    expect(bytes).not.toContain(input.description); expect(bytes).not.toContain(token);
    for (const departurePath of ['/api/company/leave-office', '/api/company/disconnect-host', '/api/company/detach-offline']) {
      const body = departurePath.endsWith('detach-offline') ? { acknowledgeActiveSessions: true } : {};
      expect(await app.handle(departurePath, 'POST', request, body)).toMatchObject({ status: 409, body: { code: 'department_outbox_pending' } });
    }
    await app.close(); const restarted = await reopen(root);
    expect((await restarted.handle('/api/company/department-outbox', 'GET', request)).body).toMatchObject({ pending: { phase: 'pending', path, input } });
    expect((await restarted.handle(path, 'POST', request, input)).body).toMatchObject({ receiptId: input.requestId, replayed: true });
    expect((await restarted.handle('/api/company/department-outbox/ack', 'POST', request, { requestId: input.requestId })).status).toBe(200);
    expect((await restarted.handle('/api/company/local-state', 'GET', request)).body).toMatchObject({ pendingDepartmentOperation: null });
  });
  it('archives an unknown department result locally after access is lost without cancelling remote work', async () => {
    const { app, root } = await fixture();
    const memberId = '33333333-3333-4333-8333-333333333333';
    vi.mocked(requestCompanyHost).mockResolvedValue(response(companyId, memberId));
    await app.handle('/api/company/sign-in', 'POST', { headers: {} }, credentials);
    const request = { headers: { 'x-realbud-member-session': token } };
    const path = '/api/company/departments/lifecycle';
    const input = { departmentId: '44444444-4444-4444-8444-444444444444', requestId: '66666666-6666-4666-8666-666666666666', expectedRevision: '0', retired: true, note: 'Fictional reviewed retirement' };
    vi.mocked(requestCompanyHost).mockImplementation(async args => {
      if (args.path === '/api/company/me') return response(companyId, memberId);
      throw new Error('Fictional uncertain result');
    });
    expect((await app.handle(path, 'POST', request, input)).status).toBe(503);
    vi.mocked(requestCompanyHost).mockClear().mockResolvedValue({ status: 401, body: { error: 'Access removed' } });
    expect((await app.handle('/api/company/department-outbox/archive', 'POST', { headers: {} }, { requestId: input.requestId, acknowledgeUnknown: false })).status).toBe(409);
    expect((await app.handle('/api/company/department-outbox/archive', 'POST', { headers: {} }, { requestId: input.requestId, acknowledgeUnknown: true })).status).toBe(200);
    expect(requestCompanyHost).not.toHaveBeenCalled();
    expect((await app.handle('/api/company/department-outbox/archive/export', 'POST', { headers: {} }, { requestId: input.requestId })).body).toMatchObject({ record: { outcome: 'unknown', input } });
    expect((await createPrivateVault(root).read(`department-change-${input.requestId}`))).toMatchObject({ outcome: 'unknown', input });
    expect((await app.handle('/api/company/local-state', 'GET', request)).body).toMatchObject({ pendingDepartmentOperation: null });
  });
  it.each(['leave', 'replace-host', 'archive'] as const)('serializes %s with a department update already in flight', async action => {
    const { app, root } = await fixture();
    const memberId = '33333333-3333-4333-8333-333333333333';
    vi.mocked(requestCompanyHost).mockResolvedValue(response(companyId, memberId));
    await app.handle('/api/company/sign-in', 'POST', { headers: {} }, credentials);
    const path = '/api/company/departments/cases/create';
    const input = { departmentId: '44444444-4444-4444-8444-444444444444', requestId: '55555555-5555-4555-8555-555555555555', title: 'Fictional concurrent update', description: '', assigneeMemberId: null };
    const request = { headers: { 'x-realbud-member-session': token } };
    const { cert } = await createHostCertificate('127.0.0.1');
    const replacement = encodeCompanyPairing({ version: 1, origin: 'https://127.0.0.1:9555', certificatePem: cert, companyId });
    const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
    const entered = deferred(), release = deferred();
    vi.mocked(requestCompanyHost).mockImplementation(async args => {
      if (args.path === '/api/company/me') return response(companyId, memberId);
      if (args.path === path) {
        entered.resolve(); await release.promise;
        if (action !== 'archive') throw new Error('Fictional response lost after the office saved this change');
        return { status: 200, body: { item: { id: input.requestId }, receiptId: input.requestId, replayed: false } };
      }
      throw new Error('A concurrent local recovery action must not call another host operation');
    });
    const mutation = app.handle(path, 'POST', request, input);
    await entered.promise;
    let finished = false;
    const following = (action === 'leave'
      ? app.handle('/api/company/leave-office', 'POST', request, {})
      : action === 'replace-host'
        ? app.handle('/api/company/connect-host', 'POST', request, { hostCode: replacement, replaceExisting: true })
        : app.handle('/api/company/department-outbox/archive', 'POST', request, { requestId: input.requestId, acknowledgeUnknown: true })
    ).then(result => { finished = true; return result; });
    try {
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(finished).toBe(false);
      expect((await createPrivateVault(root).read('department-outbox'))).toMatchObject({ phase: 'pending' });
    } finally { release.resolve(); }
    expect((await mutation).status).toBe(action === 'archive' ? 200 : 503);
    const result = await following;
    if (action === 'archive') {
      expect(result.status).toBe(200);
      expect(await createPrivateVault(root).read(`department-change-${input.requestId}`)).toMatchObject({ outcome: 'saved', input });
      expect((await app.handle('/api/company/local-state', 'GET', request)).body).toMatchObject({ pendingDepartmentOperation: null });
    } else {
      expect(result).toMatchObject({ status: 409, body: { code: 'department_outbox_pending' } });
      expect(await createPrivateVault(root).read('departure')).toBeUndefined();
      expect(JSON.parse(await readFile(join(root, 'company-installation/peer.json'), 'utf8'))).toBe(hostCode);
    }
    expect(await app.seatIdentity()).toBe(memberId);
  });
  it('does not persist malformed enrollment and lets the original member recover after a rejected identity', async () => {
    const { app, root } = await fixture();
    expect((await app.handle('/api/company/sign-in', 'POST', { headers: {} }, {})).status).toBe(400);
    expect(requestCompanyHost).not.toHaveBeenCalled();
    await expect(readFile(join(root, 'company-installation/enrollment.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    vi.mocked(requestCompanyHost).mockResolvedValue(response());
    expect((await app.handle('/api/company/sign-in', 'POST', { headers: {} }, credentials)).status).toBe(200);
    vi.mocked(requestCompanyHost).mockResolvedValue(response(companyId, 'other-fixture-member'));
    expect((await app.handle('/api/company/sign-in', 'POST', { headers: {} }, { ...credentials, loginName: 'another' })).status).toBe(409);
    vi.mocked(requestCompanyHost).mockResolvedValue(response());
    expect((await app.handle('/api/company/sign-in', 'POST', { headers: {} }, credentials)).status).toBe(200);
  });
  it('recovers lost enrollment after restart by signing in, without replaying the invitation', async () => {
    const { app, root } = await fixture(); const identity = await app.workspaceIdentity();
    vi.mocked(requestCompanyHost).mockRejectedValueOnce(new Error('Response lost after membership committed'));
    expect((await app.handle('/api/company/join', 'POST', { headers: {} }, { invitationToken: 'one-use', credential: credentials })).status).toBe(503);
    const saved = await readFile(join(root, 'company-installation/enrollment.json'), 'utf8');
    expect(saved).toContain('fixture'); expect(saved).not.toContain(credentials.password); expect(saved).not.toContain('one-use');
    await app.close(); const restarted = await reopen(root);
    expect((await restarted.handle('/api/company/join', 'POST', { headers: {} }, { credential: credentials })).status).toBe(409);
    vi.mocked(requestCompanyHost).mockResolvedValue(response());
    expect((await restarted.handle('/api/company/sign-in', 'POST', { headers: {} }, credentials)).status).toBe(200);
    expect(await restarted.workspaceIdentity()).toEqual(identity);
    await expect(readFile(join(root, 'company-installation/enrollment.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('confirms a lost departure response after restart without trying to leave twice', async () => {
    const { app, root } = await fixture(); const identity = await app.workspaceIdentity();
    vi.mocked(requestCompanyHost).mockResolvedValue(response());
    await app.handle('/api/company/sign-in', 'POST', { headers: {} }, credentials);
    let completed = false; let leaveCalls = 0;
    vi.mocked(requestCompanyHost).mockImplementation(async args => {
      if (args.path === '/api/company/me') return response();
      if (args.path === '/api/company/membership/departure-status') return { status: 200, body: { completed } };
      if (args.path === '/api/company/membership/leave') { leaveCalls++; completed = true; throw new Error('Response lost'); }
      throw new Error('Unexpected request');
    });
    const request = { headers: { 'x-realbud-member-session': 'a'.repeat(43) } };
    expect((await app.handle('/api/company/leave-office', 'POST', request, {})).status).toBe(503);
    expect(await readFile(join(root, 'company-installation/private/departure.json'), 'utf8')).not.toContain('a'.repeat(43));
    await app.close(); const restarted = await reopen(root);
    expect((await restarted.handle('/api/company/local-state', 'GET', { headers: {} })).body).toMatchObject({ departure: 'leave' });
    expect((await restarted.handle('/api/company/leave-office', 'POST', { headers: {} }, {})).status).toBe(200);
    expect(leaveCalls).toBe(1); expect(await restarted.seatIdentity()).toBeNull(); expect(await restarted.workspaceIdentity()).toEqual(identity);
    await expect(readFile(join(root, 'company-installation/peer.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('detaches an unavailable remote host only with explicit unknown-outcome acknowledgement', async () => {
    const { app, root } = await fixture(); const identity = await app.workspaceIdentity();
    expect((await app.handle('/api/company/detach-offline', 'POST', { headers: {} }, {})).status).toBe(400);
    expect((await app.handle('/api/company/detach-offline', 'POST', { headers: {} }, { acknowledgeActiveSessions: true })).body).toMatchObject({ ok: true, remoteRevocationConfirmed: false });
    expect(requestCompanyHost).not.toHaveBeenCalled();
    expect(await app.workspaceIdentity()).toEqual(identity);
    await app.close(); const restarted = await reopen(root);
    expect((await restarted.handle('/api/company/status', 'GET', { headers: {} })).body).toMatchObject({ remoteJoinAvailable: true });
    const local = await restarted.handle('/api/company/local-state', 'GET', { headers: {} });
    expect(local).toMatchObject({ status: 200, body: { remoteHost: false, departure: null, offlineDetachments: { hasMore: false, records: [{ companyId, memberId: null, remoteRevocationConfirmed: false }] } } });
    const records = (local.body as { offlineDetachments: { records: Array<{ id: string }> } }).offlineDetachments.records;
    expect(records).toHaveLength(1);
    const encrypted = await readFile(join(root, `company-installation/private/offline-detachment-${records[0].id}.json`), 'utf8');
    expect(encrypted).not.toContain(companyId);
    expect(encrypted).not.toContain('remoteRevocationConfirmed');
    expect(JSON.stringify(local.body)).not.toMatch(/memberToken|operationToken|certificatePem|password/);
    expect(requestCompanyHost).not.toHaveBeenCalled();
  });
  it('preserves separate unknown-access receipts after joining and disconnecting from another office', async () => {
    const { app, root } = await fixture(); const identity = await app.workspaceIdentity();
    vi.mocked(requestCompanyHost).mockResolvedValue(response());
    expect((await app.handle('/api/company/sign-in', 'POST', { headers: {} }, credentials)).status).toBe(200);
    expect((await app.handle('/api/company/detach-offline', 'POST', { headers: {} }, { acknowledgeActiveSessions: true })).status).toBe(200);
    await app.close(); const restarted = await reopen(root);
    vi.mocked(requestCompanyHost).mockResolvedValue({ status: 200, body: { configured: true } });
    expect((await restarted.handle('/api/company/connect-host', 'POST', { headers: {} }, { hostCode: otherHostCode })).status).toBe(200);
    vi.mocked(requestCompanyHost).mockResolvedValue(response(otherCompanyId, 'fixture-member-2'));
    expect((await restarted.handle('/api/company/sign-in', 'POST', { headers: {} }, credentials)).status).toBe(200);
    vi.mocked(requestCompanyHost).mockClear();
    expect((await restarted.handle('/api/company/detach-offline', 'POST', { headers: {} }, { acknowledgeActiveSessions: true })).status).toBe(200);
    expect((await restarted.handle('/api/company/detach-offline', 'POST', { headers: {} }, { acknowledgeActiveSessions: true })).status).toBe(200);
    await restarted.close(); const reopened = await reopen(root);
    const local = (await reopened.handle('/api/company/local-state', 'GET', { headers: {} })).body as { offlineDetachments: { records: Array<{ id: string; companyId: string; memberId: string; remoteRevocationConfirmed: boolean }> } };
    expect(local.offlineDetachments.records).toHaveLength(2);
    expect(new Set(local.offlineDetachments.records.map(record => record.id)).size).toBe(2);
    expect(local.offlineDetachments.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ companyId, memberId: 'fixture-member-1', remoteRevocationConfirmed: false }),
      expect.objectContaining({ companyId: otherCompanyId, memberId: 'fixture-member-2', remoteRevocationConfirmed: false }),
    ]));
    expect(await reopened.workspaceIdentity()).toEqual(identity);
    expect(requestCompanyHost).not.toHaveBeenCalled();
  });
  it('keeps the previous single encrypted receipt readable alongside later disconnects', async () => {
    const { app, root } = await fixture();
    const vault = createPrivateVault(root);
    await vault.write('offline-detachment', { version: 1, companyId: otherCompanyId, memberId: 'legacy-member', detachedAt: '2026-09-19T09:00:00.000Z', remoteRevocationConfirmed: false });
    const legacy = await readFile(join(root, 'company-installation/private/offline-detachment.json'), 'utf8');
    expect((await app.handle('/api/company/detach-offline', 'POST', { headers: {} }, { acknowledgeActiveSessions: true })).status).toBe(200);
    await app.close(); const restarted = await reopen(root);
    const local = (await restarted.handle('/api/company/local-state', 'GET', { headers: {} })).body as { offlineDetachments: { records: unknown[] } };
    expect(local.offlineDetachments.records).toHaveLength(2);
    expect(local.offlineDetachments.records).toContainEqual({ version: 1, id: 'legacy', companyId: otherCompanyId, memberId: 'legacy-member', detachedAt: '2026-09-19T09:00:00.000Z', remoteRevocationConfirmed: false });
    expect(await readFile(join(root, 'company-installation/private/offline-detachment.json'), 'utf8')).toBe(legacy);
  });
  it('finishes an interrupted local disconnect from its journal without losing or duplicating its receipt', async () => {
    const { app, root } = await fixture(); await app.workspaceIdentity(); await app.close();
    const vault = createPrivateVault(root);
    const receipt = { version: 1, id: 'a'.repeat(32), companyId, memberId: null, detachedAt: '2026-09-21T09:00:00.000Z', remoteRevocationConfirmed: false };
    await vault.write('departure', { version: 1, action: 'disconnect', phase: 'pending', operationToken: 'b'.repeat(43), memberToken: '', offlineDetachment: receipt });
    const restarted = await reopen(root);
    expect((await restarted.handle('/api/company/local-state', 'GET', { headers: {} })).body).toMatchObject({ remoteHost: false, departure: null, offlineDetachments: { records: [receipt], hasMore: false } });
    expect(await vault.read(`offline-detachment-${receipt.id}`)).toEqual(receipt);
    await expect(readFile(join(root, 'company-installation/peer.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await restarted.handle('/api/company/detach-offline', 'POST', { headers: {} }, { acknowledgeActiveSessions: true })).status).toBe(200);
    expect((await vault.names('offline-detachment-')).names).toHaveLength(1);
    expect(requestCompanyHost).not.toHaveBeenCalled();
  });
  it('reports unreadable historical receipts without inventing a revoked-access result or removing them', async () => {
    const { app, root } = await fixture(); await app.workspaceIdentity();
    const vault = createPrivateVault(root);
    await vault.write('offline-detachment', { version: 1, companyId, remoteRevocationConfirmed: true });
    const before = await readFile(join(root, 'company-installation/private/offline-detachment.json'), 'utf8');
    expect((await app.handle('/api/company/local-state', 'GET', { headers: {} })).status).toBe(503);
    expect(await readFile(join(root, 'company-installation/private/offline-detachment.json'), 'utf8')).toBe(before);
    expect(requestCompanyHost).not.toHaveBeenCalled();
  });
  it('re-pairs only the same office explicitly and preserves private and member identities', async () => {
    const { app, root } = await fixture();
    vi.mocked(requestCompanyHost).mockResolvedValue(response()); await app.handle('/api/company/sign-in', 'POST', { headers: {} }, credentials);
    const identity = await app.workspaceIdentity();
    const { cert } = await createHostCertificate('127.0.0.1');
    const newCode = encodeCompanyPairing({ version: 1, origin: 'https://127.0.0.1:9555', certificatePem: cert, companyId });
    const wrongCode = encodeCompanyPairing({ version: 1, origin: 'https://127.0.0.1:9555', certificatePem: cert, companyId: otherCompanyId });
    expect((await app.handle('/api/company/connect-host', 'POST', { headers: {} }, { hostCode: newCode })).status).toBe(409);
    expect((await app.handle('/api/company/connect-host', 'POST', { headers: {} }, { hostCode: wrongCode, replaceExisting: true })).body).toMatchObject({ code: 'host_identity_mismatch' });
    vi.mocked(requestCompanyHost).mockResolvedValue({ status: 200, body: { configured: true } });
    expect((await app.handle('/api/company/connect-host', 'POST', { headers: {} }, { hostCode: newCode, replaceExisting: true })).status).toBe(200);
    expect(JSON.parse(await readFile(join(root, 'company-installation/peer.json'), 'utf8'))).toBe(newCode);
    expect(await app.seatIdentity()).toBe('fixture-member-1'); expect(await app.workspaceIdentity()).toEqual(identity);
  });
});
