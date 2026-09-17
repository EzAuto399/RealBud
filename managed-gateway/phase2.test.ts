import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fixture,FIXTURE_TIME } from './testing.ts';
import { canonical,type ExecutionGrant,type ModelRequest,type ProviderEvent } from './contracts.ts';
import { LedgerDatabase } from './database.ts';
import { UsageLedger } from './ledger.ts';
import { directProvider } from './direct-provider.ts';
import { validateRequest } from './auth.ts';
export function childGrant(f:ReturnType<typeof fixture>,request=f.request,child='child-1',override:Partial<ExecutionGrant>={}):ExecutionGrant {
  return f.grant(request,{schema:2,grantVersion:2,modelCallId:child,jti:`jti-${child}`,provider:'synthetic-provider',maxAttemptSpendNanoAud:'400000000',attemptExpiresAt:FIXTURE_TIME+120000,allowedModels:[{provider:'synthetic-provider',model:request.model,capabilities:['text','tools']}],...override});
}
test('three legitimate children share one attempt; settled retail and unknown reservations consume its cap',()=>{
  const f=fixture();try {
    for(let n=1;n<=3;n++) {
      const g=childGrant(f,f.request,`child-${n}`);const r=f.ledger.reserve(g,'fixture-host-key',`fp-${n}`,`idem-${n}`,f.provider.bound(f.request)).record;
      f.ledger.dispatch(r.id,g,f.provider.id);if(n<3)f.ledger.settle(r.id,f.provider.id,f.evidence({evidenceId:`usage-${n}`,providerRequestId:`provider-${n}`}));else f.ledger.unknown(r.id,'interrupted');
    }
    assert.equal(f.ledger.requests('company-a').length,3);
    const g=childGrant(f,f.request,'child-4',{maxAttemptSpendNanoAud:'400000000'});
    const r=f.ledger.reserve(g,'fixture-host-key','fp-4','idem-4',f.provider.bound(f.request)).record;
    assert.throws(()=>f.ledger.reserve(childGrant(f,f.request,'child-5'),'fixture-host-key','fp-5','idem-5',f.provider.bound(f.request)),/attempt_cap_exceeded/);
    f.ledger.releaseUndispatched(r.id);
    assert.equal(f.ledger.reserve(childGrant(f,f.request,'child-6'),'fixture-host-key','fp-6','idem-6',f.provider.bound(f.request)).duplicate,false);
  }finally{f.close();}
});
test('same-child retries recover state, changed content or parent identity conflicts, lease cannot raise budget/deadline',()=>{
  const f=fixture();try {
    const g=childGrant(f);const r=f.ledger.reserve(g,'fixture-host-key','fp','idem',f.provider.bound(f.request)).record;
    f.ledger.dispatch(r.id,g,f.provider.id);f.ledger.unknown(r.id,'interrupted');
    assert.equal(f.ledger.reserve({...g,jti:'renewed',exp:g.exp+1000},'fixture-host-key','fp','idem',f.provider.bound(f.request)).record.state,'unknown');
    assert.throws(()=>f.ledger.reserve(g,'fixture-host-key','changed','idem',f.provider.bound(f.request)),/idempotency_conflict/);
    for(const delta of [{maxAttemptSpendNanoAud:'500000000'},{attemptExpiresAt:FIXTURE_TIME+180000},{memberId:'member-b'},{deviceId:'device-b'},{revision:'2'},{authorityVersion:'2'},{resource:'other'}])assert.throws(()=>f.ledger.reserve({...g,...delta,modelCallId:'next',jti:'next'},'fixture-host-key','fp2','idem2',f.provider.bound(f.request)),/parent_envelope_conflict/);
    assert.throws(()=>f.ledger.reserve({...g,exp:g.attemptExpiresAt!+1},'fixture-host-key','fp','idem',{}),/parent_deadline_exceeded/);
    f.ledger.revokeIssuer('fixture-host-key');assert.throws(()=>f.ledger.reserve(g,'fixture-host-key','fp','idem',{}),/issuer_revoked/);
  }finally{f.close();}
});
test('v1 SQLite migration preserves history and request bodies and cannot turn legacy attempt into new authority',()=>{
  const dir=mkdtempSync(join(tmpdir(),'realbud-v1-')),path=join(dir,'ledger.sqlite'),f=fixture(path);
  const old=f.ledger.reserve(f.grant(),'fixture-host-key','fp','idem',f.provider.bound(f.request)).record;
  const history=canonical(f.db.all('SELECT * FROM events'));const body=f.db.get<{body:string}>('SELECT body FROM requests WHERE id=?',old.id)!.body;f.close();
  const raw=new DatabaseSync(path);raw.exec(`ALTER TABLE requests RENAME TO requests_v2; CREATE TABLE requests (id TEXT PRIMARY KEY,tenant TEXT NOT NULL,member TEXT NOT NULL,job TEXT NOT NULL,attempt TEXT NOT NULL,idem TEXT NOT NULL,kid TEXT NOT NULL,jti TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(tenant,member,idem),UNIQUE(tenant,job,attempt),UNIQUE(kid,jti));INSERT INTO requests SELECT id,tenant,member,job,attempt,idem,kid,jti,body FROM requests_v2;DROP TABLE requests_v2;DROP TABLE attempts;PRAGMA user_version=1;`);raw.close();
  const db=new LedgerDatabase(path);try {
    const ledger=new UsageLedger(db,()=>FIXTURE_TIME);assert.equal(canonical(db.all('SELECT * FROM events')),history);assert.equal(db.get<{body:string}>('SELECT body FROM requests WHERE id=?',old.id)!.body,body);
    assert.throws(()=>ledger.reserve(childGrant(f),'fixture-host-key','new','new',{}),/legacy_attempt_frozen/);ledger.recover();assert.equal(ledger.request(old.id).state,'released');db.verify();
  }finally{db.close();rmSync(dir,{recursive:true,force:true});}
});
function response(provider:'deepseek'|'kimi',model:string,tools=true,overrides:Record<string,unknown>={}) {
  const parts=[{role:'assistant',...(provider==='deepseek'?{content:''}:{}),reasoning_content:'PRIVATE SYNTHETIC CONTINUATION'},...(tools?[{tool_calls:[{index:0,id:'call-1',type:'function',function:{name:'read_record',arguments:'{"id":'}}]},{tool_calls:[{index:0,function:{arguments:'"fixture"}'}}]}]:[{content:'Useful answer'}])];
  const items=parts.map(delta=>({id:tools?'provider-1':'provider-2',model,choices:[{index:0,delta,finish_reason:null}]}));
  const usage=provider==='deepseek'?{prompt_cache_hit_tokens:5,prompt_cache_miss_tokens:10}:{cached_tokens:5};
  items.push({id:tools?'provider-1':'provider-2',model,choices:[{index:0,delta:{},finish_reason:(tools?'tool_calls':'stop') as never}],usage:{prompt_tokens:15,completion_tokens:4,total_tokens:19,...usage,...overrides}} as never);
  const raw=items.map(i=>`data: ${JSON.stringify(i)}\r\n\r\n`).join('')+'data: [DONE]\r\n\r\n';
  return new Response(new ReadableStream({start(c){const bytes=new TextEncoder().encode(raw);for(let i=0;i<bytes.length;i+=13)c.enqueue(bytes.slice(i,i+13));c.close();}}),{headers:{'content-type':'text/event-stream'}});
}
for(const provider of ['deepseek','kimi'] as const)test(`${provider}: fragmented thinking/tool continuation survives next signed child without entering SQLite`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'realbud-continuation-')),path=join(dir,'ledger.sqlite'),f=fixture(path),model=provider==='kimi'?'kimi-k3':'deepseek-flash';
  const sent:Record<string,unknown>[]=[];const adapter=directProvider({provider,model:f.request.model,upstreamModel:model,maximumOutputTokens:20,enforcedContextTokens:100,terms:f.provider.terms,secret:async()=>'fixture-secret',fetch:(async(url,init)=>{assert.equal(String(url),provider==='kimi'?'https://api.moonshot.ai/v1/chat/completions':'https://api.deepseek.com/chat/completions');sent.push(JSON.parse(String(init?.body)));return response(provider,model,sent.length===1);}) as typeof fetch});
  const request:ModelRequest={...f.request,protocol:'tools-v1',thinking:'enabled',tools:[{type:'function',function:{name:'read_record',parameters:{type:'object',properties:{id:{type:'string'}}}}}]};
  const scope={provider,allowedModels:[{provider,model:request.model,capabilities:['text','tools'] as ('text'|'tools')[]}]};
  try {
    const gateway=f.gateway(adapter);const first=await f.run(gateway,request,childGrant(f,request,'one',scope));
    const message=(first.find(e=>(e as {type:string}).type==='continuation') as {data:{message:ModelRequest['messages'][number]}}).data.message;
    const next:ModelRequest={...request,idempotencyKey:'next',messages:[...request.messages,message,{role:'tool',content:'FICTIONAL RESULT',tool_call_id:'call-1'}]};
    await f.run(gateway,next,childGrant(f,next,'two',scope));assert.deepEqual((sent[1].messages as unknown[])[1],message);
    const stored=canonical({requests:f.db.all('SELECT * FROM requests'),events:f.db.all('SELECT * FROM events'),portal:f.ledger.portalUsage(f.owner)});assert(!stored.includes('PRIVATE SYNTHETIC'));assert(!stored.includes('FICTIONAL RESULT'));assert(!stored.includes('fixture-secret'));
    assert.deepEqual(f.ledger.requests(f.tenant.companyId)[0].units,{input_tokens:10,cache_read_tokens:5,output_tokens:4});f.db.verify();
  }finally{f.close();assert(!readFileSync(path).includes('PRIVATE SYNTHETIC'));rmSync(dir,{recursive:true,force:true});}
});
test('new and old provider transports are disabled without injection; invalid units/history fail closed',async()=>{
  const f=fixture();try {
    let secrets=0;const provider=directProvider({provider:'kimi',model:f.request.model,upstreamModel:'kimi-k3',maximumOutputTokens:20,enforcedContextTokens:100,terms:f.provider.terms,secret:async()=>{secrets++;return 'no';}});
    await assert.rejects(async()=>{for await(const _ of provider.stream(f.request,{signal:new AbortController().signal,dispatchId:'fixture'})){void _;}},/external_transport_disabled/);assert.equal(secrets,0);
    const request:ModelRequest={...f.request,protocol:'tools-v1',tools:[],thinking:'enabled'};
    assert.throws(()=>provider.bound({...request,messages:[{role:'assistant',content:'lost reasoning'},{role:'user',content:'next'}]}),/thinking_history_required/);
    assert.throws(()=>validateRequest({...request,messages:[{role:'tool',content:'invented',tool_call_id:'unknown'}]}),/unexpected_tool_reply/);
    const bad=directProvider({provider:'kimi',model:f.request.model,upstreamModel:'kimi-k3',maximumOutputTokens:20,enforcedContextTokens:100,terms:f.provider.terms,secret:async()=>'fixture',fetch:(async()=>response('kimi','kimi-k3',false,{cached_tokens:1.5})) as typeof fetch});
    await assert.rejects(async()=>{const output:ProviderEvent[]=[];for await(const event of bad.stream(request,{signal:new AbortController().signal,dispatchId:'test'}))output.push(event);},/invalid_integer/);
  }finally{f.close();}
});
