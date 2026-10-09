import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createCompanyKernel, migrateCompanySchema, type CompanyKernel } from './index.ts';
import { createCompanyHost } from '../company-host.ts';

const url = process.env.REALBUD_COMPANY_TEST_URL;
describe.skipIf(!url)('host identity and current owner commit authority', () => {
  let cluster: Pool, admin: Pool, pool: Pool, otherPool: Pool;
  let kernel: CompanyKernel, other: CompanyKernel;
  let database: string, owner: Awaited<ReturnType<CompanyKernel['createCompany']>>;
  let host: ReturnType<typeof createCompanyHost>;
  const password = 'Synthetic-owner-password-2026';
  const foreign = '11111111-1111-4111-8111-111111111111';
  beforeAll(() => {
    const target = new URL(url!);
    if (!/^\/realbud_company_test_[a-z0-9_]+$/.test(target.pathname)) throw new Error('Explicit disposable company database required');
    cluster = new Pool({ connectionString: target.toString() });
  });
  beforeEach(async () => {
    database = 'realbud_company_test_authority_' + randomUUID().replaceAll('-', '');
    await cluster.query('CREATE DATABASE ' + database + " WITH TEMPLATE template0 ENCODING 'UTF8'");
    const target = new URL(url!); target.pathname = '/' + database;
    admin = new Pool({ connectionString: target.toString() });
    await migrateCompanySchema(admin, { applicationRole: 'rb_company_test_app' });
    target.username = 'rb_company_test_app';
    pool = new Pool({ connectionString: target.toString(), max: 4 });
    otherPool = new Pool({ connectionString: target.toString(), max: 2, application_name: 'rb-foundation-second' });
    kernel = createCompanyKernel(pool); other = createCompanyKernel(otherPool);
    owner = await kernel.createCompany({ name: 'Fictional authority office', ownerName: 'Fictional owner', singleHost: true, credential: { loginName: 'fixture-owner', password } });
    host = createCompanyHost({ kernel, authorizeAdmin: () => ({ ok: false, status: 401, error: 'No service authority' }), hasAdminSession: () => false });
  });
  afterEach(async () => {
    await Promise.all([pool?.end(), otherPool?.end(), admin?.end()]);
    if (database) await cluster.query('DROP DATABASE ' + database);
  });
  afterAll(async () => { await cluster?.end(); });
  const request = (companyId: string) => ({ headers: { 'x-realbud-company-id': companyId } });
  async function state() {
    return {
      members: (await admin.query('SELECT id,role,active FROM realbud_company.members ORDER BY id')).rows,
      invitations: (await admin.query('SELECT id,redeemed_at,revoked_at FROM realbud_company.invitations ORDER BY id')).rows,
      credentials: (await admin.query('SELECT member_id,revision,password_verifier,recovery_hash,failed_attempts FROM realbud_company.member_credentials ORDER BY member_id')).rows,
      sessions: (await admin.query('SELECT id,revoked_at FROM realbud_company.sessions ORDER BY id')).rows,
    };
  }
  it.each(['join', 'sign-in', 'recover-member'] as const)('rejects wrong expected company before any %s database effect', async path => {
    const invitation = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Fictional invited member' });
    const before = await state();
    const body = path === 'join' ? { invitationToken: invitation.invitationToken, credential: { loginName: 'fixture-member', password } }
      : path === 'sign-in' ? { loginName: 'fixture-owner', password }
      : { loginName: 'fixture-owner', recoveryKey: owner.recoveryKey, newPassword: 'Synthetic-new-password-2026' };
    expect(await host.handle('/api/company/' + path, 'POST', request(foreign), body)).toMatchObject({ status: 409, body: { code: 'host_identity_mismatch' } });
    expect(await state()).toEqual(before);
  });
  it('admits an older member that names no office (compatibility window) and exact matching join/sign-in/recovery', async () => {
    const invitation = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Fictional invited member' });
    const body = { invitationToken: invitation.invitationToken, credential: { loginName: 'fixture-member', password } };
    const older = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Fictional older member' });
    expect((await host.handle('/api/company/join', 'POST', { headers: {} }, { invitationToken: older.invitationToken, credential: { loginName: 'fixture-older', password } })).status).toBe(201);
    const joined = await host.handle('/api/company/join', 'POST', request(owner.companyId), body);
    expect(joined.status).toBe(201);
    const key = (joined.body as { recoveryKey: string }).recoveryKey;
    expect((await host.handle('/api/company/sign-in', 'POST', request(owner.companyId), { loginName: 'fixture-member', password })).status).toBe(200);
    expect((await host.handle('/api/company/recover-member', 'POST', request(owner.companyId), { loginName: 'fixture-member', recoveryKey: key, newPassword: 'Synthetic-new-password-2026' })).status).toBe(200);
  });
  async function blockCommit() {
    let release!: () => void, enter!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    let committed = false;
    const writing = kernel.withOwnerAuthority(owner.sessionToken, async () => { enter(); await wait; committed = true; });
    await entered;
    return { release, writing, committed: () => committed };
  }
  async function waitingOnLock() {
    await vi.waitFor(async () => {
      const result = await admin.query("SELECT 1 FROM pg_stat_activity WHERE datname=$1 AND application_name='rb-foundation-second' AND wait_event_type='Lock'", [database]);
      expect(result.rowCount).toBeGreaterThan(0);
    });
  }
  it('holds ownership transfer through the complete local commit, then refuses the former owner', async () => {
    const invitation = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Fictional next owner' });
    const member = await kernel.redeemInvitation(invitation.invitationToken, { loginName: 'fixture-next', password });
    const offer = await kernel.offerOwnership(owner.sessionToken, member.memberId);
    const held = await blockCommit(); let finished = false;
    const transfer = other.acceptOwnership(member.sessionToken, offer.id).then(() => { finished = true; });
    try { await waitingOnLock(); expect(finished).toBe(false); expect(held.committed()).toBe(false); } finally { held.release(); }
    await held.writing; await transfer;
    expect(held.committed()).toBe(true);
    await expect(kernel.withOwnerAuthority(owner.sessionToken, async () => {})).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('holds session revocation through the commit, then refuses the revoked owner credential', async () => {
    const held = await blockCommit(); let finished = false;
    const revoking = other.revokeSession(owner.sessionToken).then(() => { finished = true; });
    try { await waitingOnLock(); expect(finished).toBe(false); } finally { held.release(); }
    await held.writing; await revoking;
    await expect(kernel.withOwnerAuthority(owner.sessionToken, async () => {})).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  it('releases every owner lease lock after a failed local commit', async () => {
    await expect(kernel.withOwnerAuthority(owner.sessionToken, async () => { throw new Error('Fictional write failure'); })).rejects.toThrow('Fictional write failure');
    let committed = false;
    await other.withOwnerAuthority(owner.sessionToken, async () => { committed = true; });
    expect(committed).toBe(true);
  });
});
