import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { createWebsiteWorkAdapters, websiteWorkSettingsMutation } from './website-work-adapters.ts';
import { JobRunStore } from './job-runs.ts';
import { executeRecipeJob } from './job-executor.ts';
import { manualRecipeRequestKey } from './manual-job-request.ts';
import { defaultAgencySettings } from './agency-setup.ts';
import { workflowRecipeId } from '../shared/agency-workflow-packs.ts';
import type { Recipe, Loop, LoopRun } from '../shared/contracts.ts';
import type { AgencySetupView } from '../shared/agency-setup.ts';

const clean: (()=>void)[]=[];
afterEach(()=>{for(const action of clean.splice(0).reverse())action();});
function fixture() {
  const dir=mkdtempSync(join(tmpdir(),'realbud-website-executor-'));clean.push(()=>rmSync(dir,{recursive:true,force:true}));
  const store=new JobRunStore({file:join(dir,'job-runs.json')});clean.push(()=>store.close());
  const recipe:Recipe={id:'fictional-preparation',title:'Fictional briefing',description:'Prepare a fictional briefing.',steps:['Review supplied facts.'],allowedOrigins:[],evidence:'Prepared notes',capabilities:['analyse','draft'],limits:{maxRuntimeMinutes:1,maxTurns:4},status:'active',createdAt:1,schedule:null,planApprovedAt:1,revision:1,updatedAt:1,approvedRevision:1,attachment:null,submitAcknowledgedAt:null};
  const recipes=[recipe];let instructions='Reviewed fictional instructions',authority='fixed',bookRevision=1,allowed=true,epoch=0;
  const ask=vi.fn(async()=>({ok:true,stdout:JSON.stringify({summary:'Prepared fictional notes.',evidence:[],outputs:['Fictional output.'],needsApproval:[]}),detail:'done'}));
  const view:AgencySetupView={state:{version:1,workspaceId:randomUUID(),revision:1,updatedAt:1,settings:{...defaultAgencySettings(),agencyName:'Fictional office',workflowPackId:'office-core',gmailAccountId:'fictional-account',timeZone:'Australia/Brisbane'},reviews:{}},accounts:[],properties:[],canCheckGmail:false,workflows:[{id:'morning-priorities',title:'Morning priorities',selected:true,checks:[],evidenceDigest:'a'.repeat(64),canReview:true,reviewed:true,readyForRun:false,acceptance:'not-verified'}]};
  const loop={id:'inbound-triage',revision:1,available:true} as Loop;
  const morning=new Map<string,LoopRun>();
  const runs:Promise<unknown>[]=[];
  let instructionHook:(()=>void)|undefined;
  const adapters=createWebsiteWorkAdapters({workspaceId:view.state.workspaceId,recipes:()=>recipes,instructions:async()=>{instructionHook?.();return instructions;},assertRecipeReady:async()=>{},agency:async()=>structuredClone(view),morningLoop:()=>loop,authority:()=>authority,revisionEpoch:()=>epoch,assertAdmission:()=>{if(!allowed)throw new Error('Service access ended');},bookRevision:()=>bookRevision,
    runMorning:(requestId,revision)=>{const run={id:randomUUID(),loopId:'inbound-triage',loopRevision:revision,requestId,loopName:'Morning',scheduledFor:1,status:'queued',manual:true,createdAt:1} as LoopRun;morning.set(requestId,run);return run;},findMorning:id=>morning.get(id),findJob:key=>store.getByIdempotencyKey(key),
    execute:(plan,key,beforeWorker)=>{const run=executeRecipeJob(plan,{mode:'prepare',trigger:'manual',idempotencyKey:key},{store,ask,instructionContext:beforeWorker});runs.push(run);return run;}});
  return {adapters,recipes,recipe,ask,store,view,loop,morning,runs,setInstructions:(v:string)=>instructions=v,setAuthority:(v:string)=>authority=v,setBook:(v:number)=>bookRevision=v,revoke:()=>allowed=false,mutate:()=>epoch++,setHook:(v:()=>void)=>instructionHook=v};
}
async function prepared(f:ReturnType<typeof fixture>) {const descriptor=(await f.adapters.getCatalog()).find(d=>d.operation==='prepare-recipe')!,binding=(await f.adapters.preview(descriptor)).binding;await f.adapters.check(descriptor,binding);return {descriptor,requestId:randomUUID(),binding};}
it('uses the actual preparation executor and its persisted key for duplicates and completion',async()=>{
  const f=fixture(),execution=await prepared(f);await f.adapters.check(execution.descriptor,execution.binding);
  const first=await f.adapters.dispatch(execution);await Promise.all(f.runs);const second=await f.adapters.dispatch(execution);
  expect(first.id).toBe(second.id);expect(second.phase).toBe('completed');expect(f.ask).toHaveBeenCalledTimes(1);
  const key=manualRecipeRequestKey(f.recipe,{requestId:execution.requestId,expectedRevision:1},'prepare');expect(f.store.getByIdempotencyKey(key)?.id).toBe(first.id);
  expect(JSON.stringify(second)).not.toContain('Fictional output');
});
it('never advertises portal work or dedicated ingestion recipes through generic preparation',async()=>{
  const f=fixture();f.recipes.push({...f.recipe,id:'portal-job',capabilities:['portal-read']},{...f.recipe,id:workflowRecipeId('office-core','invoice-review')!});
  const catalog=await f.adapters.getCatalog();expect(catalog).toHaveLength(1);expect(JSON.stringify(catalog)).not.toContain(f.recipe.id);
});
it('holds changed plan, instructions, private book, configuration and entitlement',async()=>{
  const f=fixture();f.recipe.capabilities=['read-book','draft'];const execution=await prepared(f);
  f.setBook(2);await expect(f.adapters.check(execution.descriptor,execution.binding)).rejects.toThrow(/changed/);f.setBook(1);
  f.setInstructions('Different instruction');await expect(f.adapters.check(execution.descriptor,execution.binding)).rejects.toThrow(/changed/);f.setInstructions('Reviewed fictional instructions');
  f.setAuthority('changed');await expect(f.adapters.dispatch(execution)).rejects.toThrow(/changed/);f.setAuthority('fixed');
  f.recipe.steps=['Unreviewed change'];await expect(f.adapters.check(execution.descriptor,execution.binding)).rejects.toThrow(/changed/);f.recipe.steps=['Review supplied facts.'];
  f.revoke();await expect(f.adapters.dispatch(execution)).rejects.toThrow(/access ended/);expect(f.ask).not.toHaveBeenCalled();
});
it('rechecks after the executor instruction await and saves failure without invoking the worker',async()=>{
  const f=fixture(),execution=await prepared(f);f.setHook(()=>f.revoke());
  const first=await f.adapters.dispatch(execution);await Promise.all(f.runs);const result=await f.adapters.lookup(execution);
  expect(result?.id).toBe(first.id);expect(result?.phase).toBe('failed');expect(f.ask).not.toHaveBeenCalled();
});
it('binds morning runs to the selected reviewed source and exact schedule revision',async()=>{
  const f=fixture();f.recipes.push({...f.recipe,id:workflowRecipeId('office-core','inbox-triage')!});f.view.workflows[0].readyForRun=true;
  const descriptor=(await f.adapters.getCatalog()).find(d=>d.operation==='morning-review')!;
  const execution={descriptor,requestId:randomUUID(),binding:(await f.adapters.preview(descriptor)).binding};
  f.view.workflows[0].evidenceDigest='b'.repeat(64);await expect(f.adapters.check(descriptor,execution.binding)).rejects.toThrow(/changed/);f.view.workflows[0].evidenceDigest='a'.repeat(64);
  await f.adapters.check(descriptor,execution.binding);const run=await f.adapters.dispatch(execution);expect((await f.adapters.dispatch(execution)).id).toBe(run.id);expect(f.morning.size).toBe(1);
  f.loop.revision=2;expect((await f.adapters.lookup(execution))?.id).toBe(run.id);expect(f.ask).not.toHaveBeenCalled();
});
it('detects a recipe edit during an awaited pack check without publishing mixed bindings',async()=>{
  const f=fixture();f.setHook(()=>{f.recipe.revision++;});expect(await f.adapters.getCatalog()).toEqual([]);
});
it('rejects a newly reviewed replacement mail scope even when the clock revision is unchanged',async()=>{
  const f=fixture();f.recipes.push({...f.recipe,id:workflowRecipeId('office-core','inbox-triage')!});f.view.workflows[0].readyForRun=true;
  const descriptor=(await f.adapters.getCatalog()).find(d=>d.operation==='morning-review')!, binding=(await f.adapters.preview(descriptor)).binding;
  f.setHook(()=>{f.view.state.revision++;f.view.workflows[0].evidenceDigest='c'.repeat(64);});
  await expect(f.adapters.check(descriptor,binding)).rejects.toThrow(/changed/);expect(f.loop.revision).toBe(1);expect(f.morning.size).toBe(0);
});
it('closes the mutation window even when an edit and rollback restore the same visible values',async()=>{
  const f=fixture(),execution=await prepared(f);f.setHook(()=>f.mutate());await expect(f.adapters.check(execution.descriptor,execution.binding)).rejects.toThrow(/changed/);
});
it('does not enqueue when a mutation starts during credential reads after a successful check',async()=>{
  const f=fixture(),execution=await prepared(f);f.mutate();await expect(f.adapters.dispatch(execution)).rejects.toThrow(/changed/);expect(f.ask).not.toHaveBeenCalled();expect(f.store.list()).toHaveLength(0);
});
it('allows a concurrent connection observation but fences actual settings writes across awaits',async()=>{
  const f=fixture(),execution=await prepared(f);
  f.setHook(()=>{if(websiteWorkSettingsMutation('/api/connected-apps/check','POST'))f.mutate();});
  await f.adapters.check(execution.descriptor,execution.binding);
  await f.adapters.dispatch(execution);await Promise.all(f.runs);expect(f.ask).toHaveBeenCalledTimes(1);
  for(const [path,method] of [['/api/connected-apps/settings','PATCH'],['/api/agency-setup','PUT'],['/api/customer-packs/install','POST'],['/api/hermes/model','POST'],['/api/service-admin/setup','POST'],['/api/config','PATCH'],['/api/recipes','POST'],['/api/recipes/fictional-preparation','DELETE']]) {
    f.setHook(()=>{if(websiteWorkSettingsMutation(path,method))f.mutate();});
    await expect(f.adapters.check(execution.descriptor,execution.binding)).rejects.toThrow(/changed/);
  }
  expect(websiteWorkSettingsMutation('/api/connected-apps/check','DELETE')).toBe(true);
  expect(websiteWorkSettingsMutation('/api/connected-apps/check/new-mutation','POST')).toBe(true);
  expect(websiteWorkSettingsMutation('/api/connected-apps/settings','GET')).toBe(false);
});
it('shows the exact local prompt instructions and refuses an oversized review without truncation',async()=>{
  const f=fixture();f.recipe.siteNotes='Reviewed local site note';const execution=await prepared(f),preview=await f.adapters.preview(execution.descriptor);
  expect(preview.details.map(v=>v.value)).toEqual(expect.arrayContaining([f.recipe.description,f.recipe.evidence,f.recipe.siteNotes,'Reviewed fictional instructions']));
  f.setInstructions('x'.repeat(70000));const descriptor=(await f.adapters.getCatalog())[0];await expect(f.adapters.preview(descriptor)).rejects.toThrow(/too large/);
});

