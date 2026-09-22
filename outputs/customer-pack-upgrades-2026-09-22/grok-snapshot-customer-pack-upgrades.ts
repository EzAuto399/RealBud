import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import type { Recipe } from '../shared/contracts.ts';
import type { CustomerPack, CustomerPackRecipe, CustomerPackChangePreview } from '../shared/customer-packs.ts';
import { AGENCY_RECIPE_ROLES, workflowRecipeId } from '../shared/agency-workflow-packs.ts';
import { validateRecipe } from './recipes.ts';

export type SkillVersion = { revision: number; digest: string; content: string; createdAt: string; reason: string };
export type SkillOverride = { activeRevision: number; versions: SkillVersion[] };
export type PackConfiguration = { pack: CustomerPack; digest: string; overrides?: Record<string, SkillOverride> };
export type PackSnapshot = PackConfiguration & { generation: number; savedAt: string; recipes: CustomerPackRecipe[]; retiredRecipeIds: string[] };
type RecipeChange = { id: string; revision: number; beforeStamp: string | null; before: CustomerPackRecipe | null; after: CustomerPackRecipe; retired: boolean };
type ArtifactChange = { key: string; before: string | null; after: string | null };
export type PackTransition = {
  version: 1; action: 'upgrade' | 'rollback'; requestDigest: string; previewDigest: string;
  fromGeneration: number; fromDigest: string; scope: string; target: PackConfiguration; before: PackSnapshot;
  recipes: RecipeChange[]; artifacts: ArtifactChange[]; retiredRecipeIds: string[];
};
export type PackUpgradeState = PackConfiguration & {
  generation?: number; history?: PackSnapshot[]; transition?: PackTransition; retiredRecipeIds?: string[];
  lastTransition?: { requestDigest: string; fromGeneration: number; targetDigest: string };
};
export type PackArtifact = { key: string; path: string; contents: string };
export const packChangeHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bad = (message: string): never => { throw Object.assign(new Error(message), { status: 409 }); };
const definition = (recipe: CustomerPackRecipe | Recipe): CustomerPackRecipe => ({ id: recipe.id, ...validateRecipe(recipe) });
const off = (recipe: CustomerPackRecipe): CustomerPackRecipe => ({ ...recipe, schedule: null });
const stamp = (recipe: Recipe) => packChangeHash({ ...definition(recipe), revision: recipe.revision, status: recipe.status,
  planApprovedAt: recipe.planApprovedAt, approvedRevision: recipe.approvedRevision, attachment: recipe.attachment, submitAcknowledgedAt: recipe.submitAcknowledgedAt });
const digest = (pack: CustomerPack) => createHash('sha256').update(JSON.stringify(pack)).digest('hex');
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const portableId = (value: unknown): value is string => typeof value === 'string' && /^[a-z][a-z0-9-]{1,79}$/.test(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key));

/** Used by live journals and portable backup admission. Old journals have no
 * upgrade state; new history is bounded and never contains arbitrary paths. */
