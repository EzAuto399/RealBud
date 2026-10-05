import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createPrivateVault } from './private-vault.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { JobRunStore } from './job-runs.ts';
import { executeRecipeJob, type JobExecutorDependencies } from './job-executor.ts';
import { createCompanyExecutionClient } from './company-execution-client.ts';
import { createDepartmentWork, DEPARTMENT_WORK_KIND, restoreDepartmentWork, type SavedDepartmentWork } from './department-work.ts';
import type { DepartmentConfiguration, DepartmentConfigurationPlan } from '../shared/department-configuration.ts';
import { departmentWorkDigest, departmentWorkRecipe } from './department-work-plan.ts';
import { manualRecipeRequestKey } from './manual-job-request.ts';
import { COMPANY_EXECUTION_PURPOSE, type BeginCompanyExecution, type CompanyExecutionGrant, type CompanyExecutionReceipt } from '../shared/company-execution.ts';
import type { DepartmentWorkPrepare } from '../shared/department-work.ts';
import type { Recipe } from '../shared/contracts.ts';
import type { CustomerPack } from '../shared/customer-packs.ts';
import { createCustomerPackService as createPackService } from './customer-packs.ts';
import { withFictionalPublisher } from './testing/pack-publisher.ts';
import { departmentStarterCustomerPack } from './department-starter-pack.ts';
import { privateTempRoot, removeFixture } from './testing/private-fixture.ts';
const createCustomerPackService = withFictionalPublisher(createPackService);

