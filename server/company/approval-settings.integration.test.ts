import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCompanyKernel } from './index.ts';
import { startCompanyPostgresFixture } from './testing-postgres.ts';
import { APPROVAL_SETTINGS_KEY, defaultApprovalSettings, type ApprovalChoice, type ApprovalSettings } from '../../shared/approval-settings.ts';

const settings = (groups: Record<string, ApprovalChoice> = {}, reviewedReads: string[] = []): ApprovalSettings =>
  ({ version: 1, purpose: 'approval-settings', groups, reviewedReads });

describe.runIf(process.env.REALBUD_TEST_POSTGRES === '1')('department approval settings on actual PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof startCompanyPostgresFixture>>, directory: string, kernel: ReturnType<typeof createCompanyKernel>;
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'rb-approval-settings-'));
    fixture = await startCompanyPostgresFixture({ outputDirectory: directory, postgresBinDirectory: process.env.REALBUD_TEST_POSTGRES_BIN });
    kernel = createCompanyKernel(fixture.pool);
  }, 60_000);
  afterAll(async () => { await fixture?.stop(); if (directory) await rm(directory, { recursive: true, force: true }); });

  async function office(name: string) {
    const owner = await kernel.createCompany({ name, ownerName: 'Fictional owner' });
    const invite = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Fictional member' }), member = await kernel.redeemInvitation(invite.invitationToken);
    let accounts = await kernel.createDepartment(owner.sessionToken, { requestId: randomUUID(), name: 'Accounts' });
    accounts = await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: accounts.id, memberId: member.memberId, access: 'write', expectedRevision: accounts.revision });
    const leasing = await kernel.createDepartment(owner.sessionToken, { requestId: randomUUID(), name: 'Leasing' });
    return { owner, member, accounts, leasing };
  }

  it('lets an editor save, gives a read-only member forbidden, and lets the owner reset any department', async () => {
    const o = await office('Fictional Acacia');
    const overview = await kernel.approvalSettingsOverview(o.member.sessionToken);
    expect(overview.member).toMatchObject({ id: o.member.memberId, role: 'member' });
    expect(overview.departments).toEqual([{ id: o.accounts.id, name: 'Accounts', canEdit: true, governs: true, revision: '0', settings: defaultApprovalSettings() }]);

    const strict = settings({ 'app:gmail': 'ask', 'class:send': 'deny' });
    const saved = await kernel.saveApprovalSettings(o.member.sessionToken, { departmentId: o.accounts.id, expectedRevision: '0', settings: strict });
    expect(saved).toMatchObject({ department: { id: o.accounts.id, name: 'Accounts' }, revision: '1', settings: strict, savedBy: { id: o.member.memberId, displayName: 'Fictional member' } });
    await expect(kernel.saveApprovalSettings(o.member.sessionToken, { departmentId: o.accounts.id, expectedRevision: '0', settings: strict })).rejects.toMatchObject({ code: 'conflict' });
    await expect(kernel.saveApprovalSettings(o.member.sessionToken, { departmentId: o.accounts.id, expectedRevision: '1', settings: { ...strict, groups: { 'class:send': 'read-without-asking' } } })).rejects.toMatchObject({ code: 'invalid_input' });
    // Not granted: Leasing is invisible to the member.
    await expect(kernel.saveApprovalSettings(o.member.sessionToken, { departmentId: o.leasing.id, expectedRevision: '0', settings: strict })).rejects.toMatchObject({ code: 'not_found' });

    const read = await kernel.setDepartmentAccess(o.owner.sessionToken, { departmentId: o.accounts.id, memberId: o.member.memberId, access: 'read', expectedRevision: o.accounts.revision });
    expect((await kernel.approvalSettingsOverview(o.member.sessionToken)).departments).toEqual([{ id: read.id, name: 'Accounts', canEdit: false, governs: true, revision: '1', settings: strict }]);
    await expect(kernel.saveApprovalSettings(o.member.sessionToken, { departmentId: o.accounts.id, expectedRevision: '1', settings: settings() })).rejects.toMatchObject({ code: 'forbidden' });

    // The owner sees every department, governed by none of them, and may reset any.
    expect((await kernel.approvalSettingsOverview(o.owner.sessionToken)).departments.map(d => [d.name, d.canEdit, d.governs])).toEqual([['Accounts', true, false], ['Leasing', true, false]]);
    const reset = await kernel.saveApprovalSettings(o.owner.sessionToken, { departmentId: o.accounts.id, expectedRevision: '1', settings: defaultApprovalSettings() });
    expect(reset).toMatchObject({ revision: '2', settings: defaultApprovalSettings(), savedBy: { id: o.owner.memberId } });

    const history = await kernel.approvalSettingsHistory(o.member.sessionToken, { departmentId: o.accounts.id, limit: 10 });
    expect(history.entries.map(e => [e.revision, e.by.displayName, e.before, e.after])).toEqual([
      ['2', 'Fictional owner', strict, defaultApprovalSettings()],
      ['1', 'Fictional member', defaultApprovalSettings(), strict],
    ]);
    expect((await kernel.approvalSettingsHistory(o.member.sessionToken, { departmentId: o.accounts.id, limit: 1 })).entries.map(e => [e.revision, e.before])).toEqual([['2', strict]]);
  });

  it('keeps reviewed reads owner-only and the record off the generic knowledge path', async () => {
    const o = await office('Fictional Banksia');
    await expect(kernel.saveApprovalSettings(o.member.sessionToken, { departmentId: o.accounts.id, expectedRevision: '0', settings: settings({}, ['GMAIL_FETCH_EMAILS']) })).rejects.toMatchObject({ code: 'forbidden' });
    await kernel.saveApprovalSettings(o.owner.sessionToken, { departmentId: o.accounts.id, expectedRevision: '0', settings: settings({ 'app:gmail': 'read-without-asking' }, ['GMAIL_FETCH_EMAILS']) });
    // An editor may change groups as long as the owner's reviewed list is unchanged.
    await kernel.saveApprovalSettings(o.member.sessionToken, { departmentId: o.accounts.id, expectedRevision: '1', settings: settings({ 'app:gmail': 'ask' }, ['GMAIL_FETCH_EMAILS']) });
    await expect(kernel.saveApprovalSettings(o.member.sessionToken, { departmentId: o.accounts.id, expectedRevision: '2', settings: settings({ 'app:gmail': 'ask' }) })).rejects.toMatchObject({ code: 'forbidden' });
    for (const token of [o.owner.sessionToken, o.member.sessionToken]) {
      await expect(kernel.replaceKnowledge(token, { scopeId: o.accounts.id, key: APPROVAL_SETTINGS_KEY, expectedRevision: '2', content: JSON.stringify(settings({ 'app:gmail': 'read-without-asking' })) })).rejects.toMatchObject({ code: 'forbidden' });
    }
    // Another office cannot read or change it.
    const other = await office('Fictional Coolabah');
    await expect(kernel.saveApprovalSettings(other.owner.sessionToken, { departmentId: o.accounts.id, expectedRevision: '2', settings: settings() })).rejects.toMatchObject({ code: 'not_found' });
    await expect(kernel.approvalSettingsHistory(other.owner.sessionToken, { departmentId: o.accounts.id, limit: 10 })).rejects.toMatchObject({ code: 'not_found' });
  });
});
