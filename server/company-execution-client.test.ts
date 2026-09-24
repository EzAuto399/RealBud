/** Real encrypted filesystem vault + simulated authority transport. No database,
 * provider, worker or real company is used by this client-boundary suite. */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrivateVault } from './private-vault.ts';
import { createCompanyExecutionClient } from './company-execution-client.ts';
import { canonicalWebsiteCommand } from '../shared/website-commands.ts';
import { COMPANY_EXECUTION_PURPOSE, type BeginCompanyExecution, type CompanyExecutionGrant, type CompanyExecutionReceipt } from '../shared/company-execution.ts';

const dirs:string[]=[];
afterEach(async()=>{ for(const path of dirs.splice(0)) await rm(path,{recursive:true,force:true}); });
const hash=(v:unknown)=>createHash('sha256').update(canonicalWebsiteCommand(v)).digest('hex');
const digest='a'.repeat(64), memberToken='m'.repeat(43);
const iso=(n:number)=>new Date(n).toISOString();
async function fixture() {
 const directory=await mkdtemp(join(tmpdir(),'rb-execution-client-'));dirs.push(directory);
 const key=randomBytes(32), vault=()=>createPrivateVault(directory,key);
 let now=Date.parse('2026-09-22T12:00:00.000Z');
 const initialIdentity={companyId:randomUUID(),memberId:randomUUID(),workspaceId:randomUUID(),workerBinding:'b'.repeat(64),certificateDigest:digest};
 let identity={...initialIdentity};
 const input={version:1 as const,requestId:randomUUID(),departmentId:randomUUID(),expectedDepartmentRevision:'5',caseId:randomUUID(),expectedCaseFence:'8',recipe:{id:'fictional-recipe',revision:2,digest,instructionDigest:digest},durationMs:3600000};
 const source={caseId:input.caseId,title:'Fictional assigned case',description:'Local company preparation only.'};
 const calls:{path:string;auth:{memberToken:string}|{executionToken:string};body:unknown}[]=[];
 const committed=new Map<string,{body:unknown;result:unknown}>();
 const drops=new Set<string>();
 let grant:CompanyExecutionGrant|undefined, admitted:CompanyExecutionReceipt|undefined, latest:CompanyExecutionReceipt|undefined;
 let transform:((path:string,result:unknown)=>unknown)|undefined;
 let afterForward:((path:string)=>void)|undefined;
 let denied:string|undefined;
 const forward=async(path:string,auth:{memberToken:string}|{executionToken:string},body?:unknown)=>{
  calls.push({path,auth:structuredClone(auth),body:structuredClone(body)});
  if(path==='/api/company/me')return{status:200,body:{company:{id:initialIdentity.companyId},member:{id:initialIdentity.memberId}}};
  if(path===denied)return{status:409,body:{error:'fictional authority denied stale fence'}};
  const b=body as Record<string,unknown>, requestKey=path+':'+String(b.requestId ?? b.executionId);
  let result:unknown;
  if(path.endsWith('/status')) {
   if(!grant)return {status:404,body:{error:'Grant missing'}};
   result=grant;
  } else if(path.endsWith('/check')) {
   if(!latest)throw new Error('Fixture was not admitted');
   result={receipt:latest,source};
  } else if(committed.has(requestKey)) {
   const prior=committed.get(requestKey)!;expect(body).toEqual(prior.body);result=prior.result;
  } else {
   if(path.endsWith('/begin')) {
    const begin=body as BeginCompanyExecution;
    const spec={version:1 as const,purpose:COMPANY_EXECUTION_PURPOSE,companyId:initialIdentity.companyId,memberId:initialIdentity.memberId,authorityId:randomUUID(),certificateDigest:digest,departmentId:begin.departmentId,departmentRevision:begin.expectedDepartmentRevision,caseId:begin.caseId,caseFence:begin.expectedCaseFence,sourceDigest:hash(source),recipe:begin.recipe,executor:begin.executor};
    grant={id:begin.requestId,revision:'0',phase:'pending',current:true,spec,digest:hash(spec),departmentName:'Fictional department',memberName:'Fictional member',source,createdAt:iso(now),expiresAt:iso(now+begin.durationMs),confirmedAt:null,revokedAt:null};result=grant;
   } else if(path.endsWith('/admit')) {
    if(!grant)throw new Error('Fixture grant missing');
    admitted={version:1,grantId:String(b.grantId),receiptId:String(b.requestId),executionId:String(b.executionId),caseId:input.caseId,fence:'9',leaseExpiresAt:iso(now+Number(b.ttlMs)),dispatchBefore:iso(now+Math.min(60000,Number(b.ttlMs)))};
    latest=admitted;result=admitted;
   } else if(path.endsWith('/renew')) {
    if(!admitted)throw new Error('Fixture admission missing');
    latest={...admitted,receiptId:String(b.requestId),leaseExpiresAt:iso(now+Number(b.ttlMs))};result=latest;
   } else if(path.endsWith('/settle')) {
    result={receiptId:b.requestId,caseId:input.caseId,fence:'10',status:'recovery_required',outcome:b.outcome,runId:b.runId};
   } else throw new Error('Unexpected fixture path');
   committed.set(requestKey,{body:structuredClone(body),result:structuredClone(result)});
  }
  afterForward?.(path);
  if(drops.delete(path))throw new Error('Fictional reply lost after host commit');
  return{status:200,body:structuredClone(transform?.(path,result) ?? result)};
 };
 const client=()=>createCompanyExecutionClient({vault:vault(),identity:async()=>({...identity}),forward,now:()=>now});
 const state=()=>vault().read('department-execution-'+input.requestId) as Promise<Record<string,any>>;
 return{directory,key,vault,client,input,source,calls,committed,drops,state,
  setIdentity:(patch:Partial<typeof identity>)=>{identity={...identity,...patch};},
  setTransform:(fn:typeof transform)=>{transform=fn;},setAfterForward:(fn:typeof afterForward)=>{afterForward=fn;},
  updateGrant:(change:(g:CompanyExecutionGrant)=>CompanyExecutionGrant)=>{if(!grant)throw Error('Missing fixture grant');grant=change(structuredClone(grant));},
  deny:(path:string)=>{denied=path;},advance:(ms:number)=>{now+=ms;},now:()=>now,
  initialize:async()=>{const c=client();await c.begin(memberToken,input);const executionId=randomUUID();await c.admit(input.requestId,executionId);return{client:c,executionId};},
 };
}

