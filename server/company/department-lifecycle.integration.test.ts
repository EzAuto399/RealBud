import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanyKernel } from './index.ts';
import { startCompanyPostgresFixture } from './testing-postgres.ts';
import { migrateCompanySchema, companySchemaManifest } from './schema.ts';

// Fictional data in an owned Unix-socket cluster only; never an operator database.
describe.runIf(process.env.REALBUD_TEST_POSTGRES === '1')('department case lifecycle on real PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof startCompanyPostgresFixture>>;
  let kernel: ReturnType<typeof createCompanyKernel>, output: string;
  beforeAll(async () => {
    output = await mkdtemp(join(tmpdir(), 'rb-department-lifecycle-'));
    fixture = await startCompanyPostgresFixture({ outputDirectory: output, postgresBinDirectory: process.env.REALBUD_TEST_POSTGRES_BIN });
    kernel = createCompanyKernel(fixture.pool);
  }, 60_000);
  afterAll(async () => { await fixture?.stop(); if (output) await rm(output, { recursive: true, force: true }); });
  async function office() {
    const owner = await kernel.createCompany({ name: 'Fictional case office', ownerName: 'Owner' });
    const member = await kernel.redeemInvitation((await kernel.issueInvitation(owner.sessionToken, { displayName: 'Case writer' })).invitationToken);
    const reader = await kernel.redeemInvitation((await kernel.issueInvitation(owner.sessionToken, { displayName: 'Case reader' })).invitationToken);
    let department = await kernel.createDepartment(owner.sessionToken, { requestId: randomUUID(), name: 'Accounts' });
    department = await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, access: 'write', expectedRevision: department.revision });
    department = await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: reader.memberId, access: 'read', expectedRevision: department.revision });
    return { owner, member, reader, department };
  }
  const create = (departmentId: string, assigneeMemberId: string | null = null) => ({ departmentId, requestId: randomUUID(), title: 'Review fictional invoice', description: 'Compare the supplied synthetic evidence.', assigneeMemberId });
  const close = (departmentId: string, caseId: string, expectedFence: string, resolution: 'done' | 'cancelled' = 'done') => ({ departmentId, caseId, expectedFence, requestId: randomUUID(), resolution, note: 'Human reviewed the fictional outcome.' });
  const lifecycle = (departmentId: string, expectedRevision: string, retired = true) => ({ departmentId, expectedRevision, retired, requestId: randomUUID(), note: retired ? 'Department work has ended.' : 'Department resumes with reviewed access.' });

  it('creates exactly once across kernels, preserving the original binding after reassignment and closure', async () => {
    const { owner, member, department } = await office();
    const input = create(department.id, member.memberId), other = createCompanyKernel(fixture.pool);
    const results = await Promise.all([kernel.createDepartmentCase(owner.sessionToken, input), other.createDepartmentCase(owner.sessionToken, input)]);
    expect(results.map(result => result.replayed).sort()).toEqual([false, true]);
    expect(results[0].item).toMatchObject({ id: input.requestId, description: input.description, assignee: { id: member.memberId, canWrite: true }, needsAssignment: false });
    const assigned = await kernel.assignDepartmentCase(owner.sessionToken, { departmentId: department.id, caseId: input.requestId, expectedFence: '0', requestId: randomUUID(), assigneeMemberId: owner.memberId });
    await kernel.closeDepartmentCase(owner.sessionToken, close(department.id, input.requestId, assigned.item.fence));
    expect(await other.createDepartmentCase(owner.sessionToken, input)).toMatchObject({ replayed: true, item: { status: 'done', assignee: { id: owner.memberId } } });
    await expect(kernel.createDepartmentCase(owner.sessionToken, { ...input, title: 'Changed retry' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(kernel.createDepartmentCase(member.sessionToken, input)).rejects.toMatchObject({ code: 'conflict' });
    const receipts = await fixture.adminPool.query('SELECT count(*)::int AS n FROM realbud_company.claim_receipts WHERE company_id=$1 AND id=$2', [owner.companyId, input.requestId]);
    expect(receipts.rows[0].n).toBe(1);
  });

  it('assigns only current writers without granting access; rejects reader, foreign and removed members', async () => {
    const one = await office(), two = await office();
    const candidates = await kernel.departmentAssignees(one.member.sessionToken, { departmentId: one.department.id });
    expect(candidates.members.map(member => member.id).sort()).toEqual([one.owner.memberId, one.member.memberId].sort());
    await expect(kernel.departmentAssignees(one.reader.sessionToken, { departmentId: one.department.id })).rejects.toMatchObject({ code: 'forbidden' });
    for (const id of [one.reader.memberId, two.member.memberId, randomUUID()]) await expect(kernel.createDepartmentCase(one.owner.sessionToken, create(one.department.id, id))).rejects.toMatchObject({ code: 'forbidden' });
    const work = await kernel.createDepartmentCase(one.member.sessionToken, create(one.department.id, one.member.memberId));
    await expect(kernel.createDepartmentCase(one.owner.sessionToken, create(two.department.id))).rejects.toMatchObject({ code: 'not_found' });
    await expect(kernel.createDepartmentCase(one.reader.sessionToken, create(one.department.id))).rejects.toMatchObject({ code: 'forbidden' });
    expect((await kernel.departmentAccess(one.owner.sessionToken, { departmentId: one.department.id })).members.find(member => member.id === one.reader.memberId)?.access).toBe('read');
    await kernel.revokeMember(one.owner.sessionToken, one.member.memberId);
    const saved = (await kernel.departmentCases(one.owner.sessionToken, { departmentId: one.department.id, filter: 'all' })).cases[0];
    expect(saved).toMatchObject({ id: work.item.id, needsAssignment: true, assignee: { active: false, canWrite: false } });
    await expect(kernel.assignDepartmentCase(one.owner.sessionToken, { departmentId: one.department.id, caseId: saved.id, expectedFence: saved.fence, requestId: randomUUID(), assigneeMemberId: one.member.memberId })).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('keeps responsibility independent of leases and prevents generic claim bypass', async () => {
    const { owner, member, department } = await office();
    const work = await kernel.createDepartmentCase(owner.sessionToken, create(department.id, member.memberId));
    await expect(kernel.claimCase(owner.sessionToken, { caseId: work.item.id, ttlMs: 60_000 })).rejects.toMatchObject({ code: 'forbidden' });
    const claim = await kernel.claimCase(member.sessionToken, { caseId: work.item.id, ttlMs: 60_000 });
    await expect(kernel.assignDepartmentCase(owner.sessionToken, { departmentId: department.id, caseId: work.item.id, expectedFence: claim.fence, requestId: randomUUID(), assigneeMemberId: owner.memberId })).rejects.toMatchObject({ code: 'claim_busy' });
    await expect(kernel.closeDepartmentCase(owner.sessionToken, close(department.id, work.item.id, claim.fence))).rejects.toMatchObject({ code: 'claim_busy' });
    await fixture.adminPool.query("UPDATE realbud_company.cases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1 AND id=$2", [owner.companyId, work.item.id]);
    await expect(kernel.closeDepartmentCase(owner.sessionToken, close(department.id, work.item.id, claim.fence))).rejects.toMatchObject({ code: 'recovery_required' });
    const recovered = await kernel.recoverDepartmentCase(owner.sessionToken, { ...close(department.id, work.item.id, claim.fence), resolution: 'released' });
    expect(recovered.item.assignee?.id).toBe(member.memberId);
    const unassigned = await kernel.assignDepartmentCase(owner.sessionToken, { departmentId: department.id, caseId: work.item.id, expectedFence: recovered.item.fence, requestId: randomUUID(), assigneeMemberId: null });
    expect(unassigned.item).toMatchObject({ holder: null, needsAssignment: true, assignee: null });
    await expect(kernel.renewClaim(member.sessionToken, { ...claim, ttlMs: 60_000 })).rejects.toMatchObject({ code: 'stale_claim' });
    expect((await kernel.claimCase(owner.sessionToken, { caseId: work.item.id, ttlMs: 60_000 })).fence).toBe('4');
  });

  it('records explicit human closure once, refusing another writer, stale edits and changed retry notes', async () => {
    const { owner, member, department } = await office();
    const work = await kernel.createDepartmentCase(member.sessionToken, create(department.id, owner.memberId));
    const input = close(department.id, work.item.id, '0', 'cancelled');
    await expect(kernel.closeDepartmentCase(member.sessionToken, input)).rejects.toMatchObject({ code: 'forbidden' });
    expect(() => kernel.closeDepartmentCase(owner.sessionToken, { ...input, note: '   ' })).toThrow();
    const closed = await kernel.closeDepartmentCase(owner.sessionToken, input);
    expect(closed.item).toMatchObject({ status: 'cancelled', fence: '1', canAssign: false, canClose: false, lastClosure: { note: input.note, resolution: 'cancelled', recordedBy: 'Owner' } });
    expect((await kernel.closeDepartmentCase(owner.sessionToken, input)).replayed).toBe(true);
    await expect(kernel.closeDepartmentCase(owner.sessionToken, { ...input, note: 'Changed' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(kernel.assignDepartmentCase(owner.sessionToken, { departmentId: department.id, caseId: work.item.id, expectedFence: '0', requestId: randomUUID(), assigneeMemberId: null })).rejects.toMatchObject({ code: 'conflict' });
    const read = await kernel.departmentCases(member.sessionToken, { departmentId: department.id, filter: 'all' });
    expect(read.department.unresolvedCases).toBe(0);
    expect(JSON.stringify(read)).not.toMatch(/claim_token|sessionToken/);
  });

  it('blocks departure for assigned work and marks lost access for reassignment without erasing history', async () => {
    const { owner, member, department } = await office();
    const work = await kernel.createDepartmentCase(owner.sessionToken, create(department.id, member.memberId));
    expect((await kernel.membershipManagement(member.sessionToken)).unresolvedWork).toBe(true);
    await expect(kernel.leaveMembership(member.sessionToken, randomBytes(32).toString('base64url'))).rejects.toMatchObject({ code: 'work_resolution_required' });
    await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, access: 'none', expectedRevision: department.revision });
    expect((await kernel.departmentCases(owner.sessionToken, { departmentId: department.id, filter: 'all' })).cases[0]).toMatchObject({ needsAssignment: true, assignee: { id: member.memberId, active: true, canWrite: false } });
    await expect(kernel.departmentCases(member.sessionToken, { departmentId: department.id })).rejects.toMatchObject({ code: 'not_found' });
    expect((await kernel.membershipManagement(member.sessionToken)).unresolvedWork).toBe(true);
    await expect(kernel.leaveMembership(member.sessionToken, randomBytes(32).toString('base64url'))).rejects.toMatchObject({ code: 'work_resolution_required' });
    await kernel.assignDepartmentCase(owner.sessionToken, { departmentId: department.id, caseId: work.item.id, expectedFence: '0', requestId: randomUUID(), assigneeMemberId: null });
    await kernel.leaveMembership(member.sessionToken, randomBytes(32).toString('base64url'));
  });

  it('serializes assignment versus claim and gives only one concurrent edit the original fence', async () => {
    const { owner, member, department } = await office(), other = createCompanyKernel(fixture.pool);
    const work = await kernel.createDepartmentCase(owner.sessionToken, create(department.id));
    const changes = await Promise.allSettled([
      kernel.assignDepartmentCase(owner.sessionToken, { departmentId: department.id, caseId: work.item.id, expectedFence: '0', requestId: randomUUID(), assigneeMemberId: member.memberId }),
      other.claimCase(owner.sessionToken, { caseId: work.item.id, ttlMs: 60_000 }),
    ]);
    expect(changes.filter(change => change.status === 'fulfilled')).toHaveLength(1);
    const current = (await kernel.departmentCases(owner.sessionToken, { departmentId: department.id, filter: 'all' })).cases[0];
    expect(current.fence).toBe('1');
    expect(current.status === 'claimed' ? current.holder?.id : current.assignee?.id).toBe(current.status === 'claimed' ? owner.memberId : member.memberId);
  });

  it('keeps a hidden unassigned interrupted claim as a departure hold without exposing its contents', async () => {
    const { owner, member, department } = await office();
    const work = await kernel.createCase(owner.sessionToken, { scopeId: department.id, title: 'Unassigned legacy claim' });
    await kernel.claimCase(member.sessionToken, { caseId: work.caseId, ttlMs: 60_000 });
    await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, access: 'none', expectedRevision: department.revision });
    await expect(kernel.departmentCases(member.sessionToken, { departmentId: department.id })).rejects.toMatchObject({ code: 'not_found' });
    expect((await kernel.membershipManagement(member.sessionToken)).unresolvedWork).toBe(true);
    await expect(kernel.leaveMembership(member.sessionToken, randomBytes(32).toString('base64url'))).rejects.toMatchObject({ code: 'work_resolution_required' });
    await kernel.recoverDepartmentCase(owner.sessionToken, { ...close(department.id, work.caseId, '2'), resolution: 'released' });
    expect((await kernel.membershipManagement(member.sessionToken)).unresolvedWork).toBe(false);
  });

  it('fails closed when the hidden-work predicate owner cannot bypass forced RLS', async () => {
    const { owner, member, department } = await office();
    await kernel.createDepartmentCase(owner.sessionToken, create(department.id, member.memberId));
    await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, access: 'none', expectedRevision: department.revision });
    try {
      await fixture.adminPool.query('GRANT CREATE ON SCHEMA realbud_company TO rb_company_test_app');
      await fixture.adminPool.query('ALTER FUNCTION realbud_company.actor_has_department_work() OWNER TO rb_company_test_app');
      await expect(kernel.leaveMembership(member.sessionToken, randomBytes(32).toString('base64url'))).rejects.toMatchObject({ code: '42501' });
    } finally {
      await fixture.adminPool.query('ALTER FUNCTION realbud_company.actor_has_department_work() OWNER TO realbud_test_admin');
      await fixture.adminPool.query('REVOKE CREATE ON SCHEMA realbud_company FROM rb_company_test_app');
    }
    expect((await kernel.authenticateSession(member.sessionToken)).memberId).toBe(member.memberId);
  });

  it('retirement refuses unresolved work, preserves read history, denies generic and RLS writes, and reactivates without work', async () => {
    const { owner, member, reader, department } = await office();
    const work = await kernel.createDepartmentCase(owner.sessionToken, create(department.id, member.memberId));
    const request = lifecycle(department.id, department.revision);
    await expect(kernel.setDepartmentLifecycle(owner.sessionToken, request)).rejects.toMatchObject({ code: 'work_resolution_required' });
    await kernel.closeDepartmentCase(member.sessionToken, close(department.id, work.item.id, '0'));
    const archived = await kernel.setDepartmentLifecycle(owner.sessionToken, request);
    expect(archived.department).toMatchObject({ retiredBy: owner.memberId, retirementNote: request.note, unresolvedCases: 0 });
    expect(archived.department.retiredAt).toBeTruthy();
    expect((await kernel.setDepartmentLifecycle(owner.sessionToken, request)).replayed).toBe(true);
    await expect(kernel.setDepartmentLifecycle(owner.sessionToken, { ...request, note: 'Changed' })).rejects.toMatchObject({ code: 'conflict' });
    for (const token of [owner.sessionToken, member.sessionToken]) {
      await expect(kernel.createCase(token, { scopeId: department.id, title: 'Cannot bypass' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(kernel.createDepartmentCase(token, create(department.id))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(kernel.claimCase(token, { caseId: work.item.id, ttlMs: 60_000 })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(kernel.replaceKnowledge(token, { scopeId: department.id, key: 'notes', expectedRevision: '0', content: 'Cannot bypass' })).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect((await kernel.departmentCases(reader.sessionToken, { departmentId: department.id, filter: 'all' }))).toMatchObject({ canCreate: false, canRecover: false, cases: [{ canAssign: false, canClose: false, status: 'done' }] });
    await expect(kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: reader.memberId, expectedRevision: archived.department.revision, access: 'write' })).rejects.toMatchObject({ code: 'forbidden' });
    const revoked = await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: reader.memberId, expectedRevision: archived.department.revision, access: 'none' });
    await expect(kernel.departmentCases(reader.sessionToken, { departmentId: department.id, filter: 'all' })).rejects.toMatchObject({ code: 'not_found' });
    const client = await fixture.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('realbud.company_id',$1,true),set_config('realbud.member_id',$2,true)", [owner.companyId, owner.memberId]);
      await expect(client.query('INSERT INTO realbud_company.cases(company_id,id,scope_id,title) VALUES($1,$2,$3,$4)', [owner.companyId, randomUUID(), department.id, 'Raw denied'])).rejects.toMatchObject({ code: '42501' });
    } finally { await client.query('ROLLBACK'); client.release(); }
    const active = await kernel.setDepartmentLifecycle(owner.sessionToken, lifecycle(department.id, revoked.revision, false));
    expect(active.department).toMatchObject({ retiredAt: null, retiredBy: null, retirementNote: '' });
    expect((await kernel.departmentCases(owner.sessionToken, { departmentId: department.id, filter: 'all' })).cases).toHaveLength(1);
    expect((await kernel.createDepartmentCase(owner.sessionToken, create(department.id))).item.status).toBe('open');
    // An old successful retire retry is observational; it cannot retire again.
    expect((await kernel.setDepartmentLifecycle(owner.sessionToken, request))).toMatchObject({ replayed: true, department: { retiredAt: null } });
  });

  it('serializes retirement versus both generic and typed creation across kernels', async () => {
    for (const typed of [false, true]) {
      const { owner, department } = await office(), other = createCompanyKernel(fixture.pool);
      const results = await Promise.allSettled([
        kernel.setDepartmentLifecycle(owner.sessionToken, lifecycle(department.id, department.revision)),
        typed ? other.createDepartmentCase(owner.sessionToken, create(department.id)) : other.createCase(owner.sessionToken, { scopeId: department.id, title: 'Concurrent create' }),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const current = (await kernel.departmentCases(owner.sessionToken, { departmentId: department.id, filter: 'all' }));
      expect(Boolean(current.department.retiredAt)).toBe(current.cases.length === 0);
    }
  });

  it('checks current owner after transfer and never changes reviewed SharedWork semantics', async () => {
    const { owner, member, department } = await office();
    const handoff = await kernel.shareWork(owner.sessionToken, { requestId: randomUUID(), title: 'Reviewed handoff', summary: 'Only selected fictional material', purpose: 'handoff', recipientMemberIds: [member.memberId], assigneeMemberId: member.memberId });
    await expect(kernel.createDepartmentCase(owner.sessionToken, create(handoff.scopeId))).rejects.toMatchObject({ code: 'not_found' });
    await expect(kernel.claimCase(owner.sessionToken, { caseId: handoff.id, ttlMs: 60_000 })).rejects.toMatchObject({ code: 'forbidden' });
    const offer = await kernel.offerOwnership(owner.sessionToken, member.memberId); await kernel.acceptOwnership(member.sessionToken, offer.id);
    await expect(kernel.setDepartmentLifecycle(owner.sessionToken, lifecycle(department.id, department.revision))).rejects.toMatchObject({ code: 'forbidden' });
    expect((await kernel.setDepartmentLifecycle(member.sessionToken, lifecycle(department.id, department.revision))).department.retiredAt).toBeTruthy();
    expect((await kernel.acceptSharedWork(member.sessionToken, { id: handoff.id, expectedRevision: handoff.revision })).state).toBe('accepted');
  });

  it('upgrades an actual 0005 database without rewriting cases, receipts, grants or active claims', async () => {
    const legacy = await startCompanyPostgresFixture({ outputDirectory: join(output, 'legacy-upgrade'), postgresBinDirectory: process.env.REALBUD_TEST_POSTGRES_BIN });
    try {
      const oldKernel = createCompanyKernel(legacy.pool);
      const owner = await oldKernel.createCompany({ name: 'Legacy office', ownerName: 'Legacy owner' });
      const department = await oldKernel.createDepartment(owner.sessionToken, { requestId: randomUUID(), name: 'Legacy department' });
      const work = await oldKernel.createCase(owner.sessionToken, { scopeId: department.id, title: 'Retained original work' });
      const claim = await oldKernel.claimCase(owner.sessionToken, { caseId: work.caseId, ttlMs: 60_000 });
      // Reconstruct precisely the pre-0006 shape in this isolated fixture. No
      // production downgrade exists; the actual migrator then upgrades it.
      await legacy.adminPool.query(`
        DROP FUNCTION realbud_company.actor_has_department_work();
        ALTER TABLE realbud_company.scopes DROP COLUMN retired_at, DROP COLUMN retired_by, DROP COLUMN retirement_note;
        ALTER TABLE realbud_company.cases DROP COLUMN description, DROP COLUMN assignee_member_id;
        ALTER TABLE realbud_company.cases DROP CONSTRAINT cases_status_check;
        ALTER TABLE realbud_company.cases ADD CONSTRAINT cases_status_check CHECK(status IN ('open','claimed','recovery_required','done'));
        DELETE FROM realbud_company.schema_migrations WHERE id='0006';
      `);
      const before = (await legacy.adminPool.query('SELECT * FROM realbud_company.cases WHERE id=$1', [work.caseId])).rows[0];
      const receipts = (await legacy.adminPool.query('SELECT * FROM realbud_company.claim_receipts ORDER BY id')).rows;
      await migrateCompanySchema(legacy.adminPool, { applicationRole: 'rb_company_test_app' });
      const after = (await legacy.adminPool.query('SELECT * FROM realbud_company.cases WHERE id=$1', [work.caseId])).rows[0];
      expect(after).toEqual({ ...before, description: '', assignee_member_id: null });
      expect((await legacy.adminPool.query('SELECT * FROM realbud_company.claim_receipts ORDER BY id')).rows).toEqual(receipts);
      expect((await legacy.adminPool.query('SELECT id,checksum FROM realbud_company.schema_migrations ORDER BY id')).rows).toEqual(companySchemaManifest());
      expect((await oldKernel.departmentCases(owner.sessionToken, { departmentId: department.id, filter: 'all' })).department).toMatchObject({ retiredAt: null, retiredBy: null, retirementNote: '' });
      expect((await oldKernel.renewClaim(owner.sessionToken, { ...claim, ttlMs: 60_000 })).fence).toBe(claim.fence);
    } finally { await legacy.stop(); }
  }, 30_000);

  it('reapplies the checksummed migration without changing existing business records', async () => {
    const { owner, member, department } = await office();
    const work = await kernel.createDepartmentCase(owner.sessionToken, create(department.id, member.memberId));
    await migrateCompanySchema(fixture.adminPool, { applicationRole: 'rb_company_test_app' });
    expect((await fixture.adminPool.query('SELECT id,checksum FROM realbud_company.schema_migrations ORDER BY id')).rows).toEqual(companySchemaManifest());
    expect((await kernel.departmentCases(member.sessionToken, { departmentId: department.id, filter: 'all' })).cases[0]).toMatchObject({ id: work.item.id, description: work.item.description, assignee: { id: member.memberId } });
  });
});
