import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createCompanyKernel, migrateCompanySchema, type CompanyKernel } from './index.ts';

const connectionString = process.env.REALBUD_COMPANY_TEST_URL;
// This suite must use an explicitly supplied disposable database. It never discovers
// operator DATABASE_URL settings and never touches a default/company database.
describe.skipIf(!connectionString)('company kernel on real PostgreSQL', () => {
  let admin: Pool;
  let app: Pool;
  let otherPool: Pool;
  let kernel: CompanyKernel;
  let other: CompanyKernel;

  beforeAll(async () => {
    if (!connectionString) throw new Error('REALBUD_COMPANY_TEST_URL required');
    const url = new URL(connectionString);
    if (!/^\/realbud_company_test_[a-z0-9_]+$/.test(url.pathname)) throw new Error('Refusing a non-disposable database name');
    admin = new Pool({ connectionString });
    const actual = await admin.query('SELECT current_database() AS name');
    if (!String(actual.rows[0].name).startsWith('realbud_company_test_')) throw new Error('Refusing non-test database');
    await admin.query("DO $$ BEGIN CREATE ROLE rb_company_test_app LOGIN NOSUPERUSER NOBYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$");
    await migrateCompanySchema(admin, { applicationRole: 'rb_company_test_app' });
    url.username = 'rb_company_test_app';
    app = new Pool({ connectionString: url.toString(), max: 4 });
    otherPool = new Pool({ connectionString: url.toString(), max: 2 });
    kernel = createCompanyKernel(app);
    other = createCompanyKernel(otherPool);
  });

  beforeEach(async () => { await admin.query('TRUNCATE realbud_company.companies CASCADE'); });
  afterAll(async () => { await Promise.all([app?.end(), otherPool?.end(), admin?.end()]); });

  async function office() {
    const owner = await kernel.createCompany({ name: 'Synthetic Office', ownerName: 'Owner' });
    const invitation = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Member' });
    const member = await other.redeemInvitation(invitation.invitationToken);
    return { owner, member };
  }
  async function team() {
    const people = await office();
    const scope = await kernel.createScope(people.owner.sessionToken, { kind: 'team', name: 'Accounts' });
    const granted = await kernel.setScopeGrant(people.owner.sessionToken, { scopeId: scope.id, memberId: people.member.memberId, permissions: ['write'], expectedRevision: '0' });
    return { ...people, scope: granted };
  }

  it('refuses superuser runtime credentials and checks migration checksums', async () => {
    await expect(createCompanyKernel(admin).getBootstrapState()).rejects.toMatchObject({ code: 'unsafe_database_role' });
    await Promise.all([
      migrateCompanySchema(admin, { applicationRole: 'rb_company_test_app' }),
      migrateCompanySchema(admin, { applicationRole: 'rb_company_test_app' }),
    ]);
    const saved = await admin.query("SELECT checksum FROM realbud_company.schema_migrations WHERE id='0001'");
    await admin.query("UPDATE realbud_company.schema_migrations SET checksum='tampered' WHERE id='0001'");
    await expect(migrateCompanySchema(admin, { applicationRole: 'rb_company_test_app' })).rejects.toThrow('checksum mismatch');
    await admin.query("UPDATE realbud_company.schema_migrations SET checksum=$1 WHERE id='0001'", [saved.rows[0].checksum]);
  });

  it('serializes single-host bootstrap and persists the resulting office', async () => {
    const results = await Promise.allSettled([
      kernel.createCompany({ name: 'First', ownerName: 'Owner', singleHost: true }),
      other.createCompany({ name: 'Second', ownerName: 'Owner', singleHost: true }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const state = await other.getBootstrapState();
    expect(state.created).toBe(true);
    expect(state.companies).toHaveLength(1);
  });

  it('stores only token hashes and redeems one invitation exactly once across pools', async () => {
    const owner = await kernel.createCompany({ name: 'Company', ownerName: 'Owner' });
    const invitation = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Invitee' });
    const stored = await admin.query('SELECT token_hash FROM realbud_company.invitations');
    expect(stored.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0].token_hash).not.toBe(invitation.invitationToken);
    const results = await Promise.allSettled([kernel.redeemInvitation(invitation.invitationToken), other.redeemInvitation(invitation.invitationToken)]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    expect(fulfilled).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    const joined = fulfilled[0]!.value;
    const actor = await other.authenticateSession(joined.sessionToken);
    expect(actor.memberId).toBe(joined.memberId);
    expect(actor.role).toBe('member');
    const sessions = await admin.query('SELECT token_hash FROM realbud_company.sessions');
    expect(sessions.rows.every(r => /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(true);
    expect(sessions.rows.some(r => [owner.sessionToken, joined.sessionToken].includes(r.token_hash))).toBe(false);
  });

  it('rejects expired/revoked invitations and revoked/expired sessions', async () => {
    const { owner, member } = await office();
    const expired = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Expired' });
    await admin.query("UPDATE realbud_company.invitations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [expired.invitationId]);
    await expect(other.redeemInvitation(expired.invitationToken)).rejects.toMatchObject({ code: 'unauthenticated' });
    const revoked = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Revoked' });
    await kernel.revokeInvitation(owner.sessionToken, revoked.invitationId);
    await expect(other.redeemInvitation(revoked.invitationToken)).rejects.toMatchObject({ code: 'unauthenticated' });
    await other.revokeSession(member.sessionToken);
    await expect(kernel.authenticateSession(member.sessionToken)).rejects.toMatchObject({ code: 'unauthenticated' });
    await admin.query("UPDATE realbud_company.sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [owner.sessionId]);
    await expect(kernel.authenticateSession(owner.sessionToken)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('holds owner recovery without owner proof, preserving sessions and private confidentiality', async () => {
    const { owner, member } = await office();
    await kernel.replaceKnowledge(owner.sessionToken, { scopeId: owner.privateScope.id, key: 'private', expectedRevision: '0', content: 'Private synthetic note' });
    const before = await admin.query('SELECT id,token_hash,revoked_at FROM realbud_company.sessions ORDER BY id');
    await expect(kernel.recoverOwnerSession({ companyId: owner.companyId, reason: 'Synthetic host-admin recovery' })).rejects.toMatchObject({ code: 'owner_proof_required' });
    const after = await admin.query('SELECT id,token_hash,revoked_at FROM realbud_company.sessions ORDER BY id');
    expect(after.rows).toEqual(before.rows);
    expect((await other.authenticateSession(owner.sessionToken)).role).toBe('owner');
    expect((await other.authenticateSession(member.sessionToken)).memberId).toBe(member.memberId);
    await expect(other.readKnowledge(member.sessionToken, { scopeId: owner.privateScope.id, key: 'private' })).rejects.toMatchObject({ code: 'not_found' });
    expect(await kernel.readKnowledge(owner.sessionToken, { scopeId: owner.privateScope.id, key: 'private' })).toMatchObject({ content: 'Private synthetic note', revision: '1' });
    expect((await admin.query("SELECT id FROM realbud_company.audit_events WHERE kind='owner_session_recovered'")).rowCount).toBe(0);
  });

  it('keeps private scopes private even from the company owner and separates companies', async () => {
    const { owner, member } = await office();
    const outsider = await kernel.createCompany({ name: 'Other company', ownerName: 'Other owner' });
    await other.replaceKnowledge(member.sessionToken, { scopeId: member.privateScope.id, key: 'note', expectedRevision: '0', content: 'Member private' });
    await expect(kernel.readKnowledge(owner.sessionToken, { scopeId: member.privateScope.id, key: 'note' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(kernel.readKnowledge(outsider.sessionToken, { scopeId: member.privateScope.id, key: 'note' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(other.setScopeGrant(member.sessionToken, { scopeId: member.privateScope.id, memberId: owner.memberId, permissions: ['read'], expectedRevision: '0' })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await kernel.listScopes(owner.sessionToken)).some(s => s.id === member.privateScope.id)).toBe(false);
    expect((await other.listScopes(member.sessionToken)).some(s => s.id === owner.companyScope.id)).toBe(true);
    await expect(other.replaceKnowledge(member.sessionToken, { scopeId: owner.companyScope.id, key: 'x', content: 'unauthorized', expectedRevision: '0' })).rejects.toMatchObject({ code: 'forbidden' });
    const scope = await kernel.createScope(owner.sessionToken, { kind: 'team', name: 'Team' });
    await expect(kernel.setScopeGrant(owner.sessionToken, { scopeId: scope.id, memberId: outsider.memberId, permissions: ['read'], expectedRevision: '0' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('serializes competing first knowledge revisions and preserves revision history', async () => {
    const { owner, member, scope } = await team();
    const results = await Promise.allSettled([
      kernel.replaceKnowledge(owner.sessionToken, { scopeId: scope.id, key: 'bill', expectedRevision: '0', content: 'Owner result', sourceRefs: ['synthetic:invoice-1'] }),
      other.replaceKnowledge(member.sessionToken, { scopeId: scope.id, key: 'bill', expectedRevision: '0', content: 'Member result', sourceRefs: ['synthetic:invoice-1'] }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    const first = await kernel.readKnowledge(owner.sessionToken, { scopeId: scope.id, key: 'bill' });
    expect(first?.revision).toBe('1');
    await other.replaceKnowledge(member.sessionToken, { scopeId: scope.id, key: 'bill', expectedRevision: '1', content: 'Reviewed correction', sourceRefs: ['synthetic:invoice-1'] });
    expect((await kernel.knowledgeHistory(owner.sessionToken, { scopeId: scope.id, key: 'bill' })).map(r => r.revision)).toEqual(['2', '1']);
    await expect(other.replaceKnowledge(member.sessionToken, { scopeId: scope.id, key: 'bill', expectedRevision: '1', content: 'Stale overwrite' })).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rejects concurrent stale grant edits and reads after revocation across warm instances', async () => {
    const { owner, member, scope } = await team();
    await other.replaceKnowledge(member.sessionToken, { scopeId: scope.id, key: 'note', content: 'Shared synthetic note', expectedRevision: '0' });
    expect(await other.readKnowledge(member.sessionToken, { scopeId: scope.id, key: 'note' })).not.toBeNull();
    const results = await Promise.allSettled([
      kernel.setScopeGrant(owner.sessionToken, { scopeId: scope.id, memberId: member.memberId, permissions: [], expectedRevision: scope.revision }),
      other.setScopeGrant(owner.sessionToken, { scopeId: scope.id, memberId: member.memberId, permissions: ['read'], expectedRevision: scope.revision }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    const fresh = (await kernel.listScopes(owner.sessionToken)).find(s => s.id === scope.id)!;
    await kernel.setScopeGrant(owner.sessionToken, { scopeId: scope.id, memberId: member.memberId, permissions: [], expectedRevision: fresh.revision });
    await expect(other.readKnowledge(member.sessionToken, { scopeId: scope.id, key: 'note' })).rejects.toMatchObject({ code: 'not_found' });
  });

  it('RLS hides private content and pooled transaction actor context clears on success and failure', async () => {
    const { owner, member } = await office();
    await kernel.replaceKnowledge(owner.sessionToken, { scopeId: owner.privateScope.id, key: 'secret', content: 'Private', expectedRevision: '0' });
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('realbud.company_id',$1,true),set_config('realbud.member_id',$2,true)", [owner.companyId, member.memberId]);
      const direct = await client.query('SELECT * FROM realbud_company.knowledge_revisions');
      expect(direct.rowCount).toBe(0);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    await expect(other.readKnowledge(member.sessionToken, { scopeId: owner.privateScope.id, key: 'secret' })).rejects.toMatchObject({ code: 'not_found' });
    for (const pool of [app, otherPool]) {
      const connections = await Promise.all(Array.from({ length: pool === app ? 4 : 2 }, () => pool.connect()));
      try {
        for (const conn of connections) {
          const result = await conn.query("SELECT nullif(current_setting('realbud.company_id',true),'') AS company,nullif(current_setting('realbud.member_id',true),'') AS member");
          expect(result.rows[0]).toEqual({ company: null, member: null });
          expect((await conn.query('SELECT * FROM realbud_company.knowledge_revisions')).rowCount).toBe(0);
        }
      } finally { connections.forEach(conn => conn.release()); }
    }
  });

  it('allows one case claimant, renews its lease and fences a released generation', async () => {
    const { owner, member, scope } = await team();
    const work = await kernel.createCase(owner.sessionToken, { scopeId: scope.id, title: 'Synthetic bill' });
    const results = await Promise.allSettled([
      kernel.claimCase(owner.sessionToken, { caseId: work.caseId, ttlMs: 30_000 }),
      other.claimCase(member.sessionToken, { caseId: work.caseId, ttlMs: 30_000 }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'claim_busy' } });
    const winningIndex = results.findIndex(r => r.status === 'fulfilled');
    const claim = (results[winningIndex] as PromiseFulfilledResult<Awaited<ReturnType<CompanyKernel['claimCase']>>>).value;
    const winner = winningIndex === 0 ? owner : member;
    await kernel.renewClaim(winner.sessionToken, { ...claim, ttlMs: 30_000 });
    await kernel.settleClaim(winner.sessionToken, { ...claim, outcome: 'released' });
    const next = await other.claimCase(member.sessionToken, { caseId: work.caseId, ttlMs: 30_000 });
    expect(BigInt(next.fence)).toBeGreaterThan(BigInt(claim.fence));
    await expect(kernel.settleClaim(winner.sessionToken, { ...claim, outcome: 'done' })).rejects.toMatchObject({ code: 'stale_claim' });
    const settled = await other.settleClaim(member.sessionToken, { ...next, outcome: 'done' });
    expect(settled.status).toBe('done');
    expect((await admin.query('SELECT * FROM realbud_company.claim_receipts WHERE case_id=$1', [work.caseId])).rowCount).toBe(4);
  });

  it('holds an expired claim and refuses late renewal or completion', async () => {
    const { owner, member, scope } = await team();
    const work = await kernel.createCase(owner.sessionToken, { scopeId: scope.id, title: 'Uncertain work' });
    const claim = await other.claimCase(member.sessionToken, { caseId: work.caseId, ttlMs: 30_000 });
    await admin.query("UPDATE realbud_company.cases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [work.caseId]);
    await expect(other.renewClaim(member.sessionToken, { ...claim, ttlMs: 30_000 })).rejects.toMatchObject({ code: 'stale_claim' });
    await expect(other.settleClaim(member.sessionToken, { ...claim, outcome: 'done' })).rejects.toMatchObject({ code: 'stale_claim' });
    await expect(kernel.claimCase(owner.sessionToken, { caseId: work.caseId, ttlMs: 30_000 })).rejects.toMatchObject({ code: 'recovery_required' });
  });

  it('revokes members without releasing unsettled work to another claimant', async () => {
    const { owner, member, scope } = await team();
    const work = await kernel.createCase(owner.sessionToken, { scopeId: scope.id, title: 'Revoked operator' });
    const claim = await other.claimCase(member.sessionToken, { caseId: work.caseId, ttlMs: 30_000 });
    await kernel.revokeMember(owner.sessionToken, member.memberId);
    await expect(other.renewClaim(member.sessionToken, { ...claim, ttlMs: 30_000 })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(kernel.claimCase(owner.sessionToken, { caseId: work.caseId, ttlMs: 30_000 })).rejects.toMatchObject({ code: 'recovery_required' });
  });

  it('concurrent session revocations are idempotent without a lock-upgrade deadlock', async () => {
    const { member } = await office();
    await Promise.all([kernel.revokeSession(member.sessionToken), other.revokeSession(member.sessionToken)]);
    await expect(kernel.authenticateSession(member.sessionToken)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('member revocation waits for an already-authorized write then denies every later write', async () => {
    const { owner, member, scope } = await team();
    const blocker = await admin.connect();
    let pendingWrite: Promise<unknown> | undefined;
    let pendingRevoke: Promise<unknown> | undefined;
    async function waitForBlocked(count: number) {
      for (let attempt = 0; attempt < 100; attempt++) {
        const result = await admin.query("SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname=current_database() AND usename='rb_company_test_app' AND wait_event='advisory'");
        if (result.rows[0].count >= count) return;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Expected concurrent operations did not reach the blocked transaction boundary');
    }
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`scope:${owner.companyId}:${scope.id}`]);
      pendingWrite = other.replaceKnowledge(member.sessionToken, { scopeId: scope.id, key: 'ordered', content: 'Before revocation', expectedRevision: '0' });
      await waitForBlocked(1);
      pendingRevoke = kernel.revokeMember(owner.sessionToken, member.memberId);
      await waitForBlocked(2);
      await blocker.query('COMMIT');
      await pendingWrite;
      await pendingRevoke;
      expect((await kernel.readKnowledge(owner.sessionToken, { scopeId: scope.id, key: 'ordered' }))?.content).toBe('Before revocation');
      await expect(other.replaceKnowledge(member.sessionToken, { scopeId: scope.id, key: 'ordered', content: 'After revocation', expectedRevision: '1' })).rejects.toMatchObject({ code: 'unauthenticated' });
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.allSettled([pendingWrite, pendingRevoke]);
    }
  });
});