it('creates complete typed remote disclosure for both adapters without private bindings or raw mailbox identifiers',async()=>{
 const f=fixture();f.recipes.push({...f.recipe,id:workflowRecipeId('office-core','inbox-triage')!});f.view.workflows[0].readyForRun=true;
 for(const descriptor of await f.adapters.getCatalog()){
  const template=await f.adapters.remoteDisclosure(descriptor,descriptor.operation==='morning-review'?'Accounts mailbox':null);
  expect(JSON.stringify(template)).not.toContain('fictional-account');expect(template).not.toHaveProperty('binding');expect(template.sections.some(s=>s.value.includes('Reviewed fictional instructions'))).toBe(true);
  if(descriptor.operation==='morning-review')expect(template.sections.some(s=>s.value.includes('relative to dispatch time'))).toBe(true);
 }
 expect(f.ask).not.toHaveBeenCalled();expect(f.morning.size).toBe(0);
});
it('keeps implicit private-book sources local and refuses raw mailbox identifiers in alias or instructions',async()=>{
 const f=fixture();f.recipe.capabilities.push('read-book');const d=(await f.adapters.getCatalog())[0];await expect(f.adapters.remoteDisclosure(d,null)).rejects.toThrow(/private book/);
 f.recipe.capabilities=['analyse'];f.recipes.push({...f.recipe,id:workflowRecipeId('office-core','inbox-triage')!});f.view.workflows[0].readyForRun=true;let m=(await f.adapters.getCatalog()).find(d=>d.operation==='morning-review')!;
 await expect(f.adapters.remoteDisclosure(m,'fictional-account')).rejects.toThrow(/connection identifier/);f.setInstructions('Use fictional-account');m=(await f.adapters.getCatalog()).find(d=>d.operation==='morning-review')!;await expect(f.adapters.remoteDisclosure(m,'Accounts')).rejects.toThrow(/raw mailbox/);expect(f.ask).not.toHaveBeenCalled();
});

