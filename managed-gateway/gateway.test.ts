import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './testing.ts';
import { verifyGrant } from './auth.ts';
import { canonical } from './contracts.ts';
import type { ProviderAdapter, ExecutionAuthority } from './contracts.ts';

const cleanups:(()=>void)[]=[]; const setup=()=>{const f=fixture();cleanups.push(f.close);return f;};
afterEach(()=>{while(cleanups.length)cleanups.pop()!();});

test('gateway streams verified measured usage once and idempotent retries never call provider again',async()=>{
  const f=setup(),g=f.gateway(); const result=await f.run(g); assert.equal(f.calls(),1);
  assert.deepEqual(result.map(r=>(r as {type:string}).type),['reserved','delta','settled']);
  const replay=await f.run(g); assert.equal(f.calls(),1); assert.equal((replay[0] as {type:string}).type,'duplicate');
});
test('issuer signature binds model, tenant, installation, audience, exact request and expiry',()=>{
  const f=setup();
  assert.throws(()=>verifyGrant({...f.envelope(),signature:'A'.repeat(86)},f.request,f.ledger),/invalid_signature/);
  for(const claims of [{companyId:'foreign-company'},{hostInstallationId:'foreign-install'},{aud:'portal'},{exp:f.now()-1},{iat:f.now()+1},{exp:f.now()+300001},{grantVersion:2}]) {
    assert.throws(()=>verifyGrant(f.envelope(f.grant(f.request,claims as never)),f.request,f.ledger));
  }
  assert.throws(()=>verifyGrant(f.envelope(),{...f.request,messages:[{role:'user',content:'changed'}]},f.ledger),/request_scope_mismatch/);
  assert.throws(()=>verifyGrant({...f.envelope(),kid:'unknown-key'},f.request,f.ledger),/issuer_unavailable/);
});
test('missing device/job authority cannot be replaced with an otherwise valid signature',async()=>{
  const f=setup(); const authority:ExecutionAuthority={async acquire(){throw new Error('device_not_enrolled');}};
  await assert.rejects(f.run(f.gateway(f.provider,authority)),/device_not_enrolled/);
  assert.equal(f.calls(),0);assert.equal(f.ledger.requests('company-a').length,0);
});
test('revoked issuer or service entitlement blocks requests before provider dispatch',async()=>{
  const f=setup();f.ledger.revokeIssuer('fixture-host-key');await assert.rejects(f.run(),/issuer_unavailable/);assert.equal(f.calls(),0);
});
test('revocation between reservation and dispatch releases only the undispatched reservation',async()=>{
  const f=setup(),g=f.gateway();
  await assert.rejects(g.execute(f.envelope(),f.request,async e=>{if(e.type==='reserved')f.ledger.revokeIssuer('fixture-host-key');},new AbortController().signal),/issuer_unavailable/);
  assert.equal(f.calls(),0);assert.equal(f.ledger.requests('company-a')[0].state,'released');
});
test('authority revocation during a stream cancels further output and retains unknown usage',async()=>{
  const f=setup();let cancelled=false;
  const p:ProviderAdapter={...f.provider,async *stream(_req,context){try{yield {type:'delta',text:'first'};f.revocation.abort();yield {type:'delta',text:'forbidden'};}finally{cancelled=context.signal.aborted;}}};
  const output:unknown[]=[];
  await assert.rejects(f.gateway(p).execute(f.envelope(),f.request,async e=>{output.push(e);},new AbortController().signal));
  assert.equal(cancelled,true);assert(!JSON.stringify(output).includes('forbidden'));assert.equal(f.ledger.requests('company-a')[0].state,'unknown');
});
test('cancellation before admission makes no reservation or provider call',async()=>{
  const f=setup(),abort=new AbortController();abort.abort();
  await assert.rejects(f.gateway().execute(f.envelope(),f.request,async()=>{},abort.signal));assert.equal(f.calls(),0);assert.equal(f.ledger.requests('company-a').length,0);
});
test('provider failure, missing or duplicate usage retains reservation and cannot auto-retry',async()=>{
  for(const mode of ['failure','missing','duplicate'] as const) {
    const f=setup();let count=0;
    const p:ProviderAdapter={...f.provider,async *stream(){count++;if(mode==='failure')throw new Error('private account upstream error');yield {type:'delta',text:'partial'};if(mode==='duplicate'){yield {type:'usage',evidence:f.evidence()};yield {type:'usage',evidence:f.evidence()};}}};
    const g=f.gateway(p);await assert.rejects(f.run(g));assert.equal(f.ledger.requests('company-a')[0].state,'unknown');await f.run(g);assert.equal(count,1);
  }
});
test('known failed request usage is measured; unused token ceiling is released',async()=>{
  const f=setup();const p:ProviderAdapter={...f.provider,async *stream(){yield {type:'usage',evidence:f.evidence({outcome:'failed',units:{input_tokens:3,cache_read_tokens:0,output_tokens:0}})};}};
  await f.run(f.gateway(p));const r=f.ledger.requests('company-a')[0];assert.equal(r.chargedNanoAud,'3000000');assert.equal(r.outcome,'failed');assert.equal(f.ledger.exposure('company-a',r.period),3000000n);
});
test('unreviewed provider terms, unselected model and excessive output limit fail closed',async()=>{
  const f=setup();await assert.rejects(f.run(f.gateway({...f.provider,terms:{reviewReference:'',approvedUntil:f.now()+1}})),/provider_terms_not_admitted/);
  const req={...f.request,model:'unselected'};await assert.rejects(f.run(f.gateway(),req,f.grant(req)),/model_route_unavailable/);
  await assert.rejects(f.run(f.gateway(),{...f.request,maxOutputTokens:0}),/invalid_output_limit/);assert.equal(f.calls(),0);
});
test('client-supplied provider URLs, identities and arbitrary tools are rejected',async()=>{
  const f=setup();for(const extra of [{companyId:'foreign'},{base_url:'https://evil.invalid'},{tools:[]}]) {
    await assert.rejects(f.run(f.gateway(),{...f.request,...extra}),/invalid_fields/);
  }
});
test('stored usage and portal responses contain no prompts, grants, private costs or upstream accounts',async()=>{
  const f=setup();await f.run();
  const persisted=canonical({events:f.db.all('SELECT * FROM events'),requests:f.db.all('SELECT * FROM requests'),usage:f.ledger.portalUsage(f.owner)});
  assert(!persisted.includes(f.request.messages[0].content!));assert(!persisted.includes(f.envelope().signature));
  const view=canonical(f.ledger.portalUsage(f.owner));assert(!view.includes('provider-one'));assert(!view.includes('fingerprint'));assert(!view.includes('markup'));
});
test('stuck authority acquisition ends on cancellation before reservation',async()=>{
  const f=setup(),abort=new AbortController();let observed=false;
  const authority:ExecutionAuthority={async acquire(_grant,signal){observed=!!signal;return new Promise(()=>{});}};
  const promise=f.gateway(f.provider,authority).execute(f.envelope(),f.request,async()=>{},abort.signal);abort.abort();await assert.rejects(promise);assert(observed);assert.equal(f.ledger.requests('company-a').length,0);
});
test('stuck provider iterators end on cancellation and retain uncertain usage',async()=>{
  const f=setup(),abort=new AbortController();let admitted:()=>void=()=>{};const dispatched=new Promise<void>(r=>{admitted=r;});
  const p:ProviderAdapter={...f.provider,async *stream(){admitted();await new Promise(()=>{});yield {type:'delta',text:'unreachable'};}};
  const promise=f.gateway(p).execute(f.envelope(),f.request,async()=>{},abort.signal);await dispatched;abort.abort();await assert.rejects(promise);assert.equal(f.ledger.requests('company-a')[0].state,'unknown');
});
test('reconciliation cannot substitute another provider for the saved route',async()=>{
  const f=setup();await f.run();const r=f.ledger.requests('company-a')[0];assert.throws(()=>f.ledger.settle(r.id,'unrelated-provider',f.evidence()),/provider_route_mismatch/);
});
