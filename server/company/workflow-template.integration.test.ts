import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createCompanyKernel, migrateCompanySchema, type CompanyKernel } from './index.ts';

const url = process.env.REALBUD_COMPANY_TEST_URL;
const template = { version: 1, recipes: [{ id: 'wf-fixture-priorities', title: 'Synthetic priorities', steps: ['Review supplied synthetic sources'],
  allowedOrigins: [], capabilities: ['read-files', 'analyse', 'draft'], status: 'active', planApprovedAt: 1,
  schedule: { time: '09:00', weekdays: [1] }, cookies: 'SYNTHETIC-SECRET' }] };

describe.skipIf(!url)('company workflow templates on PostgreSQL', () => {
  let admin: Pool, app: Pool, second: Pool, kernel: CompanyKernel, other: CompanyKernel;
  beforeAll(async () => {
    const target = new URL(url!);
    if (!/^\/realbud_company_test_[a-z0-9_]+$/.test(target.pathname)) throw new Error('Disposable database required');
    admin = new Pool({ connectionString: target.toString() });
    await migrateCompanySchema(admin, { applicationRole: 'rb_company_test_app' });
    target.username = 'rb_company_test_app';
    app = new Pool({ connectionString: target.toString(), max: 3 }); second = new Pool({ connectionString: target.toString(), max: 3 });
    kernel = createCompanyKernel(app); other = createCompanyKernel(second);
  });
  afterAll(async () => { await Promise.all([admin?.end(), app?.end(), second?.end()]); });
  async function office() {
    const owner = await kernel.createCompany({ name: 'Template fixture', ownerName: 'Alice' });
    const invite = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Bob' });
    const member = await other.redeemInvitation(invite.invitationToken);
    return { owner, member };
  }
  it('shares dormant plans with a second member and preserves the template in a new kernel', async () => {
    const { owner, member } = await office();
    const saved = await kernel.publishWorkflowTemplate(owner.sessionToken, { expectedRevision: '0', template });
    expect(saved.revision).toBe('1'); expect(saved.template.recipes[0].schedule).toBeNull();
    expect(JSON.stringify(saved)).not.toMatch(/SYNTHETIC-SECRET|planApprovedAt|"status"/);
    expect(await other.readWorkflowTemplate(member.sessionToken)).toEqual(saved);
    expect(await createCompanyKernel(second).readWorkflowTemplate(member.sessionToken)).toEqual(saved);
  });
  it('rejects member publication, revoked reads and cross-company visibility', async () => {
    const { owner, member } = await office();
    await kernel.publishWorkflowTemplate(owner.sessionToken, { expectedRevision: '0', template });
    await expect(other.publishWorkflowTemplate(member.sessionToken, { expectedRevision: '1', template })).rejects.toMatchObject({ code: 'forbidden' });
    const different = await office();
    expect((await other.readWorkflowTemplate(different.owner.sessionToken)).template).toBeNull();
    await kernel.revokeMember(owner.sessionToken, member.memberId);
    await expect(other.readWorkflowTemplate(member.sessionToken)).rejects.toMatchObject({ code: 'unauthenticated' });
  });
  it('admits one concurrent revision and keeps the previous value after malformed input', async () => {
    const { owner } = await office();
    const input = { expectedRevision: '0', template };
    const results = await Promise.allSettled([kernel.publishWorkflowTemplate(owner.sessionToken, input), other.publishWorkflowTemplate(owner.sessionToken, input)]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } });
    await expect(kernel.publishWorkflowTemplate(owner.sessionToken, { expectedRevision: '1', template: { version: 1, recipes: [template.recipes[0], { id: '../bad' }] } })).rejects.toMatchObject({ code: 'invalid_input' });
    expect((await other.readWorkflowTemplate(owner.sessionToken)).revision).toBe('1');
  });
  it('enforces owner-only writes and company isolation in PostgreSQL RLS itself', async () => {
    const { owner, member } = await office();
    await kernel.publishWorkflowTemplate(owner.sessionToken, { expectedRevision: '0', template });
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('realbud.company_id',$1,true),set_config('realbud.member_id',$2,true)", [owner.companyId, member.memberId]);
      expect((await client.query('UPDATE realbud_company.workflow_templates SET revision=2 WHERE company_id=$1', [owner.companyId])).rowCount).toBe(0);
      const otherCompany = await office();
      await kernel.publishWorkflowTemplate(otherCompany.owner.sessionToken, { expectedRevision: '0', template });
      expect((await client.query('SELECT * FROM realbud_company.workflow_templates WHERE company_id=$1', [otherCompany.owner.companyId])).rowCount).toBe(0);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('checks the additive template migration checksum', async () => {
    const saved = (await admin.query("SELECT checksum FROM realbud_company.schema_migrations WHERE id='0003'")).rows[0].checksum;
    await admin.query("UPDATE realbud_company.schema_migrations SET checksum='tampered' WHERE id='0003'");
    try { await expect(migrateCompanySchema(admin, { applicationRole: 'rb_company_test_app' })).rejects.toThrow('checksum mismatch'); }
    finally { await admin.query("UPDATE realbud_company.schema_migrations SET checksum=$1 WHERE id='0003'", [saved]); }
  });
});
