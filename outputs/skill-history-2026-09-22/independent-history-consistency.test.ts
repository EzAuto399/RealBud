import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { validateCustomerSkillArchiveSet } from '../../server/customer-pack-skill-backup.ts';
import { validateCustomerPack } from '../../server/customer-packs.ts';
import { validatePrivatePackHistoryFiles, validatePrivateBusinessFile } from '../../server/private-workspace-backup.ts';
import { packChangeHash, type PackUpgradeState, type SkillVersion } from '../../server/customer-pack-upgrades.ts';
import { skillHistoryArchive, nextSkillArchiveHead, skillHistoryHash, skillArchivePath } from '../../server/customer-pack-skill-history.ts';
import { reviewPack } from './independent-fixture.ts';
const at='2026-09-22T00:00:00.000Z', sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const version=(revision:number):SkillVersion=>{const content=`Fictional reviewed instruction ${revision}.`;return {revision,content,digest:sha(content),createdAt:at,reason:'Fictional reviewed revision'};};
function fixture(where:'none'|'hot'|'next-archive') {
 const pack=validateCustomerPack(reviewPack()), skillId=pack.skills[0].id;
 let entry:PackUpgradeState={pack,digest:packChangeHash(pack),generation:1,history:[],overrides:{[skillId]:{activeRevision:6,versions:Array.from({length:6},(_,i)=>version(i+1))}}};
 const files=new Map<string,unknown>();
 const record=skillHistoryArchive(entry,skillId,at,'a'.repeat(64)), digest=skillHistoryHash(record);
 files.set(skillArchivePath(pack.id,digest),record);
 entry.overrides![skillId]={activeRevision:6,versions:entry.overrides![skillId].versions.slice(-2),archiveHead:nextSkillArchiveHead(record,digest)};
 // Later reviewed revisions leave revision 6 as retained history. Its digest
 // remains durably committed as the earlier archive's activeDigest.
 entry.overrides![skillId].versions.push(version(7));entry.overrides![skillId].activeRevision=7;
 if(where!=='none'){
  const v=entry.overrides![skillId].versions.find(v=>v.revision===6)!;
  v.content='Contradictory retained revision six.';v.digest=sha(v.content);
 }
 if(where==='next-archive'){
  entry.overrides![skillId].versions.push(version(8));entry.overrides![skillId].activeRevision=8;
  const next=skillHistoryArchive(entry,skillId,at,'b'.repeat(64)), nextDigest=skillHistoryHash(next);
  files.set(skillArchivePath(pack.id,nextDigest),next);
  entry.overrides![skillId]={...entry.overrides![skillId],archiveHead:nextSkillArchiveHead(next,nextDigest),versions:entry.overrides![skillId].versions.slice(-2)};
 }
 const journal={version:2,installs:{[pack.id]:{...entry,version:1,phase:'installed',installedAt:at,receipt:{addedRecipes:[],installedSkills:[],preservedRecipes:[]}}}};
 files.set('customer-packs.json',journal);
 return {journal,files,reader:{get:(path:string)=>files.get(path),paths:()=>files.keys()},business:{get:(path:string)=>files.has(path)?Buffer.from(JSON.stringify(files.get(path))):undefined,paths:()=>files.keys()}};
}
describe('independent committed instruction identity consistency',()=>{
 it('admits the unchanged committed active revision once it is retained in hot history',()=>{const f=fixture('none');validatePrivateBusinessFile('customer-packs.json',f.journal);expect(()=>validateCustomerSkillArchiveSet(f.journal,f.reader)).not.toThrow();expect(()=>validatePrivatePackHistoryFiles(f.business)).not.toThrow();});
 it('admits distinct removed-and-reintroduced lineages with reused revision numbers',()=>{
  const f=fixture('none'), entry=f.journal.installs['review-office'], original=structuredClone(entry);
  const without={...structuredClone(entry.pack),revision:2,skills:[]};
  entry.history=[{pack:original.pack,digest:original.digest,overrides:original.overrides,generation:1,savedAt:at,recipes:original.pack.recipes,retiredRecipeIds:[]},
   {pack:without,digest:packChangeHash(without),generation:2,savedAt:at,recipes:without.recipes,retiredRecipeIds:[]}];
  entry.pack={...entry.pack,revision:3};entry.digest=packChangeHash(entry.pack);entry.generation=3;
  const skillId=entry.pack.skills[0].id;
  entry.overrides={[skillId]:{activeRevision:6,versions:Array.from({length:6},(_,i)=>{const v=version(i+1);v.content+=' New lineage.';v.digest=sha(v.content);return v;})}};
  const record=skillHistoryArchive(entry,skillId,at,'c'.repeat(64)),digest=skillHistoryHash(record);
  f.files.set(skillArchivePath(entry.pack.id,digest),record);
  entry.overrides[skillId]={...entry.overrides[skillId],archiveHead:nextSkillArchiveHead(record,digest),versions:entry.overrides[skillId].versions.slice(-2)};
  validatePrivateBusinessFile('customer-packs.json',f.journal);expect(()=>validatePrivatePackHistoryFiles(f.business)).not.toThrow();
 });
 it.each(['hot','next-archive'] as const)('rejects a digest contradiction for an earlier committed active revision in %s',where=>{const f=fixture(where);validatePrivateBusinessFile('customer-packs.json',f.journal);expect(()=>validatePrivatePackHistoryFiles(f.business)).toThrow();});
});
