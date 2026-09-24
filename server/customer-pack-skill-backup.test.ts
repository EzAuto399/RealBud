import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { validateCustomerSkillArchiveSet } from './customer-pack-skill-backup.ts';
import { validatePrivateBusinessFile, validatePrivatePackHistoryFiles, isPrivateBackupPath, privateBackupHistoryDirectory } from './private-workspace-backup.ts';
import { validateCustomerPack } from './customer-packs.ts';
import { packHistoryArchive, nextArchiveHead, packArchivePath, packChangeHash, type PackUpgradeState, type PackSnapshot, type SkillOverride } from './customer-pack-upgrades.ts';
import { skillHistoryArchive, skillHistoryHash, skillArchivePath, nextSkillArchiveHead } from './customer-pack-skill-history.ts';
import type { CustomerPack } from '../shared/customer-packs.ts';
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
function fixture(){
  const at='2026-09-22T00:00:00.000Z';
  const initial=validateCustomerPack({format:'realbud-customer-pack',version:1,id:'history-office',revision:1,title:'Fictional office',recipes:[{id:'wf-history-task',title:'Review source',description:'Review provided data',steps:['Read supplied evidence'],evidence:'Source references',capabilities:['read-files','analyse','draft'],limits:{maxRuntimeMinutes:2,maxTurns:6},siteNotes:null,schedule:null,allowedOrigins:[]}],skills:['retained','removed'].map(id=>({id,name:`Fictional ${id}`,description:'Reviewed preparation guidance',instructions:'# Guidance\nRead evidence first.\n',license:'Fictional license'})),workflows:[{id:'source-review',title:'Source review',recipeIds:['wf-history-task'],checks:['input-coverage']}],dependencies:{runtime:'hermes-property',mode:'supplied-source-preparation',schedules:'off',permissions:'local-review-required'}});
  const overrides:Record<string,SkillOverride>={};
  for(const skill of initial.skills)overrides[skill.id]={activeRevision:6,versions:Array.from({length:6},(_,i)=>{const content=`# ${skill.id} reviewed instructions ${i+1}\n`;return {revision:i+1,digest:sha(content),content,createdAt:at,reason:'Reviewed fictional change'};})};
  let entry:PackUpgradeState={pack:initial,digest:packChangeHash(initial),generation:1,history:[],overrides};
  const files=new Map<string,unknown>(),skillPaths:string[]=[];
  for(const skill of initial.skills){const record=skillHistoryArchive(entry,skill.id,at,'a'.repeat(64)),digest=skillHistoryHash(record),path=skillArchivePath(initial.id,digest);files.set(path,record);skillPaths.push(path);overrides[skill.id]={...overrides[skill.id],archiveHead:nextSkillArchiveHead(record,digest),versions:overrides[skill.id].versions.slice(-2)};}
  for(let generation=2;generation<=9;generation++){
    const snapshot:PackSnapshot={pack:entry.pack,digest:entry.digest,overrides:structuredClone(entry.overrides),generation:generation-1,savedAt:at,recipes:entry.pack.recipes,retiredRecipeIds:[]};
    const pack:CustomerPack={...initial,revision:generation,skills:generation>=3?initial.skills.filter(s=>s.id!=='removed'):initial.skills};
    const current=structuredClone(overrides);if(generation>=3)delete current.removed;
    entry={...entry,pack,digest:packChangeHash(pack),generation,overrides:current,history:[...entry.history!,snapshot]};
  }
  const archive=packHistoryArchive(entry,at,'b'.repeat(64)),digest=packChangeHash(archive);files.set(packArchivePath(initial.id,digest),archive);entry={...entry,archiveHead:nextArchiveHead(archive,digest),history:entry.history!.slice(-2)};
  const journal={version:2,installs:{[initial.id]:{...entry,version:1,phase:'installed',installedAt:at,receipt:{addedRecipes:[],installedSkills:[],preservedRecipes:[]}}}};
  files.set('customer-packs.json',journal);
  const reader={get:(path:string)=>files.get(path),paths:()=>files.keys()};return {entry,journal,files,reader,skillPaths,packId:initial.id};
}
describe('complete reviewed instruction backup graph',()=>{
  it('retains a removed skill reachable only through an archived configuration and validates shared heads once',()=>{
    const f=fixture(),get=vi.fn(f.reader.get);validateCustomerSkillArchiveSet(f.journal,{...f.reader,get});
    for(const path of f.skillPaths)expect(get.mock.calls.filter(([name])=>name===path)).toHaveLength(1);
    expect(f.entry.overrides?.removed).toBeUndefined();expect(f.entry.history?.every(snapshot=>!snapshot.overrides?.removed)).toBe(true);
    validatePrivatePackHistoryFiles({get:path=>f.files.has(path)?Buffer.from(JSON.stringify(f.files.get(path))):undefined,paths:()=>f.files.keys()});
  });
  it('checks every root even when its immutable head was already validated',()=>{
    const f=fixture();f.journal.installs[f.packId].history![0].overrides!.retained.archiveHead!.batches=2;
    expect(()=>validateCustomerSkillArchiveSet(f.journal,f.reader)).toThrow(/counts|identity/);
  });
  it.each(['hot','newer-batch','cached-root'] as const)('rejects a contradiction of an earlier committed active revision in %s',location=>{
    const f=fixture(),entry=f.journal.installs[f.packId];
    const override=location==='cached-root'?entry.history![0].overrides!.retained:entry.overrides!.retained;
    const content='Reviewed seventh instruction';override.versions.push({revision:7,content,digest:sha(content),createdAt:'2026-09-22T00:00:00.000Z',reason:'Reviewed change'});override.activeRevision=7;
    const committed=override.versions.find(version=>version.revision===6)!;committed.content='Contradictory revision six';committed.digest=sha(committed.content);
    if(location==='newer-batch'){
      const eighth='Reviewed eighth instruction';override.versions.push({revision:8,content:eighth,digest:sha(eighth),createdAt:'2026-09-22T00:00:00.000Z',reason:'Reviewed change'});override.activeRevision=8;
      const record=skillHistoryArchive(entry,'retained','2026-09-22T00:00:00.000Z','c'.repeat(64)),digest=skillHistoryHash(record);f.files.set(skillArchivePath(f.packId,digest),record);override.archiveHead=nextSkillArchiveHead(record,digest);override.versions=override.versions.slice(-2);
    }
    expect(()=>validateCustomerSkillArchiveSet(f.journal,f.reader)).toThrow(/contradicts/);
  });
  it.each(['missing','detached','foreign','tampered','cycle'] as const)('fails closed for %s immutable instruction storage',defect=>{
    const f=fixture(),path=f.skillPaths[1]!,record=structuredClone(f.files.get(path)) as ReturnType<typeof skillHistoryArchive>;
    if(defect==='missing')f.files.delete(path);
    if(defect==='tampered'){record.versions[0].content+=' changed';f.files.set(path,record);}
    if(defect==='cycle'){record.previous=nextSkillArchiveHead(record,path.split('/').at(-1)!.slice(0,-5));f.files.set(path,record);}
    if(defect==='foreign'){record.skillId='foreign';f.files.set(path,record);}
    if(defect==='detached'){record.archivedAt='2026-09-21T00:00:00.000Z';f.files.set(skillArchivePath(f.packId,skillHistoryHash(record)),record);}
    expect(()=>validateCustomerSkillArchiveSet(f.journal,f.reader)).toThrow(/archive|history/i);
  });
  it('requires root v2 even when all instruction heads survive only in immutable configuration history',()=>{
    const f=fixture();f.journal.version=1;f.journal.installs[f.packId].overrides={};for(const s of f.journal.installs[f.packId].history!)s.overrides={};
    expect(()=>validateCustomerSkillArchiveSet(f.journal,f.reader)).toThrow(/version 2/);
  });
  it('admits old unarchived v1 journals and rejects unsupported roots, overlarge normal journals and unresolved intent',()=>{
    const f=fixture(),entry=structuredClone(f.journal.installs[f.packId]);delete entry.archiveHead;entry.generation=1;entry.history=[];for(const override of Object.values(entry.overrides!)){delete override.archiveHead;override.versions=override.versions.map((v,i)=>({...v,revision:i+1}));override.activeRevision=override.versions.length;}
    const old={version:1,installs:{[f.packId]:entry}};expect(()=>validatePrivateBusinessFile('customer-packs.json',old)).not.toThrow();
    expect(()=>validatePrivateBusinessFile('customer-packs.json',{...old,version:3})).toThrow();
    expect(()=>validatePrivateBusinessFile('customer-packs.json',{...old,unsupported:true})).toThrow();
    expect(()=>validatePrivateBusinessFile('customer-packs.json',{...old,installs:{[f.packId]:{...entry,proposalReceipts:[{reason:'x'.repeat(2_000_000)}]}}})).toThrow();
    expect(()=>validatePrivateBusinessFile('customer-packs.json',{version:2,installs:{[f.packId]:{...entry,skillArchiveIntent:{}}}})).toThrow();
  });
  it('uses portable exact path admission for both backup formats and destination/prepared paths',()=>{
    const f=fixture();for(const path of f.skillPaths)expect(isPrivateBackupPath(path)).toBe(true);
    for(const root of ['customer-pack-history','customer-skill-history']){expect(privateBackupHistoryDirectory(root,f.packId)).toBe(true);for(const name of ['con','nul','com1','lpt9'])expect(privateBackupHistoryDirectory(root,name)).toBe(false);}
    for(const path of [`customer-skill-history/${f.packId}/extra.txt`,`customer-skill-history/${f.packId}/../${'a'.repeat(64)}.json`,`customer-skill-history/CON/${'a'.repeat(64)}.json`,`customer-skill-history/${f.packId}/${'a'.repeat(64)}.json/extra`])expect(isPrivateBackupPath(path)).toBe(false);
  });
});