const cleanups:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const cleanup of cleanups.splice(0).reverse())await cleanup();});
const pending=()=>{let resolve!:()=>void;return{promise:new Promise<void>(done=>{resolve=done;}),release:()=>resolve()};};
type LocalPlans = { recipes(): Recipe[]; instructions(id:string): Promise<string>; pack(id:string): Promise<DepartmentConfigurationPlan['pack']> };
async function fixture(local?:LocalPlans) {
  const dir=await mkdtemp(join(tmpdir(),'rb-department-work-')),key=randomBytes(32);
  const db=new WorkflowDatabase({dir,key}),file=join(dir,'job-runs.json');
  let runs=new JobRunStore({file,database:db});
  const companyId=randomUUID(),memberId=randomUUID(),workspaceId=randomUUID(),certificateDigest='c'.repeat(64),workerBinding='b'.repeat(64);
  const session='s'.repeat(43), ownerSession='o'.repeat(43);
  let connected=true,allowed=true,sessionAllowed=true,instructions='Explain the source and list missing facts.',lostBegin=false,instructionReads=0;
  let recipe:Recipe={id:'review-case',title:'Prepare a case review',description:'Review this assigned case.',steps:['Summarize the facts','Draft next steps for review'],allowedOrigins:[],evidence:'Cite the supplied case',capabilities:['analyse','draft'],limits:{maxRuntimeMinutes:1,maxTurns:2},siteNotes:null,status:'active',createdAt:1,updatedAt:1,revision:1,approvedRevision:1,planApprovedAt:1,schedule:null,attachment:null,submitAcknowledgedAt:null};
  const input:DepartmentWorkPrepare={version:1,requestId:randomUUID(),departmentId:randomUUID(),expectedDepartmentRevision:'1',caseId:randomUUID(),expectedCaseFence:'0',recipeId:recipe.id,expectedRecipeRevision:1,durationMs:86_400_000};
  let configuration:DepartmentConfiguration|null={version:1,template:'custom',plans:[{recipe:departmentWorkRecipe(recipe,instructions) as DepartmentConfigurationPlan['recipe'],pack:null}],workflowDefaults:[]};
  let pack:DepartmentConfigurationPlan['pack']=null;
  const source={caseId:input.caseId,title:'Fictional case Alpha',description:'The property inspection is on Friday. Ask the owner to confirm access.'};
  let grant:CompanyExecutionGrant|undefined,receipt:CompanyExecutionReceipt|undefined;
  const requests:{path:string;auth:unknown;body:any}[]=[], workerPrompts:string[]=[];
  let askHook:undefined|(()=>Promise<void>), afterCheck:undefined|(()=>void), executeHook:undefined|((r:Recipe,k:string,d:JobExecutorDependencies)=>Promise<never>);
  const forward=async(path:string,auth:{memberToken:string}|{executionToken:string},body?:any)=>{
    requests.push({path,auth,body:structuredClone(body)});
    if(!connected)throw Object.assign(new Error('Fictional connection unavailable'),{status:503});
    if(path==='/api/company/me')return sessionAllowed&&'memberToken' in auth?{status:200,body:{company:{id:companyId},member:{id:memberId,role:auth.memberToken===ownerSession?'owner':'member'}}}:{status:401,body:{}};
    if(path==='/api/company/departments/configuration')return body.departmentId===input.departmentId&&allowed?{status:200,body:{department:{id:input.departmentId,access:'write',revision:'1',retiredAt:null},configuration:structuredClone(configuration),canManage:'memberToken'in auth&&auth.memberToken===ownerSession}}:{status:403,body:{}};
    if(path==='/api/company/departments/cases')return body.departmentId===input.departmentId&&allowed?{status:200,body:{department:{id:input.departmentId,access:'write'},cases:[]}}:{status:403,body:{}};
    if(path.endsWith('/begin')){
      if(!grant){const begin=body as BeginCompanyExecution;const spec={version:1 as const,purpose:COMPANY_EXECUTION_PURPOSE,companyId,memberId,authorityId:randomUUID(),certificateDigest,departmentId:input.departmentId,departmentRevision:'1',caseId:input.caseId,caseFence:'0',sourceDigest:departmentWorkDigest(source),recipe:begin.recipe,executor:begin.executor};
        grant={id:input.requestId,revision:'0',phase:'pending',current:true,spec,digest:departmentWorkDigest(spec),source,departmentName:'Fictional Operations',memberName:'Fictional Member',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+input.durationMs).toISOString(),confirmedAt:null,revokedAt:null};
        grant.expiresAt=new Date(Date.parse(grant.createdAt)+input.durationMs).toISOString();
      }
      if(lostBegin){lostBegin=false;throw new Error('Fictional begin reply lost');}
      return{status:200,body:structuredClone(grant)};
    }
    if(path.endsWith('/list'))return{status:200,body:{grants:grant?[structuredClone(grant)]:[],offset:body.offset,hasMore:false,canManage:'memberToken'in auth&&auth.memberToken===ownerSession}};
    if(!grant)return{status:404,body:{}};
    if(path.endsWith('/confirm')){if(!('memberToken'in auth)||auth.memberToken!==ownerSession)return{status:403,body:{}};grant={...grant,phase:'active',revision:'1',confirmedAt:new Date().toISOString()};return{status:200,body:structuredClone(grant)};}
    if(path.endsWith('/status'))return{status:200,body:{...structuredClone(grant),current:allowed}};
    if(!allowed)return{status:409,body:{}};
    if(path.endsWith('/admit')){
      if(!receipt)receipt={version:1,grantId:grant.id,receiptId:body.requestId,executionId:body.executionId,caseId:source.caseId,fence:'1',dispatchBefore:new Date(Date.now()+60_000).toISOString(),leaseExpiresAt:new Date(Date.now()+300_000).toISOString()};
      return{status:200,body:receipt};
    }
    if(path.endsWith('/check')){afterCheck?.();return{status:200,body:{receipt,source}};}
    if(path.endsWith('/settle'))return{status:200,body:{receiptId:body.requestId,caseId:source.caseId,fence:'2',status:'recovery_required',outcome:body.outcome,runId:body.runId}};
    throw new Error(`Unexpected simulated route ${path}`);
  };
  const client=createCompanyExecutionClient({vault:createPrivateVault(dir,key),identity:async()=>({companyId,memberId,workspaceId,certificateDigest,workerBinding}),forward});
  const controllers:ReturnType<typeof createDepartmentWork>[]=[];
  const create=()=>{
    const work=createDepartmentWork({db,client,forward:(token,path,body)=>forward(path,{memberToken:token},body),recipes:()=>local?.recipes()??[structuredClone(recipe)],instructions:async id=>{instructionReads++;return local?local.instructions(id):instructions;},assertRecipeReady:async()=>{},pack:async id=>local?local.pack(id):pack,assertAdmission:()=>{},epoch:()=>JSON.stringify({recipe:local?.recipes()??recipe,instructions}),runContext:fn=>fn(),findJob:k=>runs.getByIdempotencyKey(k),
      execute:(r,k,d)=>executeHook?executeHook(r,k,d):executeRecipeJob(r,{mode:'prepare',trigger:'manual',idempotencyKey:k},{...d,store:runs}),
      ask:async(prompt,_opts,check)=>{await check();workerPrompts.push(prompt);await askHook?.();return {ok:true,stdout:JSON.stringify({summary:'Case reviewed',evidence:['Assigned case Alpha'],outputs:['Confirm Friday access with the owner.'],needsApproval:[]})};},
    });controllers.push(work);return work;
  };
  const work=create();
  const saved=()=>db.get<SavedDepartmentWork>(DEPARTMENT_WORK_KIND,`${DEPARTMENT_WORK_KIND}:${input.requestId}`)!;
  const confirm=async()=>{const g=grant!;await work.confirm(ownerSession,{version:1,requestId:randomUUID(),grantId:g.id,expectedRevision:g.revision,grantDigest:g.digest});await work.tick();await work.drain();};
  cleanups.push(async()=>{for(const c of controllers)c.stop();await Promise.all(controllers.map(c=>c.drain()));await client.drain();db.close();await rm(dir,{recursive:true,force:true});});
  return {db,work,create,client,input,source,requests,workerPrompts,saved,session,ownerSession,confirm,setConfiguration:(value:DepartmentConfiguration|null)=>configuration=value,configuration:()=>structuredClone(configuration),setPack:(value:DepartmentConfigurationPlan['pack'])=>pack=value,runs:()=>runs,
    grant:()=>grant!,setAllowed:(v:boolean)=>allowed=v,setConnected:(v:boolean)=>connected=v,logout:()=>sessionAllowed=false,
    instructionReads:()=>instructionReads,
    setAfterCheck:(hook:()=>void)=>afterCheck=hook,
    seedPending:(count:number)=>{for(let n=0;n<count;n++){
      const request={...input,requestId:randomUUID()},executionId=randomUUID();
      db.create<SavedDepartmentWork>(DEPARTMENT_WORK_KIND,`${DEPARTMENT_WORK_KIND}:${request.requestId}`,{version:1,companyId,memberId,request,recipe:departmentWorkRecipe(recipe,instructions),pack,executionId,jobKey:manualRecipeRequestKey(recipe,{requestId:executionId,expectedRevision:recipe.revision},'prepare'),phase:'requesting',detail:'Fictional saved request',runId:null,updatedAt:Date.now(),grant:null,delivery:null,restored:false},1000);
    }},
    setInstructions:(v:string)=>instructions=v,setRecipe:(p:Partial<Recipe>)=>recipe={...recipe,...p},setAskHook:(v:typeof askHook)=>askHook=v,
    loseBegin:()=>lostBegin=true,setExecuteHook:(v:typeof executeHook)=>executeHook=v,reopenRuns:()=>runs=new JobRunStore({file,database:db})};
}

