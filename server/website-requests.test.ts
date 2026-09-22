import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkflowDatabase } from './workflow-database.ts';
import { createWebsiteRequests, restoreWebsiteRequest, validateSavedWebsiteRequest, websiteRequestDigest, WEBSITE_REQUEST_KIND, type WebsiteRequestExecution, type WebsiteRequestIdentity, type WebsiteRequestRun } from './website-requests.ts';
import type { WebsiteCommandDescriptor, WebsiteCommandEnrollment, WebsiteCommandGrant, WebsiteCommandState, WebsiteCommandEvent, WebsiteCommandClaim, WebsiteCommandClaimResult } from '../shared/website-commands.ts';
const clean: (()=>void)[]=[];
afterEach(()=>{for(const close of clean.splice(0).reverse())close();});
function fixture(operation:'morning-review'|'prepare-recipe'='morning-review') {
  const directory=mkdtempSync(join(tmpdir(),'realbud-website-domain-'));
  const db=new WorkflowDatabase({dir:directory,key:Buffer.alloc(32,3)});
  clean.push(()=>{db.close();rmSync(directory,{recursive:true,force:true});});
  let time=Date.parse('2026-09-22T06:00:00.000Z');
  let identity:WebsiteRequestIdentity={workspaceId:randomUUID(),workerProfileKey:'worker-a'};
  let link:{installationId:string;token:string;companyId:string;agencyLabel:string}|null={installationId:randomUUID(),token:'a'.repeat(64),companyId:'company-a',agencyLabel:'Test Agency'};
  const descriptor:WebsiteCommandDescriptor={id:randomUUID(),operation,revision:'b'.repeat(64),label:'Morning preparation'};
  let catalog=[descriptor], binding={recipeRevision:1,sourceRevision:1};
  let grant:WebsiteCommandGrant;let commandToken='';let state:WebsiteCommandState;let sequence=0;
  const claims=new Map<string,WebsiteCommandClaimResult>(),events=new Map<string,WebsiteCommandState>();
  let fail:''|'enroll'|'claim'|'ack'|'revoke'|'unauthorized'='';let afterClaim:(()=>void)|null=null;
  const calls:{route:string;body:any;token:string}[]=[];
  const fetcher=vi.fn(async(url:Parameters<typeof fetch>[0],init?:RequestInit)=>{
    const route=String(url).split('/api/installations/')[1]!,body=JSON.parse(String(init?.body));
    const token=new Headers(init?.headers).get('authorization')!.slice(7);calls.push({route,body,token});
    if(route==='command-grants'&&init?.method==='POST') {
      expect(token).toBe(link?.token);const {commandToken:secret,...fields}=body as WebsiteCommandEnrollment;commandToken=secret;
      grant??={...fields,companyId:'company-a',enrolledAt:new Date(time).toISOString(),revokedAt:null};
      if(fail==='enroll'){fail='';throw new Error('lost enrollment secret response');}return Response.json(grant);
    }
    expect(token).toBe(commandToken);
    if(route==='command-grants'&&init?.method==='DELETE') {if(fail==='revoke')throw new Error('offline');grant={...grant,revokedAt:new Date(time).toISOString()};return Response.json({ok:true});}
    if(route==='commands/poll'&&fail==='unauthorized')return Response.json({error:'unauthorized'},{status:401});
    if(route==='commands/poll')return Response.json({grant,requests:state&&state.sequence>body.cursor?[state]:[],cursor:sequence,hasMore:false,serverTime:new Date(time).toISOString()});
    if(route==='commands/ack') {
      const event=body as WebsiteCommandEvent;
      if(state.phase==='accepted'&&['completed','needs-review','partial'].includes(event.phase))return Response.json({error:'phase'},{status:409});
      let receipt=events.get(event.eventId);
      if(!receipt){if(event.expectedRevision!==state.revision)return Response.json({error:'conflict'},{status:409});
        state={...state,phase:event.phase,outcome:event.outcome,runReference:event.runReference,revision:state.revision+1,sequence:++sequence,updatedAt:new Date(time).toISOString()};receipt=structuredClone(state);events.set(event.eventId,receipt);}
      if(fail==='ack'){fail='';throw new Error('lost response');}return Response.json(receipt);
    }
    if(route==='commands/claim') {
      const claim=body as WebsiteCommandClaim;let permission=claims.get(claim.claimId);
      if(!permission){if(claim.expectedRevision!==state.revision||state.cancellationRequested||state.phase==='cancelled')return Response.json({error:'conflict'},{status:409});
        state={...state,phase:'accepted',revision:state.revision+1,sequence:++sequence,updatedAt:new Date(time).toISOString()};
        permission={request:structuredClone(state),claimId:claim.claimId,previewDigest:claim.previewDigest,validUntil:new Date(time+60000).toISOString(),serverTime:new Date(time).toISOString()};claims.set(claim.claimId,permission);}
      afterClaim?.();if(fail==='claim'){fail='';throw new Error('lost claim response');}return Response.json(permission);
    }
    throw new Error('Unexpected route');
  }) as unknown as typeof fetch;
  const runs=new Map<string,WebsiteRequestRun>();
  const dispatch=vi.fn(async(e:WebsiteRequestExecution)=>{let run=runs.get(e.requestId);if(!run){run={id:`run:${e.requestId}`,phase:'running',outcome:null};runs.set(e.requestId,run);}return run;});
  const lookup=vi.fn(async(e:WebsiteRequestExecution)=>runs.get(e.requestId)??null), cancel=vi.fn(async(_run:WebsiteRequestRun)=>{});
  const check=vi.fn(async(_descriptor:WebsiteCommandDescriptor,expected:Record<string,unknown>)=>{if(JSON.stringify(expected)!==JSON.stringify(binding))throw new Error('Source changed');});
  const barrier=vi.fn(()=>{}),withActivity=vi.fn(async<T>(work:()=>Promise<T>)=>work());
  const create=()=>createWebsiteRequests({directory,db,officeLink:{credentials:async()=>link},identity:()=>identity,getCatalog:async()=>catalog,preview:async()=>({title:'Reviewed morning preparation',details:[{label:'Scope',value:'Locally reviewed inbox'}],binding:structuredClone(binding)}),check,dispatch,lookup,cancel,barrier,withActivity:async work=>withActivity(work) as ReturnType<typeof work>,fetch:fetcher,now:()=>time});
  let service=create();
  async function enroll(){await service.enroll({descriptorIds:[descriptor.id],label:'Private workspace'});}
  function request(){const id=randomUUID();state={envelope:{protocol:1,id,companyId:grant.companyId,installationId:grant.installationId,workspaceId:grant.workspaceId,grantId:grant.grantId,generation:grant.generation,descriptor,requester:'Account owner',createdAt:new Date(time).toISOString(),expiresAt:new Date(time+3600000).toISOString()},revision:1,phase:'queued',cancellationRequested:false,runReference:null,outcome:null,updatedAt:new Date(time).toISOString(),sequence:++sequence};return id;}
  async function preview(){const row=service.list().records[0]!;return service.preview(row.value.envelope.id,row.revision);}
  async function approve(){const row=await preview();return service.decide(row.value.envelope.id,{expectedRevision:row.revision,previewDigest:row.value.preview!.digest,decision:'approve'});}
  return {directory,db,descriptor,dispatch,lookup,cancel,calls,check,barrier,withActivity,runs,enroll,request,preview,approve,get service(){return service;},restart(){service.stop();service=create();return service;},get state(){return state;},setState(value:WebsiteCommandState){state=value;sequence=Math.max(sequence,value.sequence);},get grant(){return grant;},get token(){return commandToken;},setFail(v:typeof fail){fail=v;},setAfterClaim(fn:()=>void){afterClaim=fn;},advance(ms:number){time+=ms;},changeBinding(){binding={...binding,sourceRevision:2};},changeCatalog(){catalog=[{...descriptor,revision:'c'.repeat(64)}];},changeIdentity(){identity={...identity,workerProfileKey:'worker-b'};},relink(){link={...link!,installationId:randomUUID(),companyId:'company-b'};}};
}
describe('website request private workspace authority',()=>{
  it('persists a separate private enrollment before delivery and retries identical lost enrollment',async()=>{
    const f=fixture();f.setFail('enroll');await expect(f.enroll()).rejects.toThrow(/website could not/i);
    const status=await f.service.status();expect(status.pending).toBe(true);expect(status.publishedDescriptors).toEqual([f.descriptor]);
    f.restart();await f.enroll();expect(f.calls[0]!.body).toEqual(f.calls[1]!.body);
    const text=JSON.stringify(await f.service.status());expect(text).not.toContain(f.token);expect(text).not.toContain('a'.repeat(64));
    if(process.platform!=='win32')expect(statSync(join(f.directory,'website-requests/grant.json')).mode&0o777).toBe(0o600);
  });
  it.each(['morning-review','prepare-recipe'] as const)('saves %s before acknowledgement, requires local review and uses one exact executor key',async operation=>{
    const f=fixture(operation);await f.enroll();const id=f.request();await f.service.sync();
    expect(f.dispatch).not.toHaveBeenCalled();expect(f.service.list().records[0]!.value.phase).toBe('delivered');
    const approved=await f.approve();expect(approved.value.run?.phase).toBe('running');expect(f.dispatch).toHaveBeenCalledTimes(1);expect(f.dispatch.mock.calls[0]![0].requestId).toBe(id);
    await f.service.sync();f.restart();await f.service.recover();await f.service.sync();expect(f.dispatch).toHaveBeenCalledTimes(1);
    expect(f.service.executionBinding(id)?.binding).toEqual({recipeRevision:1,sourceRevision:1});
    const publicCalls=f.calls.filter(c=>!['command-grants'].includes(c.route));expect(JSON.stringify(publicCalls)).not.toContain('sourceRevision');
    expect(readFileSync(join(f.directory,'workflow-state.sqlite')).includes(Buffer.from('Locally reviewed inbox'))).toBe(false);
  });
  it('saves delivery before a lost ack and retries the same event without replacing local review',async()=>{
    const f=fixture();await f.enroll();f.request();f.setFail('ack');await expect(f.service.sync()).rejects.toThrow();
    const row=f.service.list().records[0]!;expect(row.value.pendingEvent).not.toBeNull();const event=row.value.pendingEvent;
    await f.service.sync();expect(f.calls.filter(c=>c.route==='commands/ack').slice(0,2).map(c=>c.body)).toEqual([event,event]);expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('reconciles an older pending receipt beyond a full page of newer history without dropping or repeating it',async()=>{
    const f=fixture();await f.enroll();const id=f.request();f.setFail('ack');await expect(f.service.sync()).rejects.toThrow();
    const oldest=f.service.list().records[0]!,event=oldest.value.pendingEvent;
    for(let index=0;index<220;index++) {
      const value=structuredClone(oldest.value),newId=randomUUID();
      value.envelope.id=newId;value.envelopeDigest=websiteRequestDigest(value.envelope);
      value.remote.envelope=structuredClone(value.envelope);value.remote.phase='rejected';value.remote.outcome='declined';
      value.phase='rejected';value.outcome='declined';value.pendingEvent=null;
      validateSavedWebsiteRequest(`website-request:${newId}`,value);
      f.db.create(WEBSITE_REQUEST_KIND,`website-request:${newId}`,value,5000);
    }
    expect(f.service.list({limit:200}).records.some(row=>row.value.envelope.id===id)).toBe(false);
    await f.service.sync();
    const recovered=f.db.get<typeof oldest.value>(WEBSITE_REQUEST_KIND,oldest.id)!;
    expect(recovered.value.pendingEvent).toBeNull();expect(recovered.value.phase).toBe('delivered');
    expect(f.db.count(WEBSITE_REQUEST_KIND)).toBe(221);
    expect(f.calls.filter(c=>c.route==='commands/ack').map(c=>c.body)).toEqual([event,event]);
    expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('reconciles a lost claim response under the same claim and requires an explicit second local action',async()=>{
    const f=fixture();await f.enroll();f.request();await f.service.sync();const p=await f.preview();f.setFail('claim');
    await expect(f.service.decide(p.value.envelope.id,{expectedRevision:p.revision,previewDigest:p.value.preview!.digest,decision:'approve'})).rejects.toThrow();expect(f.dispatch).not.toHaveBeenCalled();
    const row=f.service.list().records[0]!;await f.service.decide(row.value.envelope.id,{expectedRevision:row.revision,previewDigest:row.value.preview!.digest,decision:'approve'});
    const claims=f.calls.filter(c=>c.route==='commands/claim');expect(claims).toHaveLength(2);expect(claims[0]!.body).toEqual(claims[1]!.body);expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('does not erase an unresolved claim when another preview is requested, and decline becomes cancellation',async()=>{
    const f=fixture();await f.enroll();f.request();await f.service.sync();const p=await f.preview();f.setFail('claim');await expect(f.service.decide(p.value.envelope.id,{expectedRevision:p.revision,previewDigest:p.value.preview!.digest,decision:'approve'})).rejects.toThrow();
    const pending=f.service.list().records[0]!;await expect(f.service.preview(pending.value.envelope.id,pending.revision)).rejects.toThrow(/awaiting confirmation/);expect(f.service.list().records[0]!.value.intent).toEqual(pending.value.intent);
    await f.service.decide(pending.value.envelope.id,{expectedRevision:pending.revision,previewDigest:pending.value.preview!.digest,decision:'reject'});await f.service.sync();expect(f.service.list().records[0]!.value.phase).toBe('cancelled');expect(f.state.phase).toBe('cancelled');expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('preserves a terminal result through a lost intermediate running receipt',async()=>{
    const f=fixture();await f.enroll();f.request();await f.service.sync();f.dispatch.mockImplementationOnce(async execution=>{const run:WebsiteRequestRun={id:`run:${execution.requestId}`,phase:'completed',outcome:'prepared'};f.runs.set(execution.requestId,run);return run;});f.setFail('ack');await expect(f.approve()).rejects.toThrow();
    const row=f.service.list().records[0]!;expect(row.value.phase).toBe('completed');expect(row.value.pendingEvent?.phase).toBe('running');f.restart();await f.service.sync();expect(f.state.phase).toBe('completed');expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('does not auto-dispatch old approval after cold restart if no executor receipt exists',async()=>{
    const f=fixture();await f.enroll();f.request();await f.service.sync();const p=await f.preview();f.setFail('claim');await expect(f.service.decide(p.value.envelope.id,{expectedRevision:p.revision,previewDigest:p.value.preview!.digest,decision:'approve'})).rejects.toThrow();
    f.restart();await f.service.recover();const row=f.service.list().records[0]!;expect(row.value.phase).toBe('interrupted');expect(row.value.intent).toBeNull();expect(row.value.runReference).toBeNull();await f.service.sync();expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('attaches the existing receipt after enqueue response loss without another worker launch',async()=>{
    const f=fixture();await f.enroll();f.request();await f.service.sync();f.dispatch.mockImplementationOnce(async execution=>{f.runs.set(execution.requestId,{id:`run:${execution.requestId}`,phase:'completed',outcome:'prepared'});throw new Error('reply lost after durable enqueue');});
    const result=await f.approve();expect(result.value.phase).toBe('completed');expect(f.calls.filter(c=>c.route==='commands/ack').slice(-2).map(c=>c.body.phase)).toEqual(['running','completed']);expect(f.state.phase).toBe('completed');f.restart();await f.service.recover();expect(f.dispatch).toHaveBeenCalledTimes(1);expect(f.service.list().records[0]!.value.run?.id).toBe(result.value.run?.id);
  });
  it('revalidates source bindings after online claim and records interrupted rather than dispatching',async()=>{
    const f=fixture();await f.enroll();f.request();await f.service.sync();f.setAfterClaim(()=>f.changeBinding());await expect(f.approve()).rejects.toThrow('Source changed');
    expect(f.dispatch).not.toHaveBeenCalled();const row=f.service.list().records[0]!;expect(row.value.phase).toBe('interrupted');expect(row.value.runReference).toBeNull();expect(row.value.intent).toBeNull();
  });
  it('denies late claim permission and changed identity without launching work',async()=>{
    const f=fixture();await f.enroll();f.request();await f.service.sync();f.setAfterClaim(()=>f.advance(61_000));await expect(f.approve()).rejects.toThrow(/permission/);expect(f.dispatch).not.toHaveBeenCalled();
    f.restart();await f.service.recover();f.changeIdentity();await f.service.sync();expect((await f.service.status()).enabled).toBe(false);expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('holds stale descriptor revisions and conflicting duplicate envelopes',async()=>{
    const f=fixture();await f.enroll();f.request();await f.service.sync();f.changeCatalog();await expect(f.preview()).rejects.toThrow(/plan changed/);
    const state=f.state;f.setState({...state,envelope:{...state.envelope,requester:'Different actor'},revision:state.revision+1,sequence:state.sequence+1});await expect(f.service.sync()).rejects.toThrow(/conflicting website request/);expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('does not admit another company target or extra unrecognized remote fields',async()=>{
    const f=fixture();await f.enroll();f.request();f.setState({...f.state,envelope:{...f.state.envelope,companyId:'company-b'}});await expect(f.service.sync()).rejects.toThrow(/another workspace/);expect(f.service.list().records).toHaveLength(0);
  });
  it('serializes competing local decisions and rejects stale local revisions',async()=>{
    const f=fixture();await f.enroll();f.request();await f.service.sync();const p=await f.preview();const body={expectedRevision:p.revision,previewDigest:p.value.preview!.digest,decision:'approve' as const};
    const results=await Promise.allSettled([f.service.decide(p.value.envelope.id,body),f.service.decide(p.value.envelope.id,{...body,decision:'reject'})]);expect(results.filter(v=>v.status==='fulfilled')).toHaveLength(1);expect(f.dispatch).toHaveBeenCalledTimes(1);await expect(f.service.decide(p.value.envelope.id,body)).rejects.toThrow(/changed/);
  });
  it('persists local disable while offline and never transfers a grant after relinking',async()=>{
    const f=fixture();await f.enroll();f.request();await f.service.sync();f.setFail('revoke');await expect(f.service.disable()).rejects.toThrow();expect((await f.service.status()).enabled).toBe(false);await expect(f.preview()).rejects.toThrow();expect(f.dispatch).not.toHaveBeenCalled();f.setFail('');await f.service.sync();f.relink();expect((await f.service.status()).enabled).toBe(false);
  });
  it('retains running status when cancellation can only request a safe stop',async()=>{
    const f=fixture();await f.enroll();f.request();await f.service.sync();const row=await f.approve();const result=await f.service.cancel(row.value.envelope.id,row.revision);expect(f.cancel).toHaveBeenCalledTimes(1);expect(result.value.cancellationRequested).toBe(true);expect(result.value.phase).toBe('running');
  });
  it('preserves historical run links during restore while invalidating approval and grant authority',async()=>{
    const f=fixture();await f.enroll();f.request();await f.service.sync();const row=await f.approve();const restored=restoreWebsiteRequest(row.id,row.value,'2026-09-23T00:00:00.000Z');expect(restored.run).toEqual(row.value.run);expect(restored.phase).toBe('interrupted');expect(restored.restored).toBe(true);expect(restored.intent).toBeNull();expect(restored.pendingEvent).toBeNull();
    f.db.update(WEBSITE_REQUEST_KIND,row.id,row.revision,()=>restored);expect(()=>f.service.executionBinding(row.value.envelope.id)).toThrow(/permission/);await expect(f.service.preview(row.value.envelope.id,row.revision+1)).rejects.toThrow();expect(f.dispatch).toHaveBeenCalledTimes(1);
  });
  it('allows renewed explicit review after expired permission under the same request key',async()=>{
    const f=fixture();await f.enroll();const id=f.request();await f.service.sync();f.setAfterClaim(()=>f.advance(61_000));await expect(f.approve()).rejects.toThrow(/permission/);expect(f.service.list().records[0]!.value.phase).toBe('interrupted');
    f.setAfterClaim(()=>{});const result=await f.approve();expect(result.value.run?.phase).toBe('running');expect(f.dispatch.mock.calls[0]![0].requestId).toBe(id);expect(new Set(f.calls.filter(c=>c.route==='commands/claim').map(c=>c.body.claimId)).size).toBe(2);
  });
  it('disables local authority and requests cancellation when upstream denies the grant',async()=>{
    const f=fixture();await f.enroll();f.request();await f.service.sync();const run=await f.approve();f.setFail('unauthorized');await expect(f.service.sync()).rejects.toThrow(/no longer active/);expect((await f.service.status()).enabled).toBe(false);expect(f.cancel).toHaveBeenCalledTimes(1);expect(f.service.list().records[0]!.value.phase).toBe('running');expect(()=>f.service.executionBinding(run.value.envelope.id)).toThrow(/permission/);
  });
  it('does not revoke a permission merely because a temporary workspace barrier rejects polling',async()=>{
    const f=fixture();await f.enroll();f.barrier.mockImplementationOnce(()=>{throw new Error('Backup paused');});await expect(f.service.sync()).rejects.toThrow('Backup paused');expect((await f.service.status()).enabled).toBe(true);expect(f.calls.some(c=>c.route==='command-grants'&&!c.body.commandToken)).toBe(false);
  });
  it('reconciles cancellation racing a stale delivery acknowledgement without getting stuck',async()=>{
    const f=fixture();await f.enroll();f.request();f.setFail('ack');await expect(f.service.sync()).rejects.toThrow();const old=f.state;f.setState({...old,revision:old.revision+1,sequence:old.sequence+1,phase:'cancelled',outcome:'cancelled',cancellationRequested:true});await f.service.sync();const row=f.service.list().records[0]!;expect(row.value.phase).toBe('cancelled');expect(row.value.pendingEvent).toBeNull();expect(f.dispatch).not.toHaveBeenCalled();
  });
  it('rejects tampered saved preview and envelope digests, plus restored live authority',async()=>{
    const f=fixture();await f.enroll();f.request();await f.service.sync();const row=await f.preview();const changed=structuredClone(row.value);changed.preview!.binding.recipeRevision=99;expect(()=>validateSavedWebsiteRequest(row.id,changed)).toThrow(/recovery/);
    expect(()=>validateSavedWebsiteRequest(row.id,{...row.value,envelopeDigest:'d'.repeat(64)})).toThrow(/recovery/);expect(()=>validateSavedWebsiteRequest(row.id,{...row.value,restored:true})).toThrow(/recovery/);expect(websiteRequestDigest({b:2,a:1})).toBe(websiteRequestDigest({a:1,b:2}));
  });
});
