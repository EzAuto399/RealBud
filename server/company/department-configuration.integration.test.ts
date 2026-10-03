import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCompanyKernel } from './index.ts';
import { startCompanyPostgresFixture } from './testing-postgres.ts';
import { migrateCompanySchema } from './schema.ts';
import { createCompanyPortalCertificateGate } from './portal-proof.ts';
import { departmentConfigurationReviewMaterial, type DepartmentConfiguration, type SaveDepartmentConfigurationInput } from '../../shared/department-configuration.ts';
import { canonicalWebsiteCommand } from '../../shared/website-commands.ts';
import type { CompanyDepartment } from '../../shared/company-api.ts';
import type { AdmitCompanyExecution, BeginCompanyExecution } from '../../shared/company-execution.ts';

const hash = (v: unknown) => createHash('sha256').update(canonicalWebsiteCommand(v)).digest('hex');
function config(title = 'Review the assigned case'): DepartmentConfiguration {
  const review = { plan: { title, description: 'Fictional department facts only', steps: ['Summarize the supplied case', 'Ask for missing evidence'], evidence: 'Cite case facts', capabilities: ['analyse' as const, 'draft' as const], allowedOrigins: [], limits: { maxRuntimeMinutes: 1, maxTurns: 2 }, siteNotes: null }, instructions: 'Preserve uncertainty. Prepare text only.' };
  return { version: 1, template: 'accounts-admin', plans: [{ recipe: { id: 'case-review', revision: 1, digest: hash(review.plan), instructionDigest: hash(review.instructions), review }, pack: null }], workflowDefaults: [{ id: 'accounts', label: 'Accounts and general administration', defaultRecipeId: 'case-review' }] };
}

