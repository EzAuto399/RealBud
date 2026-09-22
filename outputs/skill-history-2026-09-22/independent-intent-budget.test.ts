import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateCustomerPack } from '../../server/customer-packs.ts';
import { validatePrivateBusinessFile } from '../../server/private-workspace-backup.ts';
import { packChangeHash } from '../../server/customer-pack-upgrades.ts';
import { skillHistoryArchive, skillHistoryHash, validateSkillJournalRoot, PACK_JOURNAL_MAX_BYTES, SKILL_ARCHIVE_INTENT_ALLOWANCE } from '../../server/customer-pack-skill-history.ts';
import { reviewPack } from './independent-fixture.ts';
const at='2026-09-22T00:00:00.000Z',sha=(text:string)=>createHash('sha256').update(text).digest('hex'),size=(v:unknown)=>Buffer.byteLength(JSON.stringify(v));
function fixture(){
 const pack=validateCustomerPack(reviewPack()),skillId=pack.skills[0].id;
 const entry={version:1,phase:'installed',installedAt:at,pack,digest:packChangeHash(pack),generation:1,history:[],receipt:{addedRecipes:[],installedSkills:[],preservedRecipes:[],note:''},overrides:{[skillId]:{activeRevision:6,versions:Array.from({length:6},(_,i)=>{const content=`Fictional reviewed instructions ${i+1}.`;return {revision:i+1,digest:sha(content),content,createdAt:at,reason:'Reviewed fictional change'};})}}};
 const journal={version:1,installs:{[pack.id]:entry}};
 entry.receipt.note='x'.repeat(PACK_JOURNAL_MAX_BYTES-size(journal));
 const record=skillHistoryArchive(entry,skillId,at,'a'.repeat(64));
 const intent={skillId,previewDigest:record.previewDigest,fromGeneration:1,fromDigest:entry.digest,activeRevision:6,activeDigest:record.activeDigest,head:null,archivedAt:at,digest:skillHistoryHash(record),scope:record.scope};
 const pending={version:2,installs:{[pack.id]:{...entry,skillArchiveIntent:intent}}};
 return {journal,pending,packId:pack.id,intent};
}
describe('independent near-full compact archival intent admission',()=>{
 it('admits an already-full valid v1 journal and its exact compact v2 intent while holding backup',()=>{
  const f=fixture();expect(size(f.journal)).toBe(PACK_JOURNAL_MAX_BYTES);validatePrivateBusinessFile('customer-packs.json',f.journal);
  expect(size(f.pending)).toBeGreaterThan(PACK_JOURNAL_MAX_BYTES);expect(size(f.pending)).toBeLessThanOrEqual(PACK_JOURNAL_MAX_BYTES+SKILL_ARCHIVE_INTENT_ALLOWANCE);
  expect(()=>validateSkillJournalRoot(f.pending)).not.toThrow();expect(()=>validatePrivateBusinessFile('customer-packs.json',f.pending)).toThrow();
  expect(()=>validateSkillJournalRoot({...f.pending,version:1})).toThrow();
 });
 it('cannot borrow intent allowance for one additional byte of normal retained data',()=>{
  const f=fixture();f.pending.installs[f.packId].receipt.note+='x';
  expect(()=>validateSkillJournalRoot(f.journal)).toThrow();expect(()=>validateSkillJournalRoot(f.pending)).toThrow();
 });
 it('rejects a compact but altered intent rather than treating any pending marker as headroom',()=>{
  const f=fixture();f.intent.digest='f'.repeat(64);expect(()=>validateSkillJournalRoot(f.pending)).toThrow();
 });
});
