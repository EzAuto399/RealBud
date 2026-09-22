/** Pure, portable admission for immutable reviewed instruction history. */
import { createHash } from 'node:crypto';
import type { PackSkillHistorySelection } from '../shared/customer-packs.ts';
import type { SkillOverride, SkillVersion, PackUpgradeState } from './customer-pack-upgrades.ts';
export type SkillArchiveHead = { digest: string; batches: number; revisions: number; throughRevision: number };
export type SkillArchiveIntent = { skillId: string; previewDigest: string; fromGeneration: number; fromDigest: string; activeRevision: number; activeDigest: string; head: string | null; archivedAt: string; digest: string; scope: string };
export type SkillRevertReceipt = { skillId:string; reviewDigest:string; selection:PackSkillHistorySelection; scope:string };
export type SkillHistoryArchive = {
 format: 'realbud-skill-history'; version: 1; packId: string; skillId: string; previous: SkillArchiveHead | null;
 installedGeneration: number; installedDigest: string; activeRevision: number; activeDigest: string;
 previewDigest: string; scope: string; archivedAt: string; versions: SkillVersion[];
};
export const SKILL_ARCHIVE_MAX_BYTES = 4_100_000;
export const SKILL_ARCHIVE_MAX_BATCHES = 10_000;
export const SKILL_HISTORY_PAGE_SIZE = 20;
export const PACK_JOURNAL_MAX_BYTES = 2_000_000;
export const SKILL_ARCHIVE_INTENT_ALLOWANCE = 16_384;
export const skillHistoryHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const skillArchivePath = (packId: string, digest: string) => `customer-skill-history/${packId}/${digest}.json`;
export const isSkillArchivePath = (path: string) => /^customer-skill-history\/[a-z][a-z0-9-]{1,79}\/[a-f0-9]{64}\.json$/.test(path);
const object = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string,unknown>,keys:string[]) => Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const hex = (v:unknown):v is string => typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const id = (v:unknown):v is string => typeof v==='string'&&/^[a-z][a-z0-9-]{1,79}$/.test(v);
const positive = (v:unknown):v is number => Number.isSafeInteger(v)&&Number(v)>0;
function invalid():never {throw Object.assign(new Error('Reviewed instruction history needs recovery. Existing instructions and history were preserved.'),{status:409});}
export function skillArchiveHeadValid(v:unknown):v is SkillArchiveHead {
 return object(v)&&exact(v,['digest','batches','revisions','throughRevision'])&&hex(v.digest)&&positive(v.batches)&&v.batches<=SKILL_ARCHIVE_MAX_BATCHES&&positive(v.revisions)&&v.revisions>=v.batches&&v.revisions<=v.batches*98&&v.throughRevision===v.revisions;
}
function versionValid(v:unknown,canonical=true):v is SkillVersion {
 if(!object(v)||!positive(v.revision)||typeof v.content!=='string'||createHash('sha256').update(v.content).digest('hex')!==v.digest||typeof v.createdAt!=='string'||typeof v.reason!=='string')return false;
 return !canonical||(exact(v,['revision','digest','content','createdAt','reason'])&&v.content.length<=40_000&&Number.isFinite(Date.parse(v.createdAt))&&v.reason.length<=500);
}
/** Legacy ordering and historical metadata remain readable for recovery. New
 * archives and mutations require an exact contiguous canonical sequence. */