it('uses owner review, existing durable executor and only assigned case input, then never repeats on tick or restart',async()=>{
  const f=await fixture();const prepared=await f.work.prepare(f.session,f.input);
  expect(prepared.grant.spec.recipe.review?.instructions).toContain('missing facts');
  await f.work.tick();await f.work.drain();expect(f.runs().list()).toHaveLength(0);
  await f.confirm();expect(f.workerPrompts).toHaveLength(1);expect(f.workerPrompts[0]).toContain(JSON.stringify(f.source));
  expect(f.workerPrompts[0]).toContain('untrusted business data');
  expect(f.saved().value.phase).toBe('review-required');expect(f.runs().list()).toHaveLength(1);
  expect(f.runs().list()[0].status).toBe('completed');
  f.logout();await f.work.tick();await f.work.drain();const cold=f.create();await cold.tick();await cold.drain();expect(f.workerPrompts).toHaveLength(1);
  expect(JSON.stringify(f.saved())).not.toContain(f.session);
  expect(f.requests.filter(r=>r.path.startsWith('/api/company/execution/')).every(r=>'executionToken'in (r.auth as object))).toBe(true);
});

it('recovers a lost begin reply from the saved intent and does not issue a second begin during background polling',async()=>{
  const f=await fixture();f.loseBegin();await expect(f.work.prepare(f.session,f.input)).rejects.toThrow('reply lost');
  expect(f.saved().value.phase).toBe('requesting');
  await f.work.tick();await f.work.drain();expect(f.saved().value.phase).toBe('waiting-owner');
  await f.work.prepare(f.session,f.input);expect(f.requests.filter(r=>r.path.endsWith('/begin'))).toHaveLength(1);
  await expect(f.work.prepare(f.session,{...f.input,durationMs:60_000})).rejects.toMatchObject({status:409});
});

