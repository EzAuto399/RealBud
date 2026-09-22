import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile, unlink, readdir } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import type { Recipe } from '../shared/contracts.ts';
import type { CustomerPack, CustomerPackCheck, CustomerPackCheckId, CustomerPackInstallation, CustomerPackPreview, CustomerPackArchivePreview, CustomerPackArchivedHistory, CustomerPackHistoryItem, PackSkillProposal, PackSkillRevisionMetadata, PackSkillHistorySummary, PackSkillArchivePreview, PackSkillArchiveConfirmation, PackSkillHistoryPage, PackSkillHistorySelection, PackSkillRevertPreview } from '../shared/customer-packs.ts';
import { loadRecipes, resetRecipeApprovalsAtomically, saveRecipesAtomically, validateRecipe } from './recipes.ts';
import { privateDirectory, readPrivateJson, writePrivateJson } from './private-json.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { austinCustomerPack } from './customer-pack-definition.ts';
import { officeCoreCustomerPack } from './office-core-pack.ts';
import { writeFileAtomic, fsyncDir } from './atomic.ts';
import { learningPolicyReady, stagedLearningEnabled, stagedLearningSupported } from './hermes-pack.ts';
import { parseDocument } from 'yaml';
import { containsCredential } from './redact.ts';
import { checkPackRecipeStage, packChangeHash, packRecipeClaims, packRecipeWrites, previewPackChange, validatePackUpgradeState,
  archiveSnapshots, packArchivePreviewDigest, packHistoryArchive, nextArchiveHead, validatePackHistoryArchive, packArchivePath, isPackArchivePath, PACK_ARCHIVE_MAX_BYTES, PACK_ARCHIVE_MAX_BATCHES,
  type PackHistoryArchive, type PackSnapshot, type PackConfiguration, type PackUpgradeState, type SkillVersion } from './customer-pack-upgrades.ts';

import { skillArchivePath, skillHistoryHash, validateSkillOverride, validateSkillJournalRoot, skillArchivePreviewDigest, skillHistoryArchive, nextSkillArchiveHead, validateSkillHistoryArchive, SKILL_ARCHIVE_MAX_BYTES, SKILL_ARCHIVE_MAX_BATCHES, SKILL_HISTORY_PAGE_SIZE, PACK_JOURNAL_MAX_BYTES, SKILL_ARCHIVE_INTENT_ALLOWANCE, type SkillHistoryArchive, type SkillArchiveHead, type SkillArchiveIntent, type SkillRevertReceipt } from './customer-pack-skill-history.ts';

const hash = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
function fail(message: string, status = 400): never { throw Object.assign(new Error(message), { status }); }
const ids = /^[a-z][a-z0-9-]{1,79}$/;
const checks: CustomerPackCheckId[] = ['worker', 'mail-account', 'browser-account', 'bank-mapping', 'bill-register', 'input-coverage', 'timezone', 'workflow-acceptance'];
/** Copy for a prerequisite the host has not reported. State stays 'unknown',
 * which is never passing: each sentence says the check has not been performed
 * on this computer, so an installed pack cannot read as ready. */
const unobserved: Record<CustomerPackCheckId, Omit<CustomerPackCheck, 'id' | 'state'>> = {
  worker: { label: 'Local worker', detail: 'The local worker has not been checked on this computer. No plan in this pack can prepare work until it is.', nextAction: 'Open worker setup and install or verify the pinned local worker.' },
  'mail-account': { label: 'Selected mail account', detail: 'The selected mail account has not been checked on this computer. A saved connection or a connected label is not verified read access.', nextAction: 'Open Connections, select the private mail account for this pack, then verify its current read access.' },
  'browser-account': { label: 'Bank or portal sign-in', detail: 'A supervised bank or portal sign-in has not been checked on this computer. Bud never signs in, pays or submits by itself.', nextAction: 'Start the portal job beside you, sign in yourself, then confirm the page Bud may read.' },
  'bank-mapping': { label: 'Property reference mapping', detail: 'The property reference mapping has not been checked on this computer. Without it no payment can be matched to a property.', nextAction: 'Open Agency workflow setup and save a reviewed reference for each property in the bank scope.' },
  'bill-register': { label: 'Expected bill records', detail: 'The expected-bills store has not been checked on this computer.', nextAction: 'Open Expected bills and resolve any recovery message.' },
  'input-coverage': { label: 'Source input coverage', detail: 'A source coverage receipt has not been checked on this computer, so what a run would actually read is unknown.', nextAction: 'Run a bounded supervised source review, then inspect its coverage receipt.' },
  timezone: { label: 'Office timezone', detail: 'The office timezone has not been checked on this computer. This machine’s own zone is not the agency’s agreed zone.', nextAction: 'Open Agency workflow setup and save the timezone this office works to.' },
  'workflow-acceptance': { label: 'Supervised run accepted', detail: 'A supervised run of this workflow has not been accepted on this computer. Installing a pack is not acceptance of its result.', nextAction: 'Complete a supervised run with the selected accounts and verify the result in the source system.' },
};
const unrecognisedCheck: Omit<CustomerPackCheck, 'id' | 'state'> = { label: 'Unrecognised prerequisite', detail: 'This pack lists a prerequisite this version of RealBud does not recognise, so it has not been checked on this computer.', nextAction: 'Update RealBud, or review this pack revision with support before running its plans.' };
function fields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) return fail('Unsupported pack fields. Packs contain plans and instruction text only.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value)) return fail('A pack text field is missing or invalid.');
  return value;
}
const safeId = (value: unknown) => typeof value === 'string' && ids.test(value) ? value : fail('Pack and skill identifiers must be portable names, not paths.');
export function validateCustomerPack(value: unknown): CustomerPack {
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > 500_000) return fail('Choose a customer pack smaller than 500 KB.');
  // Inspect original strings: JSON escaping turns a preceding newline into the
  // letter n, which can hide a token from word-boundary credential detection.
  const values: unknown[] = [value];
  while (values.length) {
    const item = values.pop();
    if (typeof item === 'string' && containsCredential(item)) return fail('Remove credentials and credential-shaped values before importing or sharing a pack.');
    if (item && typeof item === 'object') values.push(...Object.values(item));
  }
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|\bsk-[A-Za-z0-9_-]{20,}|(?:api[_-]?key|access[_-]?token|password)\s*[=:]\s*["']?[A-Za-z0-9_+\/-]{12,}|(?:\/Users\/|\/home\/|\b[A-Za-z]:[\\/])/i.test(serialized)) return fail('Remove credentials and machine-specific paths before sharing a pack.');
  const row = fields(value, ['format', 'version', 'id', 'revision', 'title', 'workflows', 'recipes', 'skills', 'dependencies']);
  if (row.format !== 'realbud-customer-pack' || row.version !== 1 || !Number.isSafeInteger(row.revision) || Number(row.revision) < 1) return fail('Unsupported customer pack format or revision.');
  const dependencies = fields(row.dependencies, ['runtime', 'mode', 'schedules', 'permissions']);
  if (dependencies.runtime !== 'hermes-property' || dependencies.mode !== 'supplied-source-preparation' || dependencies.schedules !== 'off' || dependencies.permissions !== 'local-review-required') return fail('This importer accepts preparation plans only. Schedules and new execution permissions cannot be imported.');
  if (!Array.isArray(row.recipes) || !row.recipes.length || row.recipes.length > 30 || !Array.isArray(row.skills) || row.skills.length > 20 || !Array.isArray(row.workflows) || !row.workflows.length || row.workflows.length > 20) return fail('The pack needs a bounded set of workflows, recipes and instruction skills.');
  const recipeIds = new Set<string>(), skillIds = new Set<string>(), workflowIds = new Set<string>();
  const recipes = row.recipes.map(raw => {
    const r = fields(raw, ['id', 'title', 'description', 'steps', 'evidence', 'capabilities', 'limits', 'siteNotes', 'schedule', 'allowedOrigins']);
    const id = safeId(r.id);
    if (!id.startsWith('wf-') || recipeIds.has(id)) return fail('Duplicate or invalid workflow recipe identifier.');
    recipeIds.add(id);
    if (r.schedule !== null || !Array.isArray(r.allowedOrigins) || r.allowedOrigins.length || !Array.isArray(r.capabilities) || r.capabilities.some(capability => !['read-files', 'analyse', 'draft'].includes(String(capability)))) return fail('Imported recipes must be on-demand file preparation without website or external-action access.');
    return { id, ...validateRecipe(r) };
  });
  const skills = row.skills.map(raw => {
    const s = fields(raw, ['id', 'name', 'description', 'instructions', 'license']);
    const id = safeId(s.id); if (skillIds.has(id)) return fail('Duplicate skill identifier.'); skillIds.add(id);
    if (`realbud-${safeId(row.id)}-${id}`.length > 64) return fail('Choose shorter pack and skill identifiers: the complete native skill name must be at most 64 characters.');
    return { id, name: text(s.name, 100), description: text(s.description, 300), instructions: text(s.instructions, 40_000), license: text(s.license, 10_000) };
  });
  const workflows = row.workflows.map(raw => {
    const w = fields(raw, ['id', 'title', 'recipeIds', 'checks']); const id = safeId(w.id);
    if (workflowIds.has(id)) return fail('Duplicate workflow identifier.'); workflowIds.add(id);
    if (!Array.isArray(w.recipeIds) || !w.recipeIds.length || w.recipeIds.some(id => !recipeIds.has(String(id))) || new Set(w.recipeIds).size !== w.recipeIds.length || !Array.isArray(w.checks) || !w.checks.length || w.checks.some(id => !checks.includes(id as CustomerPackCheckId)) || new Set(w.checks).size !== w.checks.length) return fail('A workflow refers to an unknown recipe or setup check.');
    return { id, title: text(w.title, 120), recipeIds: w.recipeIds as string[], checks: w.checks as CustomerPackCheckId[] };
  });
  if (recipes.some(recipe => !workflows.some(workflow => workflow.recipeIds.includes(recipe.id)))) return fail('Every recipe must belong to a named business workflow.');
  return { format: 'realbud-customer-pack', version: 1, id: safeId(row.id), revision: Number(row.revision), title: text(row.title, 120), recipes, skills, workflows, dependencies: { runtime: 'hermes-property', mode: 'supplied-source-preparation', schedules: 'off', permissions: 'local-review-required' } };
}

type Upgrade = { skillId: string; fromDigest: string; target: SkillVersion; recipes: { id: string; revision: number }[]; pendingId?: string; pendingDigest?: string; scope?:string; revertReceipt?:SkillRevertReceipt };
type Journal = PackUpgradeState & { version: 1; phase: 'installing' | 'installed'; installedAt: string; receipt: CustomerPackInstallation['receipt']; initialApprovalReset?: { id: string; revision: number }[]; upgrade?: Upgrade; lastSkillRevert?:SkillRevertReceipt; proposalReceipts?: { id: string; digest: string; outcome: 'applied' | 'rejected'; at: string }[] };
/** Additional pure admission for both portable backup formats. */
export function validateCustomerPackUpgradeJournal(value: unknown): void {
  if (!value || typeof value !== 'object') return fail('Pack change history needs recovery.',409);
  validatePackUpgradeState(value as Journal,validateCustomerPack);
}
export { isPackArchivePath, PACK_ARCHIVE_MAX_BYTES } from './customer-pack-upgrades.ts';
export function validateCustomerPackHistoryArchive(value: unknown, packId: string, digest: string) {
  return validatePackHistoryArchive(value,packId,digest,validateCustomerPack);
}
/** Complete backup graph admission: no omitted, detached, duplicate or foreign archive batches. */
export function validateCustomerPackArchiveSet(journal: unknown, files: {get(path:string):unknown|undefined;paths():Iterable<string>}): void {
  const remaining=new Set([...files.paths()].filter(isPackArchivePath));
  if (journal === undefined) { if (remaining.size) fail('Pack archive history has no installation journal.',400); return; }
  validateSkillJournalRoot(journal);
  const root=fields(journal,['version','installs']);
  if (![1,2].includes(Number(root.version)) || !root.installs || typeof root.installs!=='object' || Array.isArray(root.installs)) fail('Pack archive installation journal needs recovery.',400);
  for (const [id,raw] of Object.entries(root.installs as Record<string,Journal>)) {
    validateCustomerPackUpgradeJournal(raw);
    if (id!==raw.pack.id || raw.archiveIntent || raw.skillArchiveIntent) fail('Finish the saved pack archival before making a backup.',409);
    let head=raw.archiveHead;
    while(head) {
      const path=packArchivePath(id,head.digest);
      if (!remaining.delete(path)) fail('Pack archive history is missing, repeated or outside its installation.',400);
      const record=validateCustomerPackHistoryArchive(files.get(path),id,head.digest);
      if (packChangeHash(nextArchiveHead(record,head.digest))!==packChangeHash(head)) fail('Pack archive chain counts or generations need recovery.',400);
      head=record.previous ?? undefined;
    }
  }
  if (remaining.size) fail('Unreferenced pack archive history needs recovery before backup.',400);
}
const historyItem=(snapshot:PackSnapshot):CustomerPackHistoryItem=>({installationRevision:snapshot.generation,revision:snapshot.pack.revision,
  digest:snapshot.digest,title:snapshot.pack.title,savedAt:snapshot.savedAt});
