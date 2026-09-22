/** Host-owned recipe roles. An imported title or model response cannot bind a
 * plan to a business workflow; the agency explicitly selects one known pack. */
export const AGENCY_WORKFLOW_PACK_IDS = ['office-core', 'austin-office'] as const;
export type AgencyWorkflowPackId = typeof AGENCY_WORKFLOW_PACK_IDS[number];
export const AGENCY_WORKFLOW_PACK_NAMES: Record<AgencyWorkflowPackId, string> = {
  'office-core': 'Real estate office core',
  'austin-office': 'Austin office workflows',
};
export const AGENCY_RECIPE_ROLES = ['inbox-triage', 'invoice-review', 'bill-exceptions', 'bank-reference-prep'] as const;
export type AgencyRecipeRole = typeof AGENCY_RECIPE_ROLES[number];
const bindings: Record<AgencyWorkflowPackId, Record<AgencyRecipeRole, string>> = {
  'office-core': {
    'inbox-triage': 'wf-office-core-inbox-triage',
    'invoice-review': 'wf-office-core-invoice-review',
    'bill-exceptions': 'wf-office-core-bill-exceptions',
    'bank-reference-prep': 'wf-office-core-bank-reference-prep',
  },
  'austin-office': {
    'inbox-triage': 'wf-austin-accounts-inbox-triage',
    'invoice-review': 'wf-austin-accounts-invoice-review',
    'bill-exceptions': 'wf-austin-accounts-bill-exceptions',
    'bank-reference-prep': 'wf-austin-accounts-anz-reference-prep',
  },
};
export function isAgencyWorkflowPackId(value: unknown): value is AgencyWorkflowPackId {
  return typeof value === 'string' && (AGENCY_WORKFLOW_PACK_IDS as readonly string[]).includes(value);
}
export function workflowRecipeId(packId: unknown, role: AgencyRecipeRole): string | null {
  return isAgencyWorkflowPackId(packId) && (AGENCY_RECIPE_ROLES as readonly string[]).includes(role) ? bindings[packId][role] : null;
}
export function agencyRecipeRole(recipeId: string): AgencyRecipeRole | null {
  for (const packId of AGENCY_WORKFLOW_PACK_IDS) for (const role of AGENCY_RECIPE_ROLES) if (bindings[packId][role] === recipeId) return role;
  return null;
}