describe('company execution client with encrypted vault and simulated host',()=>{
 it('recovers a lost begin through scoped status without a member session or a second begin',async()=>{
  const f=await fixture();f.drops.add('/api/company/execution-grants/begin');
  await expect(f.client().begin(memberToken,f.input)).rejects.toThrow('reply lost');
  const intent=await f.state();expect(intent.grant).toBeUndefined();
  const grant=await f.client().status(f.input.requestId);expect(grant.phase).toBe('pending');
  expect(f.calls.filter(c=>c.path.endsWith('/begin'))).toHaveLength(1);
  expect(f.calls.at(-1)).toEqual({path:'/api/company/execution/status',auth:{executionToken:intent.begin.grantSecret},body:{version:1,grantId:f.input.requestId}});
  expect((await f.state()).grant).toEqual(grant);
 });
 it('persists pending, active and revoked status without changing immutable source or granting execution',async()=>{
  const f=await fixture(),client=f.client(),pending=await client.begin(memberToken,f.input);
  expect(await client.status(pending.id)).toEqual(pending);
  f.updateGrant(g=>({...g,phase:'active',revision:'1',confirmedAt:g.createdAt}));
  expect(await client.status(pending.id)).toMatchObject({phase:'active',revision:'1',current:true});
  f.updateGrant(g=>({...g,phase:'revoked',revision:'2',revokedAt:g.createdAt,current:false}));
  const revoked=await client.status(pending.id);expect(revoked).toMatchObject({phase:'revoked',current:false});
  expect(revoked.source).toEqual(pending.source);expect((await client.local(pending.id)).grant).toEqual(revoked);
  await expect(client.beforeDispatch(pending.id)).rejects.toThrow();
 });
 it('rejects changed immutable grants and rollback status while preserving the last accepted status',async()=>{
  const f=await fixture(),client=f.client(),pending=await client.begin(memberToken,f.input);
  f.updateGrant(g=>({...g,phase:'active',revision:'1',confirmedAt:g.createdAt}));
  const active=await client.status(pending.id);
  for(const change of [
   (g:CompanyExecutionGrant)=>({...g,spec:{...g.spec,authorityId:randomUUID()}}),
   (g:CompanyExecutionGrant)=>{const source={...g.source,description:'Substituted source'};return {...g,source,spec:{...g.spec,sourceDigest:hash(source)}};},
   (g:CompanyExecutionGrant)=>({...g,createdAt:iso(Date.parse(g.createdAt)-1000),expiresAt:iso(Date.parse(g.expiresAt)-1000)}),
   ()=>pending,
  ]){
   f.setTransform((path,result)=>{if(!path.endsWith('/status'))return result;const next=change(result as CompanyExecutionGrant);return {...next,digest:hash(next.spec)};});
   await expect(client.status(pending.id)).rejects.toMatchObject({code:'department_execution_held'});
   expect((await client.local(pending.id)).grant).toEqual(active);
  }
 });
 it('rejects status returned after an installation change and keeps historical local observations readable',async()=>{
  const f=await fixture(),client=f.client(),pending=await client.begin(memberToken,f.input);
  f.setAfterForward(path=>{if(path.endsWith('/status'))f.setIdentity({workspaceId:randomUUID()});});
  await expect(client.status(pending.id)).rejects.toMatchObject({code:'department_execution_held'});
  const count=f.calls.length;await expect(client.status(pending.id)).rejects.toThrow();expect(f.calls).toHaveLength(count);
  expect((await client.local(pending.id)).grant).toEqual(pending);expect(f.calls).toHaveLength(count);
 });
 it('returns only redacted admission and settlement recovery metadata without live authority',async()=>{
  const f=await fixture(),{client,executionId}=await f.initialize();
  const result={requestId:randomUUID(),runId:'fictional-local-run',outcome:'prepared' as const,note:'Prepared for human review'};
  f.drops.add('/api/company/execution/settle');await expect(client.settle(f.input.requestId,result)).rejects.toThrow('reply lost');
  const count=f.calls.length,saved=await f.state(),local=await client.local(f.input.requestId);
  expect(local).toEqual({grant:saved.grant,admission:{executionId,receipt:saved.admission.receipt},settlement:{input:result}});
  for(const secret of [memberToken,saved.begin.grantSecret,saved.admission.input.claimSecret])expect(JSON.stringify(local)).not.toContain(secret);
  expect(f.calls).toHaveLength(count);expect(await client.local(randomUUID())).toEqual({});
  await client.settle(f.input.requestId,result);expect((await client.local(f.input.requestId)).settlement?.receipt).toBeDefined();
 });
 it('retries lost begin, admission, renewal and settlement exactly across cold clients',async()=>{
  const f=await fixture();
  f.drops.add('/api/company/execution-grants/begin');
  await expect(f.client().begin(memberToken,f.input)).rejects.toThrow('reply lost');
  const first=await f.state();expect(first.grant).toBeUndefined();
  await f.client().begin(memberToken,f.input);
  const executionId=randomUUID();f.drops.add('/api/company/execution/admit');
  await expect(f.client().admit(f.input.requestId,executionId)).rejects.toThrow('reply lost');
  const admission=await f.client().admit(f.input.requestId,executionId);
  const renewalId=randomUUID();f.advance(1000);f.drops.add('/api/company/execution/renew');
  await expect(f.client().renew(f.input.requestId,renewalId)).rejects.toThrow('reply lost');
  const renewed=await f.client().renew(f.input.requestId,renewalId);
  expect(renewed.dispatchBefore).toBe(admission.dispatchBefore);
  const result={requestId:randomUUID(),runId:'fictional-run-1',outcome:'prepared' as const,note:'Draft prepared locally; no external action.'};
  f.drops.add('/api/company/execution/settle');await expect(f.client().settle(f.input.requestId,result)).rejects.toThrow('reply lost');
  const settled=await f.client().settle(f.input.requestId,result);expect(settled.status).toBe('recovery_required');
  for(const path of ['/api/company/execution-grants/begin','/api/company/execution/admit','/api/company/execution/renew','/api/company/execution/settle']) {
   const requests=f.calls.filter(c=>c.path===path);expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0]);
  }
  expect(f.committed.size).toBe(4);
  const saved=await f.state();expect(JSON.stringify(saved)).not.toContain(memberToken);
  const raw=await readFile(join(f.directory,'company-installation/private/department-execution-'+f.input.requestId+'.json'),'utf8');
  expect(raw).not.toContain(saved.begin.grantSecret);expect(raw).not.toContain(saved.admission.input.claimSecret);expect(raw).not.toContain(f.source.description);
 });

 it('rejects corrupted encrypted files and malformed authenticated state without a network retry',async()=>{
  const f=await fixture();await f.initialize();
  const file=join(f.directory,'company-installation/private/department-execution-'+f.input.requestId+'.json');
  const original=await readFile(file,'utf8');await writeFile(file,'{"corrupted":true}',{mode:0o600});
  const before=f.calls.length;await expect(f.client().check(f.input.requestId)).rejects.toThrow();expect(f.calls).toHaveLength(before);
  await writeFile(file,original,{mode:0o600});const saved=await f.state();saved.identity.memberToken=memberToken;
  await f.vault().write('department-execution-'+f.input.requestId,saved);
  await expect(f.client().check(f.input.requestId)).rejects.toThrow();expect(f.calls).toHaveLength(before);
 });

 it('rejects forged successful grant/source/receipt bindings while preserving exact intent',async()=>{
  const f=await fixture();f.setTransform((path,result)=>path.endsWith('/begin')?{...(result as object),digest:'c'.repeat(64)}:result);
  await expect(f.client().begin(memberToken,f.input)).rejects.toMatchObject({code:'department_execution_held'});
  expect((await f.state()).grant).toBeUndefined();f.setTransform(undefined);await f.client().begin(memberToken,f.input);
  f.setTransform((path,result)=>path.endsWith('/admit')?{...(result as object),caseId:randomUUID()}:result);
  const executionId=randomUUID();await expect(f.client().admit(f.input.requestId,executionId)).rejects.toMatchObject({code:'department_execution_held'});
  expect((await f.state()).admission.receipt).toBeUndefined();f.setTransform(undefined);await f.client().admit(f.input.requestId,executionId);
  f.setTransform((path,result)=>path.endsWith('/check')?{...(result as object),source:{...f.source,description:'Different company case material'}}:result);
  await expect(f.client().beforeDispatch(f.input.requestId)).rejects.toMatchObject({code:'department_execution_held'});
 });

 it('does not adopt authority returned after the seat or host changed during the request',async()=>{
  const f=await fixture();await f.client().begin(memberToken,f.input);
  f.setAfterForward(path=>{if(path.endsWith('/admit'))f.setIdentity({certificateDigest:'d'.repeat(64)});});
  await expect(f.client().admit(f.input.requestId,randomUUID())).rejects.toMatchObject({code:'department_execution_held'});
  const saved=await f.state();expect(saved.admission.input).toBeDefined();expect(saved.admission.receipt).toBeUndefined();
  const count=f.calls.length;await expect(f.client().check(f.input.requestId)).rejects.toThrow();expect(f.calls).toHaveLength(count);
 });

 it('keeps dispatch expiry immutable through renewal and rejects dispatch at its exact deadline',async()=>{
  const f=await fixture();await f.initialize();const first=(await f.state()).admission.receipt;
  f.advance(30000);await f.client().renew(f.input.requestId,randomUUID());
  await expect(f.client().beforeDispatch(f.input.requestId)).resolves.toMatchObject({receipt:{dispatchBefore:first.dispatchBefore}});
  f.setTransform((path,result)=>path.endsWith('/renew')?{...(result as object),dispatchBefore:iso(f.now()+60000)}:result);
  await expect(f.client().renew(f.input.requestId,randomUUID())).rejects.toMatchObject({code:'department_execution_held'});
  f.setTransform(undefined);f.advance(30000);
  await expect(f.client().beforeDispatch(f.input.requestId)).rejects.toMatchObject({code:'department_execution_held'});
 });

 it('recognizes a pending renewal receipt after reply loss but rejects an unknown receipt operation',async()=>{
  const f=await fixture();await f.initialize();const renewalId=randomUUID();f.advance(1000);
  f.drops.add('/api/company/execution/renew');
  await expect(f.client().renew(f.input.requestId,renewalId)).rejects.toThrow('reply lost');
  await expect(f.client().check(f.input.requestId)).resolves.toMatchObject({receipt:{receiptId:renewalId}});
  f.setTransform((path,result)=>path.endsWith('/check')?{...(result as {receipt:CompanyExecutionReceipt}),receipt:{...(result as {receipt:CompanyExecutionReceipt}).receipt,receiptId:randomUUID()}}:result);
  await expect(f.client().check(f.input.requestId)).rejects.toMatchObject({code:'department_execution_held'});
 });

 it('retains a denied factual settlement and never replaces it or starts again',async()=>{
  const f=await fixture();await f.initialize();f.deny('/api/company/execution/settle');
  const result={requestId:randomUUID(),runId:'fictional-run-2',outcome:'failed' as const,note:'The local preparation failed after creating a draft.'};
  await expect(f.client().settle(f.input.requestId,result)).rejects.toMatchObject({status:409});
  expect((await f.state()).settlement.input).toMatchObject(result);
  const count=f.calls.length;
  await expect(f.client().settle(f.input.requestId,{...result,outcome:'prepared'})).rejects.toThrow();
  await expect(f.client().beforeDispatch(f.input.requestId)).rejects.toThrow();
  await expect(f.client().admit(f.input.requestId,randomUUID())).rejects.toThrow();expect(f.calls).toHaveLength(count);
  await expect(f.client().settle(f.input.requestId,result)).rejects.toMatchObject({status:409});
  const requests=f.calls.filter(c=>c.path.endsWith('/settle'));expect(requests).toHaveLength(2);expect(requests[1]).toEqual(requests[0]);
 });
});
