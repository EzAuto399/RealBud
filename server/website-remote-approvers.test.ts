import { mkdtempSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createWebsiteRequests } from './website-requests.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { removeFixture } from './testing/private-fixture.ts';
import type { RemoteCommandGrant, RemoteEnrollmentSnapshot } from '../shared/website-remote-approvers.ts';
const closes:(()=>void|Promise<void>)[]=[];
afterEach(async()=>{for(const close of closes.splice(0).reverse())await close();});
function fixture(){
 const directory=mkdtempSync(join(tmpdir(),'realbud-remote-enrollment-')),db=new WorkflowDatabase({dir:directory,key:Buffer.alloc(32,4)});
 let time=Date.parse('2026-09-22T06:00:00.000Z'),clockOffset=0,authority='a'.repeat(64),epoch=1;
 const identity={workspaceId:randomUUID(),workerProfileKey:'worker-a'};
 let link={installationId:randomUUID(),companyId:'agency-a',token:'b'.repeat(64),agencyLabel:'Agency A'};
 let descriptors=[{id:randomUUID(),operation:'morning-review' as const,revision:'c'.repeat(64),label:'Morning work'}];
 const scopes=[{descriptorId:descriptors[0]!.id,descriptorRevision:descriptors[0]!.revision,disclosureDigest:'d'.repeat(64)}];
 const person={subject:randomUUID(),identityEpoch:1,email:'reader@agency.test',agencyLabel:'Agency A',companyId:'agency-a'};
 let parent:RemoteCommandGrant|null=null,v1grant:any=null,failRoute='',failBeforeRoute='',pauseRoute='',release:(()=>void)|null=null,mutate:((route:string,body:any)=>void)|null=null;
 const rows=new Map<string,RemoteEnrollmentSnapshot>(),calls:{route:string;body:any;method:string}[]=[];
 const fetcher=vi.fn(async(url:any,init:any)=>{
  const route=String(url).split('/api/installations/')[1]!,body=JSON.parse(init.body),method=init.method;calls.push({route,body,method});
  let result:any;
  if(failBeforeRoute===route){failBeforeRoute='';throw Error('Network unavailable before publication');}
  if(route==='command-grants'){
   if(method==='DELETE'){v1grant.revokedAt=new Date(time).toISOString();result={ok:true};}
   else{const {commandToken:_secret,...spec}=body;v1grant={...spec,companyId:link.companyId,enrolledAt:new Date(time).toISOString(),revokedAt:null};result=v1grant;}
  }else if(route==='v2/command-grants/cancel'){
   const {commandToken:_secret,...spec}=body;parent??={...spec,companyId:link.companyId,enrolledAt:new Date(time).toISOString(),revokedAt:null};parent={...parent!,revokedAt:new Date(time).toISOString()};result=parent;
  }else if(route==='v2/command-grants'){
   if(method==='DELETE'){if(!parent)return Response.json({error:'notfound'},{status:401});parent={...parent!,revokedAt:new Date(time).toISOString()};result=parent;}
   else {const {commandToken:_secret,...spec}=body;if(!parent||parent.revokedAt)parent={...spec,companyId:link.companyId,enrolledAt:new Date(time).toISOString(),revokedAt:null};result=parent;}
  }else if(route==='v2/remote-approvers/clock'){result={serverTime:new Date(time-clockOffset).toISOString()};
  }else{
   let row=rows.get(body.enrollmentId);
   if(route.endsWith('/begin')){row??={protocol:2,begin:body,target:{workspaceLabel:parent!.workspaceLabel,descriptors:parent!.descriptors},candidate:null,phase:'pending',approver:null,serverTime:new Date(time).toISOString()};rows.set(body.enrollmentId,row);}
   if(!row)throw Error('missing fixture enrollment');
   if(route.endsWith('/confirm')){row={...row,candidate:body.candidate,phase:'confirmed',approver:{protocol:2,id:row.begin.enrollmentId,generation:1,parentGrantId:parent!.grantId,parentGeneration:parent!.generation,installationId:parent!.installationId,workspaceId:parent!.workspaceId,workerBinding:parent!.workerBinding,companyId:parent!.companyId,person:body.candidate,scopes:row.begin.scopes,disclosurePolicy:row.begin.disclosurePolicy,enrolledAt:new Date(time).toISOString(),expiresAt:row.begin.approverExpiresAt,revokedAt:null}};rows.set(body.enrollmentId,row);}
   if(route.endsWith('/revoke')){row={...row,phase:'revoked',approver:row.approver?{...row.approver,revokedAt:new Date(time).toISOString()}:null};rows.set(body.enrollmentId,row);}
   result=row;
  }
  mutate?.(route,result);
  if(pauseRoute===route){pauseRoute='';await new Promise<void>(resolve=>{release=resolve;});}
  if(failRoute===route){failRoute='';throw Error('lost response');}
  return Response.json(result);
 }) as unknown as typeof fetch;
 const requireRemoteScopes=vi.fn(async()=>{}),dispatch=vi.fn(async()=>{throw Error('must never dispatch');}),preview=vi.fn(async()=>{throw Error('must never read sources');});
 const options={directory,db,officeLink:{credentials:async()=>link},identity:()=>identity,authority:()=>authority,revisionEpoch:()=>epoch,getCatalog:async()=>descriptors,requireRemoteScopes,preview,check:async()=>{},dispatch,lookup:async()=>null,cancel:async()=>{},fetch:fetcher,now:()=>time};
 let service=createWebsiteRequests(options);
 closes.push(()=>{service.stop();db.close();return removeFixture(directory);});
 const prepare=()=>service.remote.prepare({descriptorIds:descriptors.map(d=>d.id),label:'My workspace',scopes});
 const begin=()=>service.remote.begin({scopes});
 async function candidate(id:string){const row=rows.get(id)!;rows.set(id,{...row,candidate:person,phase:'candidate'});await service.remote.sync(id);return (await service.remote.status()).enrollments.find(e=>e.id===id)!;}
 return {directory,scopes,person,rows,calls,dispatch,preview,requireRemoteScopes,prepare,begin,candidate,get service(){return service;},restart(){service.stop();service=createWebsiteRequests(options);},setFail(route:string){failRoute=route;},setFailBefore(route:string){failBeforeRoute=route;},pause(route:string){pauseRoute=route;},release(){release?.();release=null;},get paused(){return !!release;},changeWorker(){authority='e'.repeat(64);epoch++;},changeMember(){identity.workerProfileKey='worker-b';epoch++;},changeWorkspace(){identity.workspaceId=randomUUID();epoch++;},changeLink(){link={...link,installationId:randomUUID()};epoch++;},changeCatalog(){descriptors=descriptors.map(d=>({...d,revision:'f'.repeat(64)}));epoch++;},advance(ms:number){time+=ms;},clockOffset(ms:number){clockOffset=ms;},mutate(fn:typeof mutate){mutate=fn;}};
}
const marker=(f:ReturnType<typeof fixture>)=>JSON.parse(readFileSync(join(f.directory,'website-requests/grant.json'),'utf8'));
const state=(f:ReturnType<typeof fixture>)=>JSON.parse(readFileSync(join(f.directory,'website-requests/remote-approvers.json'),'utf8'));
it('persists the protocol 2 downgrade marker before publication, then enrolls and confirms without sources',async()=>{
 const f=fixture();f.mutate((route)=>{if(route==='v2/command-grants')expect(marker(f).version).toBe(2);});
 await f.prepare();const started=await f.begin();const candidate=await f.candidate(started.challenge.enrollmentId);
 const result=await f.service.remote.confirm({enrollmentId:candidate.id,expectedRevision:candidate.revision,candidateDigest:candidate.candidateDigest!});
 expect(result.enrollments[0]!.phase).toBe('confirmed');expect(f.requireRemoteScopes).toHaveBeenCalled();expect(f.preview).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();
 const publicText=JSON.stringify(await f.service.remote.status());expect(publicText).not.toContain(started.challenge.secret);expect(publicText).not.toContain(state(f).parent.commandToken);expect(publicText).not.toContain('worker-a');expect(publicText).not.toContain('a'.repeat(64));
 await expect(f.service.enroll({descriptorIds:[f.scopes[0]!.descriptorId],label:'Legacy'})).rejects.toThrow(/protocol 2/);
 expect((await f.service.status()).remoteMode).toBe(true);
});
it.each(['v2/command-grants','v2/remote-approvers/begin','v2/remote-approvers/confirm'])('restarts and retries exact immutable %s after a lost reply',async route=>{
 const f=fixture();if(route==='v2/command-grants'){f.setFail(route);await expect(f.prepare()).rejects.toThrow();f.restart();await f.prepare();}
 else {await f.prepare();if(route.endsWith('/begin')){f.setFail(route);await expect(f.begin()).rejects.toThrow();f.restart();await f.begin();}
 else {const begun=await f.begin(),c=await f.candidate(begun.challenge.enrollmentId);f.setFail(route);await expect(f.service.remote.confirm({enrollmentId:c.id,expectedRevision:c.revision,candidateDigest:c.candidateDigest!})).rejects.toThrow();f.restart();await f.service.remote.sync(c.id);}}
 const bodies=f.calls.filter(c=>c.route===route&&c.method==='POST').map(c=>c.body);expect(bodies[0]).toEqual(bodies[1]);expect(f.dispatch).not.toHaveBeenCalled();
});
it('begin retry after saved receipt returns the original challenge instead of creating another person',async()=>{
 const f=fixture();await f.prepare();const a=await f.begin();f.restart();const b=await f.begin();expect(a.challenge).toEqual(b.challenge);expect(f.rows.size).toBe(1);
});
it.each(['changeWorker','changeLink','changeCatalog'] as const)('holds %s during publication and refuses stale confirmation',async change=>{
 const f=fixture();await f.prepare();f.mutate(route=>{if(route.endsWith('/begin'))f[change]();});await expect(f.begin()).rejects.toThrow(/changed|inactive/);
 expect(state(f).enrollments[0].snapshot).toBeNull();f.restart();if(change==='changeLink')await expect(f.service.remote.sync()).rejects.toThrow(/changed|inactive/);else{const held=await f.service.remote.sync();expect(held.enabled).toBe(false);expect(state(f).enrollments[0].snapshot).toBeNull();}expect(f.dispatch).not.toHaveBeenCalled();
});
it('rejects cross-workspace approver receipts and stale local review revisions',async()=>{
 const f=fixture();await f.prepare();const a=await f.begin(),c=await f.candidate(a.challenge.enrollmentId);
 await expect(f.service.remote.confirm({enrollmentId:c.id,expectedRevision:c.revision-1,candidateDigest:c.candidateDigest!})).rejects.toThrow(/changed/);
 f.mutate((route,result)=>{if(route.endsWith('/confirm'))result.approver.workspaceId=randomUUID();});
 await expect(f.service.remote.confirm({enrollmentId:c.id,expectedRevision:c.revision,candidateDigest:c.candidateDigest!})).rejects.toThrow();expect(state(f).enrollments[0].snapshot.phase).toBe('candidate');
});
it('local disable during an awaited publication prevents activation and drains through shared coordinator',async()=>{
 const f=fixture();await f.prepare();f.pause('v2/remote-approvers/begin');const begun=f.begin();await vi.waitFor(()=>expect(f.paused).toBe(true),{timeout:30_000});
 const disabled=f.service.remote.disable();f.release();await expect(begun).rejects.toThrow(/changed/);await disabled;
 expect(state(f).enabled).toBe(false);expect(state(f).revoked).toBe(true);expect(marker(f).version).toBe(2);
});
it('persists local revocation offline and retries after restart without reviving grant',async()=>{
 const f=fixture();await f.prepare();await f.begin();f.setFail('v2/command-grants');await expect(f.service.remote.disable()).rejects.toThrow();expect(state(f).enabled).toBe(false);expect(marker(f).version).toBe(2);
 f.restart();await f.service.remote.sync();expect(state(f).revoked).toBe(true);await expect(f.service.enroll({descriptorIds:[f.scopes[0]!.descriptorId],label:'Legacy'})).rejects.toThrow(/protocol 2/);
});
it('holds legacy enrollment if authority state exists without its marker; exact repair permits only v2',async()=>{
 const f=fixture();f.setFail('v2/command-grants');await expect(f.prepare()).rejects.toThrow();unlinkSync(join(f.directory,'website-requests/grant.json'));
 f.restart();await expect(f.service.enroll({descriptorIds:[f.scopes[0]!.descriptorId],label:'Legacy'})).rejects.toThrow(/protocol 2/);await f.service.remote.sync();expect(marker(f).version).toBe(2);
});
it('requires explicit v1 disable and advances generation while preserving permanent protocol floor',async()=>{
 const f=fixture();await f.service.enroll({descriptorIds:[f.scopes[0]!.descriptorId],label:'Legacy'});await expect(f.prepare()).rejects.toThrow(/Disable/);await f.service.disable();await f.prepare();expect(marker(f).generation).toBe(2);
 await f.service.remote.disable();await f.prepare();expect(marker(f).generation).toBe(3);
});
it('rejects tampered state, foreign disclosure scopes and expired candidate confirmation',async()=>{
 const f=fixture();await f.prepare();await expect(f.service.remote.begin({scopes:[{...f.scopes[0]!,disclosureDigest:'f'.repeat(64)}]})).rejects.toThrow(/not been reviewed/);
 const a=await f.begin(),c=await f.candidate(a.challenge.enrollmentId);f.advance(10*60_000);await expect(f.service.remote.confirm({enrollmentId:c.id,expectedRevision:c.revision,candidateDigest:c.candidateDigest!})).rejects.toThrow(/expired/);
 const s=state(f);s.enrollments[0].secret='f'.repeat(64);writeFileSync(join(f.directory,'website-requests/remote-approvers.json'),JSON.stringify(s));await expect(f.service.remote.status()).rejects.toThrow(/recovery/);
});
it('keeps confirmed enrollment history after replacement and uses status instead of reconfirming',async()=>{
 const f=fixture();await f.prepare();const a=await f.begin(),c=await f.candidate(a.challenge.enrollmentId);await f.service.remote.confirm({enrollmentId:c.id,expectedRevision:c.revision,candidateDigest:c.candidateDigest!});
 await f.service.remote.sync(c.id);expect(f.calls.at(-1)!.route).toBe('v2/remote-approvers/status');await f.service.remote.disable();await f.prepare();
 const status=await f.service.remote.status();expect(status.enrollments.find(e=>e.id===c.id)?.phase).toBe('revoked');expect(JSON.stringify(status)).not.toContain(a.challenge.secret);
});
it.each(['v2/command-grants','v2/remote-approvers/confirm'])('local disable fences an awaited %s and preserves local-first revoke',async route=>{
 const f=fixture();let waiting:Promise<unknown>;
 if(route==='v2/command-grants'){f.pause(route);waiting=f.prepare();}
 else {await f.prepare();const a=await f.begin(),c=await f.candidate(a.challenge.enrollmentId);f.pause(route);waiting=f.service.remote.confirm({enrollmentId:c.id,expectedRevision:c.revision,candidateDigest:c.candidateDigest!});}
 await vi.waitFor(()=>expect(f.paused).toBe(true),{timeout:30_000});const disabling=f.service.remote.disable();f.release();await expect(waiting).rejects.toThrow(/changed/);await disabling;expect(state(f).enabled).toBe(false);expect(f.dispatch).not.toHaveBeenCalled();
});
it('a missing authority file under a permanent marker holds rather than permitting silent reset',async()=>{
 const f=fixture();await f.prepare();unlinkSync(join(f.directory,'website-requests/remote-approvers.json'));f.restart();await expect(f.service.remote.status()).rejects.toThrow(/recovery/);await expect(f.prepare()).rejects.toThrow(/recovery/);expect(marker(f).version).toBe(2);
});
it('authoritative disclosure withdrawal prevents publication even with correct renderer supplied digests',async()=>{
 const f=fixture();await f.prepare();f.requireRemoteScopes.mockRejectedValue(new Error('Reviewed disclosure changed'));await expect(f.begin()).rejects.toThrow(/disclosure changed/);expect(f.calls.filter(c=>c.route.endsWith('/begin'))).toHaveLength(0);
});
it('checks workspace label and descriptor names in candidate receipts rather than trusting a valid digest alone',async()=>{
 const f=fixture();await f.prepare();f.mutate((route,result)=>{if(route.endsWith('/begin'))result.target.workspaceLabel='Another workspace';});await expect(f.begin()).rejects.toThrow(/another enrollment/);expect(state(f).enrollments[0].snapshot).toBeNull();
});
it.each(['revoked','expired','stale'] as const)('persists an authoritative %s confirmation receipt and retires retry after restart',async phase=>{
 const f=fixture();await f.prepare();const a=await f.begin(),c=await f.candidate(a.challenge.enrollmentId);
 f.mutate((route,result)=>{if(route.endsWith('/confirm')){result.phase=phase;if(phase==='revoked')result.approver.revokedAt=result.serverTime;}});
 const result=await f.service.remote.confirm({enrollmentId:c.id,expectedRevision:c.revision,candidateDigest:c.candidateDigest!});
 expect(result.enrollments[0]!.phase).toBe(phase);expect(state(f).enrollments[0].snapshot.phase).toBe(phase);
 // The attended candidate binding remains historical evidence, never a live retry.
 expect(state(f).enrollments[0].confirmation.candidate).toEqual(f.person);
 const confirms=f.calls.filter(c=>c.route.endsWith('/confirm')).length;
 f.restart();await f.service.remote.sync(c.id);expect((await f.service.remote.status()).enrollments[0]!.phase).toBe(phase);
 expect(f.calls.filter(c=>c.route.endsWith('/confirm'))).toHaveLength(confirms);
 const current=(await f.service.remote.status()).enrollments[0]!;
 await expect(f.service.remote.confirm({enrollmentId:c.id,expectedRevision:current.revision,candidateDigest:current.candidateDigest!})).rejects.toThrow(/changed|expired/);
 expect(f.dispatch).not.toHaveBeenCalled();
});
it('inactive candidate-only receipt also retires an uncommitted confirmation without manufacturing a grant',async()=>{
 const f=fixture();await f.prepare();const a=await f.begin(),c=await f.candidate(a.challenge.enrollmentId);
 f.mutate((route,result)=>{if(route.endsWith('/confirm')){result.phase='stale';result.approver=null;}});
 const result=await f.service.remote.confirm({enrollmentId:c.id,expectedRevision:c.revision,candidateDigest:c.candidateDigest!});
 expect(result.enrollments[0]!.phase).toBe('stale');expect(result.enrollments[0]!.approver).toBeNull();
 f.restart();await f.service.remote.sync(c.id);expect(f.calls.filter(c=>c.route.endsWith('/confirm'))).toHaveLength(1);
});