export function validatePackUpgradeState(entry: PackUpgradeState, validatePack: (value: unknown) => CustomerPack): void {
  const invalid = () => bad('Pack change history needs recovery. Its saved files and plans were preserved.');
  const configuration = (value: unknown): boolean => {
    if (!object(value)) return false;
    try { const pack = validatePack(value.pack); if (pack.id !== entry.pack.id || digest(pack) !== value.digest) return false; } catch { return false; }
    if (value.overrides !== undefined && !object(value.overrides)) return false;
    for (const [id, override] of Object.entries(value.overrides ?? {}) as [string, SkillOverride][]) {
      if (!value.pack.skills.some((skill: { id: string }) => skill.id === id) || !object(override) || !positive(override.activeRevision) ||
          !Array.isArray(override.versions) || !override.versions.length || override.versions.length > 100 ||
          new Set(override.versions.map(v => v.revision)).size !== override.versions.length || !override.versions.some(v => v.revision === override.activeRevision) ||
          override.versions.some(v => !object(v) || !positive(v.revision) || typeof v.content !== 'string' || v.content.length > 40_000 ||
            createHash('sha256').update(v.content).digest('hex') !== v.digest || typeof v.createdAt !== 'string' || typeof v.reason !== 'string')) return false;
    }
    return true;
  };
  const definitions = (values: unknown): values is CustomerPackRecipe[] => {
    if (!Array.isArray(values) || values.length > 60 || new Set(values.map(v => v?.id)).size !== values.length) return false;
    try { return values.every(v => portableId(v.id) && same(v, definition(v))); } catch { return false; }
  };
  const ids = (values: unknown): values is string[] => Array.isArray(values) && values.length <= 300 && values.every(portableId) && new Set(values).size === values.length;
  const snapshot = (value: unknown): value is PackSnapshot => object(value) && configuration(value) && positive(value.generation) &&
    typeof value.savedAt === 'string' && Number.isFinite(Date.parse(value.savedAt)) && definitions(value.recipes) &&
    value.recipes.length === value.pack.recipes.length && value.pack.recipes.every((r: CustomerPackRecipe) => value.recipes.some((p: CustomerPackRecipe) => p.id === r.id)) && ids(value.retiredRecipeIds);
  if (entry.generation !== undefined && !positive(entry.generation) || entry.retiredRecipeIds !== undefined && !ids(entry.retiredRecipeIds) ||
      entry.history !== undefined && (!Array.isArray(entry.history) || entry.history.length > 8 || entry.history.some(s => !snapshot(s)) ||
        new Set(entry.history.map(s => s.generation)).size !== entry.history.length || entry.history.some(s => s.generation >= (entry.generation ?? 1)))) invalid();
  if (entry.lastTransition && (!hex(entry.lastTransition.requestDigest) || !positive(entry.lastTransition.fromGeneration) || !hex(entry.lastTransition.targetDigest))) invalid();
  const change = entry.transition;
  if (!change) return;
  if (!object(change) || !exact(change, ['version','action','requestDigest','previewDigest','fromGeneration','fromDigest','scope','target','before','recipes','artifacts','retiredRecipeIds']) ||
      change.version !== 1 || !['upgrade','rollback'].includes(change.action) || !hex(change.requestDigest) || !hex(change.previewDigest) || !hex(change.scope) ||
      change.fromGeneration !== (entry.generation ?? 1) || change.fromDigest !== entry.digest || !configuration(change.target) || !snapshot(change.before) ||
      change.before.digest !== entry.digest || change.before.generation !== change.fromGeneration || !ids(change.retiredRecipeIds) ||
      !Array.isArray(change.recipes) || change.recipes.length > 60 || new Set(change.recipes.map(r => r.id)).size !== change.recipes.length ||
      change.recipes.some(r => !object(r) || !portableId(r.id) || !Number.isSafeInteger(r.revision) || r.revision < 0 || typeof r.retired !== 'boolean' ||
        !definitions([r.after]) || r.after.id !== r.id || r.after.schedule !== null ||
        (r.before === null ? r.revision !== 0 || r.beforeStamp !== null : !definitions([r.before]) || r.before.id !== r.id || !hex(r.beforeStamp) || r.revision < 1)) ||
      !Array.isArray(change.artifacts) || change.artifacts.length > 120 || new Set(change.artifacts.map(a => a.key)).size !== change.artifacts.length ||
      change.artifacts.some(a => !object(a) || !/^(native|guidance|license):[a-z][a-z0-9-]{1,79}$/.test(a.key) ||
        ![a.before,a.after].every(value => value === null || typeof value === 'string' && value.length <= 100_000)) ||
      change.previewDigest !== transitionDigest(change)) invalid();
}

type Dependencies = {
  listRecipes(): Recipe[];
  artifacts(configuration: PackConfiguration): PackArtifact[];
  artifactState(path: string, contents: string): Promise<'missing' | 'identical' | 'conflict'>;
  scope(): string;
};
const transitionDigest = (change: Pick<PackTransition,'action'|'fromGeneration'|'fromDigest'|'scope'|'target'|'before'|'recipes'|'artifacts'|'retiredRecipeIds'>) =>
  packChangeHash({ action:change.action,fromGeneration:change.fromGeneration,fromDigest:change.fromDigest,scope:change.scope,target:change.target,
    before:{...change.before,savedAt:undefined},recipes:change.recipes,artifacts:change.artifacts,retiredRecipeIds:change.retiredRecipeIds });

