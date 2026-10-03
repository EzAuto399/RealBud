import type { CompanyDepartment } from './company-api.ts';
import { companyExecutionSecret, companyExecutionUuid, isCompanyExecutionReview, type CompanyExecutionRecipe, type CompanyExecutionReview } from './company-execution.ts';
import { canonicalWebsiteCommand } from './website-commands.ts';

export const DEPARTMENT_CONFIGURATION_MAX_BYTES = 24 * 1024;
export type DepartmentConfigurationPlan = {
  recipe: CompanyExecutionRecipe & { review: CompanyExecutionReview };
  pack: null | { id: string; revision: number; bindingDigest: string };
};
export type DepartmentConfiguration = {
  version: 1;
  template: 'accounts-admin' | 'property-management' | 'custom';
  plans: DepartmentConfigurationPlan[];
  /** Workflow selection defaults, never member roles or additional authority. */
  workflowDefaults: { id: string; label: string; defaultRecipeId: string | null }[];
};
export type DepartmentConfigurationRead = { department: CompanyDepartment; configuration: DepartmentConfiguration | null; canManage: boolean };
export type SaveDepartmentConfigurationInput = {
  requestId: string; departmentId: string; expectedRevision: string;
  configuration: DepartmentConfiguration; reviewDigest: string; note: string; sourceReceiptId: string | null;
};
export type DepartmentConfigurationSaved = { department: CompanyDepartment; configuration: DepartmentConfiguration; receiptId: string; replayed: boolean };
export type DepartmentConfigurationHistoryItem = {
  receiptId: string; revision: string; previousRevision: string; savedAt: string;
  savedBy: { id: string; displayName: string }; note: string; sourceReceiptId: string | null;
  configuration: DepartmentConfiguration;
};
export type DepartmentConfigurationHistory = { department: CompanyDepartment; entries: DepartmentConfigurationHistoryItem[]; nextBeforeRevision: string | null };
export type DepartmentConfigurationCandidates = DepartmentConfigurationRead & { candidates: DepartmentConfigurationPlan[]; unavailable: { id: string; reason: string }[]; omitted: number };

