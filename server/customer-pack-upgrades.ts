import { createHash } from 'node:crypto';
import { isDeepStrictEqual as same } from 'node:util';
import type { Recipe } from '../shared/contracts.ts';
import type { CustomerPack, CustomerPackRecipe, CustomerPackChangePreview } from '../shared/customer-packs.ts';
import { AGENCY_RECIPE_ROLES, workflowRecipeId } from '../shared/agency-workflow-packs.ts';
import { validateRecipe } from './recipes.ts';
import { validateSkillOverride, validateSkillArchiveJournal, type SkillArchiveHead, type SkillArchiveIntent } from './customer-pack-skill-history.ts';

export type SkillVersion = { revision: number; digest: string; content: string; createdAt: string; reason: string };
export type SkillOverride = { activeRevision: number; versions: SkillVersion[]; archiveHead?: SkillArchiveHead };
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
  generation?: number; history?: PackSnapshot[]; skillArchiveIntent?: SkillArchiveIntent; lastSkillArchive?: SkillArchiveIntent; transition?: PackTransition; retiredRecipeIds?: string[];
  archiveHead?: PackArchiveHead; archiveIntent?: PackArchiveIntent;
  lastArchive?: { previewDigest: string; fromDigest: string; fromGeneration: number; archiveDigest: string; scope: string };
  lastTransition?: { requestDigest: string; previewDigest: string; fromDigest: string; fromGeneration: number; targetDigest: string };
};
/** A retired plan stays reserved for rollback; an interrupted change reserves
 * its target before recipe creation. Identical bytes do not transfer ownership. */