export async function previewPackChange(entry: PackUpgradeState, targetPack: CustomerPack, allEntries: PackUpgradeState[], deps: Dependencies,
  rollback?: PackSnapshot): Promise<{ preview: CustomerPackChangePreview; change: PackTransition }> {
  const conflicts: string[] = [];
  if (entry.transition) conflicts.push('Finish the saved pack change before previewing another version.');
  if ((entry.history?.length ?? 0) >= 8) conflicts.push('Eight prior configurations are retained. Export the pack history and ask service support to archive it before another change.');
  if (targetPack.id !== entry.pack.id || !rollback && targetPack.revision <= entry.pack.revision) conflicts.push('Choose a newer revision of this same pack, or explicitly preview a saved rollback.');
  for (const role of AGENCY_RECIPE_ROLES) {
    const required = workflowRecipeId(entry.pack.id, role);
    if (required && !targetPack.recipes.some(r => r.id === required)) conflicts.push(`Keep ${required}: this installed RealBud version uses that fixed business-workflow role. A host adapter migration is required before removing it.`);
  }
  const local = new Map(deps.listRecipes().map(recipe => [recipe.id, recipe]));
  const base = new Map(entry.pack.recipes.map(recipe => [recipe.id, recipe]));
  const desired = new Map((rollback?.recipes ?? targetPack.recipes).map(recipe => [recipe.id, recipe]));
  const recipes: RecipeChange[] = [], displayed: CustomerPackChangePreview['recipes'] = [];
  const recipeIds = [...new Set([...base.keys(), ...desired.keys()])];
  for (const id of recipeIds) {
    if (allEntries.some(other => other.pack.id !== entry.pack.id && (other.pack.recipes.some(r => r.id === id) || other.retiredRecipeIds?.includes(id))))
      conflicts.push(`${id} is claimed by another pack. Resolve plan ownership before changing it.`);
    const current = local.get(id), before = current ? definition(current) : null, published = base.get(id), wanted = desired.get(id);
    if (published && !current) conflicts.push(`${id} is missing. Repair its installed plan before upgrading.`);
    if (!published && current && !entry.retiredRecipeIds?.includes(id)) conflicts.push(`${id} already exists outside this pack. Rename the incoming plan or resolve its ownership first.`);
    let after = wanted ? definition(wanted) : before!;
    if (!after) continue;
    if (current && wanted) {
      const original = definition(published ?? wanted), merged: Record<string, unknown> = { ...definition(current) };
      for (const field of Object.keys(original) as (keyof CustomerPackRecipe)[]) {
        if (field === 'id' || field === 'schedule') continue;
        if (same(after[field], original[field])) continue;
        if (same(before![field], original[field]) || same(before![field], after[field])) merged[field] = after[field];
        else conflicts.push(`${id}: both your local plan and the incoming version changed ${field}. Resolve that field in the plan or revise the pack, then preview again.`);
      }
      after = definition(merged as CustomerPackRecipe);
    }
    after = off(after);
    recipes.push({ id, revision:current?.revision ?? 0,beforeStamp:current ? stamp(current) : null,before,after,retired:!wanted });
    displayed.push({ id, action:!wanted ? 'retire' : !before ? 'add' : same(off(before),after) ? 'preserve' : 'update',before,after });
  }
  const overrides: Record<string, SkillOverride> = {};
  for (const skill of targetPack.skills) {
    const override = entry.overrides?.[skill.id] ?? rollback?.overrides?.[skill.id];
    if (override) overrides[skill.id] = structuredClone(override);
  }
  const target: PackConfiguration = { pack:targetPack,digest:digest(targetPack),...(Object.keys(overrides).length ? {overrides} : {}) };
  const previousArtifacts = new Map(deps.artifacts(entry).map(a => [a.key,a])), nextArtifacts = new Map(deps.artifacts(target).map(a => [a.key,a]));
  const others = allEntries.filter(e => e.pack.id !== entry.pack.id).flatMap(e => deps.artifacts(e));
  const artifacts: ArtifactChange[] = [];
  for (const key of new Set([...previousArtifacts.keys(),...nextArtifacts.keys()])) {
    const old = previousArtifacts.get(key), next = nextArtifacts.get(key), path = (old ?? next)!.path;
    const shared = others.filter(a => a.path === path);
    let before = old?.contents ?? null, after = next?.contents ?? null;
    if (shared.length) {
      if (next && shared.some(a => a.contents !== next.contents)) conflicts.push(`${key} is shared with another installed pack. A compatible shared instruction revision is required.`);
      if (!next) after = old!.contents; // Another pack still owns this support file.
      if (!old) before = next!.contents;
    }
    const state = await deps.artifactState(path,before ?? after!);
    if (before !== null && state !== 'identical') conflicts.push(`${key} is missing or locally edited. Repair or review that file before changing the pack.`);
    if (before === null && state !== 'missing') conflicts.push(`${key} already exists outside this installation. Preserve it and resolve ownership before adding the skill.`);
    artifacts.push({ key,before,after });
  }
  const retiredRecipeIds = [...new Set([...(entry.retiredRecipeIds ?? []),...recipes.filter(r => r.retired).map(r => r.id)])].filter(id => !desired.has(id));
  const before: PackSnapshot = {pack:entry.pack,digest:entry.digest,...(entry.overrides ? {overrides:entry.overrides} : {}),generation:entry.generation ?? 1,
    savedAt:new Date().toISOString(),recipes:entry.pack.recipes.map(r => local.get(r.id)).filter((r):r is Recipe => !!r).map(definition),retiredRecipeIds:entry.retiredRecipeIds ?? []};
  const change: PackTransition = { version:1,action:rollback ? 'rollback' : 'upgrade',requestDigest:'',previewDigest:'',fromGeneration:entry.generation ?? 1,
    fromDigest:entry.digest,scope:deps.scope(),target,before,recipes,artifacts,retiredRecipeIds };
  change.previewDigest = transitionDigest(change);
  return { change,preview:{action:change.action,pack:targetPack,digest:target.digest,installedDigest:entry.digest,installedRevision:change.fromGeneration,
    previewDigest:change.previewDigest,...(rollback ? {rollbackRevision:rollback.generation} : {}),recipes:displayed,
    skills:[...new Set([...entry.pack.skills.map(s=>s.id),...targetPack.skills.map(s=>s.id)])].map(id=>({id,
      action:!targetPack.skills.some(s=>s.id===id) ? 'retire' : !entry.pack.skills.some(s=>s.id===id) ? 'add' : artifacts.some(a=>a.key.endsWith(`:${id}`)&&a.before!==a.after) ? 'update' : 'preserve',overrideKept:!!overrides[id]})),
    instructions:artifacts.filter(a=>a.before!==a.after),conflicts,canApply:conflicts.length===0 } };
}

