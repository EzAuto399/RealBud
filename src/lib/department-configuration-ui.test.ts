import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { normalizeDepartmentConfiguration, type DepartmentConfigurationCandidates, type DepartmentConfigurationPlan } from '@shared/department-configuration';
vi.mock('@/state/store', () => ({ api: vi.fn() }));
import { CompanyDepartmentConfiguration, departmentStarterSelection, departmentConfigurationUnchanged, departmentConfigurationImpact, departmentConfigurationImpactSummary } from '@/components/CompanyDepartmentConfiguration';

const plan = (suffix: string): DepartmentConfigurationPlan => ({
  recipe: { id: `wf-department-starters-${suffix}`, revision: 7, digest: 'a'.repeat(64), instructionDigest: 'b'.repeat(64), review: {
    plan: { title: `Fictional ${suffix}`, description: 'Review supplied fictional facts.', steps: ['Read only the supplied case.'], evidence: 'A draft for review.', capabilities: ['analyse', 'draft'], allowedOrigins: [], limits: { maxRuntimeMinutes: 2, maxTurns: 6 }, siteNotes: null },
    instructions: `Reviewed fictional instructions for ${suffix}.`,
  } }, pack: { id: 'department-starters', revision: 1, bindingDigest: 'c'.repeat(64) },
});
const fixture = (candidates = ['pm-maintenance', 'accounts-bank', 'pm-property', 'accounts-admin', 'accounts-invoice', 'unrelated'].map(plan)): DepartmentConfigurationCandidates => ({
  department: { id: 'a0000000-0000-4000-8000-000000000001', name: 'Fictional department', revision: '9', access: 'write', retiredAt: null, retiredBy: null, retirementNote: '', unresolvedCases: 3 },
  configuration: null, canManage: true, candidates, unavailable: [], omitted: 0,
});

