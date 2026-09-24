import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanyKernel } from './index.ts';
import { startCompanyPostgresFixture } from './testing-postgres.ts';

describe.runIf(process.env.REALBUD_TEST_POSTGRES === '1')('explicit departments on real PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof startCompanyPostgresFixture>>;
  let kernel: ReturnType<typeof createCompanyKernel>;
  let output: string;
  beforeAll(async () => {
    output = await mkdtemp(join(tmpdir(), 'rb-departments-'));
    fixture = await startCompanyPostgresFixture({ outputDirectory: output, postgresBinDirectory: process.env.REALBUD_TEST_POSTGRES_BIN });
    kernel = createCompanyKernel(fixture.pool);
  }, 60_000);
  afterAll(async () => { await fixture?.stop(); if (output) await rm(output, { recursive: true, force: true }); });
  async function office() {
    const owner = await kernel.createCompany({ name: 'Fictional department office', ownerName: 'Owner' });
    const invitation = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Alex' });
    const member = await kernel.redeemInvitation(invitation.invitationToken);
    const department = await kernel.createDepartment(owner.sessionToken, { name: 'Accounts', requestId: randomUUID() });
    return { owner, member, department };
  }
  it('lists only explicit departments and never exposes other offices or unrelated shared review scopes', async () => {
    const { owner, member, department } = await office();
    await kernel.createScope(owner.sessionToken, { kind: 'team', name: 'Private review' });
    await kernel.shareWork(owner.sessionToken, { requestId: randomUUID(), title: 'Review', summary: 'Fictional draft', purpose: 'request-review', recipientMemberIds: [member.memberId], assigneeMemberId: member.memberId });
    const other = await office();
    expect((await kernel.listDepartments(owner.sessionToken)).departments.map(item => item.id)).toEqual([department.id]);
    expect((await kernel.listDepartments(member.sessionToken)).departments).toEqual([]);
    await expect(kernel.departmentAccess(owner.sessionToken, { departmentId: other.department.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(kernel.departmentAccess(member.sessionToken, { departmentId: department.id })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('creates once after a lost response and rejects conflicting reuse and duplicate names', async () => {
    const { owner, member, department } = await office();
    expect((await kernel.createDepartment(owner.sessionToken, { name: 'Accounts', requestId: department.id })).id).toBe(department.id);
    await expect(kernel.createDepartment(owner.sessionToken, { name: 'Different', requestId: department.id })).rejects.toMatchObject({ code: 'conflict' });
    await expect(kernel.createDepartment(owner.sessionToken, { name: 'accounts', requestId: randomUUID() })).rejects.toMatchObject({ code: 'conflict' });
    await expect(kernel.createDepartment(member.sessionToken, { name: 'Forbidden', requestId: randomUUID() })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('enforces read-only then write then removal against real department records', async () => {
    const { owner, member, department } = await office();
    let updated = await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, access: 'read', expectedRevision: '0' });
    await kernel.replaceKnowledge(owner.sessionToken, { scopeId: department.id, key: 'procedure', expectedRevision: '0', content: 'Review before posting' });
    expect((await kernel.readKnowledge(member.sessionToken, { scopeId: department.id, key: 'procedure' }))?.content).toContain('Review');
    await expect(kernel.replaceKnowledge(member.sessionToken, { scopeId: department.id, key: 'procedure', expectedRevision: '1', content: 'Bad edit' })).rejects.toMatchObject({ code: 'forbidden' });
    updated = await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, access: 'write', expectedRevision: updated.revision });
    await kernel.replaceKnowledge(member.sessionToken, { scopeId: department.id, key: 'procedure', expectedRevision: '1', content: 'Reviewed update' });
    expect((await kernel.listDepartments(member.sessionToken)).departments[0].access).toBe('write');
    await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, access: 'none', expectedRevision: updated.revision });
    expect((await kernel.listDepartments(member.sessionToken)).departments).toEqual([]);
    await expect(kernel.readKnowledge(member.sessionToken, { scopeId: department.id, key: 'procedure' })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('rejects simultaneous stale access edits and generic grant bypasses', async () => {
    const { owner, member, department } = await office();
    const inputs = { departmentId: department.id, memberId: member.memberId, expectedRevision: '0' };
    const results = await Promise.allSettled(['read', 'write'].map(access => kernel.setDepartmentAccess(owner.sessionToken, { ...inputs, access: access as 'read' | 'write' })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    await expect(kernel.setScopeGrant(owner.sessionToken, { scopeId: department.id, memberId: member.memberId, expectedRevision: '1', permissions: ['write'] })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('binds management and implicit access to the current office owner without transferring private scopes', async () => {
    const { owner, member, department } = await office();
    const offer = await kernel.offerOwnership(owner.sessionToken, member.memberId);
    await kernel.acceptOwnership(member.sessionToken, offer.id);
    expect((await kernel.listDepartments(owner.sessionToken)).departments).toEqual([]);
    expect((await kernel.listDepartments(member.sessionToken)).departments[0].id).toBe(department.id);
    const access = await kernel.departmentAccess(member.sessionToken, { departmentId: department.id });
    expect(access.members.find(item => item.id === owner.memberId)?.access).toBe('none');
    expect(access.members.find(item => item.id === member.memberId)?.access).toBe('write');
    await kernel.setDepartmentAccess(member.sessionToken, { departmentId: department.id, memberId: owner.memberId, expectedRevision: department.revision, access: 'read' });
    await expect(kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, expectedRevision: '1', access: 'none' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(kernel.replaceKnowledge(owner.sessionToken, { scopeId: department.id, key: 'bypass', expectedRevision: '0', content: 'blocked' })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await kernel.listScopes(member.sessionToken)).some(scope => scope.id === owner.privateScope.id)).toBe(false);
  });
  it('rejects revoked and foreign members and immediately holds work after edit access is removed', async () => {
    const { owner, member, department } = await office();
    const other = await office();
    await expect(kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: other.member.memberId, expectedRevision: '0', access: 'read' })).rejects.toMatchObject({ code: 'not_found' });
    const updated = await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, access: 'write', expectedRevision: '0' });
    const job = await kernel.createCase(member.sessionToken, { scopeId: department.id, title: 'Fictional review' });
    await kernel.claimCase(member.sessionToken, { caseId: job.caseId, ttlMs: 60_000 });
    await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, access: 'read', expectedRevision: updated.revision });
    await expect(kernel.claimCase(owner.sessionToken, { caseId: job.caseId, ttlMs: 60_000 })).rejects.toMatchObject({ code: 'recovery_required' });
    await kernel.revokeMember(owner.sessionToken, member.memberId);
    await expect(kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, access: 'write', expectedRevision: '2' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(kernel.listDepartments(member.sessionToken)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect((await kernel.departmentAccess(owner.sessionToken, { departmentId: department.id })).members.some(item => item.id === member.memberId)).toBe(false);
  });
  it('paginates current members without silently excluding large offices', async () => {
    const { owner, department } = await office();
    for (let i = 0; i < 101; i++) await fixture.adminPool.query(`INSERT INTO realbud_company.members(company_id,id,display_name,role) VALUES($1,$2,$3,'member')`, [owner.companyId, randomUUID(), `Person ${String(i).padStart(3, '0')}`]);
    const first = await kernel.departmentAccess(owner.sessionToken, { departmentId: department.id });
    const second = await kernel.departmentAccess(owner.sessionToken, { departmentId: department.id, offset: 100 });
    expect(first.members).toHaveLength(100); expect(first.hasMore).toBe(true);
    expect(second.members).toHaveLength(3); expect(second.hasMore).toBe(false);
    expect(new Set([...first.members, ...second.members].map(member => member.id)).size).toBe(103);
  });
});