export function checkPackRecipeStage(change: PackTransition, current: Recipe[]): 'before' | 'paused' | 'after' {
  const local = new Map(current.map(r=>[r.id,r]));
  const paused = (row:RecipeChange, target:CustomerPackRecipe, revision:number) => {
    const saved=local.get(row.id);
    return !!saved && saved.revision===revision && saved.status==='shadow' && saved.schedule===null && saved.planApprovedAt===null && saved.approvedRevision===null && same(definition(saved),target);
  };
  if (change.recipes.every(r=>paused(r,r.after,r.revision===0 ? 1 : r.revision+1+(same(off(r.before!),r.after)?0:1)))) return 'after';
  if (change.recipes.every(r=>r.before===null ? !local.has(r.id) : paused(r,off(r.before),r.revision+1))) return 'paused';
  if (change.recipes.every(r=>r.before===null ? !local.has(r.id) : local.has(r.id)&&stamp(local.get(r.id)!)===r.beforeStamp)) return 'before';
  return bad('Plans changed during this pack update. Keep the saved change and ask service support to reconcile the listed plans; no newer plan was overwritten.');
}

export function packRecipeWrites(change: PackTransition) {
  return change.recipes.map(r=>({...r.after,status:'shadow',expectedRevision:r.revision===0 ? 0 : r.revision+1}));
}
