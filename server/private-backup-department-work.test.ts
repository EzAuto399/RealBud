import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyV3 } from '../shared/desk-v3.ts';
import type { Recipe } from '../shared/contracts.ts';
import { COMPANY_EXECUTION_PURPOSE, type CompanyExecutionGrant } from '../shared/company-execution.ts';
import { encryptJson } from './desk-crypto.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { JobRunStore } from './job-runs.ts';
import { manualRecipeRequestKey } from './manual-job-request.ts';
import { DEPARTMENT_WORK_KIND, createDepartmentWork, validateSavedDepartmentWork, type SavedDepartmentWork } from './department-work.ts';
import { departmentWorkRecipe, departmentWorkDigest } from './department-work-plan.ts';
import { createCompanyExecutionClient } from './company-execution-client.ts';
import { createPrivateVault } from './private-vault.ts';
import { createPrivateWorkspaceBackup, applyStagedPrivateRestore } from './private-workspace-backup.ts';
import { PrivateBackupCatalog } from './private-backup-catalog.ts';
import { capturePrivateWorkspace, verifyPrivateWorkspaceCapture } from './private-backup-capture.ts';
import { encodeBackupCatalog, decodeBackupCatalog } from './private-backup-archive.ts';
import { transformPrivateBackupCatalog } from './private-backup-restore-catalog.ts';
import { PrivateBackupPreparedStore } from './private-backup-prepared.ts';
import { preparePrivateBackupRestore } from './private-backup-prepare.ts';
import { stagePrivateRestoreV2, applyStagedPrivateRestoreV2 } from './private-backup-cold-restore.ts';
import { plantPrivateFile, privateDir, privateTempRoot, removeFixture, windowsAdmissionTimeout } from './testing/private-fixture.ts';