describe.runIf(process.env.REALBUD_TEST_POSTGRES === '1')('department workflow configuration on actual PostgreSQL', () => {
  let fixture: Awaited<ReturnType<typeof startCompanyPostgresFixture>>, directory: string, kernel: ReturnType<typeof createCompanyKernel>;
  const gate = createCompanyPortalCertificateGate(), bridge = { certificateDigest: () => 'a'.repeat(64), withCertificate: gate.run, verify: async () => { throw new Error('No provider mapping in this fixture'); } };
  beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'rb-department-config-')); fixture = await startCompanyPostgresFixture({ outputDirectory: directory, postgresBinDirectory: process.env.REALBUD_TEST_POSTGRES_BIN }); kernel = createCompanyKernel(fixture.pool, { portalBridge: bridge }); }, 60_000);
  afterAll(async () => { await fixture?.stop(); if (directory) await rm(directory, { recursive: true, force: true }); });
  async function office(name = 'Fictional agency') {
    const owner = await kernel.createCompany({ name, ownerName: 'Office owner' });
    const invite = await kernel.issueInvitation(owner.sessionToken, { displayName: 'Department member' }), member = await kernel.redeemInvitation(invite.invitationToken);
    let department = await kernel.createDepartment(owner.sessionToken, { requestId: randomUUID(), name: 'Accounts' });
    department = await kernel.setDepartmentAccess(owner.sessionToken, { departmentId: department.id, memberId: member.memberId, access: 'write', expectedRevision: department.revision });
    return { owner, member, department };
  }
  function change(o: Awaited<ReturnType<typeof office>>, department = o.department, configuration = config(), sourceReceiptId: string | null = null): SaveDepartmentConfigurationInput {
    const input = { departmentId: department.id, expectedRevision: department.revision, configuration, note: 'Owner reviewed this exact fictional configuration', sourceReceiptId };
    return { ...input, requestId: randomUUID(), reviewDigest: createHash('sha256').update(departmentConfigurationReviewMaterial(o.owner.companyId, input)).digest('hex') };
  }
  async function admitted(o: Awaited<ReturnType<typeof office>>, department: CompanyDepartment, configuration = config()) {
    const item = (await kernel.createDepartmentCase(o.owner.sessionToken, { departmentId: department.id, requestId: randomUUID(), title: 'Fictional invoice question', description: 'Selected fictional invoice facts', assigneeMemberId: o.member.memberId })).item;
    const input: BeginCompanyExecution = { version: 1, requestId: randomUUID(), grantSecret: randomBytes(32).toString('hex'), departmentId: department.id, expectedDepartmentRevision: department.revision, caseId: item.id, expectedCaseFence: item.fence, recipe: configuration.plans[0].recipe, executor: { workspaceId: randomUUID(), workerBinding: 'fixture-worker' }, durationMs: 60_000 };
    const pending = await kernel.beginDepartmentExecution(o.member.sessionToken, input), grant = await kernel.confirmDepartmentExecution(o.owner.sessionToken, { version: 1, requestId: randomUUID(), grantId: pending.id, expectedRevision: pending.revision, grantDigest: pending.digest });
    const request: AdmitCompanyExecution = { version: 1, grantId: grant.id, requestId: randomUUID(), executionId: randomUUID(), claimSecret: randomBytes(32).toString('hex'), ttlMs: 60_000 };
    const receipt = await kernel.admitDepartmentExecution(input.grantSecret, request);
    return { input, grant, item, request, check: { version: 1 as const, grantId: grant.id, executionId: request.executionId, claimSecret: request.claimSecret, fence: receipt.fence } };
  }
  it('starts unconfigured, denies non-owner changes and prevents a second agency from reading or changing the same plan IDs', async () => {
    const a = await office('Fictional Acacia'), b = await office('Fictional Banksia');
    expect(await kernel.departmentConfiguration(a.member.sessionToken, { departmentId: a.department.id })).toMatchObject({ configuration: null, canManage: false });
    await expect(kernel.saveDepartmentConfiguration(a.member.sessionToken, change(a))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(kernel.departmentConfiguration(b.owner.sessionToken, { departmentId: a.department.id })).rejects.toMatchObject({ code: 'not_found' });
    await expect(kernel.saveDepartmentConfiguration(b.owner.sessionToken, change(a))).rejects.toMatchObject({ code: 'not_found' });
    const savedA = await kernel.saveDepartmentConfiguration(a.owner.sessionToken, change(a));
    expect((await kernel.departmentConfiguration(b.owner.sessionToken, { departmentId: b.department.id })).configuration).toBeNull();
    const savedB = await kernel.saveDepartmentConfiguration(b.owner.sessionToken, change(b, b.department, config('Banksia review')));
    expect(savedB.configuration.plans[0].recipe.id).toBe(savedA.configuration.plans[0].recipe.id);
    expect((await kernel.departmentConfiguration(a.member.sessionToken, { departmentId: a.department.id })).configuration?.plans[0].recipe.review.plan.title).toBe('Review the assigned case');
    const read = await kernel.setDepartmentAccess(a.owner.sessionToken, { departmentId: a.department.id, memberId: a.member.memberId, access: 'read', expectedRevision: savedA.department.revision });
    expect((await kernel.departmentConfiguration(a.member.sessionToken, { departmentId: read.id })).configuration).toEqual(config());
    await expect(kernel.saveDepartmentConfiguration(a.member.sessionToken, change(a, read))).rejects.toMatchObject({ code: 'forbidden' });
    await kernel.setDepartmentAccess(a.owner.sessionToken, { departmentId: read.id, memberId: a.member.memberId, access: 'none', expectedRevision: read.revision });
    await expect(kernel.departmentConfiguration(a.member.sessionToken, { departmentId: read.id })).rejects.toMatchObject({ code: 'not_found' });
  });
  it('replays the original immutable receipt after a later save, and rollback appends a new reviewed version', async () => {
    const o = await office(), first = change(o), one = await kernel.saveDepartmentConfiguration(o.owner.sessionToken, first);
    const second = change(o, one.department, config('Changed workflow')), two = await kernel.saveDepartmentConfiguration(o.owner.sessionToken, second);
    const cold = createCompanyKernel(fixture.pool, { portalBridge: bridge });
    expect(await cold.saveDepartmentConfiguration(o.owner.sessionToken, first)).toEqual({ ...one, replayed: true });
    expect((await kernel.departmentConfiguration(o.owner.sessionToken, { departmentId: o.department.id })).configuration).toEqual(second.configuration);
    await expect(kernel.saveDepartmentConfiguration(o.owner.sessionToken, { ...first, note: 'Altered retry' })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(kernel.saveDepartmentConfiguration(o.owner.sessionToken, change(o))).rejects.toMatchObject({ code: 'conflict' });
    const rollback = change(o, two.department, first.configuration, one.receiptId), three = await kernel.saveDepartmentConfiguration(o.owner.sessionToken, rollback);
    expect(BigInt(three.department.revision)).toBe(BigInt(two.department.revision) + 1n);
    const history = await kernel.departmentConfigurationHistory(o.member.sessionToken, { departmentId: o.department.id, beforeRevision: null, limit: 10 });
    expect(history.entries.map(e => e.receiptId)).toEqual([three.receiptId, two.receiptId, one.receiptId]);
    expect(history.entries[0].sourceReceiptId).toBe(one.receiptId);
    expect((await kernel.departmentConfigurationHistory(o.member.sessionToken, { departmentId: o.department.id, beforeRevision: three.department.revision, limit: 10 })).entries.map(e => e.receiptId)).toEqual([two.receiptId, one.receiptId]);
    await expect(kernel.saveDepartmentConfiguration(o.owner.sessionToken, change(o, three.department, config('Tampered rollback'), one.receiptId))).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rejects direct execution for null, unselected or changed configuration and validates plan and review digests', async () => {
    const o = await office();
    await expect(admitted(o, o.department)).rejects.toMatchObject({ code: 'forbidden' });
    const broken = change(o); broken.configuration.plans[0].recipe.digest = 'f'.repeat(64);
    expect(() => kernel.saveDepartmentConfiguration(o.owner.sessionToken, broken)).toThrow('invalid_input');
    const saved = await kernel.saveDepartmentConfiguration(o.owner.sessionToken, change(o));
    const caseItem = (await kernel.createDepartmentCase(o.owner.sessionToken, { departmentId: o.department.id, requestId: randomUUID(), title: 'Direct request', description: '', assigneeMemberId: o.member.memberId })).item;
    const input: BeginCompanyExecution = { version: 1, requestId: randomUUID(), grantSecret: randomBytes(32).toString('hex'), departmentId: o.department.id, expectedDepartmentRevision: saved.department.revision, caseId: caseItem.id, expectedCaseFence: caseItem.fence, recipe: config('Different unreviewed content').plans[0].recipe, executor: { workspaceId: randomUUID(), workerBinding: 'fixture-worker' }, durationMs: 60_000 };
    await expect(kernel.beginDepartmentExecution(o.member.sessionToken, input)).rejects.toMatchObject({ code: 'forbidden' });
    input.recipe = { ...config().plans[0].recipe, revision: 37 };
    expect((await kernel.beginDepartmentExecution(o.member.sessionToken, input)).spec.recipe.revision).toBe(37);
  });
  it('save and reviewed rollback revoke admitted grants and retain cases for human recovery', async () => {
    const o = await office(), initial = await kernel.saveDepartmentConfiguration(o.owner.sessionToken, change(o));
    const running = await admitted(o, initial.department);
    const changed = await kernel.saveDepartmentConfiguration(o.owner.sessionToken, change(o, initial.department, config('New workflow')));
    await expect(kernel.checkDepartmentExecution(running.input.grantSecret, running.check)).rejects.toMatchObject({ code: 'stale_claim' });
    expect((await kernel.departmentCases(o.owner.sessionToken, { departmentId: o.department.id, filter: 'all' })).cases.find(c => c.id === running.item.id)).toMatchObject({ status: 'recovery_required', title: running.item.title });
    const next = await admitted(o, changed.department, changed.configuration);
    await kernel.saveDepartmentConfiguration(o.owner.sessionToken, change(o, changed.department, initial.configuration, initial.receiptId));
    await expect(kernel.checkDepartmentExecution(next.input.grantSecret, next.check)).rejects.toMatchObject({ code: 'stale_claim' });
    expect((await kernel.departmentCases(o.owner.sessionToken, { departmentId: o.department.id, filter: 'all' })).cases.find(c => c.id === next.item.id)?.status).toBe('recovery_required');
  });
  it('refuses unchanged saves and same-value rollback without revoking a live grant, changing a claim or adding history', async () => {
    const o = await office(), initial = await kernel.saveDepartmentConfiguration(o.owner.sessionToken, change(o)), running = await admitted(o, initial.department);
    const beforeGrant = await kernel.statusDepartmentExecution(running.input.grantSecret, { version: 1, grantId: running.grant.id });
    const beforeCheck = await kernel.checkDepartmentExecution(running.input.grantSecret, running.check);
    const casesBefore = await kernel.departmentCases(o.owner.sessionToken, { departmentId: o.department.id, filter: 'all' });
    for (const sourceReceiptId of [null, initial.receiptId]) {
      // JSONB field order differs from request order; compare normalized values.
      const same = JSON.parse(JSON.stringify(initial.configuration));
      same.workflowDefaults[0] = { defaultRecipeId: same.workflowDefaults[0].defaultRecipeId, label: same.workflowDefaults[0].label, id: same.workflowDefaults[0].id };
      const request = change(o, initial.department, same, sourceReceiptId);
      await expect(kernel.saveDepartmentConfiguration(o.owner.sessionToken, request)).rejects.toMatchObject({ code: 'invalid_input' });
      expect((await fixture.adminPool.query('SELECT count(*)::int AS n FROM realbud_company.audit_events WHERE id=$1', [request.requestId])).rows[0].n).toBe(0);
    }
    expect((await kernel.departmentConfiguration(o.owner.sessionToken, { departmentId: o.department.id })).department.revision).toBe(initial.department.revision);
    expect(await kernel.statusDepartmentExecution(running.input.grantSecret, { version: 1, grantId: running.grant.id })).toEqual(beforeGrant);
    expect(beforeGrant).toMatchObject({ phase: 'admitted', current: true, revokedAt: null });
    expect(await kernel.checkDepartmentExecution(running.input.grantSecret, running.check)).toEqual(beforeCheck);
    expect(await kernel.departmentCases(o.owner.sessionToken, { departmentId: o.department.id, filter: 'all' })).toEqual(casesBefore);
    expect(casesBefore.cases.find(c => c.id === running.item.id)?.status).toBe('claimed');
    expect((await kernel.departmentConfigurationHistory(o.owner.sessionToken, { departmentId: o.department.id, beforeRevision: null, limit: 10 })).entries.map(e => e.receiptId)).toEqual([initial.receiptId]);
  });
  it('preserves unreadable stored configuration and audit records while refusing authority and ordinary replacement', async () => {
    const o = await office(), initial = await kernel.saveDepartmentConfiguration(o.owner.sessionToken, change(o)), running = await admitted(o, initial.department);
    const corrupt = { version: 99, preserved: 'Fictional unsupported stored configuration' };
    await fixture.adminPool.query('UPDATE realbud_company.scopes SET department_configuration=$2 WHERE id=$1', [o.department.id, JSON.stringify(corrupt)]);
    await expect(kernel.departmentConfiguration(o.owner.sessionToken, { departmentId: o.department.id })).rejects.toMatchObject({ code: 'recovery_required' });
    await expect(kernel.saveDepartmentConfiguration(o.owner.sessionToken, change(o, initial.department, config('Replacement')))).rejects.toMatchObject({ code: 'recovery_required' });
    await expect(kernel.checkDepartmentExecution(running.input.grantSecret, running.check)).rejects.toMatchObject({ code: 'stale_claim' });
    expect((await fixture.adminPool.query('SELECT department_configuration FROM realbud_company.scopes WHERE id=$1', [o.department.id])).rows[0].department_configuration).toEqual(corrupt);
    // Valid history can still be read independently of an invalid current value.
    expect((await kernel.departmentConfigurationHistory(o.owner.sessionToken, { departmentId: o.department.id, beforeRevision: null, limit: 10 })).entries[0].receiptId).toBe(initial.receiptId);
    await fixture.adminPool.query("UPDATE realbud_company.audit_events SET details=jsonb_set(details,'{afterConfiguration}',$2::jsonb) WHERE id=$1", [initial.receiptId, JSON.stringify(corrupt)]);
    await expect(kernel.departmentConfigurationHistory(o.owner.sessionToken, { departmentId: o.department.id, beforeRevision: null, limit: 10 })).rejects.toMatchObject({ code: 'recovery_required' });
    expect((await fixture.adminPool.query("SELECT details->'afterConfiguration' AS preserved FROM realbud_company.audit_events WHERE id=$1", [initial.receiptId])).rows[0].preserved).toEqual(corrupt);
  });
  it('migration from the exact preceding schema retains work and immutable grants while revoking unconfigured legacy authority', async () => {
    const o = await office(), saved = await kernel.saveDepartmentConfiguration(o.owner.sessionToken, change(o)), running = await admitted(o, saved.department);
    const before = (await fixture.adminPool.query('SELECT title,description FROM realbud_company.cases WHERE id=$1', [running.item.id])).rows[0];
    await fixture.adminPool.query("ALTER TABLE realbud_company.scopes DROP CONSTRAINT department_configuration_scope; ALTER TABLE realbud_company.scopes DROP COLUMN department_configuration; DELETE FROM realbud_company.schema_migrations WHERE id='0009'");
    await migrateCompanySchema(fixture.adminPool, { applicationRole: 'rb_company_test_app' });
    const cold = createCompanyKernel(fixture.pool, { portalBridge: bridge });
    expect((await cold.departmentConfiguration(o.owner.sessionToken, { departmentId: o.department.id })).configuration).toBeNull();
    const row = (await fixture.adminPool.query('SELECT title,description,status FROM realbud_company.cases WHERE id=$1', [running.item.id])).rows[0];
    expect(row).toEqual({ ...before, status: 'recovery_required' });
    expect((await cold.statusDepartmentExecution(running.input.grantSecret, { version: 1, grantId: running.grant.id }))).toMatchObject({ current: false, phase: 'revoked', spec: running.grant.spec });
    await expect(cold.checkDepartmentExecution(running.input.grantSecret, running.check)).rejects.toMatchObject({ code: 'stale_claim' });
    const retained = (await fixture.adminPool.query('SELECT count(*)::int AS n FROM realbud_company.audit_events WHERE id=$1', [saved.receiptId])).rows[0].n;
    expect(retained).toBe(1);
    const revision = (await cold.departmentConfiguration(o.owner.sessionToken, { departmentId: o.department.id })).department.revision;
    await migrateCompanySchema(fixture.adminPool, { applicationRole: 'rb_company_test_app' });
    expect((await cold.departmentConfiguration(o.owner.sessionToken, { departmentId: o.department.id })).department.revision).toBe(revision);
  });
});