it('derives fixed challenge times from authenticated server clock when local time runs five seconds fast',async()=>{
 const f=fixture();await f.prepare();f.clockOffset(5000);const a=await f.begin();
 const begin=f.calls.find(c=>c.route.endsWith('/begin'))!.body;
 expect(begin.expiresAt).toBe('2026-09-22T06:09:55.000Z');expect(begin.approverExpiresAt).toBe('2026-10-22T05:59:55.000Z');
 const clocks=f.calls.filter(c=>c.route.endsWith('/clock')).length;f.advance(1000);f.restart();const retry=await f.begin();expect(retry.challenge).toEqual(a.challenge);expect(f.calls.filter(c=>c.route.endsWith('/clock'))).toHaveLength(clocks);
});
it('holds a two minute local clock discrepancy before creating or publishing a challenge',async()=>{
 const f=fixture();await f.prepare();f.clockOffset(120000);await expect(f.begin()).rejects.toThrow(/date and time/);expect(state(f).enrollments).toHaveLength(0);expect(f.calls.filter(c=>c.route.endsWith('/begin'))).toHaveLength(0);
});
it('a lost begin response retains the original server timestamps without renewing the clock',async()=>{
 const f=fixture();await f.prepare();f.clockOffset(5000);f.setFail('v2/remote-approvers/begin');await expect(f.begin()).rejects.toThrow();const original=state(f).enrollments[0].begin;
 f.advance(2000);f.restart();await f.begin();expect(state(f).enrollments[0].begin).toEqual(original);expect(f.calls.filter(c=>c.route.endsWith('/clock'))).toHaveLength(1);
});

