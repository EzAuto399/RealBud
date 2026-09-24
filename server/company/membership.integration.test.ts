import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompanyKernel } from './index.ts';
import { startCompanyPostgresFixture } from './testing-postgres.ts';

describe.runIf(process.env.REALBUD_TEST_POSTGRES === '1')('membership lifecycle on real PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof startCompanyPostgresFixture>>;
  let kernel: ReturnType<typeof createCompanyKernel>;
  let output: string;
  beforeAll(async () => {
    output = await mkdtemp(join(tmpdir(), 'rb-membership-'));
    fixture = await startCompanyPostgresFixture({ outputDirectory: output, postgresBinDirectory: process.env.REALBUD_TEST_POSTGRES_BIN });
    kernel = createCompanyKernel(fixture.pool);
  }, 60_000);
  afterAll(async () => { await fixture?.stop(); if (output) await rm(output, { recursive: true, force: true }); });
  async function office() {
    const owner = await kernel.createCompany({ name: 'Synthetic office', ownerName: 'Owner' });
    const invite = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Member' });
    const member = await kernel.redeemInvitation(invite.invitationToken);
    return { owner, member };
  }
  it('restricts management and offers to this office owner', async () => {
    const { owner, member } = await office(); const other = await office();
    expect((await kernel.membershipManagement(owner.sessionToken)).members).toHaveLength(2);
    const restricted = await kernel.membershipManagement(member.sessionToken);
    expect(restricted.members).toEqual([]); expect(restricted.invitations).toEqual([]);
    await expect(kernel.offerOwnership(member.sessionToken, owner.memberId)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(kernel.offerOwnership(owner.sessionToken, other.member.memberId)).rejects.toMatchObject({ code: 'not_found' });
    await expect(kernel.leaveMembership(owner.sessionToken, randomBytes(32).toString('base64url'))).rejects.toMatchObject({ code: 'owner_transfer_required' });
  });
  it('requires recipient acceptance, changes authority atomically and preserves private scopes', async () => {
    const { owner, member } = await office();
    const unused = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Unused' });
    const offer = await kernel.offerOwnership(owner.sessionToken, member.memberId);
    expect((await kernel.authenticateSession(owner.sessionToken)).role).toBe('owner');
    expect((await kernel.membershipManagement(member.sessionToken)).transfer?.id).toBe(offer.id);
    await expect(kernel.acceptOwnership(owner.sessionToken, offer.id)).rejects.toMatchObject({ code: 'conflict' });
    await kernel.acceptOwnership(member.sessionToken, offer.id);
    await kernel.acceptOwnership(member.sessionToken, offer.id); // lost-response retry
    expect((await kernel.authenticateSession(member.sessionToken)).role).toBe('owner');
    expect((await kernel.authenticateSession(owner.sessionToken)).role).toBe('member');
    const scopes = await kernel.listScopes(member.sessionToken);
    expect(scopes.find(scope => scope.kind === 'company')?.ownerMemberId).toBe(member.memberId);
    expect(scopes.some(scope => scope.id === owner.privateScope.id)).toBe(false);
    await expect(kernel.issueInvitation(owner.sessionToken, { displayName: 'Blocked' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(kernel.redeemInvitation(unused.invitationToken)).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  it('denies cancelled, expired and revoked-recipient transfers', async () => {
    const { owner, member } = await office();
    const cancelled = await kernel.offerOwnership(owner.sessionToken, member.memberId);
    await kernel.cancelOwnership(member.sessionToken, cancelled.id);
    await expect(kernel.acceptOwnership(member.sessionToken, cancelled.id)).rejects.toMatchObject({ code: 'conflict' });
    const expired = await kernel.offerOwnership(owner.sessionToken, member.memberId);
    await fixture.adminPool.query("UPDATE realbud_company.ownership_transfers SET expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1", [expired.id]);
    await expect(kernel.acceptOwnership(member.sessionToken, expired.id)).rejects.toMatchObject({ code: 'conflict' });
    const revoked = await kernel.offerOwnership(owner.sessionToken, member.memberId);
    await kernel.revokeMember(owner.sessionToken, member.memberId);
    await expect(kernel.acceptOwnership(member.sessionToken, revoked.id)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect((await kernel.authenticateSession(owner.sessionToken)).role).toBe('owner');
  });
  it('serializes owner acceptance against revocation without leaving two owners or a revoked owner', async () => {
    const { owner, member } = await office();
    const offer = await kernel.offerOwnership(owner.sessionToken, member.memberId);
    const results = await Promise.allSettled([kernel.acceptOwnership(member.sessionToken, offer.id), kernel.revokeMember(owner.sessionToken, member.memberId)]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const rows = await fixture.adminPool.query("SELECT id,role,active FROM realbud_company.members WHERE company_id=$1 AND role='owner'", [owner.companyId]);
    expect(rows.rows).toHaveLength(1); expect(rows.rows[0].active).toBe(true);
    expect(rows.rows[0].id).toBe(results[0].status === 'fulfilled' ? member.memberId : owner.memberId);
  });
  it('serializes departure against new shared work so a successful write cannot be orphaned', async () => {
    const { owner, member } = await office();
    const results = await Promise.allSettled([
      kernel.leaveMembership(member.sessionToken, randomBytes(32).toString('base64url')),
      kernel.shareWork(member.sessionToken, { requestId: randomUUID(), title: 'Concurrent review', summary: 'Synthetic race', purpose: 'request-review', recipientMemberIds: [owner.memberId], assigneeMemberId: owner.memberId }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    if (results[1].status === 'fulfilled') expect((await kernel.authenticateSession(member.sessionToken)).memberId).toBe(member.memberId);
    else await expect(kernel.authenticateSession(member.sessionToken)).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  it('blocks unresolved shared work, then revokes every session and records a private departure receipt', async () => {
    const { owner, member } = await office();
    const work = await kernel.shareWork(member.sessionToken, { requestId: randomUUID(), title: 'Review', summary: 'Synthetic draft', purpose: 'request-review', recipientMemberIds: [owner.memberId], assigneeMemberId: owner.memberId });
    const operationToken = randomBytes(32).toString('base64url');
    await expect(kernel.leaveMembership(member.sessionToken, operationToken)).rejects.toMatchObject({ code: 'work_resolution_required' });
    expect(await kernel.departureStatus(operationToken)).toEqual({ completed: false });
    await kernel.closeSharedWork(member.sessionToken, { id: work.id, expectedRevision: work.revision });
    await kernel.leaveMembership(member.sessionToken, operationToken);
    await expect(kernel.authenticateSession(member.sessionToken)).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(await kernel.departureStatus(operationToken)).toEqual({ completed: true });
    expect(await kernel.departureStatus(randomBytes(32).toString('base64url'))).toEqual({ completed: false });
    const audit = await fixture.adminPool.query("SELECT details FROM realbud_company.audit_events WHERE company_id=$1 AND kind='membership.left'", [owner.companyId]);
    expect(audit.rows).toHaveLength(1); expect(JSON.stringify(audit.rows)).not.toContain(operationToken);
  });
});
