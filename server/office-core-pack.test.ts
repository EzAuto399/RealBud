import { describe, expect, it } from 'vitest';
import { officeCoreCustomerPack } from './office-core-pack.ts';
import { austinCustomerPack } from './customer-pack-definition.ts';
import { validateCustomerPack } from './customer-packs.ts';
import { AGENCY_RECIPE_ROLES, AGENCY_WORKFLOW_PACK_IDS, agencyRecipeRole, workflowRecipeId } from '../shared/agency-workflow-packs.ts';

describe('portable office core pack', () => {
  it('validates a complete independent portable pack with no agency, person, credentials or active schedules', () => {
    const pack = validateCustomerPack(officeCoreCustomerPack());
    expect(pack.id).toBe('office-core'); expect(pack.revision).toBe(1);
    expect(pack.workflows.map(workflow => workflow.id)).toEqual(['bank-references', 'bills-calendar', 'morning-priorities']);
    expect(pack.recipes.map(recipe => recipe.id).sort()).toEqual(AGENCY_RECIPE_ROLES.map(role => workflowRecipeId(pack.id, role)!).sort());
    expect(JSON.stringify(pack)).not.toMatch(/Austin|Kevin|austin-office|austin-accounts|\/Users\/|[A-Z]:\\/);
    expect(pack.recipes.every(recipe => recipe.schedule === null && recipe.allowedOrigins.length === 0 && recipe.capabilities.every(capability => ['read-files', 'analyse', 'draft'].includes(capability)))).toBe(true);
    expect(pack.recipes.find(recipe => recipe.id === workflowRecipeId(pack.id, 'bank-reference-prep'))!.description).toContain('This preparation adapter supports ANZ only.');
    expect(pack.recipes.find(recipe => recipe.id === workflowRecipeId(pack.id, 'inbox-triage'))!.steps[0]).toContain('realbud-office-core-email-inbox-triage');
  });
  it('returns fresh published bytes independent of mutable caller results and keeps customer recipe IDs separate', () => {
    const original = officeCoreCustomerPack(), edited = officeCoreCustomerPack(); edited.recipes[0].description = 'Caller edit'; edited.skills[0].instructions = 'Caller edit';
    expect(officeCoreCustomerPack()).toEqual(original);
    const customer = austinCustomerPack();
    expect(original.recipes.every(recipe => !customer.recipes.some(existing => recipe.id === existing.id))).toBe(true);
    expect(customer.id).toBe('austin-office'); expect(customer.recipes[0].description).toContain('Kevin');
    expect(original.skills[0].instructions).toBe(customer.skills[0].instructions);
    expect(original.skills[0].license).toBe(customer.skills[0].license);
  });
  it('resolves only known explicit pack/role identities and rejects missing, title-based or spoofed bindings', () => {
    for (const id of AGENCY_WORKFLOW_PACK_IDS) for (const role of AGENCY_RECIPE_ROLES) expect(agencyRecipeRole(workflowRecipeId(id, role)!)).toBe(role);
    for (const id of [null, undefined, '', 'Real estate office core', 'office-core-copy', '__proto__', 'constructor']) expect(workflowRecipeId(id, 'inbox-triage')).toBeNull();
    for (const recipe of ['', 'Accounts morning inbox review', 'wf-office-core-inbox-triage-copy', '__proto__']) expect(agencyRecipeRole(recipe)).toBeNull();
  });
});