it('holds a changed instruction set before claiming or starting the worker',async()=>{
  const f=await fixture();await f.work.prepare(f.session,f.input);f.setInstructions('A different plan the owner has not reviewed.');await f.confirm();
  expect(f.workerPrompts).toHaveLength(0);expect(f.requests.filter(r=>r.path.endsWith('/admit'))).toHaveLength(0);expect(f.saved().value.phase).toBe('held');
});

it('rejects private source capabilities and incomplete oversized review instead of silently truncating owner material',async()=>{
  const f=await fixture();f.setRecipe({capabilities:['read-files','analyse']});await expect(f.work.prepare(f.session,f.input)).rejects.toMatchObject({status:409});
  expect(f.db.hasRecords()).toBe(false);f.setRecipe({capabilities:['analyse']});f.setInstructions('可'.repeat(9000));await expect(f.work.prepare(f.session,f.input)).rejects.toMatchObject({status:409});
  expect(f.requests.filter(r=>r.path.endsWith('/begin'))).toHaveLength(0);
});

it('rejects a result after revocation and retains its failed factual receipt without replaying the provider',async()=>{
  const f=await fixture();await f.work.prepare(f.session,f.input);f.setAskHook(async()=>{f.setAllowed(false);});await f.confirm();
  expect(f.workerPrompts).toHaveLength(1);expect(f.runs().list()[0].status).toBe('failed');expect(f.runs().list()[0].evidence.filter(e=>e.kind==='output')).toEqual([]);
  expect(f.saved().value.phase).toBe('held');expect(f.saved().value.delivery?.outcome).toBe('failed');
  await f.work.reconcile(f.session,f.input.requestId);expect(f.workerPrompts).toHaveLength(1);
});

it('preserves an actual queued job after uncertain dispatch, then reconciles its cold interruption without inventing not-started or rerunning',async()=>{
  const f=await fixture();await f.work.prepare(f.session,f.input);
  f.setExecuteHook(async(r,k)=>{f.runs().enqueue(r,{mode:'prepare',trigger:'manual',idempotencyKey:k});throw new Error('Fictional dispatch interruption');});
  await f.confirm();expect(f.saved().value.phase).toBe('held');expect(f.saved().value.runId).toBe(f.runs().list()[0].id);expect(f.saved().value.delivery).toBeNull();
  f.reopenRuns();expect(f.runs().list()[0].status).toBe('interrupted');
  await f.work.reconcile(f.session,f.input.requestId);expect(f.saved().value.delivery?.outcome).toBe('interrupted');expect(f.saved().value.delivery?.runId).toBe(f.runs().list()[0].id);expect(f.workerPrompts).toHaveLength(0);
});

