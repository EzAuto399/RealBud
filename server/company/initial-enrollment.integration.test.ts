import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createCompanyKernel, migrateCompanySchema, type CompanyKernel } from './index.ts';

const url = process.env.REALBUD_COMPANY_TEST_URL;
const password = 'Synthetic-member-password-2026';
const malformed = { loginName: 'alice' };

describe.skipIf(!url)('atomic initial enrollment', () => {
  let admin: Pool;
  let pool: Pool;
  let otherPool: Pool;
  let kernel: CompanyKernel;
  let other: CompanyKernel;
  beforeAll(async () => {
    const target = new URL(url!);
    if (!/^\/realbud_company_test_[a-z0-9_]+$/.test(target.pathname)) throw new Error('Explicit disposable company database required');
    admin = new Pool({ connectionString: target.toString() });
    await migrateCompanySchema(admin, { applicationRole: 'rb_company_test_app' });
    target.username = 'rb_company_test_app';
    pool = new Pool({ connectionString: target.toString(), max: 4 });
    otherPool = new Pool({ connectionString: target.toString(), max: 2 });
    kernel = createCompanyKernel(pool); other = createCompanyKernel(otherPool);
  });
  afterAll(async () => { await Promise.all([pool?.end(), otherPool?.end(), admin?.end()]); });
  async function companies() {
    return (await admin.query('SELECT count(*)::int AS n FROM realbud_company.companies')).rows[0].n as number;
  }
  async function footprint(companyId: string) {
    const { rows: [row] } = await admin.query(
      `SELECT (SELECT count(*)::int FROM realbud_company.members WHERE company_id=$1) AS members,
              (SELECT count(*)::int FROM realbud_company.scopes WHERE company_id=$1) AS scopes,
              (SELECT count(*)::int FROM realbud_company.sessions WHERE company_id=$1) AS sessions`,
      [companyId],
    );
    return row as { members: number; scopes: number; sessions: number };
  }
  async function openInvites(companyId: string) {
    return (await admin.query('SELECT count(*)::int AS n FROM realbud_company.invitations WHERE company_id=$1 AND redeemed_at IS NULL', [companyId])).rows[0].n as number;
  }

  it('lets an owner credential sign in from another kernel after the founding session is revoked', async () => {
    const created = await kernel.createCompany({ name: 'Synthetic owner office', ownerName: 'Alice', credential: { loginName: 'alice', password } });
    expect(typeof created.recoveryKey).toBe('string');
    await kernel.revokeSession(created.sessionToken);
    const signedIn = await other.signInMember({ companyId: created.companyId, loginName: 'ALICE', password });
    expect((await kernel.authenticateSession(signedIn.sessionToken)).memberId).toBe(created.memberId);
  });

  it('lets a joining member sign in and recover the same identity', async () => {
    const owner = await kernel.createCompany({ name: 'Synthetic join office', ownerName: 'Alice', credential: { loginName: 'owner', password } });
    const invite = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Bob' });
    const bob = await kernel.redeemInvitation(invite.invitationToken, { loginName: 'bob', password });
    if (!bob.recoveryKey) throw new Error('Joining must return the personal recovery key');
    await kernel.revokeSession(bob.sessionToken);
    const signedIn = await other.signInMember({ companyId: owner.companyId, loginName: 'BOB', password });
    expect((await kernel.authenticateSession(signedIn.sessionToken)).memberId).toBe(bob.memberId);
    const recovered = await other.recoverMember({ companyId: owner.companyId, loginName: 'bob', recoveryKey: bob.recoveryKey, newPassword: 'Changed-synthetic-password' });
    expect((await kernel.authenticateSession(recovered.sessionToken)).memberId).toBe(bob.memberId);
  });

  it('rejects malformed credentials without creating a company or consuming an invitation', async () => {
    const before = await companies();
    await expect(kernel.createCompany({ name: 'Rejected office', ownerName: 'Alice', credential: malformed })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await companies()).toBe(before);
    const owner = await kernel.createCompany({ name: 'Invitation office', ownerName: 'Alice' });
    const invite = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Bob' });
    const rows = await footprint(owner.companyId);
    await expect(kernel.redeemInvitation(invite.invitationToken, malformed)).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await footprint(owner.companyId)).toEqual(rows);
    expect(await openInvites(owner.companyId)).toBe(1);
  });

  it('rejects a case-insensitive duplicate username on join without extra durable rows', async () => {
    const owner = await kernel.createCompany({ name: 'Duplicate office', ownerName: 'Alice', credential: { loginName: 'alice', password } });
    const invite = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Bob' });
    const before = await footprint(owner.companyId);
    await expect(kernel.redeemInvitation(invite.invitationToken, { loginName: 'ALICE', password })).rejects.toMatchObject({ code: 'conflict' });
    expect(await footprint(owner.companyId)).toEqual(before);
    expect(await openInvites(owner.companyId)).toBe(1);
  });

  it('allows only one concurrent join for the same username and keeps the other invitation usable', async () => {
    const owner = await kernel.createCompany({ name: 'Race office', ownerName: 'Alice', credential: { loginName: 'owner', password } });
    const first = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Bob' });
    const second = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Carol' });
    const before = await footprint(owner.companyId);
    const results = await Promise.allSettled([
      kernel.redeemInvitation(first.invitationToken, { loginName: 'shared', password }),
      other.redeemInvitation(second.invitationToken, { loginName: 'shared', password }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected?.status !== 'rejected') throw new Error('Expected a conflict');
    expect(rejected.reason).toMatchObject({ code: 'conflict' });
    expect(await footprint(owner.companyId)).toEqual({ members: before.members + 1, scopes: before.scopes + 1, sessions: before.sessions + 1 });
    expect(await openInvites(owner.companyId)).toBe(1);
    const loser = results[0].status === 'rejected' ? first : second;
    const joined = await kernel.redeemInvitation(loser.invitationToken, { loginName: 'unique-join', password });
    expect((await kernel.authenticateSession(joined.sessionToken)).memberId).toBe(joined.memberId);
    expect(await openInvites(owner.companyId)).toBe(0);
  });
});