it.each(['before-publication','lost-publication-receipt'] as const)('cancels exact ambiguous parent %s into a tombstone and permits a new generation',async boundary=>{
 const f=fixture();if(boundary==='before-publication')f.setFailBefore('v2/command-grants');else f.setFail('v2/command-grants');
 await expect(f.prepare()).rejects.toThrow();const original=state(f).parent;expect(state(f).grant).toBeNull();f.restart();await f.service.remote.disable();
 expect(state(f).revoked).toBe(true);expect(state(f).grant.revokedAt).not.toBeNull();expect(marker(f).version).toBe(2);
 expect(f.calls.find(c=>c.route==='v2/command-grants/cancel')!.body).toEqual(original);
 await f.prepare();expect(state(f).parent.generation).toBe(original.generation+1);expect(state(f).parent.grantId).not.toBe(original.grantId);
});
it('pending parent cancellation survives a lost tombstone receipt and never requests current disclosure approval',async()=>{
 const f=fixture();f.setFailBefore('v2/command-grants');await expect(f.prepare()).rejects.toThrow();const parent=state(f).parent;
 f.requireRemoteScopes.mockRejectedValue(new Error('Changed disclosure'));f.setFail('v2/command-grants/cancel');await expect(f.service.remote.disable()).rejects.toThrow();expect(state(f).enabled).toBe(false);
 f.restart();await f.service.remote.sync();expect(state(f).revoked).toBe(true);expect(f.calls.filter(c=>c.route==='v2/command-grants/cancel').map(c=>c.body)).toEqual([parent,parent]);
});
it('pending parent cancellation holds a changed installation report identity without erasing the marker',async()=>{
 const f=fixture();f.setFailBefore('v2/command-grants');await expect(f.prepare()).rejects.toThrow();f.changeLink();
 await expect(f.service.remote.disable()).rejects.toThrow(/original computer link/);expect(state(f).enabled).toBe(false);expect(state(f).revoked).toBe(false);expect(marker(f).version).toBe(2);expect(f.calls.filter(c=>c.route==='v2/command-grants/cancel')).toHaveLength(0);
});
it.each(['changeWorker','changeCatalog'] as const)('reconciles portal revocation under %s readiness hold after restart',async change=>{
 const f=fixture();await f.prepare();const a=await f.begin(),c=await f.candidate(a.challenge.enrollmentId);await f.service.remote.confirm({enrollmentId:c.id,expectedRevision:c.revision,candidateDigest:c.candidateDigest!});
 const row=f.rows.get(c.id)!;f.rows.set(c.id,{...row,phase:'revoked',approver:{...row.approver!,revokedAt:row.serverTime}});f[change]();f.restart();
 const result=await f.service.remote.sync(c.id);expect(result.enabled).toBe(false);expect(result.enrollments[0]!.phase).toBe('revoked');expect(state(f).enrollments[0].snapshot.phase).toBe('revoked');expect(f.calls.at(-1)!.route).toBe('v2/remote-approvers/status');
 expect(f.preview).not.toHaveBeenCalled();expect(f.dispatch).not.toHaveBeenCalled();expect(result.error).toMatch(/sources and settings/);
});
it('pending confirmation under a disclosure readiness hold only reads status and retains an inactive receipt',async()=>{
 const f=fixture();await f.prepare();const a=await f.begin(),c=await f.candidate(a.challenge.enrollmentId);f.setFail('v2/remote-approvers/confirm');await expect(f.service.remote.confirm({enrollmentId:c.id,expectedRevision:c.revision,candidateDigest:c.candidateDigest!})).rejects.toThrow();
 const row=f.rows.get(c.id)!;f.rows.set(c.id,{...row,phase:'stale'});f.requireRemoteScopes.mockRejectedValue(new Error('Connection must be checked'));f.restart();
 await f.service.remote.sync(c.id);expect(f.calls.filter(c=>c.route.endsWith('/confirm'))).toHaveLength(1);expect((await f.service.remote.status()).enrollments[0]!.phase).toBe('stale');expect(state(f).enrollments[0].snapshot.phase).toBe('stale');
});
it('read-only status cannot adopt an active receipt while disclosure is unverified',async()=>{
 const f=fixture();await f.prepare();const a=await f.begin(),c=await f.candidate(a.challenge.enrollmentId);f.setFail('v2/remote-approvers/confirm');await expect(f.service.remote.confirm({enrollmentId:c.id,expectedRevision:c.revision,candidateDigest:c.candidateDigest!})).rejects.toThrow();f.requireRemoteScopes.mockRejectedValue(new Error('Connection must be checked'));f.restart();
 await f.service.remote.sync(c.id);expect(state(f).enrollments[0].snapshot.phase).toBe('candidate');expect((await f.service.remote.status()).enrollments[0]!.phase).toBe('stale');expect(f.calls.filter(c=>c.route.endsWith('/confirm'))).toHaveLength(1);expect(f.dispatch).not.toHaveBeenCalled();
});
it('read-only reconciliation refuses a changed website installation',async()=>{
 const f=fixture();await f.prepare();const a=await f.begin(),c=await f.candidate(a.challenge.enrollmentId);await f.service.remote.confirm({enrollmentId:c.id,expectedRevision:c.revision,candidateDigest:c.candidateDigest!});const before=f.calls.length;f.changeLink();f.restart();
 await expect(f.service.remote.sync(c.id)).rejects.toThrow(/matching computer link/);expect(f.calls).toHaveLength(before);
});
it('local disable fences an awaited status response before it can overwrite enrollment',async()=>{
 const f=fixture();await f.prepare();const a=await f.begin(),c=await f.candidate(a.challenge.enrollmentId);await f.service.remote.confirm({enrollmentId:c.id,expectedRevision:c.revision,candidateDigest:c.candidateDigest!});f.pause('v2/remote-approvers/status');const syncing=f.service.remote.sync(c.id);await vi.waitFor(()=>expect(f.paused).toBe(true),{timeout:30_000});const disabling=f.service.remote.disable();f.release();await expect(syncing).rejects.toThrow(/changed/);await disabling;expect(state(f).enabled).toBe(false);
});