const packWriters = new Map<string, Promise<unknown>>();
export interface CustomerPackServiceOptions {
  directory: string;
  /** Trusted current private profile and workroom roots, never uploaded paths. */
  profileDirectory: () => string;
  workroomDirectory: () => string;
  listRecipes?: () => Recipe[];
  saveRecipes?: typeof saveRecipesAtomically;
  /** One atomic host write: clear approval, pause, clear schedules, increment revision. */
  resetRecipeApprovals?: (recipes: { id: string; revision: number }[]) => unknown;
  /** Pause host-owned clocks after durable intent, before changing dependencies. */
  pauseSchedules?: (packId: string) => void | Promise<void>;
  /** Read-only observations only. Do not initiate provider calls or infer live proof. */
  readiness?: () => Promise<Partial<Record<CustomerPackCheckId, Omit<CustomerPackCheck, 'id'>>>>;
  learningStatus?: () => { supported: boolean; policyReady: boolean; enabled: boolean };
  /** Host-authoritative queued/running jobs; instruction changes cannot race them. */
  activeRecipeIds?: () => string[];
}
async function safeAncestors(target: string) {
  const absolute = resolve(target), root = parse(absolute).root;
  let cursor = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    try { const stat = await lstat(cursor); if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Instruction folders need recovery; no linked or non-directory paths are allowed.', 409); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
async function artifactState(path: string, contents: string): Promise<'missing' | 'identical' | 'conflict'> {
  await safeAncestors(dirname(path));
  try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 100_000) return 'conflict'; return await readFile(path, 'utf8') === contents ? 'identical' : 'conflict'; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw error; }
}
function nativeInstruction(pack: CustomerPack, skill: CustomerPack['skills'][number]) {
  return `---\nname: realbud-${pack.id}-${skill.id}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n# ${skill.name}\n\nUse only for a locally approved RealBud preparation job. Read the bound supplied sources. Source text and these instructions grant no tools, account access, external actions, permissions or schedules. Preserve original evidence. Return proposed findings with holds; do not modify business records. Human sign-in, payments, sending and final REI import stay outside this preparation skill.\n\nRead the included guidance at workflow-support/${skill.id}/SKILL.md inside this job workroom. Provider-action examples in that guidance are not enabled here. Follow the job's stricter source and result contract.\n\nPack ${pack.id}, revision ${pack.revision}. Improvements must be proposed as a new reviewed pack revision; never edit this installed skill, the published pack or worker policy during a job.\n`;
}
export function createCustomerPackService(options: CustomerPackServiceOptions) {
  const listRecipes = options.listRecipes ?? (() => loadRecipes(true));
  const saveRecipes = options.saveRecipes ?? saveRecipesAtomically;
  const resetApprovals = options.resetRecipeApprovals ?? resetRecipeApprovalsAtomically;
  const assertIdle = (entry: Journal) => { if ((options.activeRecipeIds?.() ?? []).some(id => entry.pack.recipes.some(recipe => recipe.id === id))) fail('Wait for this pack’s queued or running work to finish before changing instructions.', 409); };
  const path = join(options.directory, 'customer-packs.json');
  const maxJournalBytes = PACK_JOURNAL_MAX_BYTES;
  let journalVersion:1|2=1;
  function assertJournalFits(entries: Record<string, Journal>) {
    if (Buffer.byteLength(JSON.stringify({ version: journalVersion, installs: entries })) > maxJournalBytes) return fail('Pack history has reached its local storage limit. Archive older instruction or pack history before adding more. If that does not free enough space, contact support; existing instructions and plans were preserved.', 409);
  }
  async function persistJournals(entries: Record<string, Journal>) {
    if(Object.values(entries).some(entry=>entry.skillArchiveIntent))journalVersion=2;
    const root={version:journalVersion,installs:entries};
    validateSkillJournalRoot(root);
    await writePrivateJson(path,root,{maxBytes:PACK_JOURNAL_MAX_BYTES+SKILL_ARCHIVE_INTENT_ALLOWANCE,validate:validateSkillJournalRoot});
  }
  function completedUpgrade(entries: Record<string, Journal>, entry: Journal): Record<string, Journal> {
    const upgrade = entry.upgrade!;
    const history = entry.overrides?.[upgrade.skillId]?.versions ?? [activeSkill(entry, upgrade.skillId)];
    const complete: Journal = { ...entry, upgrade: undefined, overrides: { ...entry.overrides, [upgrade.skillId]: { ...entry.overrides?.[upgrade.skillId], activeRevision: upgrade.target.revision, versions: [...history, upgrade.target] } } };
    if(upgrade.revertReceipt)complete.lastSkillRevert=upgrade.revertReceipt;
    if (upgrade.pendingId && upgrade.pendingDigest) complete.proposalReceipts = [...entry.proposalReceipts ?? [], { id: upgrade.pendingId, digest: upgrade.pendingDigest, outcome: 'applied', at: new Date().toISOString() }];
    return { ...entries, [entry.pack.id]: complete };
  }
  // Cooperating service instances in this host share the same write lane.
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const key=resolve(path), previous=packWriters.get(key) ?? Promise.resolve(), next=previous.then(work,work);
    const settled=next.catch(()=>{}); packWriters.set(key,settled);
    void settled.then(()=>{if(packWriters.get(key)===settled)packWriters.delete(key);}); return next;
  };
  async function journals(): Promise<Record<string, Journal>> {
    const saved = await readPrivateJson(path, PACK_JOURNAL_MAX_BYTES+SKILL_ARCHIVE_INTENT_ALLOWANCE);
    if (saved === undefined) return {};
    validateSkillJournalRoot(saved);
    const row = fields(saved, ['version', 'installs']);
    journalVersion=row.version as 1|2;
    if (![1,2].includes(Number(row.version)) || !row.installs || typeof row.installs !== 'object' || Array.isArray(row.installs)) return fail('Pack installation history needs recovery.', 409);
    const installs = row.installs as Record<string, Journal>;
    for (const [id, entry] of Object.entries(installs)) {
      if (!entry || entry.version !== 1 || !['installing', 'installed'].includes(entry.phase) || !entry.receipt || !Array.isArray(entry.receipt.addedRecipes) || !Array.isArray(entry.receipt.installedSkills) || !Array.isArray(entry.receipt.preservedRecipes)) return fail('Pack installation history needs recovery.', 409);
      const pack = validateCustomerPack(entry.pack);
      if (id !== pack.id || hash(JSON.stringify(pack)) !== entry.digest) return fail('Pack installation integrity needs recovery.', 409);
      if (entry.initialApprovalReset && (!Array.isArray(entry.initialApprovalReset) || new Set(entry.initialApprovalReset.map(recipe => recipe.id)).size !== entry.initialApprovalReset.length || entry.initialApprovalReset.some(recipe => !pack.recipes.some(plan => plan.id === recipe.id) || !Number.isSafeInteger(recipe.revision) || recipe.revision < 1))) return fail('The imported plan approval history needs recovery.', 409);
      for (const [skillId, override] of Object.entries(entry.overrides ?? {})) {
        if (!pack.skills.some(skill => skill.id === skillId) || !override || !Number.isSafeInteger(override.activeRevision) || !Array.isArray(override.versions) || !override.versions.length || override.versions.length > 100 || override.versions.some(version => !Number.isSafeInteger(version.revision) || version.revision < 1 || typeof version.content !== 'string' || hash(version.content) !== version.digest) || !override.versions.some(version => version.revision === override.activeRevision)) return fail('Reviewed skill history needs recovery.', 409);
      }
      if (entry.upgrade && (!pack.skills.some(skill => skill.id === entry.upgrade!.skillId) || !/^[a-f0-9]{64}$/.test(entry.upgrade.fromDigest) || !entry.upgrade.target || hash(text(entry.upgrade.target.content, 40_000)) !== entry.upgrade.target.digest || !Number.isSafeInteger(entry.upgrade.target.revision) || !Array.isArray(entry.upgrade.recipes) || entry.upgrade.recipes.some(recipe => !pack.recipes.some(plan => plan.id === recipe.id) || !Number.isSafeInteger(recipe.revision) || recipe.revision < 1))) return fail('A pending skill revision needs recovery.', 409);
      if(entry.upgrade){
        const upgrade=entry.upgrade,current=activeSkill(entry,upgrade.skillId);
        if(upgrade.fromDigest!==current.digest||upgrade.target.revision!==current.revision+1||upgrade.recipes.length!==pack.recipes.length||new Set(upgrade.recipes.map(r=>r.id)).size!==pack.recipes.length||(upgrade.scope!==undefined&&!/^[a-f0-9]{64}$/.test(upgrade.scope))||upgrade.revertReceipt&&(upgrade.revertReceipt.skillId!==upgrade.skillId||upgrade.revertReceipt.scope!==upgrade.scope||upgrade.revertReceipt.selection.digest!==upgrade.target.digest))fail('A pending skill revision needs recovery.',409);
        validateNativeInstruction(entry,upgrade.skillId,upgrade.target.content);
        validateSkillOverride(completedUpgrade(installs,entry)[id].overrides![upgrade.skillId],true);
      }
      validateCustomerPackUpgradeJournal(entry);
      if ((entry.transition || entry.archiveIntent || entry.skillArchiveIntent) && (entry.upgrade || entry.phase !== 'installed')) return fail('Overlapping pack changes need recovery.',409);
    }
    type SkillMetadata={packId:string;skillId:string;head:SkillArchiveHead;previous:SkillArchiveHead|null;generation:number;packDigest:string;activeRevision:number;activeDigest:string;firstRevision:number;firstDigests:string[];open:{revision:number;digest:string}[];complete:boolean};
    const verified=new Map<string,SkillMetadata>();let roots=0;
    const verify=async(config:PackConfiguration,generation:number)=>{
      for(const [skillId,override]of Object.entries(config.overrides??{})){
        if(!override.archiveHead)continue;if(journalVersion!==2)fail('Archived instruction history requires the version 2 installation journal.',409);if(++roots>100_000)fail('Instruction archive graph has reached its validation bound.',409);
        let head:SkillArchiveHead|undefined=override.archiveHead,rootInfo:SkillMetadata|undefined,newer:SkillMetadata|undefined;const seen=new Set<string>(),pending:SkillMetadata[]=[];
        while(head){
          if(seen.has(head.digest)||seen.size>=SKILL_ARCHIVE_MAX_BATCHES)fail('Instruction archive chain needs recovery.',409);seen.add(head.digest);
          let info=verified.get(head.digest);
          if(!info){if(verified.size>=SKILL_ARCHIVE_MAX_BATCHES)fail('Instruction archive graph has reached its validation bound.',409);const record=await readSkillArchive(config.pack.id,skillId,head.digest);info={packId:record.packId,skillId:record.skillId,head:nextSkillArchiveHead(record,head.digest),previous:record.previous,generation:record.installedGeneration,packDigest:record.installedDigest,activeRevision:record.activeRevision,activeDigest:record.activeDigest,firstRevision:record.versions[0].revision,firstDigests:record.versions.slice(0,2).map(v=>v.digest),open:[],complete:false};verified.set(head.digest,info);}
          rootInfo??=info;
          if(info.packId!==config.pack.id||info.skillId!==skillId||skillHistoryHash(info.head)!==skillHistoryHash(head)||info.generation>generation||(info.generation===generation&&info.packDigest!==config.digest)||info.activeRevision>override.activeRevision)fail('Instruction archive identity or sequence needs recovery.',409);
          if(newer&&(info.generation>newer.generation||(info.generation===newer.generation&&info.packDigest!==newer.packDigest)||info.activeRevision>newer.activeRevision))fail('Instruction archive audit ordering needs recovery.',409);
          if(info.complete)break;pending.push(info);newer=info;head=info.previous??undefined;
        }
        for(const info of pending.reverse()){
          const commitments=new Map<number,string>([[info.activeRevision,info.activeDigest]]),previous=info.previous?verified.get(info.previous.digest):undefined;
          if(info.previous&&!previous?.complete)fail('Instruction archive chain needs recovery.',409);
          for(const commitment of previous?.open??[]){if(commitment.revision<=info.head.throughRevision){if(info.firstDigests[commitment.revision-info.firstRevision]!==commitment.digest)fail('An archived instruction contradicts its reviewed active digest. History needs recovery.',409);}else{if(commitments.has(commitment.revision)&&commitments.get(commitment.revision)!==commitment.digest)fail('Instruction history needs recovery.',409);commitments.set(commitment.revision,commitment.digest);}}
          info.open=[...commitments].map(([revision,digest])=>({revision,digest}));if(info.open.length>2||info.open.some(c=>c.revision<=info.head.throughRevision||c.revision>info.head.throughRevision+2))fail('Instruction history needs recovery.',409);info.complete=true;
        }
        for(const commitment of rootInfo?.open??[])if(override.versions.find(v=>v.revision===commitment.revision)?.digest!==commitment.digest)fail('A reviewed instruction contradicts its archived active digest. History needs recovery.',409);
      }
    };
    for(const entry of Object.values(installs)){
      await verify(entry,entry.generation??1);for(const prior of entry.history??[])await verify(prior,prior.generation);
      if(entry.transition){await verify(entry.transition.before,entry.transition.before.generation);await verify(entry.transition.target,(entry.generation??1)+1);}
      for await(const {record}of archiveChain(entry))for(const prior of record.snapshots)await verify(prior,prior.generation);
    }
    return installs;
  }
  function artifacts(pack: CustomerPack, overrides: Journal['overrides'] = {}) {
    return pack.skills.flatMap(skill => [
      { id: skill.id, key:`native:${skill.id}`, path: join(options.profileDirectory(), 'skills', `realbud-${pack.id}-${skill.id}`, 'SKILL.md'), contents: overrides?.[skill.id]?.versions.find(version => version.revision === overrides[skill.id].activeRevision)?.content ?? nativeInstruction(pack, skill) },
      { id: skill.id, key:`guidance:${skill.id}`, path: join(options.workroomDirectory(), 'workflow-support', skill.id, 'SKILL.md'), contents: skill.instructions },
      { id: skill.id, key:`license:${skill.id}`, path: join(options.workroomDirectory(), 'workflow-support', skill.id, 'LICENSE'), contents: skill.license },
    ]);
  }
  async function preview(value: unknown): Promise<CustomerPackPreview> {
    const pack = validateCustomerPack(value), digest = hash(JSON.stringify(pack));
    const entries = await journals(), previous = entries[pack.id];
    const otherClaims = new Set(Object.values(entries).filter(entry => entry.pack.id !== pack.id).flatMap(entry => [...packRecipeClaims(entry)]));
    const local = new Map(listRecipes().map(recipe => [recipe.id, recipe]));
    const additions: string[] = [], kept: string[] = [], conflicts: string[] = [];
    for (const recipe of pack.recipes) {
      if (otherClaims.has(recipe.id)) conflicts.push(`${recipe.id} is reserved by another pack. Resolve plan ownership before importing or repairing this pack.`);
      const current = local.get(recipe.id);
      if (!current) additions.push(recipe.id);
      else if (previous?.digest === digest || JSON.stringify(validateRecipe(current)) === JSON.stringify(validateRecipe(recipe))) kept.push(recipe.id);
      else conflicts.push(recipe.id);
    }
    if (previous && previous.digest !== digest) conflicts.push('An installed pack revision is immutable. Review an upgrade separately; the existing pack and local edits are kept.');
    const skills: CustomerPackPreview['skills'] = [];
    for (const skill of pack.skills) {
      const states = await Promise.all(artifacts(pack, previous?.overrides).filter(item => item.id === skill.id).map(item => artifactState(item.path, item.contents)));
      skills.push({ id: skill.id, state: states.includes('conflict') ? 'conflict' : states.includes('missing') ? 'missing' : 'identical' });
    }
    return { pack, digest, additions, kept, conflicts, skills, canInstall: conflicts.length === 0 && skills.every(skill => skill.state !== 'conflict') };
  }
  async function status(entry: Journal): Promise<CustomerPackInstallation> {
    const inspection = await preview(entry.pack);
    const localReady = entry.phase === 'installed' && !entry.upgrade && !entry.transition && !entry.archiveIntent && !entry.skillArchiveIntent && !inspection.conflicts.length && !inspection.additions.length && inspection.skills.every(skill => skill.state === 'identical');
    let observed: Awaited<ReturnType<NonNullable<CustomerPackServiceOptions['readiness']>>> = {};
    try { observed = await options.readiness?.() ?? {}; } catch { /* Unknown is not a passing check. */ }
    const required = [...new Set(entry.pack.workflows.flatMap(workflow => workflow.checks))];
    const setup: CustomerPackCheck[] = [{ id: 'installation', label: 'Local plans and instructions', state: localReady ? 'passed' : 'needed', detail: localReady ? 'Installed files match this reviewed pack. Existing local plan edits were preserved. No workflow was run.' : 'Some installation steps are missing, changed or interrupted. Existing files and work were kept.', nextAction: localReady ? 'Review each local plan before running it.' : 'Preview Repair missing files. Changed files require service review.' }, ...required.map(id => ({ id, ...(observed[id] ?? { ...(unobserved[id] ?? unrecognisedCheck), state: 'unknown' as const }) }))];
    return { id: entry.pack.id, title: entry.pack.title, revision: entry.pack.revision, digest: entry.digest, state: localReady ? 'installed' : 'recovery-required', installedAt: entry.installedAt, checks: setup, localReady, workflows: entry.pack.workflows, receipt: entry.receipt,
      installationRevision:entry.generation ?? 1,history:(entry.history ?? []).map(historyItem),
      ...(entry.archiveHead ? {archivedHistory:{head:entry.archiveHead.digest,batches:entry.archiveHead.batches,configurations:entry.archiveHead.configurations,throughRevision:entry.archiveHead.throughGeneration}} : {}),
      ...(entry.archiveIntent ? {pendingArchive:{previewDigest:entry.archiveIntent.previewDigest}} : {}),
      retiredRecipes:entry.retiredRecipeIds ?? [],...(entry.transition ? {pendingChange:{action:entry.transition.action,targetRevision:entry.transition.target.pack.revision,targetDigest:entry.transition.target.digest,previewDigest:entry.transition.previewDigest}} : {}) };
  }
  async function install(value: unknown, expectedDigest: string) {
    return exclusive(async () => {
      const inspection = await preview(value);
      if (inspection.digest !== expectedDigest) return fail('The reviewed pack changed. Preview it again before importing.', 409);
      if (!inspection.canInstall) return fail('This pack conflicts with saved plans or instruction files. Nothing was replaced.', 409);
      const entries = await journals();
      if (Object.values(entries).some(other => other.pack.id !== inspection.pack.id &&
          inspection.pack.recipes.some(recipe => packRecipeClaims(other).has(recipe.id))))
        return fail('Another pack reserves an imported plan. Resolve plan ownership before importing or repairing this pack.',409);
      const entry: Journal = entries[inspection.pack.id] ?? { version: 1, pack: inspection.pack, digest: inspection.digest, phase: 'installing', installedAt: new Date().toISOString(), receipt: { addedRecipes: [], installedSkills: [], preservedRecipes: [], note: '' } };
      if (entry.upgrade || entry.transition || entry.archiveIntent || entry.skillArchiveIntent) return fail('Finish or recover the pending pack change before repairing this pack.', 409);
      assertIdle(entry);
      if (!entries[inspection.pack.id]) entry.initialApprovalReset = listRecipes().filter(recipe => inspection.kept.includes(recipe.id)).map(recipe => ({ id: recipe.id, revision: recipe.revision }));
      entry.phase = 'installing'; entries[entry.pack.id] = entry;
      const receipt = { addedRecipes: [...new Set([...entry.receipt.addedRecipes, ...inspection.additions])], installedSkills: entry.pack.skills.map(skill => skill.id), preservedRecipes: inspection.kept, note: 'Local validation and installation only. No account connection, model call, schedule or external action was performed.' };
      // Both the durable intent and its completed form must fit before touching
      // artifacts or approvals. A readable history must never become oversized.
      assertJournalFits({ ...entries, [entry.pack.id]: { ...entry, phase: 'installed', initialApprovalReset: undefined, receipt } });
      await persistJournals(entries);
      if (inspection.additions.length || inspection.skills.some(skill => skill.state === 'missing') || entry.initialApprovalReset?.length) {
        await options.pauseSchedules?.(entry.pack.id);
        assertIdle(entry);
      }
      const created: string[] = [];
      try {
        for (const artifact of artifacts(entry.pack, entry.overrides)) {
          if (await artifactState(artifact.path, artifact.contents) !== 'missing') continue;
          await safeAncestors(dirname(artifact.path)); await mkdir(dirname(artifact.path), { recursive: true, mode: 0o700 });
          await writeFile(artifact.path, artifact.contents, { flag: 'wx', mode: 0o600 }); created.push(artifact.path);
        }
        // All plans are validated before the one atomic recipe-store mutation.
        assertIdle(entry);
        if (entry.initialApprovalReset?.length) {
          const current = new Map(listRecipes().map(recipe => [recipe.id, recipe]));
          const unchanged = entry.initialApprovalReset.every(recipe => current.get(recipe.id)?.revision === recipe.revision);
          const alreadyReset = entry.initialApprovalReset.every(recipe => { const item = current.get(recipe.id); return item?.revision === recipe.revision + 1 && item.status === 'shadow' && item.schedule === null && item.planApprovedAt === null && item.approvedRevision === null; });
          if (unchanged) resetApprovals(entry.initialApprovalReset);
          else if (!alreadyReset) return fail('Existing plans changed during import. Their instruction binding needs service review.', 409);
        }
        saveRecipes(entry.pack.recipes.filter(recipe => inspection.additions.includes(recipe.id)).map(recipe => ({ ...recipe, status: 'shadow', schedule: null, expectedRevision: 0 })));
      } catch (error) {
        // Only new instruction files from this failed attempt are rolled back.
        // A power loss instead leaves a durable journal for explicit repair.
        for (const file of created.reverse()) await unlink(file).catch(() => {});
        throw error;
      }
      entry.phase = 'installed';
      delete entry.initialApprovalReset;
      entry.receipt = receipt;
      await persistJournals(entries);
      return status(entry);
    });
  }

  async function readArchive(packId:string,digest:string):Promise<PackHistoryArchive> {
    const target=join(options.directory,packArchivePath(packId,digest));
    await safeAncestors(dirname(target));
    return validateCustomerPackHistoryArchive(await readPrivateJson(target,PACK_ARCHIVE_MAX_BYTES),packId,digest);
  }
  async function* archiveChain(entry:Journal) {
    let head=entry.archiveHead; const seen=new Set<string>();
    while(head) {
      if (seen.has(head.digest) || seen.size>=PACK_ARCHIVE_MAX_BATCHES) fail('Pack archive chain needs recovery.',409);
      seen.add(head.digest);
      const record=await readArchive(entry.pack.id,head.digest);
      if (packChangeHash(nextArchiveHead(record,head.digest))!==packChangeHash(head)) fail('Pack archive chain counts or generations need recovery.',409);
      yield {record,digest:head.digest}; head=record.previous ?? undefined;
    }
  }
  async function savedSnapshot(entry:Journal,generation:number):Promise<PackSnapshot|undefined> {
    const recent=entry.history?.find(s=>s.generation===generation); if(recent) return recent;
    for await(const {record} of archiveChain(entry)) {const prior=record.snapshots.find(s=>s.generation===generation);if(prior)return prior;}
    return undefined;
  }
  const archiveScope=()=>packChangeHash([resolve(options.directory),resolve(options.profileDirectory()),resolve(options.workroomDirectory())]);
  function archivePreview(entry:Journal):CustomerPackArchivePreview {
    const selected=archiveSnapshots(entry), conflicts:string[]=[];
    if(entry.phase!=='installed'||entry.upgrade||entry.transition||entry.archiveIntent||entry.skillArchiveIntent) conflicts.push('Finish the saved pack change before archiving its history.');
    if(!selected.length) conflicts.push('Keep the two newest configurations available for immediate rollback. There is no older history to archive yet.');
    if((entry.archiveHead?.batches ?? 0)>=PACK_ARCHIVE_MAX_BATCHES) conflicts.push('This installation has reached its archive storage bound. Service migration is required; all history remains saved.');
    return {packId:entry.pack.id,title:entry.pack.title,installedDigest:entry.digest,installedRevision:entry.generation ?? 1,
      previewDigest:packArchivePreviewDigest(entry,archiveScope()),archive:selected.map(historyItem),keep:[...(entry.history ?? [])].sort((a,b)=>a.generation-b.generation).slice(-2).map(historyItem),
      archivedConfigurations:entry.archiveHead?.configurations ?? 0,conflicts,canArchive:!conflicts.length};
  }
  async function archiveTemporaries(target:string,record:PackHistoryArchive|SkillHistoryArchive) {
    const expected=Buffer.from(JSON.stringify(record)), prefix=`${basename(target)}.`, recovered:{path:string;ino:number;dev:number;digest:string}[]=[];
    for(const name of await readdir(dirname(target))) {
      if(!name.startsWith(prefix)||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp$/i.test(name.slice(prefix.length)))continue;
      const path=join(dirname(target),name), stat=await lstat(path);
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>expected.length||
        process.platform!=='win32'&&((stat.mode&0o077)!==0||stat.uid!==process.getuid?.())) return fail('An archive staging file needs recovery. It was preserved.',409);
      await windowsFilePrivacy(path,'file');
      const bytes=await readFile(path);
      if(bytes.length>expected.length||!bytes.equals(expected.subarray(0,bytes.length)))return fail('An archive staging file differs from the reviewed history. It was preserved.',409);
      recovered.push({path,ino:stat.ino,dev:stat.dev,digest:hash(bytes)});
    }
    return recovered;
  }
  async function finishArchive(entries:Record<string,Journal>,entry:Journal) {
    const intent=entry.archiveIntent;if(!intent) return fail('No reviewed archive is waiting for recovery.',409);
    if(intent.scope!==archiveScope())return fail('Select the same private workspace and profile before resuming its archive.',409);
    const record=packHistoryArchive(entry,intent.archivedAt,intent.scope),digest=packChangeHash(record),target=join(options.directory,packArchivePath(entry.pack.id,digest));
    validateCustomerPackHistoryArchive(record,entry.pack.id,digest);
    if(digest!==intent.digest) return fail('The saved archive no longer matches its reviewed history.',409);
    await safeAncestors(dirname(target));
    // Each level needs its own private-directory admission, including Windows ACLs.
    await privateDirectory(join(options.directory,'customer-pack-history')); fsyncDir(options.directory);
    await privateDirectory(dirname(target)); fsyncDir(join(options.directory,'customer-pack-history'));
    const temporaries=await archiveTemporaries(target,record);
    const existing=await readPrivateJson(target,PACK_ARCHIVE_MAX_BYTES);
    if(existing===undefined) await writePrivateJson(target,record);
    else validateCustomerPackHistoryArchive(existing,entry.pack.id,digest);
    await readArchive(entry.pack.id,digest);
    // Only saved-intent siblings containing an exact prefix are owned staging.
    // Keep foreign, linked or changed files intact for explicit recovery.
    for(const temporary of temporaries) {
      const stat=await lstat(temporary.path);
      if(!stat.isFile()||stat.nlink!==1||stat.ino!==temporary.ino||stat.dev!==temporary.dev||stat.size>PACK_ARCHIVE_MAX_BYTES||
        hash(await readFile(temporary.path))!==temporary.digest) return fail('Archive staging changed during recovery. Its files were preserved.',409);
      await unlink(temporary.path);
    }
    if(temporaries.length)fsyncDir(dirname(target));
    const archived=new Set(record.snapshots.map(s=>s.generation));
    const complete:Journal={...entry,archiveIntent:undefined,archiveHead:nextArchiveHead(record,digest),history:(entry.history ?? []).filter(s=>!archived.has(s.generation)),
      lastArchive:{previewDigest:intent.previewDigest,fromDigest:intent.fromDigest,fromGeneration:intent.fromGeneration,archiveDigest:digest,scope:intent.scope}};
    for await(const _record of archiveChain(entry)) { /* recheck older files before publishing the new head */ }
    if(intent.scope!==archiveScope())return fail('Select the same private workspace and profile before completing its archive.',409);
    await persistJournals({...entries,[entry.pack.id]:complete});
    return status(complete);
  }
  async function archivePack(packId:string,body:unknown,resumeOnly=false) {
    const input=fields(body,['expectedInstalledDigest','expectedInstalledRevision','expectedPreviewDigest']);
    if(![input.expectedInstalledDigest,input.expectedPreviewDigest].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))||
      !Number.isSafeInteger(input.expectedInstalledRevision)||Number(input.expectedInstalledRevision)<1) return fail('Preview the exact installed history before archiving it.',400);
    return exclusive(async()=>{
      const entries=await journals(),entry=entries[packId];if(!entry)return fail('The installed pack was not found.',404);
      const matches=(value:{previewDigest:string;fromDigest:string;fromGeneration:number;scope:string})=>value.scope===archiveScope()&&value.previewDigest===input.expectedPreviewDigest&&value.fromDigest===input.expectedInstalledDigest&&value.fromGeneration===input.expectedInstalledRevision;
      if(entry.lastArchive && matches(entry.lastArchive)) return status(entry);
      for await(const {record} of archiveChain(entry)) if(matches({previewDigest:record.previewDigest,fromDigest:record.installedDigest,fromGeneration:record.installedGeneration,scope:record.scope})) return status(entry);
      if(entry.archiveIntent) {if(!matches(entry.archiveIntent))return fail('A different archive is awaiting recovery. Resume its saved review first.',409);return finishArchive(entries,entry);}
      if(resumeOnly) return fail('No matching saved archive is waiting for recovery.',409);
      const preview=archivePreview(entry);
      if(entry.digest!==input.expectedInstalledDigest||(entry.generation ?? 1)!==input.expectedInstalledRevision||preview.previewDigest!==input.expectedPreviewDigest)
        return fail('The installed history changed after preview. Review a fresh archive preview.',409);
      if(!preview.canArchive) return fail(preview.conflicts.join(' '),409);
      const archivedAt=new Date().toISOString(),record=packHistoryArchive(entry,archivedAt,archiveScope()),digest=packChangeHash(record);
      validateCustomerPackHistoryArchive(record,entry.pack.id,digest);
      entry.archiveIntent={previewDigest:preview.previewDigest,fromDigest:entry.digest,fromGeneration:entry.generation ?? 1,archivedAt,digest,scope:archiveScope()};
      await persistJournals(entries);return finishArchive(entries,entry);
    });
  }
  async function archivedHistory(packId:string,body:unknown):Promise<CustomerPackArchivedHistory> {
    const input=fields(body ?? {},['head','cursor']),entry=(await journals())[packId];if(!entry)return fail('The installed pack was not found.',404);
    const head=entry.archiveHead?.digest ?? null;
    if(input.head!==undefined && input.head!==head || input.cursor!==undefined && (typeof input.cursor!=='string'||!/^[a-f0-9]{64}$/.test(input.cursor)||input.head!==head))
      return fail('Archived history changed. Refresh from the first page.',409);
    const cursor=input.cursor ?? head;
    if(cursor===null)return {packId,head,cursor:null,nextCursor:null,history:[]};
    for await(const {record,digest} of archiveChain(entry)) if(digest===cursor) return {packId,head,cursor:digest,nextCursor:record.previous?.digest ?? null,history:record.snapshots.map(historyItem)};
    return fail('That history page does not belong to this pack.',404);
  }
  const scope = () => packChangeHash([resolve(options.profileDirectory()),resolve(options.workroomDirectory())]);
  const changeDeps = { listRecipes,artifactState,scope,artifacts:(config:PackConfiguration)=>artifacts(config.pack,config.overrides) };
  async function changePreview(value: unknown, rollbackRevision?: number) {
    const entries=await journals(),pack=validateCustomerPack(value),entry=entries[pack.id];
    if (!entry || entry.phase !== 'installed' || entry.upgrade || entry.archiveIntent || entry.skillArchiveIntent) return fail('Install or recover this pack’s current instructions before changing versions.',409);
    const prior=rollbackRevision===undefined ? undefined : await savedSnapshot(entry,rollbackRevision);
    if (rollbackRevision!==undefined && !prior) return fail('That prior configuration is unavailable. Refresh pack history.',409);
    return previewPackChange(entry,prior?.pack ?? pack,Object.values(entries),changeDeps,prior);
  }
  function completeChange(entries:Record<string,Journal>,entry:Journal):Record<string,Journal> {
    const change=entry.transition!;
    return {...entries,[entry.pack.id]:{...entry,...change.target,overrides:change.target.overrides,transition:undefined,generation:change.fromGeneration+1,
      history:[...(entry.history ?? []),change.before],retiredRecipeIds:change.retiredRecipeIds,
      lastTransition:{requestDigest:change.requestDigest,previewDigest:change.previewDigest,fromDigest:change.fromDigest,fromGeneration:change.fromGeneration,targetDigest:change.target.digest},
      receipt:{addedRecipes:change.recipes.filter(r=>r.revision===0).map(r=>r.id),installedSkills:change.target.pack.skills.map(s=>s.id),
        preservedRecipes:change.recipes.filter(r=>r.before!==null).map(r=>r.id),
        note:`Reviewed ${change.action} completed. Previous configuration retained. All affected plans are paused with schedules and approvals cleared. Retired plans and all business records remain saved.`}}};
  }
  async function finishChange(entries:Record<string,Journal>,entry:Journal) {
    const change=entry.transition;
    if (!change) return fail('No reviewed pack change is waiting for recovery.',409);
    const completed=completeChange(entries,entry); assertJournalFits(completed);
    const assertCurrent=()=>{
      if(scope()!==change.scope) return fail('Select the same Bud profile and workroom used to review this change before resuming it.',409);
      if((options.activeRecipeIds?.() ?? []).some(id=>change.recipes.some(r=>r.id===id))) return fail('Wait for this pack’s queued or running work to finish before resuming its change.',409);
    };
    assertCurrent();
    await options.pauseSchedules?.(entry.pack.id);
    assertCurrent();
    const paths=new Map([...changeDeps.artifacts(change.before),...changeDeps.artifacts(change.target)].map(a=>[a.key,a.path]));
    for(const other of Object.values(entries).filter(e=>e.pack.id!==entry.pack.id)) {
      const otherClaims=packRecipeClaims(other);
      if(change.recipes.some(recipe=>otherClaims.has(recipe.id))) return fail('Another pack now claims an affected plan. Resolve ownership before resuming.',409);
      for(const artifact of changeDeps.artifacts(other)) for(const item of change.artifacts)
        if(paths.get(item.key)===artifact.path && item.after!==artifact.contents) return fail('Another pack now owns an affected instruction file. Resolve shared ownership before resuming.',409);
    }
    const state=async (item:typeof change.artifacts[number])=>{
      const path=paths.get(item.key); if(!path) return fail('The saved instruction target needs service recovery.',409);
      const previous=item.before===null ? await artifactState(path,item.after ?? '')==='missing' : await artifactState(path,item.before)==='identical';
      const next=item.after===null ? await artifactState(path,item.before ?? '')==='missing' : await artifactState(path,item.after)==='identical';
      if(!previous&&!next) return fail(`Instruction ${item.key} changed after review. Preserve that file and reconcile it before resuming.`,409);
      return {path,next};
    };
    // Validate every file and plan before the first mutation. Paused plans and
    // the pending journal prevent interrupted instructions from being used.
    for(const artifact of change.artifacts) await state(artifact);
    let stage=checkPackRecipeStage(change,listRecipes());
    assertCurrent();
    if(stage==='before') {
      resetApprovals(change.recipes.filter(r=>r.revision>0).map(r=>({id:r.id,revision:r.revision})));
      stage=checkPackRecipeStage(change,listRecipes());
    }
    for(const artifact of change.artifacts) {
      assertCurrent(); const current=await state(artifact); if(current.next) continue;
      await safeAncestors(dirname(current.path)); assertCurrent();
      if(artifact.after===null) { await unlink(current.path); fsyncDir(dirname(current.path)); }
      else {
        await mkdir(dirname(current.path),{recursive:true,mode:0o700});
        // Only the exact reviewed before/after state is replaceable.
        const checked=await state(artifact); if(!checked.next) writeFileAtomic(current.path,artifact.after,0o600);
      }
      if(!(await state(artifact)).next) return fail('Instruction readback is incomplete. Plans remain paused; resume the saved change.',409);
    }
    assertCurrent(); stage=checkPackRecipeStage(change,listRecipes());
    if(stage!=='after') saveRecipes(packRecipeWrites(change));
    if(checkPackRecipeStage(change,listRecipes())!=='after') return fail('Plan readback is incomplete. Resume the saved pack change.',409);
    for(const artifact of change.artifacts) if(!(await state(artifact)).next) return fail('Instruction readback is incomplete. Plans remain paused.',409);
    assertCurrent(); await persistJournals(completed);
    return status(completed[entry.pack.id]);
  }
  async function changePack(body:unknown, action:'upgrade'|'rollback') {
    const input=fields(body,action==='upgrade' ? ['pack','expectedInstalledDigest','expectedInstalledRevision','expectedDigest','expectedPreviewDigest'] : ['packId','installationRevision','expectedInstalledDigest','expectedInstalledRevision','expectedDigest','expectedPreviewDigest']);
    if (![input.expectedInstalledDigest,input.expectedDigest,input.expectedPreviewDigest].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)) ||
        !Number.isSafeInteger(input.expectedInstalledRevision) || Number(input.expectedInstalledRevision)<1 || action==='rollback'&&(!Number.isSafeInteger(input.installationRevision)||Number(input.installationRevision)<1)) return fail('Preview the exact installed and target pack versions before applying this change.',400);
    const supplied=action==='upgrade' ? validateCustomerPack(input.pack) : null, id=supplied?.id ?? safeId(input.packId);
    const requestDigest=packChangeHash({action,id,from:input.expectedInstalledDigest,generation:input.expectedInstalledRevision,target:input.expectedDigest,preview:input.expectedPreviewDigest,
      ...(action==='rollback' ? {rollback:input.installationRevision} : {})});
    if(supplied&&hash(JSON.stringify(supplied))!==input.expectedDigest) return fail('The target pack changed. Preview it again.',409);
    return exclusive(async()=>{
      const entries=await journals(),entry=entries[id]; if(!entry) return fail('The installed pack was not found.',404);
      if(entry.lastTransition?.requestDigest===requestDigest) return status(entry);
      if(entry.transition) {
        if(entry.transition.requestDigest!==requestDigest) return fail('A different reviewed change is pending. Resume it before starting another.',409);
        return finishChange(entries,entry);
      }
      if(entry.digest!==input.expectedInstalledDigest||(entry.generation ?? 1)!==input.expectedInstalledRevision) return fail('This installation changed. Refresh it and review a new preview.',409);
      if(entry.phase!=='installed'||entry.upgrade||entry.archiveIntent||entry.skillArchiveIntent) return fail('Recover the current installation before changing pack versions.',409);
      assertIdle(entry);
      const prior=action==='rollback' ? await savedSnapshot(entry,Number(input.installationRevision)) : undefined;
      if(action==='rollback'&&!prior) return fail('That prior configuration is unavailable. Refresh pack history.',409);
      const target=prior?.pack ?? supplied!,planned=await previewPackChange(entry,target,Object.values(entries),changeDeps,prior);
      if(planned.preview.digest!==input.expectedDigest||planned.preview.previewDigest!==input.expectedPreviewDigest) return fail('Plans, instructions or the target changed after preview. Review a fresh preview.',409);
      if(!planned.preview.canApply) return fail(planned.preview.conflicts.join(' '),409);
      entry.transition={...planned.change,requestDigest};
      assertJournalFits(completeChange(entries,entry)); await persistJournals(entries);
      return finishChange(entries,entry);
    });
  }
  function assertOwnedRecipeReady(entries:Record<string,Journal>,recipeId:string) {
    const owners=Object.values(entries).filter(entry=>packRecipeClaims(entry).has(recipeId));
    if(owners.length>1) return fail('More than one imported pack claims this workflow plan. Resolve its ownership before running.',409);
    for(const entry of owners) {
      if(entry.retiredRecipeIds?.includes(recipeId)) return fail('This plan was retired by a reviewed pack change. Its history is retained; use a current plan or explicitly roll back the pack.',409);
      if(entry.transition || entry.archiveIntent || entry.skillArchiveIntent) return fail('This plan’s reviewed pack change needs recovery before work can run.',409);
    }
  }

  const pendingDirectory = () => join(options.profileDirectory(), 'pending', 'skills');
  async function pendingRecord(id: string) {
    if (!/^[a-f0-9]{8}$/.test(id)) return fail('Invalid pending skill identifier.');
    const file = join(pendingDirectory(), `${id}.json`);
    await safeAncestors(dirname(file));
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 100_000) return fail('This pending proposal is not a safe instruction record.', 409);
    const raw = await readFile(file, 'utf8');
    let record: Record<string, unknown>;
    try { record = fields(JSON.parse(raw), ['id', 'subsystem', 'action', 'summary', 'origin', 'created_at', 'payload']); } catch { return fail('This pending skill proposal has an unsupported format.', 409); }
    if (record.id !== id || record.subsystem !== 'skills') return fail('This pending proposal has a different identity.', 409);
    return { file, digest: hash(raw), record };
  }
  async function readSkillArchive(packId:string,skillId:string,digest:string):Promise<SkillHistoryArchive> {
    const target=join(options.directory,skillArchivePath(packId,digest));await safeAncestors(dirname(target));
    return validateSkillHistoryArchive(await readPrivateJson(target,SKILL_ARCHIVE_MAX_BYTES),packId,skillId,digest);
  }
  async function* skillChain(packId:string,skillId:string,initial:SkillArchiveHead|undefined) {
    let head=initial;const seen=new Set<string>();
    while(head){if(seen.has(head.digest)||seen.size>=SKILL_ARCHIVE_MAX_BATCHES)fail('Instruction archive chain needs recovery.',409);seen.add(head.digest);
      const record=await readSkillArchive(packId,skillId,head.digest);if(skillHistoryHash(nextSkillArchiveHead(record,head.digest))!==skillHistoryHash(head))fail('Instruction archive counts need recovery.',409);
      yield {record,digest:head.digest};head=record.previous??undefined;
    }
  }
  const revisionMetadata=(entry:PackConfiguration,skillId:string,version:SkillVersion,activeRevision:number):PackSkillRevisionMetadata=>({packId:entry.pack.id,skillId,revision:version.revision,digest:version.digest,createdAt:version.createdAt,reason:version.reason,active:version.revision===activeRevision});
  function skillOverride(entry:Journal,skillId:string) {return entry.overrides?.[skillId]??{activeRevision:1,versions:[activeSkill(entry,skillId)]};}
  const skillConfirmation=(intent:SkillArchiveIntent):PackSkillArchiveConfirmation=>({expectedInstalledDigest:intent.fromDigest,expectedInstalledRevision:intent.fromGeneration,expectedActiveDigest:intent.activeDigest,expectedActiveRevision:intent.activeRevision,expectedHead:intent.head,expectedPreviewDigest:intent.previewDigest});
  function skillSummary(entry:Journal,skillId:string):PackSkillHistorySummary {
    const override=skillOverride(entry,skillId),active=activeSkill(entry,skillId);
    return {packId:entry.pack.id,skillId,name:entry.pack.skills.find(s=>s.id===skillId)!.name,installedDigest:entry.digest,installedRevision:entry.generation??1,activeRevision:active.revision,activeDigest:active.digest,head:override.archiveHead?.digest??null,hotRevisions:override.versions.length,archivedRevisions:override.archiveHead?.revisions??0,pendingArchive:entry.skillArchiveIntent?.skillId===skillId?skillConfirmation(entry.skillArchiveIntent):null};
  }
  function completedSkillArchive(entry:Journal,intent:SkillArchiveIntent,record:SkillHistoryArchive):Journal {
    const override=entry.overrides![intent.skillId];
    return {...entry,skillArchiveIntent:undefined,lastSkillArchive:intent,overrides:{...entry.overrides,[intent.skillId]:{...override,archiveHead:nextSkillArchiveHead(record,intent.digest),versions:override.versions.slice(-2)}}};
  }
  async function skillArchivePreview(entry:Journal,skillId:string):Promise<PackSkillArchivePreview> {
    const summary=skillSummary(entry,skillId),override=skillOverride(entry,skillId),conflicts:string[]=[];
    if(entry.phase!=='installed'||entry.upgrade||entry.transition||entry.archiveIntent||entry.skillArchiveIntent)conflicts.push('Finish the saved pack or instruction change before archiving older revisions.');
    if(override.versions.length<=2)conflicts.push('The two newest revisions stay immediately available. There are no older revisions to archive yet.');
    if((override.archiveHead?.batches??0)>=SKILL_ARCHIVE_MAX_BATCHES)conflicts.push('This skill has reached its retained history bound. Service migration is required; nothing was removed.');
    try{validateSkillOverride(override,true);}catch{conflicts.push('The saved revision ordering is ambiguous and needs recovery before archival.');}
    try{assertIdle(entry);}catch{conflicts.push('Wait for this pack’s queued or running work to finish.');}
    const current=activeSkill(entry,skillId),artifact=artifacts(entry.pack,entry.overrides).find(a=>a.key===`native:${skillId}`)!;
    if(await artifactState(artifact.path,current.content)!=='identical')conflicts.push('The current instruction file changed or is missing. Repair or review it before archiving history.');
    const previewDigest=skillArchivePreviewDigest(entry,skillId,archiveScope());
    if(!conflicts.length){try{const at=new Date().toISOString(),record=skillHistoryArchive(entry,skillId,at,archiveScope()),intent:SkillArchiveIntent={skillId,previewDigest,fromGeneration:entry.generation??1,fromDigest:entry.digest,activeRevision:current.revision,activeDigest:current.digest,head:override.archiveHead?.digest??null,archivedAt:at,digest:skillHistoryHash(record),scope:archiveScope()};validateSkillHistoryArchive(record,entry.pack.id,skillId,intent.digest);
      const entries=await journals();assertJournalFits({...entries,[entry.pack.id]:completedSkillArchive(entry,intent,record)});validateSkillJournalRoot({version:2,installs:{...entries,[entry.pack.id]:{...entry,skillArchiveIntent:intent}}});
    }catch(error){conflicts.push(error instanceof Error?error.message:'This archive cannot fit safely in the current journal.');}}
    return {...summary,previewDigest,archive:override.versions.slice(0,-2).map(v=>revisionMetadata(entry,skillId,v,current.revision)),keep:override.versions.slice(-2).map(v=>revisionMetadata(entry,skillId,v,current.revision)),conflicts,canArchive:!conflicts.length};
  }
  async function finishSkillArchive(entries:Record<string,Journal>,entry:Journal) {
    const intent=entry.skillArchiveIntent;if(!intent)fail('No reviewed instruction archive is waiting for recovery.',409);
    if(intent.scope!==archiveScope())fail('Select the same private workspace and profile before resuming this instruction archive.',409);assertIdle(entry);
    const record=skillHistoryArchive(entry,intent.skillId,intent.archivedAt,intent.scope),digest=skillHistoryHash(record),complete=completedSkillArchive(entry,intent,record);
    validateSkillHistoryArchive(record,entry.pack.id,intent.skillId,digest);if(digest!==intent.digest)fail('The saved archive no longer matches its reviewed instructions.',409);
    assertJournalFits({...entries,[entry.pack.id]:complete});
    const target=join(options.directory,skillArchivePath(entry.pack.id,digest));await safeAncestors(dirname(target));
    await privateDirectory(join(options.directory,'customer-skill-history'));fsyncDir(options.directory);await privateDirectory(dirname(target));fsyncDir(join(options.directory,'customer-skill-history'));
    const temporaries=await archiveTemporaries(target,record),existing=await readPrivateJson(target,SKILL_ARCHIVE_MAX_BYTES);
    if(existing===undefined)await writePrivateJson(target,record);else validateSkillHistoryArchive(existing,entry.pack.id,intent.skillId,digest);
    await readSkillArchive(entry.pack.id,intent.skillId,digest);
    for(const temporary of temporaries){const stat=await lstat(temporary.path);if(!stat.isFile()||stat.nlink!==1||stat.ino!==temporary.ino||stat.dev!==temporary.dev||stat.size>SKILL_ARCHIVE_MAX_BYTES||hash(await readFile(temporary.path))!==temporary.digest)fail('Instruction archive staging changed. Its files were preserved.',409);await unlink(temporary.path);}
    if(temporaries.length)fsyncDir(dirname(target));
    for await(const _record of skillChain(entry.pack.id,intent.skillId,entry.overrides?.[intent.skillId]?.archiveHead)){/* revalidate retained chain before pruning hot text */}
    const active=activeSkill(entry,intent.skillId),artifact=artifacts(entry.pack,entry.overrides).find(a=>a.key===`native:${intent.skillId}`)!;
    if(await artifactState(artifact.path,active.content)!=='identical')fail('Current instructions changed during archival. Restore their reviewed file before resuming.',409);
    if(intent.scope!==archiveScope())fail('The private workspace changed during archival. Resume in its original workspace.',409);assertIdle(entry);
    await persistJournals({...entries,[entry.pack.id]:complete});return status(complete);
  }
  async function archiveSkill(packId:string,skillId:string,body:unknown,resumeOnly=false) {
    const input=fields(body,['expectedInstalledDigest','expectedInstalledRevision','expectedActiveDigest','expectedActiveRevision','expectedHead','expectedPreviewDigest']);
    if(![input.expectedInstalledDigest,input.expectedActiveDigest,input.expectedPreviewDigest].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))||![input.expectedInstalledRevision,input.expectedActiveRevision].every(v=>Number.isSafeInteger(v)&&Number(v)>0)||(input.expectedHead!==null&&(typeof input.expectedHead!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedHead))))fail('Review the exact current instruction history before archiving it.',400);
    return exclusive(async()=>{const entries=await journals(),entry=entries[packId];if(!entry)fail('The installed pack was not found.',404);
      const matches=(intent:SkillArchiveIntent)=>intent.skillId===skillId&&intent.scope===archiveScope()&&JSON.stringify(skillConfirmation(intent))===JSON.stringify({expectedInstalledDigest:input.expectedInstalledDigest,expectedInstalledRevision:input.expectedInstalledRevision,expectedActiveDigest:input.expectedActiveDigest,expectedActiveRevision:input.expectedActiveRevision,expectedHead:input.expectedHead,expectedPreviewDigest:input.expectedPreviewDigest});
      if(entry.lastSkillArchive&&matches(entry.lastSkillArchive))return status(entry);
      // A lost response may be retried after a later archive or after removal of
      // the skill. Reconcile only an exact immutable, still reachable receipt.
      async function* configurations(){yield entry;yield* entry.history??[];for await(const {record}of archiveChain(entry))yield* record.snapshots;}
      const checked=new Set<string>();
      for await(const config of configurations())for await(const {record,digest}of skillChain(entry.pack.id,skillId,config.overrides?.[skillId]?.archiveHead)){
        if(checked.has(digest))break;if(checked.size>=SKILL_ARCHIVE_MAX_BATCHES)fail('Instruction archive graph has reached its validation bound.',409);checked.add(digest);
        if(matches({skillId:record.skillId,previewDigest:record.previewDigest,fromGeneration:record.installedGeneration,fromDigest:record.installedDigest,activeRevision:record.activeRevision,activeDigest:record.activeDigest,head:record.previous?.digest??null,archivedAt:record.archivedAt,digest,scope:record.scope}))return status(entry);
      }

      if(entry.skillArchiveIntent){if(!matches(entry.skillArchiveIntent))fail('A different instruction archive is awaiting recovery. Resume its saved review.',409);return finishSkillArchive(entries,entry);}
      if(resumeOnly)fail('No matching saved instruction archive is waiting for recovery.',409);
      const preview=await skillArchivePreview(entry,skillId);if(!preview.canArchive)fail(preview.conflicts.join(' '),409);
      const active=activeSkill(entry,skillId),archivedAt=new Date().toISOString(),record=skillHistoryArchive(entry,skillId,archivedAt,archiveScope());
      const intent:SkillArchiveIntent={skillId,previewDigest:preview.previewDigest,fromGeneration:entry.generation??1,fromDigest:entry.digest,activeRevision:active.revision,activeDigest:active.digest,head:entry.overrides?.[skillId]?.archiveHead?.digest??null,archivedAt,digest:skillHistoryHash(record),scope:archiveScope()};
      if(!matches(intent))fail('Instruction history changed after preview. Review a fresh archive preview.',409);assertIdle(entry);
      assertJournalFits({...entries,[entry.pack.id]:completedSkillArchive(entry,intent,record)});entry.skillArchiveIntent=intent;
      await persistJournals(entries);return finishSkillArchive(entries,entry);
    });
  }
  async function selectedSkillSource(entry:Journal,skillId:string,installationRevision:unknown) {
    const generation=installationRevision===undefined?entry.generation??1:Number(installationRevision);
    if(!Number.isSafeInteger(generation)||generation<1)fail('Select a saved pack configuration.',400);
    const config=generation===(entry.generation??1)?entry:await savedSnapshot(entry,generation);
    if(!config||!config.pack.skills.some(s=>s.id===skillId))fail('That saved skill configuration is unavailable.',404);
    const override=config.overrides?.[skillId]??{activeRevision:1,versions:[{revision:1,digest:hash(nativeInstruction(config.pack,config.pack.skills.find(s=>s.id===skillId)!)),content:nativeInstruction(config.pack,config.pack.skills.find(s=>s.id===skillId)!),createdAt:'installedAt'in config?config.installedAt:config.savedAt,reason:'Published pack baseline'}]};
    validateSkillOverride(override,true);const head=override.archiveHead?.digest??null;
    return {config,override,generation,head,sourceDigest:skillHistoryHash({generation,packDigest:config.digest,skillId,override})};
  }
  async function skillHistory(packId:string,skillId:string,body:unknown):Promise<PackSkillHistoryPage> {
    const input=fields(body??{},['installationRevision','head','sourceDigest','cursor']),entry=(await journals())[packId];if(!entry)fail('The installed pack was not found.',404);
    const source=await selectedSkillSource(entry,skillId,input.installationRevision);
    if(input.head!==undefined&&input.head!==source.head||input.sourceDigest!==undefined&&input.sourceDigest!==source.sourceDigest||input.cursor!==undefined&&(input.head!==source.head||input.sourceDigest!==source.sourceDigest||input.installationRevision!==source.generation))fail('Instruction history changed. Refresh from the first page.',409);
    const cursor=input.cursor??'hot:0';if(typeof cursor!=='string'||!/^(?:hot|[a-f0-9]{64}):\d{1,3}$/.test(cursor))fail('Choose a valid instruction history page.',400);
    const [batch,indexText]=cursor.split(':'),index=Number(indexText);let versions:SkillVersion[],next:string|null=null;
    if(batch==='hot'){versions=[...source.override.versions].reverse();next=source.head?`${source.head}:0`:null;}
    else{let found:SkillHistoryArchive|undefined;for await(const {record,digest}of skillChain(packId,skillId,source.override.archiveHead))if(digest===batch){found=record;break;}if(!found)fail('That instruction history page is outside the selected configuration.',404);versions=[...found.versions].reverse();next=found.previous?`${found.previous.digest}:0`:null;}
    if(index>=versions.length)fail('That instruction history page is no longer available.',404);
    const selected=versions.slice(index,index+SKILL_HISTORY_PAGE_SIZE);if(index+selected.length<versions.length)next=`${batch}:${index+selected.length}`;
    return {packId,skillId,installationRevision:source.generation,head:source.head,sourceDigest:source.sourceDigest,cursor,nextCursor:next,revisions:selected.map(v=>revisionMetadata(source.config,skillId,v,source.override.activeRevision))};
  }
  async function skillRevertPreview(packId:string,skillId:string,body:unknown):Promise<PackSkillRevertPreview> {
    const input=fields(body,['installationRevision','head','sourceDigest','revision','digest']);
    if(!Number.isSafeInteger(input.revision)||Number(input.revision)<1||typeof input.digest!=='string'||!/^[a-f0-9]{64}$/.test(input.digest)||typeof input.sourceDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.sourceDigest)||!Number.isSafeInteger(input.installationRevision)||Number(input.installationRevision)<1||(input.head!==null&&(typeof input.head!=='string'||!/^[a-f0-9]{64}$/.test(input.head))))fail('Select the exact saved instruction revision for review.',400);
    const entry=(await journals())[packId];if(!entry)fail('The installed pack was not found.',404);const current=activeSkill(entry,skillId),source=await selectedSkillSource(entry,skillId,input.installationRevision);
    if(source.head!==input.head||source.sourceDigest!==input.sourceDigest)fail('The selected instruction history changed. Refresh before reviewing it.',409);
    let prior=source.override.versions.find(v=>v.revision===input.revision);
    if(!prior)for await(const {record}of skillChain(packId,skillId,source.override.archiveHead)){prior=record.versions.find(v=>v.revision===input.revision);if(prior)break;}
    if(!prior||prior.digest!==input.digest)fail('That saved instruction text is unavailable or changed.',409);
    const conflicts:string[]=[];if(entry.phase!=='installed'||entry.upgrade||entry.transition||entry.archiveIntent||entry.skillArchiveIntent)conflicts.push('Finish the saved pack or instruction change before reverting.');
    try{validateSkillOverride(skillOverride(entry,skillId),true);assertIdle(entry);}catch{conflicts.push('Current instruction history or active work needs review before reverting.');}
    if(current.digest===prior.digest)conflicts.push('These exact instructions are already active.');if(skillOverride(entry,skillId).versions.length>=100)conflicts.push('Archive older instruction revisions before adding another revision.');
    const artifact=artifacts(entry.pack,entry.overrides).find(a=>a.key===`native:${skillId}`)!;if(await artifactState(artifact.path,current.content)!=='identical')conflicts.push('The active instruction file changed. Repair or review it before reverting.');
    const selection:PackSkillHistorySelection={installationRevision:Number(input.installationRevision),head:input.head as string|null,sourceDigest:String(input.sourceDigest),revision:Number(input.revision),digest:String(input.digest)},recipes=entry.pack.recipes.map(p=>({id:p.id,revision:listRecipes().find(r=>r.id===p.id)?.revision??null}));
    const reviewDigest=skillHistoryHash({packId,skillId,selection,installedDigest:entry.digest,installedRevision:entry.generation??1,activeRevision:current.revision,activeDigest:current.digest,recipes,scope:archiveScope()});
    return {packId,skillId,name:entry.pack.skills.find(s=>s.id===skillId)!.name,selection,reviewDigest,installedDigest:entry.digest,installedRevision:entry.generation??1,activeRevision:current.revision,activeDigest:current.digest,current:current.content,proposed:prior.content,target:revisionMetadata(source.config,skillId,prior,current.revision),conflicts,canRevert:!conflicts.length};
  }

  const activeSkill = (entry: Journal, skillId: string) => {
    const skill = entry.pack.skills.find(skill => skill.id === skillId); if (!skill) return fail('This skill is not owned by the selected pack.', 404);
    const override = entry.overrides?.[skillId];
    return override?.versions.find(version => version.revision === override.activeRevision) ?? { revision: 1, digest: hash(nativeInstruction(entry.pack, skill)), content: nativeInstruction(entry.pack, skill), createdAt: entry.installedAt, reason: 'Published pack baseline' };
  };
  function validateNativeInstruction(entry: Journal, skillId: string, content: unknown): string {
    const native = text(content, 40_000), name = `realbud-${entry.pack.id}-${skillId}`;
    const normalized = native.replaceAll('\r\n', '\n');
    const front = normalized.match(/^---\n([\s\S]*?)\n---\n/);
    if (!front || front[1].split('\n').length !== 2 || !front[1].split('\n').includes(`name: ${name}`) || !front[1].split('\n').some(line => /^description: [^\r\n]+$/.test(line))) return fail('Only this pack’s named SKILL.md text can be updated. Keep only name and description in its frontmatter; no tool, path or permission metadata.', 409);
    const header = parseDocument(front[1], { uniqueKeys: true, version: '1.1' });
    if (header.errors.length || header.warnings.length) return fail('Instruction frontmatter must contain plain name and description text.', 409);
    const metadata = fields(header.toJSON(), ['name', 'description']);
    if (metadata.name !== name || typeof metadata.description !== 'string' || !metadata.description.trim() || metadata.description.length > 300) return fail('Instruction frontmatter must retain its owned name and a short text description.', 409);
    // Reuse portable-content checks before exposing or accepting proposed text.
    validateCustomerPack({ ...entry.pack, skills: entry.pack.skills.map(skill => skill.id === skillId ? { ...skill, instructions: native } : skill) });
    return native;
  }
  async function proposal(id: string, entries: Record<string, Journal>): Promise<PackSkillProposal> {
    const pending = await pendingRecord(id), payload = pending.record.payload;
    const origin = pending.record.origin === 'background_review' ? 'Background review' : 'Worker proposal';
    const unsupported = (reason: string): PackSkillProposal => ({ id, pendingDigest: pending.digest, packId: null, skillId: null, name: 'Other skill proposal', state: 'unsupported', reason, current: null, proposed: null, currentDigest: null, activeRevision: 0, origin });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return unsupported('The proposal payload needs service review.');
    const p = payload as Record<string, unknown>;
    if (!['create', 'edit'].includes(String(p.action)) || pending.record.action !== p.action || Object.keys(p).some(key => !['action', 'name', 'content', 'category', 'replace_all'].includes(key)) || (p.replace_all !== undefined && p.replace_all !== false) || (p.category !== undefined && p.category !== '')) return unsupported('Only complete text edits to this installed pack’s instruction skills are supported. Scripts, patches, deletion, other skills and memory changes remain held.');
    for (const entry of Object.values(entries)) for (const skill of entry.pack.skills) {
      if (p.name !== `realbud-${entry.pack.id}-${skill.id}`) continue;
      if (entry.upgrade || entry.transition || entry.archiveIntent || entry.skillArchiveIntent) return unsupported('This pack already has a reviewed change awaiting recovery.');
      const current = activeSkill(entry, skill.id);
      const file = artifacts(entry.pack, entry.overrides).find(artifact => artifact.id === skill.id)!.path;
      if (await artifactState(file, current.content) !== 'identical') return unsupported('The installed skill has changed or is missing. Resolve its local state before reviewing a new revision.');
      let proposed: string;
      try { proposed = validateNativeInstruction(entry, skill.id, p.content); }
      catch { return unsupported('Proposed instructions contain unsupported metadata, a machine-specific path or sensitive-looking content. Revise the proposal; nothing was activated.'); }
      return { id, pendingDigest: pending.digest, packId: entry.pack.id, skillId: skill.id, name: skill.name, state: 'reviewable', reason: 'Review the complete old and new instructions. Approval pauses dependent plans and requires fresh plan approval.', current: current.content, proposed, currentDigest: current.digest, activeRevision: current.revision, origin };
    }
    return unsupported('This proposal targets a skill outside the installed customer pack. It cannot modify the worker’s core or another skill through this screen.');
  }
  async function proposals() {
    const entries = await journals();
    let names: string[] = [];
    try { await safeAncestors(pendingDirectory()); names = (await readdir(pendingDirectory())).filter(name => /^[a-f0-9]{8}\.json$/.test(name)).sort(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const items: PackSkillProposal[] = [];
    for (const name of names.slice(0, 100)) {
      try {
        const item = await proposal(name.slice(0, -5), entries);
        if (!Object.values(entries).some(entry => entry.proposalReceipts?.some(receipt => receipt.id === item.id && receipt.digest === item.pendingDigest))) items.push(item);
      } catch { items.push({ id: name.slice(0, -5), pendingDigest: '', packId: null, skillId: null, name: 'Unreadable skill proposal', state: 'unsupported', reason: 'The record needs service recovery. It was not followed or activated.', current: null, proposed: null, currentDigest: null, activeRevision: 0, origin: 'Worker proposal' }); }
    }
    const revisions: PackSkillRevisionMetadata[] = Object.values(entries).flatMap(entry => entry.pack.skills.flatMap(skill => {
      const versions = entry.overrides?.[skill.id]?.versions ?? [activeSkill(entry, skill.id)];
      return versions.slice(-2).map(version => revisionMetadata(entry, skill.id, version, activeSkill(entry, skill.id).revision));
    }));
    const learning = options.learningStatus?.() ?? { supported: stagedLearningSupported(), policyReady: learningPolicyReady(), enabled: stagedLearningEnabled() };
    return { proposals: items, revisions, skillHistories:Object.values(entries).flatMap(entry=>entry.pack.skills.map(skill=>skillSummary(entry,skill.id))), learning, hasMore: names.length > 100, pendingUpgrades: Object.values(entries).filter(entry => entry.upgrade).map(entry => ({ packId: entry.pack.id, digest: entry.digest })) };
  }
  async function finishUpgrade(entries: Record<string, Journal>, entry: Journal) {
    assertIdle(entry);
    const upgrade = entry.upgrade; if (!upgrade) return fail('No instruction change needs recovery.', 409);
    const assertUpgradeScope=()=>{if(upgrade.scope&&upgrade.scope!==archiveScope())fail('Select the same private workspace and profile before recovering this instruction change.',409);};
    assertUpgradeScope();
    const completed = completedUpgrade(entries, entry);
    assertJournalFits(completed);
    await options.pauseSchedules?.(entry.pack.id);
    assertIdle(entry);
    if (upgrade.pendingId && upgrade.pendingDigest) {
      const pending = await pendingRecord(upgrade.pendingId).catch(() => null);
      if (pending?.digest !== upgrade.pendingDigest) return fail('The approved pending proposal changed or disappeared. Existing instructions were preserved; service recovery is required.', 409);
    }
    const current = activeSkill(entry, upgrade.skillId), target = artifacts(entry.pack, entry.overrides).find(artifact => artifact.id === upgrade.skillId)!;
    const previousState = await artifactState(target.path, current.content), nextState = await artifactState(target.path, upgrade.target.content);
    if (current.digest !== upgrade.fromDigest || (previousState !== 'identical' && nextState !== 'identical')) return fail('Instructions changed during review. Existing files were preserved; service review is required.', 409);
    const local = new Map(listRecipes().map(recipe => [recipe.id, recipe]));
    const unchanged = upgrade.recipes.every(recipe => local.get(recipe.id)?.revision === recipe.revision);
    const alreadyPaused = upgrade.recipes.every(recipe => { const current = local.get(recipe.id); return current?.revision === recipe.revision + 1 && current.status === 'shadow' && current.schedule === null && current.planApprovedAt === null && current.approvedRevision === null; });
    assertIdle(entry);
    assertUpgradeScope();
    if (unchanged) resetApprovals(upgrade.recipes);
    else if (!alreadyPaused) return fail('Dependent plans changed during the instruction update. They must be reviewed before recovery can continue.', 409);
    // Pause/clear approvals first. A crash can hold work, never run changed
    // instructions under an old plan approval.
    if (nextState !== 'identical') writeFileAtomic(target.path, upgrade.target.content, 0o600);
    if (await artifactState(target.path, upgrade.target.content) !== 'identical') return fail('Instruction readback failed; dependent plans remain paused.', 409);
    assertUpgradeScope();
    await persistJournals(completed);
    if (upgrade.pendingId && upgrade.pendingDigest) {
      const record = await pendingRecord(upgrade.pendingId).catch(() => null);
      if (record?.digest === upgrade.pendingDigest) await unlink(record.file);
    }
    return status(completed[entry.pack.id]);
  }
  async function reviewProposal(body: unknown) {
    const input = fields(body, ['id', 'pendingDigest', 'currentDigest', 'decision']);
    if (!['approve', 'reject'].includes(String(input.decision))) return fail('Choose approve or reject.');
    return exclusive(async () => {
      const entries = await journals(), item = await proposal(String(input.id), entries);
      if (!item.pendingDigest || item.pendingDigest !== input.pendingDigest) return fail('The proposal changed. Review it again.', 409);
      if (!item.packId || !item.skillId || item.state !== 'reviewable') return fail('This proposal needs service review and cannot be applied here.', 409);
      const entry = entries[item.packId];
      if (item.currentDigest !== input.currentDigest) return fail('The active skill changed. Review the latest instructions first.', 409);
      if (input.decision === 'reject') {
        entry.proposalReceipts ??= []; entry.proposalReceipts.push({ id: item.id, digest: item.pendingDigest, outcome: 'rejected', at: new Date().toISOString() });
        await persistJournals(entries);
        const record = await pendingRecord(item.id); if (record.digest === item.pendingDigest) await unlink(record.file);
        return status(entry);
      }
      if ((entry.overrides?.[item.skillId]?.versions.length ?? 1) >= 100) return fail('Archive older instruction revisions before adding another revision.', 409);
      validateSkillOverride(skillOverride(entry,item.skillId),true);
      assertIdle(entry);
      const recipes = entry.pack.recipes.map(plan => { const current = listRecipes().find(recipe => recipe.id === plan.id); if (!current) return fail('Repair the missing dependent plan before updating instructions.', 409); return { id: current.id, revision: current.revision }; });
      entry.upgrade = { scope:archiveScope(), skillId: item.skillId, fromDigest: item.currentDigest!, target: { revision: item.activeRevision + 1, content: item.proposed!, digest: hash(item.proposed!), createdAt: new Date().toISOString(), reason: `Reviewed native proposal ${item.id}` }, recipes, pendingId: item.id, pendingDigest: item.pendingDigest };
      assertJournalFits(completedUpgrade(entries, entry));
      await persistJournals(entries);
      return finishUpgrade(entries, entry);
    });
  }
  async function revertSkill(body: unknown) {
    const input=fields(body,['packId','skillId','installationRevision','head','sourceDigest','revision','digest','expectedReviewDigest','currentDigest']);
    if(input.currentDigest!==undefined||typeof input.expectedReviewDigest!=='string'||!/^[a-f0-9]{64}$/.test(input.expectedReviewDigest))fail('Open instruction history and review the full selected revision before reverting. This older review is no longer sufficient.',409);
    const packId=safeId(input.packId),skillId=safeId(input.skillId);
    const selection={installationRevision:input.installationRevision,head:input.head,sourceDigest:input.sourceDigest,revision:input.revision,digest:input.digest} as PackSkillHistorySelection;
    return exclusive(async()=>{
      const entries=await journals(),entry=entries[packId];if(!entry)fail('The installed pack was not found.',404);
      const receipt:SkillRevertReceipt={skillId,selection,reviewDigest:input.expectedReviewDigest as string,scope:archiveScope()};
      const same=(saved:SkillRevertReceipt|undefined)=>saved&&skillHistoryHash(saved)===skillHistoryHash(receipt);
      if(same(entry.lastSkillRevert))return status(entry);
      if(entry.upgrade){if(!same(entry.upgrade.revertReceipt))fail('A different instruction change needs recovery before reverting.',409);return finishUpgrade(entries,entry);}
      const preview=await skillRevertPreview(packId,skillId,selection);
      if(preview.reviewDigest!==input.expectedReviewDigest)fail('Instructions, their saved configuration or dependent plans changed after review. Review them again.',409);
      if(!preview.canRevert)fail(preview.conflicts.join(' '),409);
      if(receipt.scope!==archiveScope())fail('The private workspace changed during review. Review it again.',409);
      assertIdle(entry);validateSkillOverride(skillOverride(entry,skillId),true);
      const content=validateNativeInstruction(entry,skillId,preview.proposed);
      const recipes=entry.pack.recipes.map(plan=>{const current=listRecipes().find(r=>r.id===plan.id);if(!current)fail('Repair missing plans before reverting.',409);return {id:current.id,revision:current.revision};});
      entry.upgrade={skillId,fromDigest:preview.activeDigest,target:{revision:preview.activeRevision+1,content,digest:hash(content),createdAt:new Date().toISOString(),reason:`Reviewed revert to instruction revision ${selection.revision} from configuration ${selection.installationRevision}`},recipes,scope:receipt.scope,revertReceipt:receipt};
      assertJournalFits(completedUpgrade(entries,entry));await persistJournals(entries);return finishUpgrade(entries,entry);
    });
  }

  return {
    preview, install,
    async previewUpgrade(value:unknown) { return (await changePreview(value)).preview; },
    upgrade:(body:unknown)=>changePack(body,'upgrade'), rollback:(body:unknown)=>changePack(body,'rollback'),
    proposals, reviewProposal, revertSkill, skillHistory, skillRevertPreview, archiveSkill,
    async skillArchivePreview(packId:string,skillId:string){const entry=(await journals())[safeId(packId)];if(!entry)fail('The installed pack was not found.',404);return skillArchivePreview(entry,safeId(skillId));},
    async packRecipeBinding(packId: string, recipeId: string): Promise<string> {
      const entries = await journals(), entry = entries[packId];
      assertOwnedRecipeReady(entries,recipeId);
      if (!entry || !entry.pack.recipes.some(recipe => recipe.id === recipeId) || !(await status(entry)).localReady) return fail('Install and review the selected workflow pack before using this plan.',409);
      return hash(JSON.stringify({ pack: entry.digest, skills: entry.pack.skills.map(skill => { const active=activeSkill(entry,skill.id);return [skill.id,active.revision,active.digest]; }) }));
    },
    async instructionContext(recipeId: string): Promise<string> {
      const contexts: string[] = [];
      const entries=await journals(); assertOwnedRecipeReady(entries,recipeId);
      for (const entry of Object.values(entries)) if (entry.pack.recipes.some(recipe => recipe.id === recipeId)) {
        if (!(await status(entry)).localReady) return fail('This job’s instruction pack needs recovery before preparing work.', 409);
        for (const skill of entry.pack.skills) { const version = activeSkill(entry, skill.id); contexts.push(`Reviewed instruction skill realbud-${entry.pack.id}-${skill.id}, revision ${version.revision}, SHA-256 ${version.digest}:\n${version.content}`); }
      }
      return contexts.join('\n\n');
    },
    async assertReadyForRecipe(recipeId: string) {
      const entries=await journals(); assertOwnedRecipeReady(entries,recipeId);
      for (const entry of Object.values(entries)) if (entry.pack.recipes.some(recipe => recipe.id === recipeId)) {
        if (!(await status(entry)).localReady) return fail('This job’s instruction pack needs recovery. Open customer pack setup before preparing it.', 409);
      }
    },
    async list() { const entries = await journals(); return { installations: await Promise.all(Object.values(entries).map(status)) }; },
    async handle(route: string, method: string, body?: unknown): Promise<{ status: number; body: unknown } | null> {
      if (!route.startsWith('/api/customer-packs')) return null;
      if (route === '/api/customer-packs' && method === 'GET') return { status: 200, body: await this.list() };
      if (route === '/api/customer-packs/skill-proposals' && method === 'GET') return { status: 200, body: await proposals() };
      if (route === '/api/customer-packs/skill-proposals/review' && method === 'POST') return { status: 200, body: await reviewProposal(body) };
      if (route === '/api/customer-packs/skill-proposals/revert' && method === 'POST') return { status: 200, body: await revertSkill(body) };
      if(route==='/api/customer-packs/upgrade/preview'&&method==='POST') { const input=fields(body,['pack']); return {status:200,body:await this.previewUpgrade(input.pack)}; }
      if(route==='/api/customer-packs/upgrade'&&method==='POST') return {status:200,body:await changePack(body,'upgrade')};
      if(route==='/api/customer-packs/rollback'&&method==='POST') return {status:200,body:await changePack(body,'rollback')};
      const skillRoute=route.match(/^\/api\/customer-packs\/([a-z][a-z0-9-]{1,79})\/skills\/([a-z][a-z0-9-]{1,79})\/(archive-preview|archive|resume-archive|history|revert-preview|revert)$/);
      if(skillRoute&&method==='POST'){
        const [,packId,skillId,action]=skillRoute;
        if(action==='archive-preview'){fields(body??{},[]);return {status:200,body:await this.skillArchivePreview(packId,skillId)};}
        if(action==='history')return {status:200,body:await skillHistory(packId,skillId,body)};
        if(action==='revert-preview')return {status:200,body:await skillRevertPreview(packId,skillId,body)};
        if(action==='revert'){const input=fields(body,['installationRevision','head','sourceDigest','revision','digest','expectedReviewDigest']);return {status:200,body:await revertSkill({...input,packId,skillId})};}
        return {status:200,body:await archiveSkill(packId,skillId,body,action==='resume-archive')};
      }
      const archiveRoute=route.match(/^\/api\/customer-packs\/([a-z][a-z0-9-]{1,79})\/(archive-preview|archive|resume-archive|archived-history)$/);
      if(archiveRoute&&method==='POST') {
        const [,id,action]=archiveRoute;
        if(action==='archive-preview') { fields(body ?? {},[]);const entry=(await journals())[id];if(!entry)return fail('The installed pack was not found.',404);return {status:200,body:archivePreview(entry)}; }
        if(action==='archived-history') return {status:200,body:await archivedHistory(id,body)};
        return {status:200,body:await archivePack(id,body,action==='resume-archive')};
      }
      const packChange=route.match(/^\/api\/customer-packs\/([a-z][a-z0-9-]{1,79})\/(rollback-preview|resume-change|history-export)$/);
      if(packChange&&method==='POST') {
        const input=fields(body,packChange[2]==='resume-change' ? ['expectedInstalledDigest','expectedInstalledRevision','expectedPreviewDigest'] : ['installationRevision']);
        if(packChange[2]==='resume-change') return exclusive(async()=>{
          if(![input.expectedInstalledDigest,input.expectedPreviewDigest].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))||
              !Number.isSafeInteger(input.expectedInstalledRevision)||Number(input.expectedInstalledRevision)<1) return fail('Choose the exact saved pack change before resuming.',400);
          const entries=await journals(),entry=entries[packChange[1]];
          const last=entry?.lastTransition;
          if(entry&&last&&last.fromDigest===input.expectedInstalledDigest&&last.fromGeneration===input.expectedInstalledRevision&&last.previewDigest===input.expectedPreviewDigest)
            return {status:200,body:await status(entry)};
          if(!entry||entry.digest!==input.expectedInstalledDigest||(entry.generation ?? 1)!==input.expectedInstalledRevision||entry.transition?.previewDigest!==input.expectedPreviewDigest)
            return fail('The saved change no longer matches this screen. Refresh setup before resuming.',409);
          return {status:200,body:await finishChange(entries,entry)};
        });
        const entry=(await journals())[packChange[1]],prior=entry ? await savedSnapshot(entry,Number(input.installationRevision)) : undefined;
        if(!prior) return fail('That saved configuration is unavailable. Refresh pack history.',404);
        if(packChange[2]==='history-export') return {status:200,body:prior.pack};
        return {status:200,body:(await changePreview(entry.pack,prior.generation)).preview};
      }
      const recover = route.match(/^\/api\/customer-packs\/([a-z][a-z0-9-]{1,79})\/recover-instructions$/);
      if (recover && method === 'POST') return exclusive(async () => { const input = fields(body, ['expectedDigest']); const entries = await journals(), entry = entries[recover[1]]; if (!entry || entry.digest !== input.expectedDigest) return fail('Refresh this pack before recovering instructions.', 409); return { status: 200, body: await finishUpgrade(entries, entry) }; });
      if (route === '/api/customer-packs/austin-office/export' && method === 'GET') return { status: 200, body: validateCustomerPack(austinCustomerPack()) };
      if (route === '/api/customer-packs/office-core/export' && method === 'GET') return { status: 200, body: validateCustomerPack(officeCoreCustomerPack()) };
      if (route === '/api/customer-packs/preview' && method === 'POST') { const input = fields(body, ['pack']); return { status: 200, body: await preview(input.pack) }; }
      if (route === '/api/customer-packs/install' && method === 'POST') { const input = fields(body, ['pack', 'expectedDigest']); return { status: 200, body: await install(input.pack, String(input.expectedDigest)) }; }
      const repair = route.match(/^\/api\/customer-packs\/([a-z][a-z0-9-]{1,79})\/repair$/);
      if (repair && method === 'POST') { const input = fields(body, ['expectedDigest']); const entry = (await journals())[repair[1]]; if (!entry) return fail('Pack installation was not found.', 404); return { status: 200, body: await install(entry.pack, String(input.expectedDigest)) }; }
      return { status: 404, body: { error: 'Unknown customer pack action.' } };
    },
  };
}
