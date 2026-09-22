import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { emptyV3 } from '../shared/desk-v3.ts';
import type { Recipe } from '../shared/contracts.ts';
import type { WebsiteCommandEnvelope } from '../shared/website-commands.ts';
import { encryptJson, decryptJson } from './desk-crypto.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { JobRunStore } from './job-runs.ts';
import { LoopManager } from './routines.ts';
import { manualRecipeRequestKey } from './manual-job-request.ts';
import { websiteRunReceipt } from './website-work-adapters.ts';
import { createRemoteDisclosureReview, REMOTE_TEMPLATE_KIND } from './website-remote-disclosure.ts';
import { recordRemoteEvidence, REMOTE_EVIDENCE_KIND } from './website-remote-evidence.ts';
import { WEBSITE_REQUEST_KIND, createWebsiteRequests, validateSavedWebsiteRequest, websiteRequestDigest, type SavedWebsiteRequest } from './website-requests.ts';
import { WEBSITE_REMOTE_WORK_KIND, validateSavedWebsiteRemoteWork, type SavedWebsiteRemoteWork } from './website-remote-work.ts';
import type { RemoteWorkEnvelope, RemoteWorkReview, RemoteWorkState } from '../shared/website-remote-work.ts';
import type { RemoteApproverGrant } from '../shared/website-remote-approvers.ts';
import { createPrivateWorkspaceBackup, applyStagedPrivateRestore } from './private-workspace-backup.ts';
import { PrivateBackupCatalog } from './private-backup-catalog.ts';
import { capturePrivateWorkspace, verifyPrivateWorkspaceCapture } from './private-backup-capture.ts';
import { encodeBackupCatalog, decodeBackupCatalog } from './private-backup-archive.ts';
import { transformPrivateBackupCatalog } from './private-backup-restore-catalog.ts';
import { PrivateBackupPreparedStore } from './private-backup-prepared.ts';
import { preparePrivateBackupRestore } from './private-backup-prepare.ts';
import { stagePrivateRestoreV2, applyStagedPrivateRestoreV2 } from './private-backup-cold-restore.ts';
import { plantPrivateFile, privateDir, privateTempRoot, removeFixture, windowsAdmissionTimeout } from './testing/private-fixture.ts';
const env=vi.hoisted(()=>{const previous=process.env.REALBUD_DATA_DIR;process.env.REALBUD_DATA_DIR=`${process.env.TMPDIR??'/tmp'}/rb-website-backup-unopened-${process.pid}-${Date.now()}`;return {previous,guard:process.env.REALBUD_DATA_DIR};});
const roots:string[]=[],dbs:WorkflowDatabase[]=[],catalogs:PrivateBackupCatalog[]=[],stores:PrivateBackupPreparedStore[]=[];
const at='2026-09-22T07:00:00.000Z',phrase='Fictional website history encrypted recovery phrase';
afterEach(async()=>{for(const store of stores.splice(0))await store.close();for(const c of catalogs.splice(0))c.close();for(const db of dbs.splice(0))db.close();await Promise.all(roots.splice(0).map(root=>removeFixture(root)));});
afterAll(async()=>{if(env.previous===undefined)delete process.env.REALBUD_DATA_DIR;else process.env.REALBUD_DATA_DIR=env.previous;await removeFixture(env.guard);});
const sha=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
async function file(directory:string,path:string,value:string|Buffer){plantPrivateFile(join(directory,path),value);}
async function fixture(){
  const directory=privateTempRoot(join(realpathSync(tmpdir()),'RealBud website restore Ω '));roots.push(directory);const key=randomBytes(32),workspaceId=randomUUID();
  await file(directory,'desk.key',key);await file(directory,'desk.json',JSON.stringify(encryptJson(key,emptyV3({name:'Fictional workspace',timezone:'UTC',jurisdictions:[]}))));
  await file(directory,'company-installation/workspace.json',JSON.stringify({version:1,id:workspaceId,workerMemberKey:'worker-original'}));
  const backup=createPrivateWorkspaceBackup({directory,key:()=>key,workspaceId,epoch:()=> 'idle',assertIdle(){},assertFresh(){},now:()=>Date.parse(at)});
  return {directory,key,workspaceId,backup};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
const recipe:Recipe={id:'fixture-preparation',title:'Fictional preparation',description:'Prepare local evidence.',steps:['Read supplied evidence.'],allowedOrigins:[],evidence:'Local evidence only',capabilities:['read-files','analyse','draft'],limits:{maxRuntimeMinutes:2,maxTurns:6},siteNotes:null,status:'active',createdAt:1,schedule:null,planApprovedAt:2,revision:2,updatedAt:2,approvedRevision:2,attachment:null,submitAcknowledgedAt:null};
async function populate(f:Fixture){
  const db=new WorkflowDatabase({dir:f.directory,key:f.key});dbs.push(db);const jobs=new JobRunStore({file:join(f.directory,'job-runs.json'),database:db,now:()=>Date.parse(at)});
  const loops=new LoopManager({file:join(f.directory,'loops.json'),database:db,now:()=>Date.parse(at),execute:async()=>({ok:true,detail:'Fictional morning result saved'})});
  const records=[];
  for(const state of ['completed','running','intent','morning'] as const){
    const requestId=randomUUID(),envelope:WebsiteCommandEnvelope={protocol:1,id:requestId,companyId:'fictional-company',installationId:randomUUID(),workspaceId:f.workspaceId,grantId:randomUUID(),generation:1,descriptor:{id:randomUUID(),operation:state==='morning'?'morning-review':'prepare-recipe',revision:'a'.repeat(64),label:'Reviewed preparation'},requester:'Fictional owner',createdAt:at,expiresAt:'2026-09-22T08:00:00.000Z'};
    const identity={workspaceId:f.workspaceId,workerProfileKey:'worker-original'},envelopeDigest=websiteRequestDigest(envelope);
    const content={title:'Fictional preparation',details:[{label:'Source',value:'Fictional local source'}],binding:{recipeId:recipe.id,recipeRevision:recipe.revision,...(state==='morning'?{morning:{loopRevision:loops.listLoops().find(loop=>loop.id==='inbound-triage')!.revision}}:{})}};
    const preview={...content,digest:websiteRequestDigest({envelopeDigest,identity,content}),createdAt:at};
    const executionKey=state==='morning'?requestId:manualRecipeRequestKey(recipe,{requestId,expectedRevision:recipe.revision},'prepare');
    let run=null;
    if(state==='morning'){loops.runNow('inbound-triage',{requestId,expectedRevision:content.binding.morning!.loopRevision});await loops.tick();run=loops.getRunByRequest(requestId)!;}
    else if(state!=='intent'){const queued=jobs.enqueue(recipe,{mode:'prepare',trigger:'manual',idempotencyKey:executionKey}).run;if(state==='completed'){jobs.start(queued.id);run=jobs.settle(queued.id,{status:'completed',detail:'Fictional saved preparation'});}else run=queued;}
    const value:SavedWebsiteRequest={version:1,envelope,envelopeDigest,identity,remote:{envelope,revision:2,phase:'accepted',cancellationRequested:false,runReference:null,outcome:null,updatedAt:at,sequence:2},phase:state==='intent'?'accepted':state==='morning'?'completed':state,outcome:state==='completed'||state==='morning'?'prepared':null,preview,decision:{choice:'approve',previewDigest:preview.digest,at},intent:state==='intent'?{requestId,claim:{grantId:envelope.grantId,generation:1,requestId,expectedRevision:1,envelope,previewDigest:preview.digest,claimId:randomUUID()},stage:'dispatch'}:null,run:run?websiteRunReceipt(run):null,runReference:run?randomUUID():null,pendingEvent:null,restored:false,cancellationRequested:false,updatedAt:at};
    const id=`website-request:${requestId}`;validateSavedWebsiteRequest(id,value);records.push({state,executionKey,row:db.create(WEBSITE_REQUEST_KIND,id,value)});
  }
  const remoteDescriptor={id:randomUUID(),operation:'prepare-recipe' as const,revision:'d'.repeat(64),label:'Fictional disclosure'};
  const disclosure=createRemoteDisclosureReview({db,workspaceId:f.workspaceId,catalog:async()=>[remoteDescriptor],capture:async()=>({version:1,policy:'exact-reviewed-template-v1',descriptor:remoteDescriptor,mailboxAlias:null,sections:[{label:'Instructions',value:'Complete fictional reviewed text'}]})});
  const [template]=await disclosure.preview({descriptorIds:[remoteDescriptor.id],mailboxAlias:null});
  const scopes=await disclosure.approve({reviews:[{id:template.id,revision:template.revision,digest:template.value.digest}]});
  recordRemoteEvidence(db,{workspaceId:f.workspaceId,enrollmentId:randomUUID(),snapshot:null,scopes,phase:'pending'});
  await file(f.directory,'website-requests/remote-approvers.json',JSON.stringify({secret:'remote-secret-canary-never-export',confirmation:'pending-authority-never-export'}));
  await file(f.directory,'website-requests/grant.json',JSON.stringify({commandToken:'command-canary-do-not-export'}));
  await file(f.directory,'office-link/link.json',JSON.stringify({token:'report-canary-do-not-export'}));
  return {db,jobs,records};
}
async function populateRemote(f:Fixture) {
  const {db,jobs}=await populate(f);
  const remoteRecipe={...recipe,id:"remote-fixture-preparation"};
  const loops=new LoopManager({file:join(f.directory,'loops.json'),database:db,now:()=>Date.parse(at),execute:async()=>({ok:true,detail:'Fictional remote morning result'})});
  const records=[];
  for(const state of ['completed','running','intent','morning'] as const) {
    const person={subject:randomUUID(),identityEpoch:1,email:'staff@example.test',agencyLabel:'Fictional agency',companyId:'fictional-company'};
    const descriptor={id:randomUUID(),operation:state==='morning'?'morning-review' as const:'prepare-recipe' as const,revision:'a'.repeat(64),label:'Reviewed remote preparation'};
    const envelope:RemoteWorkEnvelope={protocol:2,id:randomUUID(),companyId:person.companyId,installationId:randomUUID(),workspaceId:f.workspaceId,workerBinding:randomUUID(),grantId:randomUUID(),generation:1,descriptor,requester:person,requesterEnrollmentId:randomUUID(),createdAt:at,expiresAt:'2026-09-22T08:00:00.000Z'};
    const disclosure=createRemoteDisclosureReview({db,workspaceId:f.workspaceId,catalog:async()=>[descriptor],capture:async()=>({version:1,policy:'exact-reviewed-template-v1',descriptor,mailboxAlias:state==='morning'?'Office inbox':null,sections:[{label:'Instructions',value:'Complete remote preparation instructions'}]})});
    const [template]=await disclosure.preview({descriptorIds:[descriptor.id],mailboxAlias:state==='morning'?'Office inbox':null});
    const scopes=await disclosure.approve({reviews:[{id:template.id,revision:template.revision,digest:template.value.digest}]});
    const approver:RemoteApproverGrant={protocol:2,id:envelope.requesterEnrollmentId,generation:1,parentGrantId:envelope.grantId,parentGeneration:1,installationId:envelope.installationId,workspaceId:f.workspaceId,workerBinding:envelope.workerBinding,companyId:person.companyId,person,scopes,disclosurePolicy:'exact-reviewed-template-v1',enrolledAt:at,expiresAt:envelope.expiresAt,revokedAt:null};
    db.create(REMOTE_EVIDENCE_KIND,`remote-enrollment:${approver.id}`,{version:1,workspaceId:f.workspaceId,enrollmentId:approver.id,scopes,candidate:person,approver,phase:'confirmed',restored:false,updatedAt:at});
    const identity={workspaceId:f.workspaceId,workerProfileKey:'worker-original'},activationId=randomUUID(),envelopeDigest=websiteRequestDigest(envelope);
    const content={title:'Fictional remote preparation',details:[{label:'Source',value:'Private source details retained locally'}],binding:{recipeId:remoteRecipe.id,recipeRevision:remoteRecipe.revision,...(state==='morning'?{morning:{loopRevision:loops.listLoops().find(loop=>loop.id==='inbound-triage')!.revision}}:{})}};
    const preview={...content,digest:websiteRequestDigest({envelopeDigest,identity,activationId,content}),createdAt:at};
    const review:RemoteWorkReview={protocol:2,reviewId:randomUUID(),requestId:envelope.id,grantId:envelope.grantId,generation:1,activationId,previewDigest:preview.digest,previewRevision:1,descriptorId:descriptor.id,descriptorRevision:descriptor.revision,template:template.value.template,templateDigest:template.value.digest,audience:[{enrollmentId:approver.id,generation:1,person}],createdAt:at,expiresAt:envelope.expiresAt};
    const reviewDigest=websiteRequestDigest(review),decision={protocol:2 as const,requestId:envelope.id,reviewId:review.reviewId,reviewDigest,decisionId:randomUUID(),choice:'approve' as const,reviewRevision:2,person,enrollmentId:approver.id,decidedAt:at};
    const remote:RemoteWorkState={envelope,revision:4,phase:'accepted',cancellationRequested:false,runReference:null,outcome:null,updatedAt:at,sequence:4,review:{id:review.reviewId,digest:reviewDigest,revision:2,expiresAt:review.expiresAt,decision,prunedAt:null}};
    const executionKey=state==='morning'?envelope.id:manualRecipeRequestKey(remoteRecipe,{requestId:envelope.id,expectedRevision:remoteRecipe.revision},'prepare');
    let run=null;
    if(state==='morning'){loops.runNow('inbound-triage',{requestId:envelope.id,expectedRevision:content.binding.morning!.loopRevision});await loops.tick();run=loops.getRunByRequest(envelope.id)!;}
    else if(state!=='intent'){const queued=jobs.enqueue(remoteRecipe,{mode:'prepare',trigger:'manual',idempotencyKey:executionKey}).run;if(state==='completed'){jobs.start(queued.id);run=jobs.settle(queued.id,{status:'completed',detail:'Fictional remote result'});}else run=queued;}
    const publication={protocol:2 as const,grantId:envelope.grantId,generation:1,requestId:envelope.id,expectedRevision:1,review,reviewDigest};
    const value:SavedWebsiteRemoteWork={version:2,envelope,envelopeDigest,identity,authority:'b'.repeat(64),activationId,remote,phase:state==='intent'?'accepted':state==='morning'?'completed':state,outcome:state==='completed'||state==='morning'?'prepared':null,preview,publication,publicationPending:false,intent:state==='intent'?{claim:{protocol:2,grantId:envelope.grantId,generation:1,requestId:envelope.id,expectedRevision:3,claimId:randomUUID(),reviewId:review.reviewId,reviewDigest,decisionId:decision.decisionId,previewDigest:preview.digest,activationId},stage:'dispatch'}:null,run:run?websiteRunReceipt(run):null,runReference:run?randomUUID():null,pendingEvent:null,pendingCancel:null,cancellationRequested:false,restored:false,updatedAt:at};
    const id=`website-remote-work:${envelope.id}`;validateSavedWebsiteRemoteWork(id,value);records.push({state,executionKey,templateId:template.id,row:db.create(WEBSITE_REMOTE_WORK_KIND,id,value)});
  }
  await file(f.directory,'website-requests/remote-work.json',JSON.stringify({commandToken:'remote-work-private-token-canary',enabled:true,activationId:randomUUID()}));
  return {db,jobs,records};
}
async function catalog(f:Fixture,name:string,key=f.key,workspaceId=f.workspaceId){const c=await PrivateBackupCatalog.create({directory:join(f.directory,name),key,workspaceId,maxEntries:200,maxBytes:8*1024*1024});catalogs.push(c);return c;}
async function* chunks(bytes:Buffer){for(let offset=0;offset<bytes.length;offset+=701)yield bytes.subarray(offset,offset+701);}
async function collect(stream:AsyncIterable<Uint8Array>){const parts:Buffer[]=[];for await(const value of stream)parts.push(Buffer.from(value));return Buffer.concat(parts);}
async function capture(source:Fixture){const scratch=await fixture(),captured=await catalog(scratch,'capture',source.key,source.workspaceId);const options={directory:source.directory,key:source.key,workspaceId:source.workspaceId,catalog:captured,assertLease(){}};const result=await capturePrivateWorkspace(options);await verifyPrivateWorkspaceCapture(options,result);return {scratch,captured,result};}
async function restoreV2(source:Fixture,target:Fixture){
  const {scratch,captured,result}=await capture(source);
  expect(captured.getFile('website-requests/grant.json')).toBeUndefined();expect(captured.getFile('office-link/link.json')).toBeUndefined();
  const archive=await collect(encodeBackupCatalog(captured,{passphrase:phrase,createdAt:at,databasePresent:result.databasePresent}));expect(archive.includes(Buffer.from('Fictional local source'))).toBe(false);
  const decoded=await decodeBackupCatalog(chunks(archive),{directory:join(scratch.directory,'decoded'),key:target.key,passphrase:phrase,expectedArchiveDigest:sha(archive)});catalogs.push(decoded.catalog);
  const transformed=await catalog(scratch,'transformed',target.key,source.workspaceId);transformPrivateBackupCatalog({source:decoded.catalog,destination:transformed,at:Date.parse(at)+1000});
  const directoryId=randomUUID(),parent=join(target.directory,'private-backup-v2/prepared');privateDir(parent);
  const prepared=await PrivateBackupPreparedStore.create({directory:join(parent,directoryId),key:target.key,workspaceId:source.workspaceId});stores.push(prepared);
  const summary=await preparePrivateBackupRestore({directory:target.directory,key:target.key,source:transformed,prepared,databasePresent:result.databasePresent,assertLease(){}});await prepared.close();
  const stage={directory:target.directory,key:target.key,directoryId,storeId:summary.storeId,workspaceId:source.workspaceId,expectedPreparedDigest:summary.digest,receipt:decoded.receipt,assertFresh(){},assertIdle(){},epoch:()=> 'idle'};
  await stagePrivateRestoreV2(stage);expect((await applyStagedPrivateRestoreV2(stage)).restored).toBe(true);
}
describe('website request history through actual encrypted private backup and cold restore',()=>{
  it.each(['v1','v2'] as const)('%s retains real execution links and pre-enqueue intent evidence but never restores command authority',windowsAdmissionTimeout(134),async version=>{
    const source=await fixture(),target=await fixture(),populated=await populate(source);expect(source.key.equals(target.key)).toBe(false);
    if(version==='v1'){
      const {backup,receipt}=await source.backup.exportBackup(phrase);
      const key=scryptSync(phrase,Buffer.from(backup.salt,'hex'),32,{N:32768,r:8,p:1,maxmem:64*1024*1024});
      try{const snapshot=decryptJson(key,backup.payload) as {files:{path:string}[]};expect(snapshot.files.some(f=>f.path.startsWith('website-requests/')||f.path.startsWith('office-link/'))).toBe(false);}finally{key.fill(0);}
      await target.backup.stageRestore({backup,passphrase:phrase,expectedDigest:receipt.digest});expect((await applyStagedPrivateRestore({directory:target.directory,key:target.key})).restored).toBe(true);
    }else await restoreV2(source,target);
    expect(existsSync(join(target.directory,'website-requests/remote-approvers.json'))).toBe(false);expect(existsSync(join(target.directory,'website-requests/grant.json'))).toBe(false);expect(existsSync(join(target.directory,'office-link/link.json'))).toBe(false);expect(await readFile(join(target.directory,'desk.key'))).toEqual(target.key);
    const db=new WorkflowDatabase({dir:target.directory,key:target.key});dbs.push(db);const jobs=new JobRunStore({file:join(target.directory,'job-runs.json'),database:db});
    const service=createWebsiteRequests({directory:target.directory,db,officeLink:{credentials:async()=>null},identity:()=>({workspaceId:source.workspaceId,workerProfileKey:'worker-original'}),getCatalog:async()=>[],preview:async()=>{throw new Error('No restore dispatch');},check:async()=>{},dispatch:async()=>{throw new Error('No restore dispatch');},lookup:async()=>null,cancel:async()=>{}});
    for(const original of populated.records){const restored=db.get<SavedWebsiteRequest>(WEBSITE_REQUEST_KIND,original.row.id)!;expect(restored.revision).toBe(original.row.revision+1);expect(restored.value.restored).toBe(true);expect(restored.value.envelope).toEqual(original.row.value.envelope);expect(restored.value.run).toEqual(original.row.value.run);expect(restored.value.intent).toBeNull();expect(restored.value.pendingEvent).toBeNull();expect(restored.value.phase).toBe(original.state==='completed'||original.state==='morning'?'completed':'interrupted');expect(()=>service.executionBinding(restored.value.envelope.id)).toThrow(/permission/);
      if(original.state!=='intent'&&original.state!=='morning')expect(jobs.getByIdempotencyKey(original.executionKey)?.status).toBe(original.state==='completed'?'completed':'interrupted');}
    const templates=db.list<any>(REMOTE_TEMPLATE_KIND);expect(templates).toHaveLength(1);expect(templates[0].value.approved).toBe(false);expect(templates[0].value.restored).toBe(true);expect(templates[0].value.template.sections[0].value).toBe('Complete fictional reviewed text');const history=db.list<any>(REMOTE_EVIDENCE_KIND);expect(history).toHaveLength(1);expect(history[0].value.restored).toBe(true);expect(history[0].value.phase).toBe('historical');
    expect((await service.status()).enabled).toBe(false);await service.recover();expect(service.list().records.every(row=>row.value.restored)).toBe(true);
    // Re-export the recovered target: transformed execution and request graphs stay coherent.
    const rebound=createPrivateWorkspaceBackup({directory:target.directory,key:()=>target.key,workspaceId:source.workspaceId,epoch:()=> 'idle',assertIdle(){},assertFresh(){}});await expect(rebound.exportBackup(phrase)).resolves.toHaveProperty('receipt');
  });
  it.each(['missing-run','foreign-workspace','wrong-request-key'] as const)('rejects authenticated %s history at both v1 export and v2 archive admission',async defect=>{
    const source=await fixture(),populated=await populate(source),row=populated.records[0]!.row;
    const value=structuredClone(row.value);
    if(defect==='missing-run')value.run!.id=randomUUID();
    if(defect==='foreign-workspace'){
      value.identity.workspaceId=randomUUID();value.envelope.workspaceId=value.identity.workspaceId;value.remote.envelope=value.envelope;value.envelopeDigest=websiteRequestDigest(value.envelope);
      const {digest:_digest,createdAt:_created,...content}=value.preview!;value.preview!.digest=websiteRequestDigest({envelopeDigest:value.envelopeDigest,identity:value.identity,content});value.decision!.previewDigest=value.preview!.digest;
    }
    if(defect==='wrong-request-key'){
      value.preview!.binding.recipeRevision=99;const {digest:_digest,createdAt:_created,...content}=value.preview!;value.preview!.digest=websiteRequestDigest({envelopeDigest:value.envelopeDigest,identity:value.identity,content});value.decision!.previewDigest=value.preview!.digest;
    }
    validateSavedWebsiteRequest(row.id,value);populated.db.update(WEBSITE_REQUEST_KIND,row.id,row.revision,()=>value);
    await expect(source.backup.exportBackup(phrase)).rejects.toThrow(/workspace or execution receipts/);const {captured,result}=await capture(source);expect(()=>captured.validate()).toThrow(/workspace or execution receipts/);await expect(collect(encodeBackupCatalog(captured,{passphrase:phrase,createdAt:at,databasePresent:result.databasePresent}))).rejects.toThrow(/workspace or execution receipts/);
  });
});

describe('remote work evidence through encrypted backup and cold restore',()=>{
  it.each(['v1','v2'] as const)('%s restores full review evidence and real executor links without remote authority',windowsAdmissionTimeout(142),async version=>{
    const source=await fixture(),target=await fixture(),populated=await populateRemote(source);
    if(version==='v1'){
      const {backup,receipt}=await source.backup.exportBackup(phrase);
      await target.backup.stageRestore({backup,passphrase:phrase,expectedDigest:receipt.digest});
      expect((await applyStagedPrivateRestore({directory:target.directory,key:target.key})).restored).toBe(true);
    }else await restoreV2(source,target);
    expect(existsSync(join(target.directory,'website-requests/remote-work.json'))).toBe(false);
    expect(existsSync(join(target.directory,'website-requests/remote-approvers.json'))).toBe(false);
    expect(await readFile(join(target.directory,'desk.key'))).toEqual(target.key);
    const db=new WorkflowDatabase({dir:target.directory,key:target.key});dbs.push(db);
    const service=createWebsiteRequests({directory:target.directory,db,officeLink:{credentials:async()=>null},identity:()=>({workspaceId:source.workspaceId,workerProfileKey:'worker-original'}),getCatalog:async()=>[],preview:async()=>{throw new Error('No restore preview');},check:async()=>{},dispatch:async()=>{throw new Error('No restore dispatch');},lookup:async()=>null,cancel:async()=>{}});
    for(const original of populated.records){
      const row=db.get<SavedWebsiteRemoteWork>(WEBSITE_REMOTE_WORK_KIND,original.row.id)!;
      expect(row.revision).toBe(original.row.revision+1);expect(row.value.restored).toBe(true);expect(row.value.cancellationRequested).toBe(true);
      expect(row.value.publication).toEqual(original.row.value.publication);expect(row.value.preview).toEqual(original.row.value.preview);expect(row.value.run).toEqual(original.row.value.run);
      expect(row.value.intent).toBeNull();expect(row.value.pendingCancel).toBeNull();expect(row.value.pendingEvent).toBeNull();expect(row.value.publicationPending).toBe(false);
      expect(row.value.phase).toBe(['completed','morning'].includes(original.state)?'completed':'interrupted');
      expect(()=>service.executionBinding(row.value.envelope.id)).toThrow(/permission/);
    }
    expect((await service.remoteWork.status()).enabled).toBe(false);await service.recover();
    const rebound=createPrivateWorkspaceBackup({directory:target.directory,key:()=>target.key,workspaceId:source.workspaceId,epoch:()=> 'idle',assertIdle(){},assertFresh(){}});
    await expect(rebound.exportBackup(phrase)).resolves.toHaveProperty('receipt');
  });
  it.each(['missing-template','missing-audience','foreign-person','wrong-request-key'] as const)('rejects %s in remote evidence before archive admission',async defect=>{
    const source=await fixture(),populated=await populateRemote(source),row=populated.records[0]!.row,value=structuredClone(row.value);
    if(defect==='missing-template'){
      value.publication!.review.template.sections[0].value='Changed full template';value.publication!.review.templateDigest=websiteRequestDigest(value.publication!.review.template);
    }else if(defect==='missing-audience')value.publication!.review.audience[0].enrollmentId=randomUUID();
    else if(defect==='foreign-person')value.publication!.review.audience[0].person={...value.publication!.review.audience[0].person,subject:randomUUID()};
    else {value.preview!.binding.recipeRevision=99;const {digest:_digest,createdAt:_created,...content}=value.preview!;value.preview!.digest=websiteRequestDigest({envelopeDigest:value.envelopeDigest,identity:value.identity,activationId:value.activationId,content});value.publication!.review.previewDigest=value.preview!.digest;}
    value.publication!.reviewDigest=websiteRequestDigest(value.publication!.review);value.remote.review!.digest=value.publication!.reviewDigest;
    value.remote.review!.decision!.reviewDigest=value.publication!.reviewDigest;
    value.remote.review!.decision!.enrollmentId=value.publication!.review.audience[0].enrollmentId;value.remote.review!.decision!.person=value.publication!.review.audience[0].person;
    validateSavedWebsiteRemoteWork(row.id,value);populated.db.update(WEBSITE_REMOTE_WORK_KIND,row.id,row.revision,()=>value);
    await expect(source.backup.exportBackup(phrase)).rejects.toThrow(/workspace or execution receipts/);
    const {captured,result}=await capture(source);expect(()=>captured.validate()).toThrow(/workspace or execution receipts/);
    await expect(collect(encodeBackupCatalog(captured,{passphrase:phrase,createdAt:at,databasePresent:result.databasePresent}))).rejects.toThrow(/workspace or execution receipts/);
  });
});