it.each(['changeMember','changeWorkspace'] as const)('read-only reconciliation denies %s before requesting another private workspace enrollment',async change=>{
 const f=fixture();await f.prepare();const a=await f.begin(),c=await f.candidate(a.challenge.enrollmentId);await f.service.remote.confirm({enrollmentId:c.id,expectedRevision:c.revision,candidateDigest:c.candidateDigest!});const before=f.calls.length;f[change]();f.restart();await expect(f.service.remote.sync(c.id)).rejects.toThrow(/another workspace/);expect(f.calls).toHaveLength(before);
});
it('read-only reconciliation rejects a changed marker during the status response before saving it',async()=>{
 const f=fixture();await f.prepare();const a=await f.begin(),c=await f.candidate(a.challenge.enrollmentId);await f.service.remote.confirm({enrollmentId:c.id,expectedRevision:c.revision,candidateDigest:c.candidateDigest!});
 f.mutate((route,result)=>{if(route.endsWith('/status')){result.phase='revoked';const m=marker(f);m.transitionId=randomUUID();writeFileSync(join(f.directory,'website-requests/grant.json'),JSON.stringify(m));}});
 await expect(f.service.remote.sync(c.id)).rejects.toThrow(/transition needs recovery/);expect(state(f).enrollments[0].snapshot.phase).toBe('confirmed');
});