export function packRecipeClaims(entry: PackUpgradeState): Set<string> {
  return new Set([
    ...entry.pack.recipes.map(recipe => recipe.id), ...(entry.retiredRecipeIds ?? []),
    ...(entry.transition?.target.pack.recipes.map(recipe => recipe.id) ?? []),
    ...(entry.transition?.recipes.map(recipe => recipe.id) ?? []),
    ...(entry.transition?.retiredRecipeIds ?? []),
  ]);
}
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
export function validatePackUpgradeState(entry: PackUpgradeState, validatePack: (value: unknown) => CustomerPack, completeHistory = true): void {
  const invalid = () => bad('Pack change history needs recovery. Its saved files and plans were preserved.');
  const configuration = (value: unknown): boolean => {
    if (!object(value)) return false;
    try { const pack = validatePack(value.pack); if (pack.id !== entry.pack.id || digest(pack) !== value.digest) return false; } catch { return false; }
    if (value.overrides !== undefined && !object(value.overrides)) return false;
    for (const [id, override] of Object.entries(value.overrides ?? {}) as [string, SkillOverride][]) {
      try { validateSkillOverride(override); } catch { return false; }
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
  if (completeHistory) {
    const ordered=[...(entry.history ?? [])].sort((a,b)=>a.generation-b.generation), start=entry.archiveHead?.throughGeneration ?? 0;
    if (start+ordered.length !== (entry.generation ?? 1)-1 || ordered.some((snapshot,index)=>snapshot.generation!==start+index+1)) invalid();
  }
  validateArchiveJournal(entry);
  validateSkillArchiveJournal(entry);
  if (entry.lastTransition && (!hex(entry.lastTransition.requestDigest) || !hex(entry.lastTransition.previewDigest) || !hex(entry.lastTransition.fromDigest) ||
      !positive(entry.lastTransition.fromGeneration) || !hex(entry.lastTransition.targetDigest))) invalid();
  const change = entry.transition;
  if (!change) return;
  if (!object(change) || !exact(change, ['version','action','requestDigest','previewDigest','fromGeneration','fromDigest','scope','target','before','recipes','artifacts','retiredRecipeIds']) ||
      change.version !== 1 || !['upgrade','rollback'].includes(change.action) || !hex(change.requestDigest) || !hex(change.previewDigest) || !hex(change.scope) ||
      change.fromGeneration !== (entry.generation ?? 1) || change.fromDigest !== entry.digest || !configuration(change.target) || !snapshot(change.before) ||
      change.before.digest !== entry.digest || change.before.generation !== change.fromGeneration || !same(change.before.overrides,entry.overrides) || !ids(change.retiredRecipeIds) ||
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
  if (entry.transition || entry.archiveIntent || entry.skillArchiveIntent) conflicts.push('Finish the saved pack change before previewing another version.');
  if ((entry.history?.length ?? 0) >= 8) conflicts.push('Eight prior configurations are retained. Archive older history in pack setup before another change; the two newest rollback configurations stay immediately available.');
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
  const otherClaims = new Set(allEntries.filter(other => other.pack.id !== entry.pack.id).flatMap(other => [...packRecipeClaims(other)]));
  for (const id of recipeIds) {
    if (otherClaims.has(id))
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


export type PackArchiveHead = { digest: string; batches: number; configurations: number; throughGeneration: number };
export type PackArchiveIntent = { previewDigest: string; fromGeneration: number; fromDigest: string; archivedAt: string; digest: string; scope: string };
export type PackHistoryArchive = {
  format: 'realbud-pack-history'; version: 1; packId: string; previous: PackArchiveHead | null;
  installedGeneration: number; installedDigest: string; previewDigest: string; scope: string; archivedAt: string; snapshots: PackSnapshot[];
};
export const PACK_ARCHIVE_MAX_BYTES = 2_000_000;
export const PACK_ARCHIVE_MAX_BATCHES = 10_000;
export const packArchivePath = (packId: string, digest: string) => `customer-pack-history/${packId}/${digest}.json`;
export const isPackArchivePath = (path: string) => /^customer-pack-history\/[a-z][a-z0-9-]{1,79}\/[a-f0-9]{64}\.json$/.test(path);
const archiveHeadValid = (value: unknown): value is PackArchiveHead => object(value) && exact(value,['digest','batches','configurations','throughGeneration']) &&
  hex(value.digest) && positive(value.batches) && value.batches <= PACK_ARCHIVE_MAX_BATCHES && positive(value.configurations) &&
  value.configurations >= value.batches && value.configurations <= value.batches * 6 && positive(value.throughGeneration) && value.throughGeneration === value.configurations;
function validateArchiveJournal(entry: PackUpgradeState) {
  const invalid = () => bad('Pack archive history needs recovery. Its saved configurations were preserved.');
  if (entry.archiveHead !== undefined && (!archiveHeadValid(entry.archiveHead) || entry.archiveHead.throughGeneration >= (entry.generation ?? 1) ||
      (entry.history ?? []).some(snapshot => snapshot.generation <= entry.archiveHead!.throughGeneration))) invalid();
  if (entry.lastArchive !== undefined && (!object(entry.lastArchive) || !exact(entry.lastArchive,['previewDigest','fromDigest','fromGeneration','archiveDigest','scope']) ||
      !hex(entry.lastArchive.previewDigest) || !hex(entry.lastArchive.fromDigest) || !positive(entry.lastArchive.fromGeneration) || !hex(entry.lastArchive.archiveDigest) || !hex(entry.lastArchive.scope))) invalid();
  const intent=entry.archiveIntent;
  if (intent !== undefined && (!object(intent) || !exact(intent,['previewDigest','fromGeneration','fromDigest','archivedAt','digest','scope']) ||
      !hex(intent.previewDigest) || !hex(intent.digest) || !hex(intent.scope) || intent.fromGeneration !== (entry.generation ?? 1) || intent.fromDigest !== entry.digest ||
      typeof intent.archivedAt !== 'string' || !Number.isFinite(Date.parse(intent.archivedAt)) || entry.transition ||
      intent.previewDigest !== packArchivePreviewDigest(entry,intent.scope) || intent.digest !== packChangeHash(packHistoryArchive(entry,intent.archivedAt,intent.scope)))) invalid();
}
export const archiveSnapshots = (entry: PackUpgradeState) => [...(entry.history ?? [])].sort((a,b)=>a.generation-b.generation).slice(0,-2);
export const packArchivePreviewDigest = (entry: PackUpgradeState, scope: string) => packChangeHash({packId:entry.pack.id, generation:entry.generation ?? 1,
  digest:entry.digest, scope, history:entry.history ?? [], head:entry.archiveHead ?? null});
export function packHistoryArchive(entry: PackUpgradeState, archivedAt: string, scope: string): PackHistoryArchive {
  return {format:'realbud-pack-history',version:1,packId:entry.pack.id,previous:entry.archiveHead ?? null,
    installedGeneration:entry.generation ?? 1,installedDigest:entry.digest,previewDigest:packArchivePreviewDigest(entry,scope),scope,archivedAt,snapshots:archiveSnapshots(entry)};
}
export function nextArchiveHead(record: PackHistoryArchive, digest: string): PackArchiveHead {
  return {digest,batches:(record.previous?.batches ?? 0)+1,configurations:(record.previous?.configurations ?? 0)+record.snapshots.length,
    throughGeneration:record.snapshots.at(-1)!.generation};
}
/** Pure file admission shared by live storage and both backup formats. */
export function validatePackHistoryArchive(value: unknown, expectedPackId: string, expectedDigest: string,
  validatePack: (value:unknown)=>CustomerPack): PackHistoryArchive {
  const invalid=():never=>bad('Archived pack configurations need recovery. No history was removed.');
  if (!object(value) || !exact(value,['format','version','packId','previous','installedGeneration','installedDigest','previewDigest','scope','archivedAt','snapshots']) ||
      value.format !== 'realbud-pack-history' || value.version !== 1 || value.packId !== expectedPackId || !portableId(value.packId) ||
      !hex(expectedDigest) || packChangeHash(value) !== expectedDigest || Buffer.byteLength(JSON.stringify(value)) > PACK_ARCHIVE_MAX_BYTES ||
      !positive(value.installedGeneration) || !hex(value.installedDigest) || !hex(value.previewDigest) || !hex(value.scope) ||
      typeof value.archivedAt !== 'string' || !Number.isFinite(Date.parse(value.archivedAt)) ||
      value.previous !== null && !archiveHeadValid(value.previous) || !Array.isArray(value.snapshots) || !value.snapshots.length || value.snapshots.length>6) return invalid();
  const archive=value as PackHistoryArchive;
  try {
    const first=archive.snapshots[0];
    if (!first || first.pack?.id !== expectedPackId) return invalid();
    validatePackUpgradeState({pack:first.pack,digest:first.digest,generation:archive.installedGeneration,history:archive.snapshots},validatePack,false);
    if (archive.snapshots.some((snapshot,index)=>snapshot.generation !== (index ? archive.snapshots[index-1].generation : archive.previous?.throughGeneration ?? 0)+1)) return invalid();
    if ((archive.previous?.batches ?? 0) >= PACK_ARCHIVE_MAX_BATCHES) return invalid();
  } catch { return invalid(); }
  return archive;
}
