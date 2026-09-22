import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanyKernel } from './index.ts';
import { startCompanyPostgresFixture } from './testing-postgres.ts';

describe.runIf(process.env.REALBUD_TEST_POSTGRES === '1')('department recovery on real PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof startCompanyPostgresFixture>>;
  let kernel: ReturnType<typeof createCompanyKernel>;
  let output: string;
  beforeAll(async () => {
    output = await mkdtemp(join(tmpdir(), 'rb-department-recovery-'));
    fixture = await startCompanyPostgresFixture({ outputDirectory: output, postgresBinDirectory: process.env.REALBUD_TEST_POSTGRES_BIN });
    kernel = createCompanyKernel(fixture.pool);
  }, 60_000);
  afterAll(async () => { await fixture?.stop(); if (output) await rm(output, { recursive: true, force: true }); });
  async function office() {
    const owner = await kernel.createCompany({ name: 'Fictional recovery office', ownerName: 'Owner' });
    const invite = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Alex' });
    const member = await kernel.redeemInvitation(invite.invitationToken);
    let department = await kernel.createDepartment(owner.sessionToken, { name: 'Operations', requestId: randomUUID() });
    department = await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, expectedRevision: department.revision, access: 'write' });
    const work = await kernel.createCase(member.sessionToken, { scopeId: department.id, title: 'Check synthetic result' });
    const claim = await kernel.claimCase(member.sessionToken, { caseId: work.caseId, ttlMs: 60_000 });
    return { owner, member, department, work, claim };
  }
  const decision = (departmentId: string, caseId: string, expectedFence: string, resolution: 'done' | 'released' = 'done') => ({ departmentId, caseId, expectedFence, resolution, requestId: randomUUID(), note: 'Confirmed the synthetic outcome before recovery.' });
  async function expire(companyId: string, caseId: string) {
    await fixture.adminPool.query(`UPDATE realbud_company.cases SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE company_id=$1 AND id=$2`, [companyId, caseId]);
  }

  it('resolves the read-only holder departure deadlock, preserves the note and never restores the old claim', async () => {
    const { owner, member, department, work, claim } = await office();
    await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, access: 'read', expectedRevision: department.revision });
    expect((await kernel.membershipManagement(member.sessionToken)).unresolvedWork).toBe(true);
    await expect(kernel.leaveMembership(member.sessionToken, randomBytes(32).toString('base64url'))).rejects.toMatchObject({ code: 'work_resolution_required' });
    const page = await kernel.departmentCases(member.sessionToken, { departmentId: department.id });
    expect(page).toMatchObject({ canRecover: false, cases: [{ id: work.caseId, needsReview: true, fence: '2', holder: { id: member.memberId } }] });
    const request = decision(department.id, work.caseId, page.cases[0].fence);
    await expect(kernel.recoverDepartmentCase(member.sessionToken, request)).rejects.toMatchObject({ code: 'forbidden' });
    const saved = await kernel.recoverDepartmentCase(owner.sessionToken, request);
    expect(saved).toMatchObject({ replayed: false, receiptId: request.requestId, item: { status: 'done', fence: '3', holder: null, leaseExpiresAt: null, lastRecovery: { note: request.note, reviewedBy: 'Owner' } } });
    expect((await kernel.membershipManagement(member.sessionToken)).unresolvedWork).toBe(false);
    expect((await kernel.departmentCases(owner.sessionToken, { departmentId: department.id })).cases).toHaveLength(0);
    const bytes = JSON.stringify(await kernel.departmentCases(member.sessionToken, { departmentId: department.id, filter: 'all' }));
    expect(bytes).toContain(request.note); expect(bytes).not.toContain('claim_token_hash'); expect(bytes).not.toContain(claim.claimToken);
    const changed = (await kernel.listDepartments(owner.sessionToken)).departments[0];
    await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, access: 'write', expectedRevision: changed.revision });
    await expect(kernel.settleClaim(member.sessionToken, { ...claim, outcome: 'done' })).rejects.toMatchObject({ code: 'stale_claim' });
    await kernel.leaveMembership(member.sessionToken, randomBytes(32).toString('base64url'));
    await expect(kernel.departmentCases(member.sessionToken, { departmentId: department.id })).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  it('refuses live claims, admits expired claims only after review, and preserves idempotency after new work starts', async () => {
    const { owner, member, department, work, claim } = await office();
    const request = decision(department.id, work.caseId, claim.fence, 'released');
    await expect(kernel.recoverDepartmentCase(owner.sessionToken, request)).rejects.toMatchObject({ code: 'claim_busy' });
    expect((await kernel.departmentCases(owner.sessionToken, { departmentId: department.id })).cases).toEqual([]);
    await expire(owner.companyId, work.caseId);
    expect((await kernel.departmentCases(owner.sessionToken, { departmentId: department.id })).cases[0]).toMatchObject({ status: 'claimed', needsReview: true });
    const saved = await kernel.recoverDepartmentCase(owner.sessionToken, request);
    expect(saved.item).toMatchObject({ status: 'open', fence: '2', holder: null });
    const fresh = await kernel.claimCase(member.sessionToken, { caseId: work.caseId, ttlMs: 60_000 });
    expect(fresh.fence).toBe('3');
    await expect(kernel.renewClaim(member.sessionToken, { ...claim, ttlMs: 60_000 })).rejects.toMatchObject({ code: 'stale_claim' });
    const replay = await kernel.recoverDepartmentCase(owner.sessionToken, request);
    expect(replay).toMatchObject({ replayed: true, receiptId: request.requestId, item: { status: 'claimed', fence: fresh.fence } });
    await expect(kernel.recoverDepartmentCase(owner.sessionToken, { ...request, note: 'Changed decision' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await fixture.adminPool.query(`SELECT count(*)::int AS n FROM realbud_company.claim_receipts WHERE company_id=$1 AND id=$2`, [owner.companyId, request.requestId])).rows[0].n).toBe(1);
  });
  it('serializes concurrent decisions across kernels and rejects stale fence decisions without changing the winner', async () => {
    const { owner, department, work, claim } = await office();
    await expire(owner.companyId, work.caseId);
    const otherKernel = createCompanyKernel(fixture.pool);
    const first = decision(department.id, work.caseId, claim.fence), second = decision(department.id, work.caseId, claim.fence, 'released');
    const results = await Promise.allSettled([kernel.recoverDepartmentCase(owner.sessionToken, first), otherKernel.recoverDepartmentCase(owner.sessionToken, second)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    const current = (await kernel.departmentCases(owner.sessionToken, { departmentId: department.id, filter: 'all' })).cases[0];
    expect(current.fence).toBe('2'); expect(current.needsReview).toBe(false);
  });
  it('never exposes a foreign office, private scope, unrelated reviewed handoff or no-access department', async () => {
    const one = await office(), other = await office();
    const handoff = await kernel.shareWork(one.owner.sessionToken, { requestId: randomUUID(), title: 'Private reviewed handoff', summary: 'Selected result only', purpose: 'handoff', recipientMemberIds: [one.member.memberId], assigneeMemberId: one.member.memberId });
    for (const id of [other.department.id, one.owner.privateScope.id, handoff.scopeId]) {
      await expect(kernel.departmentCases(one.owner.sessionToken, { departmentId: id })).rejects.toMatchObject({ code: 'not_found' });
      await expect(kernel.recoverDepartmentCase(one.owner.sessionToken, decision(id, one.work.caseId, '1'))).rejects.toMatchObject({ code: 'not_found' });
    }
    await kernel.setDepartmentAccess(one.owner.sessionToken, { departmentId: one.department.id, memberId: one.member.memberId, expectedRevision: one.department.revision, access: 'none' });
    await expect(kernel.departmentCases(one.member.sessionToken, { departmentId: one.department.id })).rejects.toMatchObject({ code: 'not_found' });
    const held = (await kernel.departmentCases(one.owner.sessionToken, { departmentId: one.department.id })).cases[0];
    await expect(kernel.recoverDepartmentCase(other.owner.sessionToken, decision(one.department.id, held.id, held.fence))).rejects.toMatchObject({ code: 'not_found' });
    expect((await kernel.departmentCases(one.owner.sessionToken, { departmentId: one.department.id, filter: 'all' })).cases.map(item => item.id)).toEqual([one.work.caseId]);
    await expect(kernel.recoverDepartmentCase(one.owner.sessionToken, decision(one.department.id, handoff.id, '0'))).rejects.toMatchObject({ code: 'not_found' });
  });
  it('makes removed-member claims reviewable and checks current owner authority even for a replay', async () => {
    const { owner, member, department, work } = await office();
    await kernel.revokeMember(owner.sessionToken, member.memberId);
    const held = (await kernel.departmentCases(owner.sessionToken, { departmentId: department.id })).cases[0];
    expect(held.holder).toMatchObject({ id: member.memberId, active: false });
    const request = decision(department.id, work.caseId, held.fence);
    await kernel.recoverDepartmentCase(owner.sessionToken, request);
    const invite = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Successor' });
    const successor = await kernel.redeemInvitation(invite.invitationToken);
    const offer = await kernel.offerOwnership(owner.sessionToken, successor.memberId);
    await kernel.acceptOwnership(successor.sessionToken, offer.id);
    await expect(kernel.recoverDepartmentCase(owner.sessionToken, request)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await kernel.recoverDepartmentCase(successor.sessionToken, request)).replayed).toBe(true);
  });
  it('fences the previous owner’s implicit department claims immediately on ownership transfer, retaining explicit grants', async () => {
    const { owner, member, department } = await office();
    const owned = await kernel.createCase(owner.sessionToken, { scopeId: department.id, title: 'Owner claim' });
    const claim = await kernel.claimCase(owner.sessionToken, { caseId: owned.caseId, ttlMs: 60_000 });
    const explicit = await kernel.createDepartment(owner.sessionToken, { name: 'Explicit access', requestId: randomUUID() });
    // A prior owner's write grant can remain when they later accept ownership.
    await fixture.adminPool.query(`INSERT INTO realbud_company.scope_grants(company_id,scope_id,member_id,permission) VALUES($1,$2,$3,'write')`, [owner.companyId, explicit.id, owner.memberId]);
    const retained = await kernel.createCase(owner.sessionToken, { scopeId: explicit.id, title: 'Explicit write claim' });
    const retainedClaim = await kernel.claimCase(owner.sessionToken, { caseId: retained.caseId, ttlMs: 60_000 });
    const offer = await kernel.offerOwnership(owner.sessionToken, member.memberId);
    await kernel.acceptOwnership(member.sessionToken, offer.id);
    const held = (await kernel.departmentCases(member.sessionToken, { departmentId: department.id })).cases.find(item => item.id === owned.caseId)!;
    expect(held).toMatchObject({ status: 'recovery_required', fence: '2', holder: { id: owner.memberId } });
    await kernel.recoverDepartmentCase(member.sessionToken, decision(department.id, owned.caseId, held.fence));
    await expect(kernel.settleClaim(owner.sessionToken, { ...claim, outcome: 'done' })).rejects.toMatchObject({ code: 'not_found' });
    expect((await kernel.renewClaim(owner.sessionToken, { ...retainedClaim, ttlMs: 60_000 })).fence).toBe(retainedClaim.fence);
  });
  it('pages all case records, rejects invalid input, and cannot recover ordinary open or settled cases', async () => {
    const { owner, department, work } = await office();
    for (let i = 0; i < 21; i++) await kernel.createCase(owner.sessionToken, { scopeId: department.id, title: `Synthetic case ${i}` });
    const first = await kernel.departmentCases(owner.sessionToken, { departmentId: department.id, filter: 'all' });
    const second = await kernel.departmentCases(owner.sessionToken, { departmentId: department.id, filter: 'all', offset: 20 });
    expect(first.cases).toHaveLength(20); expect(first.hasMore).toBe(true);
    expect(second.cases).toHaveLength(2); expect(second.hasMore).toBe(false);
    expect(new Set([...first.cases, ...second.cases].map(item => item.id)).size).toBe(22);
    await expect(kernel.recoverDepartmentCase(owner.sessionToken, decision(department.id, first.cases[0].id, '0'))).rejects.toMatchObject({ code: 'conflict' });
    for (const patch of [{ expectedFence: '9223372036854775808' }, { note: '' }, { note: 'x'.repeat(2049) }, { note: '\u0000' }, { requestId: 'invalid' }, { resolution: 'erase' }]) {
      expect(() => kernel.recoverDepartmentCase(owner.sessionToken, { ...decision(department.id, work.caseId, '1'), ...patch } as Parameters<typeof kernel.recoverDepartmentCase>[1])).toThrow();
    }
    expect(() => kernel.departmentCases(owner.sessionToken, { departmentId: department.id, offset: 1 })).toThrow();
    expect(() => kernel.departmentCases(owner.sessionToken, { departmentId: department.id, filter: 'secrets' as 'all' })).toThrow();
  });
});