it('unchanged enrollment status observation preserves a private work capability; revocation invalidates it',async()=>{
 const f=fixture();await f.prepare();const begun=await f.begin(),candidate=await f.candidate(begun.challenge.enrollmentId);await f.service.remote.confirm({enrollmentId:candidate.id,expectedRevision:candidate.revision,candidateDigest:candidate.candidateDigest!});
 const authority=await f.service.remote.workAuthority();expect(authority.isCurrent()).toBe(true);f.advance(1000);f.mutate((route,result)=>{if(route.endsWith('/status'))result.serverTime=new Date(Date.parse(result.serverTime)+1000).toISOString();});await f.service.remote.sync();expect(authority.isCurrent()).toBe(true);await authority.assertCurrent();await f.service.remote.revoke(candidate.id);expect(authority.isCurrent()).toBe(false);await expect(authority.assertCurrent()).rejects.toThrow();
});

it('an inactive receipt cannot erase previously confirmed approver evidence',async()=>{const f=fixture();await f.prepare();const begun=await f.begin(),candidate=await f.candidate(begun.challenge.enrollmentId);await f.service.remote.confirm({enrollmentId:candidate.id,expectedRevision:candidate.revision,candidateDigest:candidate.candidateDigest!});const before=state(f).enrollments[0].snapshot.approver;f.rows.set(candidate.id,{...f.rows.get(candidate.id)!,phase:'stale',approver:null});await expect(f.service.remote.sync()).rejects.toThrow();expect(state(f).enrollments[0].snapshot.approver).toEqual(before);});