export function validateSkillOverride(value:unknown,canonical=false):asserts value is SkillOverride {
 if(!object(value)||!positive(value.activeRevision)||!Array.isArray(value.versions)||!value.versions.length||value.versions.length>100||value.versions.some(v=>!versionValid(v,false))||!value.versions.some(v=>v.revision===value.activeRevision)||(value.archiveHead!==undefined&&!skillArchiveHeadValid(value.archiveHead)))invalid();
 if(canonical||value.archiveHead){
  if(Object.keys(value).some(k=>!['activeRevision','versions','archiveHead'].includes(k))||value.versions.some((v:unknown)=>!versionValid(v)))invalid();
  const start=value.archiveHead?.throughRevision??0;if(value.versions.some((v:SkillVersion,i:number)=>v.revision!==start+i+1)||value.activeRevision!==start+value.versions.length)invalid();
 }
}
export function skillArchivePreviewDigest(entry:PackUpgradeState,skillId:string,scope:string):string {
 return skillHistoryHash({packId:entry.pack.id,skillId,generation:entry.generation??1,digest:entry.digest,scope,override:entry.overrides?.[skillId]??null});
}
export function skillHistoryArchive(entry:PackUpgradeState,skillId:string,archivedAt:string,scope:string):SkillHistoryArchive {
 const override=entry.overrides?.[skillId];validateSkillOverride(override,true);
 const active=override.versions.at(-1)!;
 return {format:'realbud-skill-history',version:1,packId:entry.pack.id,skillId,previous:override.archiveHead??null,installedGeneration:entry.generation??1,installedDigest:entry.digest,activeRevision:active.revision,activeDigest:active.digest,previewDigest:skillArchivePreviewDigest(entry,skillId,scope),scope,archivedAt,versions:override.versions.slice(0,-2)};
}
export function nextSkillArchiveHead(record:SkillHistoryArchive,digest:string):SkillArchiveHead {
 return {digest,batches:(record.previous?.batches??0)+1,revisions:(record.previous?.revisions??0)+record.versions.length,throughRevision:record.versions.at(-1)!.revision};
}
export function validateSkillHistoryArchive(value:unknown,packId:string,skillId:string,digest:string):SkillHistoryArchive {
 if(!object(value)||!exact(value,['format','version','packId','skillId','previous','installedGeneration','installedDigest','activeRevision','activeDigest','previewDigest','scope','archivedAt','versions'])||value.format!=='realbud-skill-history'||value.version!==1||!id(packId)||value.packId!==packId||!id(skillId)||value.skillId!==skillId||!hex(digest)||skillHistoryHash(value)!==digest||Buffer.byteLength(JSON.stringify(value))>SKILL_ARCHIVE_MAX_BYTES||!positive(value.installedGeneration)||!hex(value.installedDigest)||!positive(value.activeRevision)||!hex(value.activeDigest)||!hex(value.previewDigest)||!hex(value.scope)||typeof value.archivedAt!=='string'||!Number.isFinite(Date.parse(value.archivedAt))||(value.previous!==null&&!skillArchiveHeadValid(value.previous))||!Array.isArray(value.versions)||!value.versions.length||value.versions.length>98||value.versions.some(v=>!versionValid(v)))invalid();
 const record=value as SkillHistoryArchive;
 if((record.previous?.batches??0)>=SKILL_ARCHIVE_MAX_BATCHES||record.versions.some((v,i)=>v.revision!==(record.previous?.throughRevision??0)+i+1)||record.versions.at(-1)!.revision!==record.activeRevision-2)invalid();
 return record;
}
export function validateSkillRevertReceipt(value:unknown):asserts value is SkillRevertReceipt {
 if(!object(value)||!exact(value,['skillId','reviewDigest','selection','scope'])||!id(value.skillId)||!hex(value.reviewDigest)||!hex(value.scope)||!object(value.selection))invalid();
 const v=value.selection;if(!exact(v,['installationRevision','head','sourceDigest','revision','digest'])||!positive(v.installationRevision)||!positive(v.revision)||!hex(v.digest)||!hex(v.sourceDigest)||(v.head!==null&&!hex(v.head)))invalid();
}
function validateArchiveReceipt(intent:unknown):asserts intent is SkillArchiveIntent {
 if(!object(intent)||!exact(intent,['skillId','previewDigest','fromGeneration','fromDigest','activeRevision','activeDigest','head','archivedAt','digest','scope'])||!id(intent.skillId)||!hex(intent.previewDigest)||!hex(intent.fromDigest)||!hex(intent.activeDigest)||!hex(intent.digest)||!hex(intent.scope)||!positive(intent.activeRevision)||!positive(intent.fromGeneration)||(intent.head!==null&&!hex(intent.head))||typeof intent.archivedAt!=='string'||!Number.isFinite(Date.parse(intent.archivedAt)))invalid();
}
export function validateSkillArchiveJournal(entry:PackUpgradeState):void {
 for(const override of Object.values(entry.overrides??{}))validateSkillOverride(override);
 if(entry.lastSkillArchive)validateArchiveReceipt(entry.lastSkillArchive);
 const extras=entry as PackUpgradeState & {upgrade?:{revertReceipt?:SkillRevertReceipt};lastSkillRevert?:SkillRevertReceipt};
 if(extras.lastSkillRevert)validateSkillRevertReceipt(extras.lastSkillRevert);if(extras.upgrade?.revertReceipt)validateSkillRevertReceipt(extras.upgrade.revertReceipt);
 const intent=entry.skillArchiveIntent;if(!intent)return;validateArchiveReceipt(intent);if(extras.upgrade)invalid();
 if(!object(intent)||!exact(intent,['skillId','previewDigest','fromGeneration','fromDigest','activeRevision','activeDigest','head','archivedAt','digest','scope'])||!id(intent.skillId)||!hex(intent.previewDigest)||!hex(intent.fromDigest)||!hex(intent.activeDigest)||!hex(intent.digest)||!hex(intent.scope)||!positive(intent.activeRevision)||intent.fromGeneration!==(entry.generation??1)||intent.fromDigest!==entry.digest||(intent.head!==null&&!hex(intent.head))||typeof intent.archivedAt!=='string'||!Number.isFinite(Date.parse(intent.archivedAt))||entry.transition||entry.archiveIntent)invalid();
 const override=entry.overrides?.[intent.skillId];validateSkillOverride(override,true);
 const record=skillHistoryArchive(entry,intent.skillId,intent.archivedAt,intent.scope);
 if(!record.versions.length||intent.activeRevision!==override.activeRevision||intent.activeDigest!==override.versions.at(-1)!.digest||intent.head!==(override.archiveHead?.digest??null)||record.previewDigest!==intent.previewDigest||skillHistoryHash(record)!==intent.digest)invalid();
 validateSkillHistoryArchive(record,entry.pack.id,intent.skillId,intent.digest);
}
/** Root v2 is a persistent downgrade gate. Only an exact compact pending intent
 * may borrow up to 16 KiB over a previously admissible <=2 MB journal. */