it('never starts restored approvals, and keeps the original plan and factual history',async()=>{
  const f=await fixture();await f.work.prepare(f.session,f.input);const row=f.saved();
  f.db.update<SavedDepartmentWork>(DEPARTMENT_WORK_KIND,row.id,row.revision,v=>restoreDepartmentWork(row.id,v));
  await f.work.tick();await f.work.drain();expect(f.workerPrompts).toHaveLength(0);expect(f.saved().value.restored).toBe(true);
  await expect(f.work.prepare(f.session,f.input)).rejects.toMatchObject({status:409});
});

it('cancels the active worker on service stop and does not accept its late output',async()=>{
  const f=await fixture();await f.work.prepare(f.session,f.input);const gate=pending(),entered=pending();f.setAskHook(async()=>{entered.release();await gate.promise;});
  const confirmation=f.confirm();await entered.promise;f.work.stop();gate.release();await confirmation;
  expect(f.workerPrompts).toHaveLength(1);expect(f.runs().list()[0].status).toBe('failed');expect(f.runs().list()[0].evidence.filter(e=>e.kind==='output')).toEqual([]);
});

it('denies catalog disclosure before reading instructions when department access is absent, including random targets',async()=>{
  const f=await fixture();await expect(f.work.catalog(f.session,randomUUID())).rejects.toMatchObject({status:403});expect(f.instructionReads()).toBe(0);
  f.setAllowed(false);await expect(f.work.catalog(f.session,f.input.departmentId)).rejects.toMatchObject({status:403});expect(f.instructionReads()).toBe(0);
  await expect(f.work.list(f.session,{departmentId:f.input.departmentId,offset:0,limit:10})).rejects.toMatchObject({status:403});
});

it('requires explicit configuration and filters by reviewed bytes instead of displaying every locally approved plan',async()=>{
  const f=await fixture();
  f.setConfiguration(null);
  expect(await f.work.catalog(f.session,f.input.departmentId)).toMatchObject({configured:false,recipes:[],unavailable:[{reason:expect.stringMatching(/owner must configure/)}]});
  await expect(f.work.prepare(f.session,f.input)).rejects.toMatchObject({status:409});
  expect(f.requests.some(r=>r.path.endsWith('/begin'))).toBe(false);expect(f.saved()).toBeUndefined();
  const candidates=await f.work.configurationCandidates(f.ownerSession,f.input.departmentId);
  expect(candidates.candidates).toHaveLength(1);
  f.setConfiguration({version:1,template:'custom',plans:candidates.candidates,workflowDefaults:[]});
  expect((await f.work.catalog(f.session,f.input.departmentId)).recipes).toHaveLength(1);
  f.setRecipe({revision:9,approvedRevision:9});
  expect((await f.work.catalog(f.session,f.input.departmentId)).recipes[0].revision).toBe(9);
  f.setInstructions('Changed local instructions without department review');
  expect(await f.work.catalog(f.session,f.input.departmentId)).toMatchObject({configured:true,recipes:[],unavailable:[{id:f.input.recipeId}]});
  await expect(f.work.configurationCandidates(f.session,f.input.departmentId)).rejects.toMatchObject({status:403});
});

