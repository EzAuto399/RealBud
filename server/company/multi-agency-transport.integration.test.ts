import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanyHost } from '../company-host.ts';
import { createCompanyKernel } from './index.ts';
import { createHostCertificate } from './host-certificate.ts';
import { requestCompanyHost, startCompanyTransport } from './host-transport.ts';
import { startCompanyPostgresFixture } from './testing-postgres.ts';

// These are separate host databases and TLS identities, not mocked tenant headers.
// The fixture application roles have neither superuser nor RLS-bypass privileges.
describe.runIf(process.env.REALBUD_TEST_POSTGRES === '1')('independent agency authority over real PostgreSQL and pinned TLS', () => {
  const fixtures: Awaited<ReturnType<typeof startCompanyPostgresFixture>>[] = [];
  const transports: Awaited<ReturnType<typeof startCompanyTransport>>[] = [];
  let output: string;
  let alpha: Awaited<ReturnType<typeof agency>>;
  let beta: Awaited<ReturnType<typeof agency>>;

  async function agency(name: string) {
    const fixture = await startCompanyPostgresFixture({ outputDirectory: join(output, name), postgresBinDirectory: process.env.REALBUD_TEST_POSTGRES_BIN });
    fixtures.push(fixture);
    const kernel = createCompanyKernel(fixture.pool);
    const password = `Synthetic-${name}-member-password-2026`;
    const owner = await kernel.createCompany({ name: `Fictional ${name}`, ownerName: 'Practice owner', singleHost: true,
      credential: { loginName: 'owner', password: `Synthetic-${name}-owner-password-2026` } });
    const invitation = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Practice accountant' });
    const member = await kernel.redeemInvitation(invitation.invitationToken, { loginName: 'accountant', password });
    const department = await kernel.createDepartment(owner.sessionToken, { requestId: randomUUID(), name: 'Accounts' });
    await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, access: 'write', expectedRevision: '0' });
    await kernel.replaceKnowledge(member.sessionToken, { scopeId: department.id, key: 'record', expectedRevision: '0', content: `Synthetic ${name} record` });
    const host = createCompanyHost({ kernel,
      authorizeAdmin: request => request.headers['x-test-admin'] === 'fixture-admin' ? { ok: true, expiresAt: Date.now() + 60_000 } : { ok: false, status: 401, error: 'No admin' },
      hasAdminSession: request => request.headers['x-test-admin'] === 'fixture-admin' });
    const certificate = await createHostCertificate('localhost');
    const transport = await startCompanyTransport({ ...certificate, host: '127.0.0.1', port: 0, handle: host.handle });
    transports.push(transport);
    const call = (path: string, token: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => requestCompanyHost({
      origin: `https://localhost:${transport.port}`, certificatePem: certificate.cert, path: `/api/company/${path}`, method, memberToken: token, body,
    });
    return { fixture, kernel, owner, member, department, password, certificate, transport, call };
  }

  beforeAll(async () => {
    output = await mkdtemp(join(tmpdir(), 'rb-agencies-'));
    alpha = await agency('Alpha');
    beta = await agency('Beta');
  }, 60_000);
  afterAll(async () => {
    try { await Promise.all(transports.map(transport => transport.close())); }
    finally {
      try { await Promise.all(fixtures.map(fixture => fixture.stop())); }
      finally { if (output) await rm(output, { recursive: true, force: true }); }
    }
  });

  it('binds credentials, invitations, records and department permissions to the selected office', async () => {
    expect(alpha.owner.companyId).not.toBe(beta.owner.companyId);
    for (const [own, foreign] of [[alpha, beta], [beta, alpha]]) {
      const publicStatus = await own.call('status', '');
      expect(publicStatus.status).toBe(200);
      expect(publicStatus.body).not.toHaveProperty('company');
      expect(publicStatus.body).not.toHaveProperty('member');
      expect((await own.call('me', foreign.member.sessionToken)).status).toBe(401);
      expect((await own.call('sign-in', '', { loginName: 'accountant', password: foreign.password })).status).toBe(401);
      expect((await own.call('recover-member', '', { loginName: 'accountant', recoveryKey: foreign.member.recoveryKey, newPassword: 'Changed-synthetic-password-2026' })).status).toBe(401);
      expect((await own.call('sign-in', '', { loginName: 'accountant', password: own.password })).body).toMatchObject({ company: { id: own.owner.companyId }, member: { id: own.member.memberId } });
      expect((await own.call('knowledge/read', own.member.sessionToken, { scopeId: foreign.department.id, key: 'record' })).status).toBe(404);
      expect((await own.call('departments/access', own.owner.sessionToken, { departmentId: own.department.id, memberId: foreign.member.memberId, access: 'write', expectedRevision: '1' }, 'PUT')).status).toBe(404);
      expect((await own.call('departments/access', foreign.owner.sessionToken, { departmentId: own.department.id })).status).toBe(401);
      const listing = await own.call('departments/list', own.member.sessionToken, {});
      expect(listing.body).toMatchObject({ canManage: false, departments: [{ id: own.department.id, name: 'Accounts', access: 'write' }] });
      expect(JSON.stringify(listing.body)).not.toContain(foreign.department.id);
      expect((await own.call('knowledge/read', own.member.sessionToken, { scopeId: own.department.id, key: 'record' })).body).toMatchObject({ knowledge: { content: expect.stringContaining('Synthetic') } });
    }
    const invitation = await alpha.kernel.issueInvitation(alpha.owner.sessionToken, { displayName: 'New practice member' });
    const joinInput = { invitationToken: invitation.invitationToken, credential: { loginName: 'new-member', password: 'Synthetic-new-member-password' } };
    expect((await beta.call('join', '', joinInput)).status).toBe(401);
    expect((await alpha.call('join', '', joinInput)).body).toMatchObject({ company: { id: alpha.owner.companyId }, member: { displayName: 'New practice member' } });
    expect((await alpha.call('join', '', joinInput)).status).toBe(401);
  });

  it('keeps LAN callers outside service administration, device enrollment and agent execution', async () => {
    await expect(requestCompanyHost({ origin: `https://localhost:${alpha.transport.port}`, certificatePem: beta.certificate.cert, path: '/api/company/me', method: 'GET', memberToken: alpha.owner.sessionToken })).rejects.toThrow();
    // Use raw HTTPS to exercise server admission independently of client allowlisting.
    const raw = (path: string, method = 'POST', token = alpha.owner.sessionToken): Promise<{ status: number; body: unknown }> => new Promise((resolve, reject) => {
      const request = https.request({ hostname: 'localhost', port: alpha.transport.port, path, method, ca: alpha.certificate.cert, rejectUnauthorized: true, agent: false,
        headers: { 'content-type': 'application/json', 'x-realbud-member-session': token, 'x-test-admin': 'fixture-admin', authorization: 'Bearer fixture-admin', cookie: 'fixture-admin=true' } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
      });
      request.setTimeout(5_000, () => request.destroy(new Error('Synthetic request timed out')));
      request.on('error', reject);
      request.end(method === 'GET' ? undefined : '{}');
    });
    for (const path of ['/api/company/create', '/api/company/recover-owner', '/api/company/devices/enroll', '/api/company/workers/run', '/api/agent/chat', '/api/service-admin/login']) {
      expect((await raw(path)).status).toBe(404);
    }
    expect((await raw('/api/company/me', 'GET', '')).status).toBe(401);
    expect((await alpha.call('departments', alpha.member.sessionToken, { requestId: randomUUID(), name: 'Denied', companyId: beta.owner.companyId })).status).toBe(400);
    expect((await alpha.call('status', alpha.owner.sessionToken)).body).toMatchObject({ ownerRecoveryAllowed: false,
      limitations: expect.arrayContaining([expect.stringContaining('enrolled-device checks')]) });
  });

  it('revokes every member session and recovery route while holding uncertain work and preserving the other office', async () => {
    const signedIn = await alpha.call('sign-in', '', { loginName: 'accountant', password: alpha.password });
    const secondToken = (signedIn.body as { memberToken: string }).memberToken;
    const work = await alpha.kernel.createCase(alpha.owner.sessionToken, { scopeId: alpha.department.id, title: 'Synthetic uncertain work' });
    const claim = await alpha.kernel.claimCase(alpha.member.sessionToken, { caseId: work.caseId, ttlMs: 30_000 });
    expect((await alpha.call('members/revoke', alpha.owner.sessionToken, { memberId: alpha.member.memberId })).status).toBe(200);
    for (const token of [alpha.member.sessionToken, secondToken]) {
      expect((await alpha.call('me', token)).status).toBe(401);
      expect((await alpha.call('departments/list', token, {})).status).toBe(401);
      expect((await alpha.call('cases/settle', token, { caseId: claim.caseId, fence: claim.fence, claimToken: claim.claimToken, outcome: 'done' })).status).toBe(401);
    }
    expect((await alpha.call('sign-in', '', { loginName: 'accountant', password: alpha.password })).status).toBe(401);
    expect((await alpha.call('recover-member', '', { loginName: 'accountant', recoveryKey: alpha.member.recoveryKey, newPassword: 'Changed-synthetic-password-2026' })).status).toBe(401);
    expect((await alpha.call('cases/claim', alpha.owner.sessionToken, { caseId: work.caseId, ttlMs: 30_000 })).body).toMatchObject({ code: 'recovery_required' });
    expect((await beta.call('me', beta.member.sessionToken)).body).toMatchObject({ company: { id: beta.owner.companyId }, member: { id: beta.member.memberId } });
    expect((await beta.call('knowledge/read', beta.member.sessionToken, { scopeId: beta.department.id, key: 'record' })).body).toMatchObject({ knowledge: { content: 'Synthetic Beta record' } });
  });
});