export function validateSkillJournalRoot(value:unknown): asserts value is {version:1|2;installs:Record<string,PackUpgradeState>} {
 if(!object(value)||!exact(value,['version','installs'])||![1,2].includes(value.version)||!object(value.installs))invalid();
 let hasArchive=false,intents=0;
 const inspect=(config:any)=>{if(!config)return;for(const override of Object.values(config.overrides??{}) as SkillOverride[]){validateSkillOverride(override);if(override.archiveHead)hasArchive=true;}};
 const stripped=structuredClone(value);
 for(const [packId,entry]of Object.entries(value.installs)as[string,PackUpgradeState][]){
  if(!object(entry)||entry.pack?.id!==packId)invalid();validateSkillArchiveJournal(entry);inspect(entry);for(const snapshot of entry.history??[])inspect(snapshot);inspect(entry.transition?.target);inspect(entry.transition?.before);
  if(entry.skillArchiveIntent){hasArchive=true;intents++;delete stripped.installs[packId].skillArchiveIntent;}
  if(entry.lastSkillArchive)hasArchive=true;
 }
 if(hasArchive&&value.version!==2)invalid();
 const bytes=Buffer.byteLength(JSON.stringify(value));
 if(bytes>PACK_JOURNAL_MAX_BYTES){const base=Buffer.byteLength(JSON.stringify(stripped));if(!intents||base>PACK_JOURNAL_MAX_BYTES||bytes-base>SKILL_ARCHIVE_INTENT_ALLOWANCE||bytes>PACK_JOURNAL_MAX_BYTES+SKILL_ARCHIVE_INTENT_ALLOWANCE)invalid();}
}