it('matches pack identity and holds a pending request after its local pack changes',async()=>{
  const f=await fixture(),config=f.configuration()!;
  const pack={id:'fictional-pack',revision:1,bindingDigest:'a'.repeat(64)};
  config.plans[0].pack=pack;f.setConfiguration(config);
  expect((await f.work.catalog(f.session,f.input.departmentId)).recipes).toHaveLength(0);
  f.setPack(pack);await f.work.prepare(f.session,f.input);
  expect(f.saved().value.pack).toEqual(pack);
  f.setPack({...pack,bindingDigest:'b'.repeat(64)});await f.confirm();
  expect(f.workerPrompts).toHaveLength(0);expect(f.saved().value.phase).toBe('held');
});

it('paginates all orphan requests after ten without hiding the final saved intent',async()=>{
  const f=await fixture();f.seedPending(11);
  const first=await f.work.list(f.session,{departmentId:f.input.departmentId,offset:0,limit:10});
  const second=await f.work.list(f.session,{departmentId:f.input.departmentId,offset:10,limit:10});
  expect(first.local).toHaveLength(10);expect(first.hasMore).toBe(true);expect(second.local).toHaveLength(1);expect(second.hasMore).toBe(false);
  expect(new Set([...first.local,...second.local].map(r=>r.grantId)).size).toBe(11);
});

it('four older pending owner requests cannot starve a later approved preparation',async()=>{
  const f=await fixture();f.seedPending(4);await f.work.prepare(f.session,f.input);await f.confirm();
  expect(f.workerPrompts).toHaveLength(1);expect(f.saved().value.phase).toBe('review-required');
});

it('holds dispatch when workflow instructions change during the awaited host permission check',async()=>{
  const f=await fixture();await f.work.prepare(f.session,f.input);f.setAfterCheck(()=>f.setInstructions('New instructions after the host check began.'));await f.confirm();
  expect(f.workerPrompts).toHaveLength(0);expect(f.runs().list()).toHaveLength(0);expect(f.saved().value.delivery?.outcome).toBe('interrupted');
});

it('an idle scan never enters the worker context, so it cannot wait behind a workspace pause and hold a restore as busy',async()=>{
  const f=await fixture();let entered=0;
  const idle=createDepartmentWork({db:f.db,client:f.client,forward:async()=>{throw new Error('No request is expected.');},recipes:()=>[],instructions:async()=>'',assertRecipeReady:async()=>{},pack:async()=>null,assertAdmission:()=>{},epoch:()=>'idle',
    // A context that never admits, like one waiting behind a workspace pause.
    runContext:()=>{entered++;return new Promise<never>(()=>{});},findJob:()=>undefined,
    execute:async()=>{throw new Error('Nothing should run.');},ask:async()=>{throw new Error('Nothing should ask.');}});
  await idle.tick();
  expect(entered).toBe(0);expect(idle.busy).toBe(false);
  idle.stop();
});


async function installedDepartmentPack(pack=departmentStarterCustomerPack()) {
  const root=privateTempRoot(join(realpathSync(tmpdir()),'rb-department-pack-workspace-'));
  cleanups.push(()=>removeFixture(root));
  let recipes:Recipe[]=[];
  const options={directory:root,profileDirectory:()=>join(root,'profile'),workroomDirectory:()=>join(root,'workroom'),
    listRecipes:()=>recipes,saveRecipes:(inputs:unknown[])=>{
      recipes=inputs.map(raw=>({...raw as object,revision:1,createdAt:1,updatedAt:1,planApprovedAt:null,approvedRevision:null,attachment:null,submitAcknowledgedAt:null} as Recipe));return recipes;
    },resetRecipeApprovals:(expected:{id:string;revision:number}[])=>{
      for(const item of expected)if(!recipes.some(recipe=>recipe.id===item.id&&recipe.revision===item.revision))throw new Error('Stale fictional local approval');
      recipes=recipes.map(recipe=>expected.some(item=>item.id===recipe.id)?{...recipe,revision:recipe.revision+1,status:'shadow',schedule:null,planApprovedAt:null,approvedRevision:null}:recipe);
    },learningStatus:()=>({supported:true,policyReady:true,enabled:true})};
  const service=createCustomerPackService(options),preview=await service.preview(pack);
  await service.install(pack,preview.digest);
  const approve=()=>{for(const recipe of recipes)Object.assign(recipe,{status:'active',approvedRevision:recipe.revision,planApprovedAt:1});};
  approve();
  const local:LocalPlans={recipes:()=>recipes,instructions:id=>service.departmentInstructionContext(id),pack:async id=>({id:pack.id,revision:pack.revision,bindingDigest:await service.packRecipeBinding(pack.id,id)})};
  const configuration=async(legacy=false):Promise<DepartmentConfiguration>=>({version:1,template:'custom',plans:[{recipe:departmentWorkRecipe(recipes[0],await (legacy?service.instructionContext(recipes[0].id):local.instructions(recipes[0].id))) as DepartmentConfigurationPlan['recipe'],pack:await local.pack(recipes[0].id)}],workflowDefaults:[]});
  return {root,service,pack,local,approve,configuration};
}

