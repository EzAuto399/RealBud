import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, symlink, link } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { CustomerPack, PackSkillHistoryPage, PackSkillHistorySelection, PackSkillRevertPreview } from '../shared/customer-packs.ts';
import { emptyV3 } from '../shared/desk-v3.ts';
import { encryptJson } from './desk-crypto.ts';
import { createPrivateWorkspaceBackup, applyStagedPrivateRestore, validatePrivatePackHistoryFiles } from './private-workspace-backup.ts';
import { PrivateBackupCatalog } from './private-backup-catalog.ts';
import { capturePrivateWorkspace, verifyPrivateWorkspaceCapture, privateBackupTargetPaths } from './private-backup-capture.ts';
import { encodeBackupCatalog, decodeBackupCatalog } from './private-backup-archive.ts';
import { transformPrivateBackupCatalog } from './private-backup-restore-catalog.ts';
import { PrivateBackupPreparedStore } from './private-backup-prepared.ts';
import { preparePrivateBackupRestore } from './private-backup-prepare.ts';
import { stagePrivateRestoreV2, applyStagedPrivateRestoreV2, privateRestoreTargetHash } from './private-backup-cold-restore.ts';
import { packHistoryArchive, nextArchiveHead, packArchivePath, packChangeHash, type PackUpgradeState, type PackSnapshot, type SkillOverride } from './customer-pack-upgrades.ts';
import { skillHistoryArchive, skillHistoryHash, skillArchivePath, nextSkillArchiveHead, skillArchivePreviewDigest } from './customer-pack-skill-history.ts';
import { plantPrivateFile, privateDir, privateTempRoot, removeFixture, windowsAdmissionTimeout } from './testing/private-fixture.ts';
const env=vi.hoisted(()=>{const previous=process.env.REALBUD_DATA_DIR;process.env.REALBUD_DATA_DIR=`${process.env.TMPDIR??'/tmp'}/rb-skill-backup-unopened-${process.pid}-${Date.now()}`;return {previous,guard:process.env.REALBUD_DATA_DIR};});
const roots:string[]=[],catalogs:PrivateBackupCatalog[]=[],stores:PrivateBackupPreparedStore[]=[];
const at='2026-09-22T07:00:00.000Z',phrase='Fictional reviewed instruction recovery phrase';
afterEach(async()=>{for(const store of stores.splice(0))await store.close();for(const c of catalogs.splice(0))c.close();await Promise.all(roots.splice(0).map(removeFixture));});
afterAll(async()=>{if(env.previous===undefined)delete process.env.REALBUD_DATA_DIR;else process.env.REALBUD_DATA_DIR=env.previous;await rm(env.guard,{recursive:true,force:true});});
const sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
async function file(directory:string,path:string,value:string|Uint8Array){plantPrivateFile(join(directory,path),Buffer.from(value));}
async function fixture(){const directory=privateTempRoot(join(realpathSync(tmpdir()),'RealBud skill restore Ω '));roots.push(directory);const key=randomBytes(32),workspaceId=randomUUID();await file(directory,'desk.key',key);await file(directory,'desk.json',JSON.stringify(encryptJson(key,emptyV3({name:'Fictional workspace',timezone:'UTC',jurisdictions:[]}))));await file(directory,'company-installation/workspace.json',JSON.stringify({version:1,id:workspaceId,workerMemberKey:null}));const backup=createPrivateWorkspaceBackup({directory,key:()=>key,workspaceId,epoch:()=> 'idle',assertIdle(){},assertFresh(){},now:()=>Date.parse(at)});return {directory,key,workspaceId,backup};}
type Fixture=Awaited<ReturnType<typeof fixture>>;
async function openPack(directory:string){process.env.REALBUD_DATA_DIR=directory;vi.resetModules();const recipes=await import('./recipes.ts'),packs=await import('./customer-packs.ts');const service=packs.createCustomerPackService({directory,profileDirectory:()=>join(directory,'profile'),workroomDirectory:()=>join(directory,'vault'),activeRecipeIds:()=>[],learningStatus:()=>({supported:true,policyReady:true,enabled:true})});return {recipes,service,validate:packs.validateCustomerPack};}
async function populate(f:Fixture){
 const host=await openPack(f.directory);
 const initial=host.validate({format:'realbud-customer-pack',version:1,id:'history-office',revision:1,title:'Fictional office',recipes:[{id:'wf-history-task',title:'Review source',description:'Review provided data',steps:['Read supplied evidence'],evidence:'Source references',capabilities:['read-files','analyse','draft'],limits:{maxRuntimeMinutes:2,maxTurns:6},siteNotes:null,schedule:null,allowedOrigins:[]}],skills:['retained','removed'].map(id=>({id,name:`Fictional ${id}`,description:'Reviewed preparation guidance',instructions:'# Guidance\nRead evidence first.\n',license:'Fictional license'})),workflows:[{id:'source-review',title:'Source review',recipeIds:['wf-history-task'],checks:['input-coverage']}],dependencies:{runtime:'hermes-property',mode:'supplied-source-preparation',schedules:'off',permissions:'local-review-required'}});
 const first=await host.service.preview(initial);await host.service.install(initial,first.digest);
 const installed=JSON.parse(await readFile(join(f.directory,'customer-packs.json'),'utf8')).installs[initial.id];
 const overrides:Record<string,SkillOverride>={};
 for(const skill of initial.skills){const baseline=await readFile(join(f.directory,`profile/skills/realbud-${initial.id}-${skill.id}/SKILL.md`),'utf8');overrides[skill.id]={activeRevision:6,versions:Array.from({length:6},(_,i)=>{const content=baseline+`\nReviewed fictional instruction ${i+1}.\n`;return {revision:i+1,digest:sha(content),content,createdAt:at,reason:'Reviewed fictional change'};})};}
 let entry:PackUpgradeState={pack:initial,digest:packChangeHash(initial),generation:1,history:[],overrides};const files=new Map<string,Buffer>(),skillPaths:string[]=[];
 for(const skill of initial.skills){const record=skillHistoryArchive(entry,skill.id,at,'a'.repeat(64)),digest=skillHistoryHash(record),path=skillArchivePath(initial.id,digest);files.set(path,Buffer.from(JSON.stringify(record)));skillPaths.push(path);overrides[skill.id]={...overrides[skill.id],archiveHead:nextSkillArchiveHead(record,digest),versions:overrides[skill.id].versions.slice(-2)};}
 for(let generation=2;generation<=9;generation++){const snapshot:PackSnapshot={pack:entry.pack,digest:entry.digest,overrides:structuredClone(entry.overrides),generation:generation-1,savedAt:at,recipes:entry.pack.recipes,retiredRecipeIds:[]};const pack:CustomerPack={...initial,revision:generation,skills:generation>=3?initial.skills.filter(s=>s.id!=='removed'):initial.skills};const current=structuredClone(overrides);if(generation>=3)delete current.removed;entry={...entry,pack,digest:packChangeHash(pack),generation,overrides:current,history:[...entry.history!,snapshot]};}
 const archive=packHistoryArchive(entry,at,'b'.repeat(64)),digest=packChangeHash(archive);files.set(packArchivePath(initial.id,digest),Buffer.from(JSON.stringify(archive)));entry={...entry,archiveHead:nextArchiveHead(archive,digest),history:entry.history!.slice(-2)};
 const journal={version:2,installs:{[initial.id]:{...installed,...entry}}};files.set('customer-packs.json',Buffer.from(JSON.stringify(journal)));for(const [path,bytes]of files)await file(f.directory,path,bytes);
 const native=`profile/skills/realbud-${initial.id}-retained/SKILL.md`;await file(f.directory,native,entry.overrides!.retained.versions.at(-1)!.content);
 const recipe=host.recipes.getRecipe('wf-history-task')!;host.recipes.saveRecipe({...recipe,status:'active',schedule:{time:'08:00',weekdays:[1]},expectedRevision:recipe.revision});host.recipes.patchRecipe(recipe.id,{planApproved:true,expectedRevision:host.recipes.getRecipe(recipe.id)!.revision});
 return {host,initial,entry,journal,files,skillPaths,native};
}
async function catalog(f:Fixture,name:string,key=f.key,workspaceId=f.workspaceId){const c=await PrivateBackupCatalog.create({directory:join(f.directory,name),key,workspaceId,maxEntries:300,maxBytes:16*1024*1024});catalogs.push(c);return c;}
async function* chunks(bytes:Buffer){for(let offset=0;offset<bytes.length;offset+=701)yield bytes.subarray(offset,offset+701);}
async function collect(stream:AsyncIterable<Uint8Array>){const parts:Buffer[]=[];for await(const value of stream)parts.push(Buffer.from(value));return Buffer.concat(parts);}
async function capture(source:Fixture){const scratch=await fixture(),captured=await catalog(scratch,'capture',source.key,source.workspaceId);const options={directory:source.directory,key:source.key,workspaceId:source.workspaceId,catalog:captured,assertLease(){}};const result=await capturePrivateWorkspace(options);await verifyPrivateWorkspaceCapture(options,result);return {scratch,captured,result};}
async function restoreV2(source:Fixture,target:Fixture,expected:Awaited<ReturnType<typeof populate>>){
 const {scratch,captured,result}=await capture(source);for(const path of expected.skillPaths)expect(captured.getFile(path)?.data).toEqual(expected.files.get(path));
 const archive=await collect(encodeBackupCatalog(captured,{passphrase:phrase,createdAt:at,databasePresent:result.databasePresent}));expect(archive.includes(Buffer.from('Reviewed fictional instruction'))).toBe(false);
 const decoded=await decodeBackupCatalog(chunks(archive),{directory:join(scratch.directory,'decoded'),key:target.key,passphrase:phrase,expectedArchiveDigest:sha(archive)});catalogs.push(decoded.catalog);
 const transformed=await catalog(scratch,'transformed',target.key,source.workspaceId);transformPrivateBackupCatalog({source:decoded.catalog,destination:transformed,at:Date.parse(at)+1000});
 const directoryId=randomUUID(),parent=join(target.directory,'private-backup-v2/prepared');privateDir(parent);const prepared=await PrivateBackupPreparedStore.create({directory:join(parent,directoryId),key:target.key,workspaceId:source.workspaceId});stores.push(prepared);
 const summary=await preparePrivateBackupRestore({directory:target.directory,key:target.key,source:transformed,prepared,databasePresent:result.databasePresent,assertLease(){}});await prepared.close();
 const stage={directory:target.directory,key:target.key,directoryId,storeId:summary.storeId,workspaceId:source.workspaceId,expectedPreparedDigest:summary.digest,receipt:decoded.receipt,assertFresh(){},assertIdle(){},epoch:()=> 'idle'};await stagePrivateRestoreV2(stage);expect((await applyStagedPrivateRestoreV2(stage)).restored).toBe(true);
}
async function repairAndRevert(target:Fixture,expected:Awaited<ReturnType<typeof populate>>){
 expect(existsSync(join(target.directory,expected.native))).toBe(false);
 const host=await openPack(target.directory),recipe=host.recipes.getRecipe('wf-history-task')!;expect(recipe.schedule).toBeNull();expect(recipe.approvedRevision).toBeNull();expect(recipe.status).toBe('paused');
 await host.service.install(expected.entry.pack,expected.entry.digest);expect(await readFile(join(target.directory,expected.native),'utf8')).toBe(expected.entry.overrides!.retained.versions.at(-1)!.content);
 const route=`/api/customer-packs/${expected.initial.id}/skills/retained`;
 const result=await host.service.handle(`${route}/history`,'POST',{});expect(result?.status).toBe(200);let page=result!.body as PackSkillHistoryPage;
 let revision=page.revisions.find(item=>item.revision===2);
 while(!revision&&page.nextCursor){const result=await host.service.handle(`${route}/history`,'POST',{installationRevision:page.installationRevision,head:page.head,sourceDigest:page.sourceDigest,cursor:page.nextCursor});expect(result?.status).toBe(200);page=result!.body as PackSkillHistoryPage;revision=page.revisions.find(item=>item.revision===2);}
 expect(revision).toBeDefined();
 const selection:PackSkillHistorySelection={installationRevision:page.installationRevision,head:page.head,sourceDigest:page.sourceDigest,revision:revision!.revision,digest:revision!.digest};
 const previewResult=await host.service.handle(`${route}/revert-preview`,'POST',selection);expect(previewResult?.status).toBe(200);const preview=previewResult!.body as PackSkillRevertPreview;expect(preview.canRevert,preview.conflicts.join('; ')).toBe(true);
 const body={...preview.selection,expectedReviewDigest:preview.reviewDigest};
 const applied=await host.service.handle(`${route}/revert`,'POST',body);expect(applied?.status).toBe(200);expect(await readFile(join(target.directory,expected.native),'utf8')).toBe(preview.proposed);
 const after=await readFile(join(target.directory,'customer-packs.json'),'utf8');await host.service.handle(`${route}/revert`,'POST',body);expect(await readFile(join(target.directory,'customer-packs.json'),'utf8')).toBe(after);
 expect(host.recipes.getRecipe('wf-history-task')).toMatchObject({schedule:null,approvedRevision:null,status:'shadow'});
 for(const [path,bytes]of expected.files)if(path!=='customer-packs.json')expect(await readFile(join(target.directory,path))).toEqual(bytes);
}
describe('encrypted reviewed instruction history cold restore',()=>{
 it.each(['v1','v2'] as const)('%s preserves shared and removed-skill archive roots, rekeys, repairs native instructions and performs reviewed archived revert',windowsAdmissionTimeout(324),async version=>{
  const source=await fixture(),target=await fixture(),expected=await populate(source);expect(source.key.equals(target.key)).toBe(false);
  const obsolete=JSON.parse(expected.files.get(expected.skillPaths[0])!.toString());obsolete.archivedAt='2026-09-20T00:00:00.000Z';const obsoletePath=skillArchivePath(expected.initial.id,skillHistoryHash(obsolete));await file(target.directory,obsoletePath,JSON.stringify(obsolete));
  if(version==='v1'){const {backup,receipt}=await source.backup.exportBackup(phrase);await target.backup.stageRestore({backup,passphrase:phrase,expectedDigest:receipt.digest});expect((await applyStagedPrivateRestore({directory:target.directory,key:target.key})).restored).toBe(true);}else await restoreV2(source,target,expected);
  expect(existsSync(join(target.directory,obsoletePath))).toBe(false);
  for(const [path,bytes]of expected.files)expect(await readFile(join(target.directory,path))).toEqual(bytes);expect(await readFile(join(target.directory,'desk.key'))).toEqual(target.key);
  await repairAndRevert(target,expected);
  const rebound=createPrivateWorkspaceBackup({directory:target.directory,key:()=>target.key,workspaceId:source.workspaceId,epoch:()=> 'idle',assertIdle(){},assertFresh(){}});await expect(rebound.exportBackup(phrase)).resolves.toHaveProperty('receipt');
 });
 it('rejects a valid unresolved compact instruction archival intent before either format can export it',async()=>{
  const source=await fixture(),expected=await populate(source),entry=expected.journal.installs[expected.initial.id],override=entry.overrides!.retained;
  for(let revision=7;revision<=8;revision++){const content=override.versions.at(-1)!.content+`Reviewed addition ${revision}.\n`;override.versions.push({revision,content,digest:sha(content),createdAt:at,reason:'Reviewed change'});}override.activeRevision=8;
  const scope='c'.repeat(64),record=skillHistoryArchive(entry,'retained',at,scope);
  entry.skillArchiveIntent={skillId:'retained',previewDigest:skillArchivePreviewDigest(entry,'retained',scope),fromGeneration:entry.generation!,fromDigest:entry.digest,activeRevision:override.activeRevision,activeDigest:override.versions.at(-1)!.digest,head:override.archiveHead!.digest,archivedAt:at,digest:skillHistoryHash(record),scope};
  await file(source.directory,'customer-packs.json',JSON.stringify(expected.journal));await expect(source.backup.exportBackup(phrase)).rejects.toThrow(/Finish or recover/);await expect(capture(source)).rejects.toThrow(/Finish or recover/);
 });
 it.each(['unknown-file','unknown-folder','symlink-file','hardlink-file'] as const)('refuses %s in both capture and cold destination enumeration',async defect=>{
  const source=await fixture(),expected=await populate(source),base=`customer-skill-history/${expected.initial.id}`;
  if(defect==='unknown-file')await file(source.directory,`${base}/unexpected.txt`,'Retain me');
  if(defect==='unknown-folder')await mkdir(join(source.directory,base,'extra'),{mode:0o700});
  if(defect==='symlink-file'||defect==='hardlink-file'){const target=join(source.directory,base,`${'d'.repeat(64)}.json`);if(defect==='symlink-file')await symlink(join(source.directory,expected.skillPaths[0]),target);else await link(join(source.directory,expected.skillPaths[0]),target);}
  await expect(source.backup.exportBackup(phrase)).rejects.toThrow(/archive|linked|invalid/i);await expect(capture(source)).rejects.toThrow(/archive|linked|invalid/i);if(defect==='unknown-file'||defect==='unknown-folder')await expect(privateBackupTargetPaths(source.directory)).rejects.toThrow(/archive|linked|invalid/i);else await expect(privateRestoreTargetHash(join(source.directory,base,`${'d'.repeat(64)}.json`))).rejects.toThrow(/recovery|linked|invalid/i);
 });
 // Windows prevents creating this folder; the pure admission test still runs there.
 it.skipIf(process.platform==='win32')('refuses a Windows-reserved empty history folder in capture and destination enumeration',async()=>{
  const source=await fixture();await populate(source);await mkdir(join(source.directory,'customer-skill-history/con'),{mode:0o700});
  await expect(source.backup.exportBackup(phrase)).rejects.toThrow(/archive/i);await expect(capture(source)).rejects.toThrow(/archive/i);await expect(privateBackupTargetPaths(source.directory)).rejects.toThrow(/archive/i);
 });
 it('preserves source bytes when shared graph admission rejects an orphan immutable batch',async()=>{
  const source=await fixture(),expected=await populate(source),record=JSON.parse(expected.files.get(expected.skillPaths[0])!.toString());record.archivedAt='2026-09-21T00:00:00.000Z';const path=skillArchivePath(expected.initial.id,skillHistoryHash(record));await file(source.directory,path,JSON.stringify(record));
  await expect(source.backup.exportBackup(phrase)).rejects.toThrow(/Unreferenced instruction/);const {captured}=await capture(source);expect(()=>captured.validate()).toThrow(/Unreferenced instruction/);
  const paths=[...expected.files.keys(),path];const values=new Map(await Promise.all(paths.map(async p=>[p,await readFile(join(source.directory,p))] as const)));expect(()=>validatePrivatePackHistoryFiles({get:p=>values.get(p),paths:()=>values.keys()})).toThrow(/Unreferenced instruction/);for(const [p,bytes]of expected.files)expect(values.get(p)).toEqual(bytes);
 });
});