it.each(['morning-review','prepare-recipe'] as const)('enqueues %s before the first microtask after claim admission and preserves the existing key',async operation=>{
  const f=fixture();
  if(operation==='morning-review'){
    f.recipes.push({...f.recipe,id:workflowRecipeId('office-core','inbox-triage')!});
    f.view.workflows[0].readyForRun=true;
  }
  const descriptor=(await f.adapters.getCatalog()).find(d=>d.operation===operation)!;
  const execution={descriptor,requestId:randomUUID(),binding:(await f.adapters.preview(descriptor)).binding};
  await f.adapters.check(descriptor,execution.binding);
  // The domain admitted this claim just before its deadline. Advancing the
  // clock and revoking on the next microtask must happen after durable enqueue.
  let clock=59_999;
  const validUntil=60_000;
  queueMicrotask(()=>{clock=60_001;f.revoke();});
  expect(clock).toBeLessThan(validUntil);
  const flight=f.adapters.dispatch(execution);
  const saved=operation==='morning-review'?f.morning.get(execution.requestId):f.store.getByIdempotencyKey(manualRecipeRequestKey(f.recipe,{requestId:execution.requestId,expectedRevision:1},'prepare'));
  expect(saved).toBeDefined();
  expect(clock).toBeLessThan(validUntil);
  const first=await flight;
  expect(clock).toBeGreaterThan(validUntil);
  await Promise.all(f.runs);
  const existing=await f.adapters.lookup(execution);
  const repeated=await f.adapters.dispatch(execution);
  expect(existing?.id).toBe(first.id);
  expect(repeated.id).toBe(first.id);
  expect(operation==='morning-review'?f.morning.size:f.store.list().length).toBe(1);
  expect(f.ask).not.toHaveBeenCalled();
});