const env=vi.hoisted(()=>{const previous=process.env.REALBUD_DATA_DIR;process.env.REALBUD_DATA_DIR=`${process.env.TMPDIR??'/tmp'}/rb-department-backup-unopened-${process.pid}-${Date.now()}`;return {previous,guard:process.env.REALBUD_DATA_DIR};});
const roots:string[]=[],dbs:WorkflowDatabase[]=[],catalogs:PrivateBackupCatalog[]=[],stores:PrivateBackupPreparedStore[]=[];
const at='2026-09-22T07:00:00.000Z',phrase='Fictional department history encrypted recovery phrase';
afterEach(async()=>{for(const store of stores.splice(0))await store.close();for(const c of catalogs.splice(0))c.close();for(const db of dbs.splice(0))db.close();await Promise.all(roots.splice(0).map(root=>removeFixture(root)));});
afterAll(async()=>{if(env.previous===undefined)delete process.env.REALBUD_DATA_DIR;else process.env.REALBUD_DATA_DIR=env.previous;await removeFixture(env.guard);});
async function file(directory:string,path:string,value:string|Buffer){plantPrivateFile(join(directory,path),value);}
async function fixture(){
  const directory=privateTempRoot(join(realpathSync(tmpdir()),'RealBud department restore Ω '));roots.push(directory);const key=randomBytes(32),workspaceId=randomUUID();
  await file(directory,'desk.key',key);await file(directory,'desk.json',JSON.stringify(encryptJson(key,emptyV3({name:'Fictional workspace',timezone:'UTC',jurisdictions:[]}))));
  await file(directory,'company-installation/workspace.json',JSON.stringify({version:1,id:workspaceId,workerMemberKey:'worker-original'}));
  return {directory,key,workspaceId,backup:createPrivateWorkspaceBackup({directory,key:()=>key,workspaceId,epoch:()=> 'idle',assertIdle(){},assertFresh(){},now:()=>Date.parse(at)})};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const recipe:Recipe={id:'fixture-department-preparation',title:'Fictional assigned case preparation',description:'Prepare only the supplied case.',steps:['Analyse the supplied case and draft a summary.'],allowedOrigins:[],evidence:'Draft only',capabilities:['analyse','draft'],limits:{maxRuntimeMinutes:2,maxTurns:6},siteNotes:null,status:'active',createdAt:1,schedule:null,planApprovedAt:2,revision:2,updatedAt:2,approvedRevision:2,attachment:null,submitAcknowledgedAt:null};
async function populate(f:Fixture){
  const db=new WorkflowDatabase({dir:f.directory,key:f.key});dbs.push(db);const jobs=new JobRunStore({file:join(f.directory,'job-runs.json'),database:db,now:()=>Date.parse(at)});
  const records=[];
  for(const state of ['requesting','running','completed','dispatch-crash','not-started'] as const){
    const selected={...recipe,id:`${recipe.id}-${state}`},plan=departmentWorkRecipe(selected,'Complete fictional case instructions. Do not read private sources.');
    const request={version:1 as const,requestId:randomUUID(),departmentId:randomUUID(),caseId:randomUUID(),expectedDepartmentRevision:'2',expectedCaseFence:'0',recipeId:selected.id,expectedRecipeRevision:selected.revision,durationMs:86400000};
    const companyId=randomUUID(),memberId=randomUUID(),executionId=randomUUID(),jobKey=manualRecipeRequestKey(selected,{requestId:executionId,expectedRevision:selected.revision},'prepare');
    const source={caseId:request.caseId,title:'Fictional selected case',description:'Captured case source retained for human review.'};
    const spec={version:1 as const,purpose:COMPANY_EXECUTION_PURPOSE,companyId,memberId,authorityId:randomUUID(),certificateDigest:'a'.repeat(64),departmentId:request.departmentId,departmentRevision:request.expectedDepartmentRevision,caseId:request.caseId,caseFence:request.expectedCaseFence,sourceDigest:departmentWorkDigest(source),recipe:plan,executor:{workspaceId:f.workspaceId,workerBinding:'b'.repeat(64)}};
    const grant:CompanyExecutionGrant={id:request.requestId,revision:'2',phase:'admitted',current:true,spec,digest:departmentWorkDigest(spec),source,departmentName:'Fictional department',memberName:'Fictional member',createdAt:at,expiresAt:'2026-09-23T07:00:00.000Z',confirmedAt:at,revokedAt:null};
    let runId:string|null=null;
    if(['running','completed','dispatch-crash'].includes(state)){
      const queued=jobs.enqueue(selected,{mode:'prepare',trigger:'manual',idempotencyKey:jobKey}).run;jobs.start(queued.id);
      if(state==='completed')jobs.settle(queued.id,{status:'completed',detail:'Factual case draft saved',evidence:[{kind:'output',note:'Fictional result retained',at:Date.parse(at)}]});
      if(state!=='dispatch-crash')runId=queued.id;
    }
    const delivery=state==='completed'?{requestId:randomUUID(),runId:runId!,outcome:'prepared' as const,note:'Prepared for human review'}:state==='not-started'?{requestId:randomUUID(),runId:`not-started:${executionId}`,outcome:'interrupted' as const,note:'No durable executor receipt was found'}:null;
    const value:SavedDepartmentWork={version:1,companyId,memberId,request,recipe:plan,executionId,jobKey,phase:state==='requesting'?'requesting':state==='completed'?'review-required':state==='not-started'?'held':'running',detail:'Fictional saved history',runId,updatedAt:Date.parse(at),grant:state==='requesting'?null:grant,delivery,restored:false};
    const id=`department-work:${request.requestId}`;validateSavedDepartmentWork(id,value);records.push({state,row:db.create(DEPARTMENT_WORK_KIND,id,value)});
    // The installation client vault is real and encrypted, but deliberately
    // excluded even though the public work history is included.
    await createPrivateVault(f.directory,f.key).write(`department-execution-${request.requestId}`,{grantSecret:'grant-secret-must-not-restore',claimSecret:'claim-secret-must-not-restore',memberToken:'session-must-not-restore'});
  }
  return {db,jobs,records};
}
async function catalog(f:Fixture,name:string,key=f.key,workspaceId=f.workspaceId){const c=await PrivateBackupCatalog.create({directory:join(f.directory,name),key,workspaceId,maxEntries:200,maxBytes:8*1024*1024});catalogs.push(c);return c;}
async function capture(source:Fixture){const scratch=await fixture(),captured=await catalog(scratch,'capture',source.key,source.workspaceId);const options={directory:source.directory,key:source.key,workspaceId:source.workspaceId,catalog:captured,assertLease(){}};const result=await capturePrivateWorkspace(options);await verifyPrivateWorkspaceCapture(options,result);return {scratch,captured,result};}
async function* chunks(bytes:Buffer){for(let offset=0;offset<bytes.length;offset+=701)yield bytes.subarray(offset,offset+701);}
async function collect(stream:AsyncIterable<Uint8Array>){const parts:Buffer[]=[];for await(const value of stream)parts.push(Buffer.from(value));return Buffer.concat(parts);}
async function restoreV2(source:Fixture,target:Fixture){
  const {scratch,captured,result}=await capture(source);
  expect([...captured.iterateFiles()].some(f=>f.path.includes('department-execution-'))).toBe(false);
  const archive=await collect(encodeBackupCatalog(captured,{passphrase:phrase,createdAt:at,databasePresent:result.databasePresent}));
  for(const privateText of ['Captured case source','grant-secret-must-not-restore','session-must-not-restore'])expect(archive.includes(Buffer.from(privateText))).toBe(false);
  const decoded=await decodeBackupCatalog(chunks(archive),{directory:join(scratch.directory,'decoded'),key:target.key,passphrase:phrase,expectedArchiveDigest:createHash('sha256').update(archive).digest('hex')});catalogs.push(decoded.catalog);
  const transformed=await catalog(scratch,'transformed',target.key,source.workspaceId);transformPrivateBackupCatalog({source:decoded.catalog,destination:transformed,at:Date.parse(at)+1000});
  const directoryId=randomUUID(),parent=join(target.directory,'private-backup-v2/prepared');privateDir(parent);
  const prepared=await PrivateBackupPreparedStore.create({directory:join(parent,directoryId),key:target.key,workspaceId:source.workspaceId});stores.push(prepared);
  const summary=await preparePrivateBackupRestore({directory:target.directory,key:target.key,source:transformed,prepared,databasePresent:result.databasePresent,assertLease(){}});await prepared.close();
  const stage={directory:target.directory,key:target.key,directoryId,storeId:summary.storeId,workspaceId:source.workspaceId,expectedPreparedDigest:summary.digest,receipt:decoded.receipt,assertFresh(){},assertIdle(){},epoch:()=> 'idle'};
  await stagePrivateRestoreV2(stage);expect((await applyStagedPrivateRestoreV2(stage)).restored).toBe(true);
}

describe('department work history through encrypted backup and cold restore',()=>{
  it.each(['v1','v2'] as const)('%s preserves factual and pre-enqueue history while holding every restored request',windowsAdmissionTimeout(139),async version=>{
    const source=await fixture(),target=await fixture(),populated=await populate(source);
    if(version==='v1'){const {backup,receipt}=await source.backup.exportBackup(phrase);await target.backup.stageRestore({backup,passphrase:phrase,expectedDigest:receipt.digest});expect((await applyStagedPrivateRestore({directory:target.directory,key:target.key})).restored).toBe(true);}
    else await restoreV2(source,target);
    expect(await readFile(join(target.directory,'desk.key'))).toEqual(target.key);
    const db=new WorkflowDatabase({dir:target.directory,key:target.key});dbs.push(db);const jobs=new JobRunStore({file:join(target.directory,'job-runs.json'),database:db});
    for(const original of populated.records){
      const restored=db.get<SavedDepartmentWork>(DEPARTMENT_WORK_KIND,original.row.id)!;
      expect(restored.revision).toBe(original.row.revision+1);expect(restored.value).toMatchObject({restored:true,phase:'held'});
      expect(restored.value.request).toEqual(original.row.value.request);expect(restored.value.grant).toEqual(original.row.value.grant);expect(restored.value.recipe).toEqual(original.row.value.recipe);expect(restored.value.delivery).toEqual(original.row.value.delivery);expect(restored.value.runId).toBe(original.row.value.runId);
      if(['running','completed','dispatch-crash'].includes(original.state))expect(jobs.getByIdempotencyKey(original.row.value.jobKey)?.status).toBe(original.state==='completed'?'completed':'interrupted');
      expect(existsSync(join(target.directory,'company-installation/private',`department-execution-${original.row.value.request.requestId}.json`))).toBe(false);
      expect(populated.db.get(DEPARTMENT_WORK_KIND,original.row.id)?.value).toEqual(original.row.value);
    }
    const network=vi.fn(async()=>{throw Error('Restored authority must not be contacted');}),execute=vi.fn(async()=>{throw Error('Restored work must not dispatch');});
    const client=createCompanyExecutionClient({vault:createPrivateVault(target.directory,target.key),identity:network,forward:network});
    const service=createDepartmentWork({db,client,forward:network,recipes:()=>[recipe],instructions:network,assertRecipeReady:network,assertAdmission(){},epoch:()=> 'restored',runContext:fn=>fn(),findJob:key=>jobs.getByIdempotencyKey(key),execute,ask:network});
    await service.tick();await service.drain();service.stop();expect(network).not.toHaveBeenCalled();expect(execute).not.toHaveBeenCalled();
    const rebound=createPrivateWorkspaceBackup({directory:target.directory,key:()=>target.key,workspaceId:source.workspaceId,epoch:()=> 'idle',assertIdle(){},assertFresh(){}});
    await expect(rebound.exportBackup(phrase)).resolves.toHaveProperty('receipt');
  });
  it.each(['wrong-run','wrong-plan','foreign-workspace','false-not-started','wrong-result','secret-field'] as const)('rejects %s at legacy export and catalog admission',async defect=>{
    const source=await fixture(),populated=await populate(source),row=populated.records.find(r=>r.state==='completed')!.row,value=structuredClone(row.value);
    if(defect==='wrong-run'){value.runId=randomUUID();value.delivery!.runId=value.runId;}
    if(defect==='wrong-plan'){value.recipe=structuredClone(value.recipe);value.recipe.review!.plan.steps=['A different reviewed operation'];value.recipe.digest=departmentWorkDigest(value.recipe.review!.plan);value.grant!.spec.recipe=value.recipe;value.grant!.digest=departmentWorkDigest(value.grant!.spec);}
    if(defect==='foreign-workspace'){value.grant!.spec.executor.workspaceId=randomUUID();value.grant!.digest=departmentWorkDigest(value.grant!.spec);}
    if(defect==='false-not-started'){value.runId=null;value.delivery={...value.delivery!,runId:`not-started:${value.executionId}`,outcome:'interrupted'};}
    if(defect==='wrong-result')value.delivery!.outcome='failed';
    if(defect==='secret-field')Object.assign(value,{grantSecret:'unexpected-secret'});
    populated.db.update(DEPARTMENT_WORK_KIND,row.id,row.revision,()=>value);
    await expect(source.backup.exportBackup(phrase)).rejects.toThrow(/department|Department/);
    if(defect==='secret-field'){await expect(capture(source)).rejects.toThrow(/department|Department/);return;}
    const {captured,result}=await capture(source);expect(()=>captured.validate()).toThrow(/execution receipts/);
    await expect(collect(encodeBackupCatalog(captured,{passphrase:phrase,createdAt:at,databasePresent:result.databasePresent}))).rejects.toThrow(/execution receipts/);
  });
});