const invalid = (): never => { throw new Error('Check the department workflow configuration and its reviewed plans.'); };
// In Unicode mode a valid surrogate pair is one code point outside this range.
// Lone surrogates cannot be stored in PostgreSQL jsonb; reject before journaling.
const wellFormed = (v: string): boolean => !/[\uD800-\uDFFF]/u.test(v);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function exact(v: unknown, fields: string[]): Record<string, unknown> {
  if (!object(v) || Object.keys(v).sort().join(',') !== [...fields].sort().join(',')) return invalid();
  return v;
}
function text(v: unknown, max: number): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || !wellFormed(v) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v)) return invalid();
  return v;
}
export function departmentConfigurationRevision(v: unknown): string {
  if (typeof v !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(v) || BigInt(v) > 9_223_372_036_854_775_807n) return invalid();
  return v;
}
function positive(v: unknown): number { if (!Number.isSafeInteger(v) || Number(v) < 1) return invalid(); return Number(v); }
function identifier(v: unknown): string { const s = text(v, 80); if (!/^[a-z][a-z0-9-]{1,79}$/.test(s)) return invalid(); return s; }
export function normalizeDepartmentConfigurationPlan(value: unknown): DepartmentConfigurationPlan {
  const row = exact(value, ['recipe', 'pack']);
  const recipe = exact(row.recipe, ['id', 'revision', 'digest', 'instructionDigest', 'review']);
  if (!companyExecutionSecret(recipe.digest) || !companyExecutionSecret(recipe.instructionDigest) || !isCompanyExecutionReview(recipe.review)) return invalid();
  const { plan, instructions } = recipe.review;
  if (![instructions, plan.title, plan.description, plan.evidence, ...plan.steps, ...(plan.siteNotes === null ? [] : [plan.siteNotes])].every(wellFormed)) return invalid();
  let pack: DepartmentConfigurationPlan['pack'] = null;
  if (row.pack !== null) {
    const p = exact(row.pack, ['id', 'revision', 'bindingDigest']);
    if (!companyExecutionSecret(p.bindingDigest)) return invalid();
    pack = { id: identifier(p.id), revision: positive(p.revision), bindingDigest: p.bindingDigest };
  }
  return { recipe: { id: text(recipe.id, 128), revision: positive(recipe.revision), digest: recipe.digest, instructionDigest: recipe.instructionDigest, review: structuredClone(recipe.review) }, pack };
}
export function normalizeDepartmentConfiguration(value: unknown): DepartmentConfiguration {
  const row = exact(value, ['version', 'template', 'plans', 'workflowDefaults']);
  if (row.version !== 1 || typeof row.template !== 'string' || !['accounts-admin', 'property-management', 'custom'].includes(row.template) ||
    !Array.isArray(row.plans) || row.plans.length > 8 || !Array.isArray(row.workflowDefaults) || row.workflowDefaults.length > 8) return invalid();
  const plans = row.plans.map(normalizeDepartmentConfigurationPlan), ids = new Set(plans.map(p => p.recipe.id));
  if (ids.size !== plans.length) return invalid();
  const workflowDefaults = row.workflowDefaults.map(value => {
    const d = exact(value, ['id', 'label', 'defaultRecipeId']);
    if (d.defaultRecipeId !== null && (typeof d.defaultRecipeId !== 'string' || !ids.has(d.defaultRecipeId))) return invalid();
    return { id: identifier(d.id), label: text(d.label, 120), defaultRecipeId: d.defaultRecipeId as string | null };
  });
  if (new Set(workflowDefaults.map(d => d.id)).size !== workflowDefaults.length) return invalid();
  const result: DepartmentConfiguration = { version: 1, template: row.template as DepartmentConfiguration['template'], plans, workflowDefaults };
  if (new TextEncoder().encode(JSON.stringify(result)).byteLength > DEPARTMENT_CONFIGURATION_MAX_BYTES) return invalid();
  return result;
}
export function isDepartmentConfiguration(value: unknown): value is DepartmentConfiguration {
  try { normalizeDepartmentConfiguration(value); return true; } catch { return false; }
}
export function normalizeSaveDepartmentConfiguration(value: unknown): SaveDepartmentConfigurationInput {
  const row = exact(value, ['requestId', 'departmentId', 'expectedRevision', 'configuration', 'reviewDigest', 'note', 'sourceReceiptId']);
  if (!companyExecutionUuid(row.requestId) || !companyExecutionUuid(row.departmentId) || !companyExecutionSecret(row.reviewDigest) ||
    row.sourceReceiptId !== null && !companyExecutionUuid(row.sourceReceiptId)) return invalid();
  return { requestId: row.requestId, departmentId: row.departmentId, expectedRevision: departmentConfigurationRevision(row.expectedRevision), configuration: normalizeDepartmentConfiguration(row.configuration),
    reviewDigest: row.reviewDigest, note: text(row.note, 2048).trim(), sourceReceiptId: row.sourceReceiptId as string | null };
}
/** Canonical bytes only. Hosts compute SHA-256 and verify all plan hashes. */
export function departmentConfigurationReviewMaterial(companyId: string, input: Omit<SaveDepartmentConfigurationInput, 'requestId' | 'reviewDigest'>): string {
  if (!companyExecutionUuid(companyId) || !companyExecutionUuid(input.departmentId) || input.sourceReceiptId !== null && !companyExecutionUuid(input.sourceReceiptId)) return invalid();
  return canonicalWebsiteCommand({ version: 1, companyId, departmentId: input.departmentId, expectedRevision: departmentConfigurationRevision(input.expectedRevision),
    configuration: normalizeDepartmentConfiguration(input.configuration), note: text(input.note, 2048).trim(), sourceReceiptId: input.sourceReceiptId });
}
/** Local revision counters are not shared version identities. The grant still
 * records the executing instance's revision; shared permission binds its bytes. */
export function departmentConfigurationAllows(configuration: unknown, recipe: CompanyExecutionRecipe): boolean {
  if (!recipe.review) return false;
  try { return normalizeDepartmentConfiguration(configuration).plans.some(p => p.recipe.id === recipe.id && p.recipe.digest === recipe.digest && p.recipe.instructionDigest === recipe.instructionDigest &&
    canonicalWebsiteCommand(p.recipe.review) === canonicalWebsiteCommand(recipe.review)); } catch { return false; }
}
