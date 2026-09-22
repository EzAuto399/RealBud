import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createCompanyKernel, migrateCompanySchema, type CompanyKernel } from './index.ts';
import { companySchemaManifest } from './schema.ts';

const url = process.env.REALBUD_COMPANY_TEST_URL;
const password = 'Synthetic-member-password-2026';
describe.skipIf(!url)('durable independent member authentication', () => {
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
  async function office() {
    const created = await kernel.createCompany({ name: 'Synthetic sign-in office', ownerName: 'Alice' });
    const credentials = await kernel.enrollMemberCredential(created.sessionToken, { loginName: 'alice', password });
    return { ...created, ...credentials };
  }
  it('signs back into the same owner identity and private knowledge after logout', async () => {
    const owner = await office();
    await kernel.replaceKnowledge(owner.sessionToken, { scopeId: owner.privateScope.id, key: 'note', expectedRevision: '0', content: 'Private synthetic note' });
    await kernel.revokeSession(owner.sessionToken);
    const signedIn = await other.signInMember({ companyId: owner.companyId, loginName: 'ALICE', password });
    expect((await kernel.authenticateSession(signedIn.sessionToken)).memberId).toBe(owner.memberId);
    expect((await kernel.readKnowledge(signedIn.sessionToken, { scopeId: owner.privateScope.id, key: 'note' }))?.content).toBe('Private synthetic note');
    const row = (await admin.query('SELECT * FROM realbud_company.member_credentials WHERE company_id=$1', [owner.companyId])).rows[0];
    expect(row.password_verifier).not.toContain(password);
    expect(row.recovery_hash).not.toBe(owner.recoveryKey);
  });
  it('commits failed attempts across kernels and casing, then permits sign-in after the block expires', async () => {
    const owner = await office();
    for (let i = 0; i < 5; i++) await expect((i % 2 ? other : kernel).signInMember({ companyId: owner.companyId, loginName: i % 2 ? 'ALICE' : 'alice', password: 'Wrong-synthetic-password' })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(other.signInMember({ companyId: owner.companyId, loginName: 'alice', password })).rejects.toMatchObject({ code: 'unauthenticated' });
    const row = (await admin.query('SELECT failed_attempts, blocked_until>clock_timestamp() AS blocked FROM realbud_company.member_credentials WHERE company_id=$1', [owner.companyId])).rows[0];
    expect(row).toEqual({ failed_attempts: 5, blocked: true });
    await admin.query("UPDATE realbud_company.member_credentials SET blocked_until=clock_timestamp()-interval '1 second' WHERE company_id=$1", [owner.companyId]);
    await expect(other.signInMember({ companyId: owner.companyId, loginName: 'alice', password })).resolves.toHaveProperty('sessionToken');
  });
  it('allows exactly one concurrent recovery and revokes previous sessions without changing identity', async () => {
    const owner = await office();
    const input = { companyId: owner.companyId, loginName: 'alice', recoveryKey: owner.recoveryKey, newPassword: 'Changed-synthetic-password' };
    const results = await Promise.allSettled([kernel.recoverMember(input), other.recoverMember(input)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const successful = results.find(result => result.status === 'fulfilled')!;
    if (successful.status !== 'fulfilled') throw new Error('Expected a recovery');
    expect(successful.value.recoveryKey).not.toBe(owner.recoveryKey);
    expect((await kernel.authenticateSession(successful.value.sessionToken)).memberId).toBe(owner.memberId);
    await expect(kernel.authenticateSession(owner.sessionToken)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(kernel.recoverMember(input)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(other.signInMember({ companyId: owner.companyId, loginName: 'alice', password: input.newPassword })).resolves.toHaveProperty('sessionToken');
  });
  it('requires the current password for changes and retires other sessions and the old recovery key', async () => {
    const owner = await office();
    const second = await other.signInMember({ companyId: owner.companyId, loginName: 'alice', password });
    await expect(kernel.enrollMemberCredential(owner.sessionToken, { loginName: 'alice', password })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(kernel.enrollMemberCredential(owner.sessionToken, { loginName: 'alice', password, currentPassword: 'Wrong-synthetic-password' })).rejects.toMatchObject({ code: 'unauthenticated' });
    const changed = await kernel.enrollMemberCredential(owner.sessionToken, { loginName: 'alice.new', password: 'Changed-synthetic-password', currentPassword: password });
    expect(changed.recoveryKey).not.toBe(owner.recoveryKey);
    await expect(other.authenticateSession(second.sessionToken)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect((await kernel.authenticateSession(owner.sessionToken)).memberId).toBe(owner.memberId);
    await expect(kernel.signInMember({ companyId: owner.companyId, loginName: 'alice', password })).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  it('blocks password and recovery access after membership revocation, with no administrator impersonation route', async () => {
    const owner = await office();
    const invite = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Bob' });
    const bob = await kernel.redeemInvitation(invite.invitationToken);
    const credentials = await kernel.enrollMemberCredential(bob.sessionToken, { loginName: 'bob', password });
    await kernel.revokeMember(owner.sessionToken, bob.memberId);
    await expect(other.signInMember({ companyId: bob.companyId, loginName: 'bob', password })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(other.recoverMember({ companyId: bob.companyId, loginName: 'bob', recoveryKey: credentials.recoveryKey, newPassword: password })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(kernel.recoverOwnerSession({ companyId: owner.companyId, reason: 'I am service admin' })).rejects.toMatchObject({ code: 'owner_proof_required' });
  });
  it('checks the additive credential migration checksum while preserving the original migration', async () => {
    const before = await admin.query('SELECT id, checksum FROM realbud_company.schema_migrations ORDER BY id');
    expect(before.rows).toEqual(companySchemaManifest());
    await migrateCompanySchema(admin, { applicationRole: 'rb_company_test_app' });
    expect((await admin.query('SELECT id, checksum FROM realbud_company.schema_migrations ORDER BY id')).rows).toEqual(before.rows);
    await admin.query("UPDATE realbud_company.schema_migrations SET checksum='tampered' WHERE id='0002'");
    try { await expect(migrateCompanySchema(admin, { applicationRole: 'rb_company_test_app' })).rejects.toThrow('checksum mismatch'); }
    finally { await admin.query("UPDATE realbud_company.schema_migrations SET checksum=$1 WHERE id='0002'", [before.rows[1].checksum]); }
  });
});