it('accepts identical starter content across two real workspace directories after a reviewed change and revert, but refuses changed content',async()=>{
  const owner=await installedDepartmentPack(),member=await installedDepartmentPack(),pack=owner.pack,skill=pack.skills[0],id=pack.recipes[0].id;
  expect(owner.root).not.toBe(member.root);
  const ownerConfiguration=await owner.configuration(),f=await fixture(member.local);
  f.input.recipeId=id;f.setConfiguration(ownerConfiguration);
  expect((await f.work.catalog(f.session,f.input.departmentId)).recipes).toHaveLength(1);
  const baseline=readFileSync(join(member.root,'profile','skills',`realbud-${pack.id}-${skill.id}`,'SKILL.md'),'utf8');
  const changed=`${baseline}\nList missing source facts before the proposed next steps.\n`;
  const pendingDirectory=join(member.root,'profile','pending','skills');await mkdir(pendingDirectory,{recursive:true});
  await writeFile(join(pendingDirectory,'1234abcd.json'),JSON.stringify({id:'1234abcd',subsystem:'skills',action:'edit',summary:'Fictional reviewed instruction clarification',origin:'background_review',created_at:'2026-10-03T00:00:00Z',payload:{action:'edit',name:`realbud-${pack.id}-${skill.id}`,content:changed,replace_all:false}}),{mode:0o600});
  const proposal=(await member.service.proposals()).proposals.find(item=>item.id==='1234abcd')!;
  expect(proposal.state).toBe('reviewable');
  await member.service.reviewProposal({id:proposal.id,pendingDigest:proposal.pendingDigest,currentDigest:proposal.currentDigest,decision:'approve'});
  member.approve();f.input.expectedRecipeRevision=member.local.recipes()[0].revision;
  expect(await member.local.pack(id)).not.toEqual(ownerConfiguration.plans[0].pack);
  expect((await f.work.catalog(f.session,f.input.departmentId)).recipes).toHaveLength(0);
  await expect(f.work.prepare(f.session,f.input)).rejects.toThrow('The owner must configure and review this exact department workflow');
  expect(f.db.hasRecords()).toBe(false);expect(f.requests.some(request=>request.path.endsWith('/begin'))).toBe(false);
  const history=await member.service.skillHistory(pack.id,skill.id,{}),target=history.revisions.find(revision=>revision.revision===1)!;
  const review=await member.service.skillRevertPreview(pack.id,skill.id,{installationRevision:history.installationRevision,head:history.head,sourceDigest:history.sourceDigest,revision:target.revision,digest:target.digest});
  await member.service.revertSkill({packId:pack.id,skillId:skill.id,...review.selection,expectedReviewDigest:review.reviewDigest});member.approve();
  expect((await member.service.skillHistory(pack.id,skill.id,{})).revisions.find(revision=>revision.active)?.revision).toBe(3);
  expect((await owner.service.skillHistory(pack.id,skill.id,{})).revisions.find(revision=>revision.active)?.revision).toBe(1);
  expect(member.local.recipes()[0].revision).toBe(3);expect(owner.local.recipes()[0].revision).toBe(1);
  expect(await member.local.instructions(id)).toBe(await owner.local.instructions(id));
  expect(await member.local.pack(id)).toEqual(ownerConfiguration.plans[0].pack);
  expect((await f.work.catalog(f.session,f.input.departmentId)).recipes[0]).toMatchObject({id,revision:3});
  f.input.expectedRecipeRevision=3;expect((await f.work.prepare(f.session,f.input)).grant.spec.recipe.revision).toBe(3);
  // A clean member also accepts the same reviewed content published by an owner with history.
  const reverse=await fixture(owner.local);reverse.input.recipeId=id;reverse.setConfiguration(await member.configuration());
  expect((await reverse.work.catalog(reverse.session,reverse.input.departmentId)).recipes[0]).toMatchObject({id,revision:1});
  expect((await reverse.work.prepare(reverse.session,reverse.input)).grant.spec.recipe.revision).toBe(1);
  expect(f.workerPrompts).toHaveLength(0);expect(reverse.workerPrompts).toHaveLength(0);
});