describe('department starter selection is a draft convenience', () => {
  it('selects the three Accounts groups in their displayed order using only exact reviewed candidates', () => {
    const data = fixture(), before = structuredClone(data), selected = departmentStarterSelection(data, 'accounts-admin');
    expect(selected.workflowDefaults).toEqual([
      { id: 'invoice', label: 'Invoice issues', defaultRecipeId: 'wf-department-starters-accounts-invoice' },
      { id: 'admin', label: 'General admin and mail cases', defaultRecipeId: 'wf-department-starters-accounts-admin' },
      { id: 'bank', label: 'Bank exceptions', defaultRecipeId: 'wf-department-starters-accounts-bank' },
    ]);
    expect(selected.plans).toEqual(['accounts-invoice', 'accounts-admin', 'accounts-bank'].map(plan));
    expect(normalizeDepartmentConfiguration(selected)).toEqual(selected);
    expect(data).toEqual(before);
  });

  it('selects the two Property Management groups without Accounts plans', () => {
    const selected = departmentStarterSelection(fixture(), 'property-management');
    expect(selected.workflowDefaults).toEqual([
      { id: 'property', label: 'Owner and property cases', defaultRecipeId: 'wf-department-starters-pm-property' },
      { id: 'maintenance', label: 'Maintenance and inspections', defaultRecipeId: 'wf-department-starters-pm-maintenance' },
    ]);
    expect(selected.plans).toEqual(['pm-property', 'pm-maintenance'].map(plan));
    expect(normalizeDepartmentConfiguration(selected)).toEqual(selected);
  });

  it('leaves missing starter groups unassigned rather than substituting another available plan', () => {
    const similar = { ...plan('accounts-bank'), recipe: { ...plan('accounts-bank').recipe, id: 'accounts-bank' } };
    const data = fixture([plan('accounts-invoice'), similar, plan('unrelated')]);
    data.unavailable = [{ id: 'wf-department-starters-accounts-bank', reason: 'The exact approved pack is unavailable.' }];
    data.omitted = 30;
    const selected = departmentStarterSelection(data, 'accounts-admin');
    expect(selected.plans).toEqual([plan('accounts-invoice')]);
    expect(selected.workflowDefaults.map(item => item.defaultRecipeId)).toEqual(['wf-department-starters-accounts-invoice', null, null]);
    expect(normalizeDepartmentConfiguration(selected)).toEqual(selected);
  });

  it.each([['accounts-admin', 3], ['property-management', 2]] as const)('keeps %s group names but no invented plans when candidates are absent', (template, count) => {
    const selected = departmentStarterSelection(fixture([]), template);
    expect(selected.plans).toEqual([]);
    expect(selected.workflowDefaults).toHaveLength(count);
    expect(selected.workflowDefaults.every(item => item.defaultRecipeId === null)).toBe(true);
    expect(normalizeDepartmentConfiguration(selected)).toEqual(selected);
  });

  it('starts Custom with no implicit plans or work types', () => {
    expect(departmentStarterSelection(fixture(), 'custom')).toEqual({ version: 1, template: 'custom', plans: [], workflowDefaults: [] });
  });

  it('does not grant membership, alter revision, manufacture approval, or rewrite reviewed plan bytes', () => {
    const data = fixture(); data.canManage = false; data.department.access = 'read';
    const before = structuredClone(data), selected = departmentStarterSelection(data, 'accounts-admin');
    expect(data).toEqual(before);
    expect(Object.keys(selected).sort()).toEqual(['plans', 'template', 'version', 'workflowDefaults']);
    for (const selectedPlan of selected.plans) {
      expect(selectedPlan).toEqual(before.candidates.find(candidate => candidate.recipe.id === selectedPlan.recipe.id));
      expect(Object.keys(selectedPlan).sort()).toEqual(['pack', 'recipe']);
    }
  });

  it('renders a checking state without editable or approval controls before permission data arrives', () => {
    const html = renderToStaticMarkup(createElement(CompanyDepartmentConfiguration, { departmentId: fixture().department.id, operationBlocked: true }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Checking current workflow settings');
    expect(html).toContain('Each assigned case still needs its own owner approval.');
    expect(html).not.toMatch(/<form\b|<input\b|<select\b|Save reviewed department workflows/);
    expect(html).toMatch(/<button\b[^>]*disabled=""[^>]*>Refresh current workflow settings<\/button>/);
  });
});


describe('configuration change safeguards', () => {
  it('recognizes the same normalized saved definition despite object key order, but allows first setup and changed defaults', () => {
    const original = departmentStarterSelection(fixture(), 'accounts-admin');
    const reordered = { workflowDefaults: original.workflowDefaults, plans: original.plans, template: original.template, version: original.version };
    expect(departmentConfigurationUnchanged(original, reordered)).toBe(true);
    expect(departmentConfigurationUnchanged(null, original)).toBe(false);
    expect(departmentConfigurationUnchanged(original, { ...original, workflowDefaults: original.workflowDefaults.map((row, index) => index ? row : { ...row, label: 'Changed label' }) })).toBe(false);
    expect(departmentConfigurationUnchanged(original, { ...original, plans: [...original.plans, original.plans[0]] })).toBe(false);
  });
  it('counts only current non-revoked permissions and claimed cases, and exposes partial pagination', () => {
    const preparations = { grants: [
      { current: true, phase: 'pending' as const }, { current: true, phase: 'active' as const },
      { current: true, phase: 'admitted' as const }, { current: false, phase: 'active' as const },
      { current: true, phase: 'revoked' as const },
    ], hasMore: false };
    const cases = { cases: [{ status: 'claimed' as const }, { status: 'open' as const }, { status: 'recovery_required' as const }], hasMore: false };
    expect(departmentConfigurationImpact(preparations, cases)).toEqual({ permissions: 3, claimed: 1, complete: true });
    expect(departmentConfigurationImpact({ ...preparations, hasMore: true }, cases)).toEqual({ permissions: null, claimed: null, complete: false });
    expect(departmentConfigurationImpact(preparations, { ...cases, hasMore: true }).complete).toBe(false);
  });
  it('never reports zero impact from an oldest page of expired permissions when later pages exist', () => {
    const firstPage = { grants: Array.from({ length: 10 }, () => ({ current: false, phase: 'revoked' as const })), hasMore: true };
    const result = departmentConfigurationImpact(firstPage, { cases: [], hasMore: false });
    expect(result).toEqual({ permissions: null, claimed: null, complete: false });
    expect(departmentConfigurationImpactSummary(result)).toContain('cannot count all affected work');
    expect(departmentConfigurationImpactSummary(result)).not.toMatch(/0|zero/);
  });
});
