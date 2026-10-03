import { describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalWebsiteCommand } from './website-commands.ts';
import { departmentConfigurationAllows, departmentConfigurationReviewMaterial, normalizeDepartmentConfiguration, normalizeDepartmentConfigurationPlan, normalizeSaveDepartmentConfiguration, type DepartmentConfiguration } from './department-configuration.ts';
const hash = (v: unknown) => createHash('sha256').update(canonicalWebsiteCommand(v)).digest('hex');
function configuration(): DepartmentConfiguration {
  const review = { plan: { title: 'Case review', description: '', steps: ['Review supplied case'], evidence: '', capabilities: ['analyse' as const], allowedOrigins: [], limits: { maxRuntimeMinutes: 1, maxTurns: 2 }, siteNotes: null }, instructions: 'Ask for missing evidence.' };
  return { version: 1, template: 'accounts-admin', plans: [{ recipe: { id: 'case-review', revision: 1, digest: hash(review.plan), instructionDigest: hash(review.instructions), review }, pack: null }], workflowDefaults: [{ id: 'accounts', label: 'Accounts', defaultRecipeId: 'case-review' }] };
}
describe('department configuration contract', () => {
  it('keeps selected exact bytes and does not confuse independent local counters with authority', () => {
    const c = configuration(), normalized = normalizeDepartmentConfiguration(c);
    expect(normalized).toEqual(c); expect(normalized).not.toBe(c);
    expect(departmentConfigurationAllows(c, { ...c.plans[0].recipe, revision: 81 })).toBe(true);
    expect(departmentConfigurationAllows(null, c.plans[0].recipe)).toBe(false);
    expect(departmentConfigurationAllows(c, { ...c.plans[0].recipe, id: 'unselected' })).toBe(false);
    const changed = structuredClone(c.plans[0].recipe); changed.review.instructions += ' changed';
    expect(departmentConfigurationAllows(c, changed)).toBe(false);
  });
  it('refuses hidden authority fields, duplicate plans/defaults and dangling default plans', () => {
    const c = configuration();
    for (const value of [{ ...c, credentials: {} }, { ...c, template: ['custom'] }, { ...c, template: { toString: () => 'custom' } }, { ...c, plans: [...c.plans, ...c.plans] }, { ...c, workflowDefaults: [...c.workflowDefaults, ...c.workflowDefaults] },
      { ...c, workflowDefaults: [{ ...c.workflowDefaults[0], defaultRecipeId: 'other' }] }, { ...c, workflowDefaults: [{ ...c.workflowDefaults[0], permission: 'write' }] }]) expect(() => normalizeDepartmentConfiguration(value)).toThrow();
  });
  it('refuses extra capability, origins, oversized aggregate, too many plans/defaults and invalid provenance', () => {
    const c = configuration();
    for (const change of [{ capabilities: ['analyse', 'send'] }, { allowedOrigins: ['https://example.com'] }]) {
      const v = structuredClone(c); Object.assign(v.plans[0].recipe.review.plan, change); expect(() => normalizeDepartmentConfiguration(v)).toThrow();
    }
    const large = configuration(); large.plans = Array.from({ length: 8 }, (_, i) => ({ ...structuredClone(c.plans[0]), recipe: { ...structuredClone(c.plans[0].recipe), id: `plan-${i}`, review: { ...structuredClone(c.plans[0].recipe.review), instructions: 'x'.repeat(4000) } } })); large.workflowDefaults = [];
    expect(() => normalizeDepartmentConfiguration(large)).toThrow();
    expect(() => normalizeDepartmentConfiguration({ ...c, plans: Array.from({ length: 9 }, (_, i) => ({ ...c.plans[0], recipe: { ...c.plans[0].recipe, id: `plan-${i}` } })) })).toThrow();
    expect(() => normalizeDepartmentConfiguration({ ...c, workflowDefaults: Array.from({ length: 9 }, (_, i) => ({ id: `role-${i}`, label: 'Role', defaultRecipeId: null })) })).toThrow();
    expect(() => normalizeDepartmentConfiguration({ ...c, plans: [{ ...c.plans[0], pack: { id: '../private', revision: 1, bindingDigest: 'a'.repeat(64) } }] })).toThrow();
  });
  it('binds review to company, department, revision, complete configuration, note and rollback source', () => {
    const company = randomUUID(), input = { departmentId: randomUUID(), expectedRevision: '2', configuration: configuration(), note: 'Reviewed plans', sourceReceiptId: null };
    const material = departmentConfigurationReviewMaterial(company, input);
    for (const changed of [{ ...input, departmentId: randomUUID() }, { ...input, expectedRevision: '3' }, { ...input, note: 'Different review' }, { ...input, sourceReceiptId: randomUUID() }, { ...input, configuration: { ...input.configuration, template: 'custom' as const } }]) expect(departmentConfigurationReviewMaterial(company, changed)).not.toBe(material);
    expect(departmentConfigurationReviewMaterial(randomUUID(), input)).not.toBe(material);
    const request = { ...input, requestId: randomUUID(), reviewDigest: createHash('sha256').update(material).digest('hex') };
    expect(normalizeSaveDepartmentConfiguration(request)).toEqual(request);
    expect(() => normalizeSaveDepartmentConfiguration({ ...request, ownerApproved: true })).toThrow();
  });
  it('rejects lone surrogates in every free-text configuration field and the review reason before persistence', () => {
    const fields: ((c: DepartmentConfiguration, value: string) => void)[] = [
      (c, value) => { c.plans[0].recipe.id = value; c.workflowDefaults[0].defaultRecipeId = value; },
      (c, value) => { c.plans[0].recipe.review.instructions = value; },
      (c, value) => { c.plans[0].recipe.review.plan.title = value; },
      (c, value) => { c.plans[0].recipe.review.plan.description = value; },
      (c, value) => { c.plans[0].recipe.review.plan.steps[0] = value; },
      (c, value) => { c.plans[0].recipe.review.plan.evidence = value; },
      (c, value) => { c.plans[0].recipe.review.plan.siteNotes = value; },
      (c, value) => { c.workflowDefaults[0].label = value; },
    ];
    for (const value of ['\uD800', '\uDC00', 'text\uD800end', '\uDC00\uD800']) {
      for (const set of fields) { const c = configuration(); set(c, value); expect(() => normalizeDepartmentConfiguration(c)).toThrow(); }
      const plan = configuration().plans[0]; plan.recipe.review.instructions = value;
      expect(() => normalizeDepartmentConfigurationPlan(plan)).toThrow();
      const input = { requestId: randomUUID(), departmentId: randomUUID(), expectedRevision: '2', configuration: configuration(), note: value, sourceReceiptId: null, reviewDigest: 'a'.repeat(64) };
      expect(() => normalizeSaveDepartmentConfiguration(input)).toThrow();
      expect(() => departmentConfigurationReviewMaterial(randomUUID(), input)).toThrow();
    }
    const valid = configuration();
    for (const set of fields) set(valid, 'Fictional review 🏡 — café');
    expect(normalizeDepartmentConfiguration(valid)).toEqual(valid);
    expect(normalizeSaveDepartmentConfiguration({ requestId: randomUUID(), departmentId: randomUUID(), expectedRevision: '2', configuration: valid, note: 'Reviewed 🏡', sourceReceiptId: null, reviewDigest: 'a'.repeat(64) }).note).toBe('Reviewed 🏡');
  });
});