it('marks legacy support-file instruction packs unavailable in owner candidates, member catalogs and runtime preparation',async()=>{
  const pack:CustomerPack=departmentStarterCustomerPack();pack.id='fictional-custom-case-review';
  const installed=await installedDepartmentPack(pack),f=await fixture(installed.local),id=pack.recipes[0].id;
  f.input.recipeId=id;f.setConfiguration(await installed.configuration(true));
  expect(await installed.service.instructionContext(id)).toContain('workflow-support/');
  await expect(installed.local.instructions(id)).rejects.toThrow('requires support files');
  const candidates=await f.work.configurationCandidates(f.ownerSession,f.input.departmentId);
  expect(candidates.candidates).toEqual([]);expect(candidates.unavailable).toHaveLength(pack.recipes.length);
  expect(candidates.unavailable.every(item=>item.reason.includes('requires support files'))).toBe(true);
  expect(await f.work.catalog(f.session,f.input.departmentId)).toMatchObject({recipes:[],unavailable:[{id,reason:expect.stringContaining('requires support files')}]});
  await expect(f.work.prepare(f.session,f.input)).rejects.toThrow('requires support files');
  expect(f.db.hasRecords()).toBe(false);expect(f.requests.some(request=>request.path.endsWith('/begin'))).toBe(false);expect(f.workerPrompts).toHaveLength(0);
  // A request saved by the former generic reader is also held before admission after the reader is corrected.
  let useLegacyReader=true;
  const retained=await fixture({...installed.local,instructions:recipeId=>useLegacyReader?installed.service.instructionContext(recipeId):installed.local.instructions(recipeId)});
  retained.input.recipeId=id;retained.setConfiguration(await installed.configuration(true));
  await retained.work.prepare(retained.session,retained.input);useLegacyReader=false;await retained.confirm();
  expect(retained.saved().value.phase).toBe('held');expect(retained.workerPrompts).toHaveLength(0);
  expect(retained.requests.some(request=>request.path.endsWith('/admit'))).toBe(false);
});

it('distinguishes a stale department revision from a missing configuration before journaling or owner review',async()=>{
  const f=await fixture();
  await expect(f.work.prepare(f.session,{...f.input,expectedDepartmentRevision:'0'})).rejects.toThrow('Department workflows changed. Refresh the department cases and plans');
  f.setConfiguration(null);
  await expect(f.work.prepare(f.session,f.input)).rejects.toThrow('The owner must configure and review this exact department workflow');
  expect(f.db.hasRecords()).toBe(false);expect(f.requests.some(request=>request.path.endsWith('/begin'))).toBe(false);
});
