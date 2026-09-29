import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fixture } from './testing.ts';
import type { PortalPrincipal } from './contracts.ts';
import { ManagedConnectors, newConnectorCredential, type ConnectorDevice, type ConnectorOptions } from './connectors.ts';
import { createGatewayServer } from './http.ts';
function setup(overrides:Partial<ConnectorOptions>={}){
  const f=fixture(),a=newConnectorCredential(),b=newConnectorCredential(),other=newConnectorCredential();
  f.ledger.provisionTenant({...f.tenant,companyId:'company-b',licenseId:'license-b'});
  const base:ConnectorDevice={id:'a',companyId:f.tenant.companyId,licenseId:f.tenant.licenseId,memberId:'staff-a',installationId:'desktop-a',profile:'property',tokenHash:a.tokenHash,active:true,expiresAt:f.tenant.serviceExpiresAt,projectKeyEnv:'REALBUD_COMPOSIO_PROJECT_A',authConfigId:'auth-a',userId:'staff-a',accountId:'personal-a'};
  let devices=[base,{...base,id:'b',installationId:'desktop-b',memberId:'staff-b',userId:'staff-b',tokenHash:b.tokenHash},{...base,id:'other',companyId:'company-b',licenseId:'license-b',installationId:'other',tokenHash:other.tokenHash,projectKeyEnv:'REALBUD_COMPOSIO_PROJECT_B'}];
  let connects=0,reads=0;const seen:string[]=[];
  const options:ConnectorOptions={ledger:f.ledger,devices:()=>devices,secret:()=> 'ak_synthetic_office_secret',
    authorize:async(binding)=>{connects++;seen.push(binding.userId);return {url:'https://connect.example.invalid/oauth',accountId:'shared-'+binding.userId,expiresAt:new Date(f.now()+60000).toISOString()};},
    transport:(binding)=>({async request(){return {content:[{type:'text',text:JSON.stringify({accountId:binding.accountId,emailAddress:'office@example.invalid'})}]};}}),
    access:async(binding)=>{reads++;seen.push(binding.accountId??'none');return {checkedAt:new Date(f.now()).toISOString(),services:{gmail:{connected:true,status:'ACTIVE',accounts:[{id:binding.accountId!,status:'ACTIVE'}],accountSelectionRequired:false}},tools:{available:true,names:[]}};},...overrides};
  const broker=new ManagedConnectors(options),owner=f.owner;
  const call=(op:string,body:unknown=undefined,actor:PortalPrincipal=owner)=>broker.officeMailbox.handle(actor,op,body,async()=>{});
  const request=(token=a.token,path='/v1/connectors/status',body?:unknown,session?:string,policyRevision?:number)=>broker.handle({token,profile:'property',method:body?'POST':'GET',path,body,session,policyRevision:policyRevision??broker.officeMailbox.policy(f.tenant.companyId).revision,signal:new AbortController().signal});
  const shared=async()=>{await call('policy',{mode:'shared',expectedRevision:0});await call('authorize',{expectedRevision:1});await call('verify',{expectedRevision:1});const status=await call('status') as {candidate:{accountId:string;emailAddress:string}};await call('confirm',{expectedRevision:2,...status.candidate});await call('grants',{expectedRevision:3,installationId:'desktop-a',allowed:true});};
  return {f,a,b,other,base,broker,call,request,shared,options,seen,reads:()=>reads,connects:()=>connects,getDevices:()=>devices,set:(next:ConnectorDevice[])=>{devices=next;}};
}
test('two offices and two desktops isolate private office mailbox; rotation and revocation never inherit a grant',async()=>{
  const s=setup();try{
    await s.shared();const status=(await s.request()).body as {sourceKind:string;policyRevision:number};assert.equal(status.sourceKind,'office_shared');assert.equal(status.policyRevision,4);assert.match(s.seen.at(-1)!,/^shared-office_/);
    await assert.rejects(()=>s.request(s.b.token,'/v1/connectors/mcp',{jsonrpc:'2.0',id:1,method:'initialize'}),/office_mailbox_desktop_denied/);
    const personal=(await s.request(s.other.token)).body as {sourceKind:string;policyRevision:number};assert.equal(personal.sourceKind,'personal');assert.equal(personal.policyRevision,0);assert.equal(s.seen.at(-1),'personal-a');
    const otherOwner={...s.f.owner,companyId:'company-b'};
    await s.call('policy',{mode:'shared',expectedRevision:0},otherOwner);
    await assert.rejects(()=>s.call('grants',{expectedRevision:1,installationId:'desktop-a',allowed:true},otherOwner),/confirmation_required/);
    await s.call('authorize',{expectedRevision:1},otherOwner);assert.equal(new Set(s.seen.filter(v=>v.startsWith('office_'))).size,2);
    const secondReview=await s.call('verify',{expectedRevision:1},otherOwner) as {candidate:{accountId:string;emailAddress:string}};
    await s.call('confirm',{expectedRevision:2,...secondReview.candidate},otherOwner);
    await assert.rejects(()=>s.call('grants',{expectedRevision:3,installationId:'desktop-a',allowed:true},otherOwner),/installation_unavailable/);
    await s.call('grants',{expectedRevision:3,installationId:'other',allowed:true},otherOwner);await s.request(s.other.token);
    assert.equal(s.seen.at(-1),secondReview.candidate.accountId);
    assert.notEqual(secondReview.candidate.accountId,s.broker.officeMailbox.binding(s.base)!.accountId);
    const next=newConnectorCredential();s.set(s.getDevices().map(d=>d.id==='a'?{...d,tokenHash:next.tokenHash}:d));
    await assert.rejects(()=>s.request(),/connector_access_denied/);await assert.rejects(()=>s.request(next.token,'/v1/connectors/mcp',{jsonrpc:'2.0',id:1,method:'initialize'}),/office_mailbox_desktop_denied/);
    await s.call('grants',{expectedRevision:4,installationId:'desktop-a',allowed:true});await s.request(next.token);
    s.set(s.getDevices().map(d=>d.id==='a'?{...d,active:false}:d));await assert.rejects(()=>s.request(next.token),/connector_access_denied/);
  }finally{s.f.close();}
});
test('owner-only policy is revision-checked; shared desktop authorize refused; personal flow restored',async()=>{
  const s=setup();try{
    await s.request();assert.equal(s.seen.at(-1),'personal-a');
    await assert.rejects(()=>s.call('status',undefined,{...s.f.owner,role:'billing_reader'}),/forbidden/);
    await s.shared();await assert.rejects(()=>s.request(s.a.token,'/v1/connectors/authorize',{app:'gmail'}),/owner_authorization_required/);
    await assert.rejects(()=>s.call('policy',{mode:'personal',expectedRevision:0}),/revision_changed/);
    await s.call('policy',{mode:'personal',expectedRevision:4});await s.request();assert.equal(s.seen.at(-1),'personal-a');
    await s.call('policy',{mode:'shared',expectedRevision:5});await assert.rejects(()=>s.request(s.a.token,'/v1/connectors/mcp',{jsonrpc:'2.0',id:1,method:'initialize'}),/desktop_denied/);
  }finally{s.f.close();}
});
test('unknown OAuth outcomes hold durably across retries, broker restart and policy transitions',async()=>{
  let attempts=0;const s=setup({authorize:async()=>{attempts++;throw new Error('lost provider reply');}});try{
    await s.call('policy',{mode:'shared',expectedRevision:0});await assert.rejects(()=>s.call('authorize',{expectedRevision:1}),/lost provider reply/);
    await assert.rejects(()=>s.call('authorize',{expectedRevision:1}),/outcome_unknown/);
    await s.call('policy',{mode:'personal',expectedRevision:1});await s.call('policy',{mode:'shared',expectedRevision:2});
    const restarted=new ManagedConnectors(s.options);await assert.rejects(()=>restarted.officeMailbox.handle(s.f.owner,'authorize',{expectedRevision:3},async()=>{}),/outcome_unknown/);assert.equal(attempts,1);
  }finally{s.f.close();}
});
test('policy mutation during status, scan or attachment awaits withholds results',async()=>{
  for(const operation of ['status','scan','attachment']){
    const s=setup();try{
      await s.shared();const account=s.broker.officeMailbox.binding(s.base)!.accountId!;
      const change=async()=>{await s.call('policy',{mode:'personal',expectedRevision:4});};
      if(operation==='status')s.options.access=async()=>{await change();return {checkedAt:'',services:{},tools:{available:false,names:[]}};};
      if(operation==='scan')s.options.scan=async()=>{await change();return {} as never;};
      if(operation==='attachment')s.options.attachment=async()=>{await change();return {} as never;};
      const body=operation==='scan'?{expectedAccountId:account,scope:{windowStartAt:s.f.now()-60000,windowEndAt:s.f.now(),includeSent:true,maxMessages:20,carryThreadIds:[]}}:operation==='attachment'?{accountId:account,threadId:'abc',messageId:'def',attachment:{id:'attachment-a',name:'invoice.pdf',mimeType:'application/pdf',size:100}}:undefined;
      await assert.rejects(()=>s.request(s.a.token,operation==='status'?'/v1/connectors/status':operation==='scan'?'/v1/connectors/mail-scan':'/v1/connectors/mail-attachment',body),/connector_binding_changed/);
    }finally{s.f.close();}
  }
});
test('existing MCP session is invalidated by shared policy changes',async()=>{
  const s=setup();try{
    await s.shared();s.options.transport=()=>({async request(){return {};}});const session=(await s.request(s.a.token,'/v1/connectors/mcp',{jsonrpc:'2.0',id:1,method:'initialize'})).session;
    await s.call('grants',{expectedRevision:4,installationId:'desktop-a',allowed:false});
    await assert.rejects(()=>s.request(s.a.token,'/v1/connectors/mcp',{jsonrpc:'2.0',id:2,method:'tools/list'},session),/session_expired/);
  }finally{s.f.close();}
});
test('owner authority revoked during OAuth retains receipt and withholds URL; exact account verification required',async()=>{
  const s=setup();try{
    await s.call('policy',{mode:'shared',expectedRevision:0});
    await assert.rejects(()=>s.broker.officeMailbox.handle(s.f.owner,'authorize',{expectedRevision:1},async()=>{throw Error('owner revoked');}),/owner revoked/);
    assert.equal((await s.call('status') as {state:string}).state,'pending');assert.equal(s.connects(),1);
    s.options.access=async()=>({checkedAt:'',services:{gmail:{connected:true,status:'ACTIVE',accounts:[{id:'wrong-account',status:'ACTIVE'}],accountSelectionRequired:false}},tools:{available:true,names:[]}});
    await assert.rejects(()=>s.call('verify',{expectedRevision:1}),/not_connected/);
  }finally{s.f.close();}
});
test('portal mailbox routes enforce owner role, strict bodies, tenant scope and no raw credentials',async()=>{
  const s=setup();const server=createGatewayServer({connectors:s.broker,allowedOrigins:new Set(),portal:{async authenticate(token){return {...s.f.owner,role:token.includes('reader')?'billing_reader':'billing_owner'};}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/portal/mailbox`;
  try{
    const req=(suffix='',body?:unknown,reader=false)=>fetch(base+suffix,{method:body?'POST':'GET',headers:{authorization:'Bearer '+(reader?'reader':'owner')+'-fictional-token-00000000000000','content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
    assert.equal((await req('',undefined,true)).status,403);
    assert.equal((await req('/policy',{mode:'shared',expectedRevision:0,companyId:'company-b'})).status,400);
    assert.equal((await req('/policy',{mode:'shared',expectedRevision:0})).status,200);
    const result=await(await req()).text();assert.ok(!result.includes('ak_')&&!result.includes('rbc_')&&!result.includes(s.a.tokenHash)&&!result.includes('other'));
    assert.equal((await req('/authorize',{expectedRevision:1})).status,200);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));s.f.close();}
});
test('simultaneous owner OAuth attempts create one intent; policy change holds result while retaining exact receipt',async()=>{
  let finish!:(v:{url:string;accountId:string;expiresAt:string})=>void;
  let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;});
  let attempts=0;const s=setup({authorize:async()=>{attempts++;entered();return new Promise(resolve=>{finish=resolve;});}});
  try{
    await s.call('policy',{mode:'shared',expectedRevision:0});const pending=s.call('authorize',{expectedRevision:1});await started;
    await assert.rejects(()=>s.call('authorize',{expectedRevision:1}),/outcome_unknown/);
    await s.call('policy',{mode:'personal',expectedRevision:1});finish({url:'https://connect.example.invalid/once',accountId:'account-exact',expiresAt:new Date(s.f.now()+60000).toISOString()});
    await assert.rejects(()=>pending,/revision_changed/);assert.equal(attempts,1);
    assert.equal((await s.call('status') as {state:string}).state,'not_connected');
    await s.call('policy',{mode:'shared',expectedRevision:2});await s.call('verify',{expectedRevision:3});assert.equal((await s.call('status') as {candidate:{accountId:string}}).candidate.accountId,'account-exact');
  }finally{s.f.close();}
});
test('grant revocation during an established MCP request withholds provider output',async()=>{
  const s=setup();try{
    await s.shared();s.options.transport=()=>({async request(method){if(method!=='initialize')await s.call('grants',{expectedRevision:4,installationId:'desktop-a',allowed:false});return {content:'synthetic private content'};}});
    const session=(await s.request(s.a.token,'/v1/connectors/mcp',{jsonrpc:'2.0',id:1,method:'initialize'})).session;
    await assert.rejects(()=>s.request(s.a.token,'/v1/connectors/mcp',{jsonrpc:'2.0',id:2,method:'tools/call'},session),/connector_binding_changed/);
  }finally{s.f.close();}
});
test('owner must review provider email and confirm the exact candidate before any desktop grant',async()=>{
  const s=setup();try{
    await s.call('policy',{mode:'shared',expectedRevision:0});await s.call('authorize',{expectedRevision:1});
    const review=await s.call('verify',{expectedRevision:1}) as {state:string;revision:number;candidate:{accountId:string;emailAddress:string}};
    assert.equal(review.state,'review');assert.equal(review.candidate.emailAddress,'office@example.invalid');
    await assert.rejects(()=>s.call('grants',{expectedRevision:2,installationId:'desktop-a',allowed:true}),/confirmation_required/);
    await assert.rejects(()=>s.call('confirm',{expectedRevision:2,...review.candidate,accountId:'other-account'}),/candidate_changed/);
    s.options.transport=(binding)=>({async request(){return {content:[{type:'text',text:JSON.stringify({accountId:binding.accountId,emailAddress:'different@example.invalid'})}]};}});
    await assert.rejects(()=>s.call('confirm',{expectedRevision:2,...review.candidate}),/candidate_changed/);
    assert.equal((await s.call('status') as {state:string}).state,'review');
  }finally{s.f.close();}
});
test('missing identity proof holds owner review; provider profile is never inferred from an alias',async()=>{
  const s=setup({transport:()=>({async request(){return {isError:true,content:[{type:'text',text:'profile unavailable'}]};}})});
  try{
    await s.call('policy',{mode:'shared',expectedRevision:0});await s.call('authorize',{expectedRevision:1});
    await assert.rejects(()=>s.call('verify',{expectedRevision:1}),/identity_unverified/);
    assert.equal((await s.call('status') as {state:string}).state,'pending');
  }finally{s.f.close();}
});
test('shared scan, attachment and MCP require reviewed revision even after revoke/regrant of same account',async()=>{
  const s=setup();try{
    await s.shared();const rev=4;
    await s.call('grants',{expectedRevision:rev,installationId:'desktop-a',allowed:false});await s.call('grants',{expectedRevision:rev+1,installationId:'desktop-a',allowed:true});
    for(const path of ['/v1/connectors/mail-scan','/v1/connectors/mail-attachment','/v1/connectors/mcp']){
      for(const policyRevision of [undefined,rev])await assert.rejects(()=>s.broker.handle({token:s.a.token,profile:'property',method:'POST',path,body:{},policyRevision,signal:new AbortController().signal}),/office_mailbox_review_required/);
    }
    await s.call('policy',{mode:'personal',expectedRevision:6});
    await assert.rejects(()=>s.request(s.a.token,'/v1/connectors/mcp',{jsonrpc:'2.0',id:1,method:'initialize'},undefined,6),/office_mailbox_review_required/);
    await assert.rejects(()=>s.broker.handle({token:s.a.token,profile:'property',method:'POST',path:'/v1/connectors/mcp',body:{jsonrpc:'2.0',id:1,method:'initialize'},signal:new AbortController().signal}),/office_mailbox_review_required/);
    await s.request(s.a.token,'/v1/connectors/mcp',{jsonrpc:'2.0',id:1,method:'initialize'},undefined,7);
  }finally{s.f.close();}
});
test('mode transitions and shared resets require fresh owner verification and confirmation',async()=>{
  const s=setup();try{
    await s.shared();await assert.rejects(()=>s.call('verify',{expectedRevision:4}),/already_confirmed/);
    const personal=await s.call('policy',{mode:'personal',expectedRevision:4}) as {state:string;accountId?:string;candidate?:unknown};
    assert.equal(personal.state,'not_connected');assert.equal(personal.accountId,undefined);assert.equal(personal.candidate,undefined);
    const shared=await s.call('policy',{mode:'shared',expectedRevision:5}) as {state:string};assert.equal(shared.state,'pending');
    await assert.rejects(()=>s.call('grants',{expectedRevision:6,installationId:'desktop-a',allowed:true}),/confirmation_required/);
    const review=await s.call('verify',{expectedRevision:6}) as {candidate:{accountId:string;emailAddress:string}};
    await s.call('confirm',{expectedRevision:7,...review.candidate});await s.call('grants',{expectedRevision:8,installationId:'desktop-a',allowed:true});await s.request();
    await s.call('policy',{mode:'shared',expectedRevision:9});await assert.rejects(()=>s.call('grants',{expectedRevision:10,installationId:'desktop-a',allowed:true}),/confirmation_required/);
  }finally{s.f.close();}
});
test('editing registry profile cannot inherit an installation shared-mail grant',async()=>{
  const s=setup();try{
    await s.shared();s.set(s.getDevices().map(d=>d.id==='a'?{...d,profile:'property-other'}:d));
    await assert.rejects(()=>s.broker.handle({token:s.a.token,profile:'property-other',method:'POST',path:'/v1/connectors/mcp',policyRevision:4,body:{jsonrpc:'2.0',id:1,method:'initialize'},signal:new AbortController().signal}),/desktop_denied/);
  }finally{s.f.close();}
});
test('ungranted or unfinished shared desktops receive safe setup status without provider calls',async()=>{
  const s=setup();try{
    await s.call('policy',{mode:'shared',expectedRevision:0});
    const pending=(await s.request()).body as {sourceKind:string;policyRevision:number;services:{gmail:{connected:boolean;accounts:unknown[]}};tools:{available:boolean;names:string[]}};
    assert.equal(pending.sourceKind,'office_shared');assert.equal(pending.policyRevision,1);assert.equal(pending.services.gmail.connected,false);assert.deepEqual(pending.services.gmail.accounts,[]);assert.deepEqual(pending.tools,{available:false,names:[]});assert.equal(s.reads(),0);
    await s.call('authorize',{expectedRevision:1});const review=await s.call('verify',{expectedRevision:1}) as {candidate:{accountId:string;emailAddress:string}};
    await s.call('confirm',{expectedRevision:2,...review.candidate});await s.call('grants',{expectedRevision:3,installationId:'desktop-a',allowed:true});
    const reads=s.reads(),ungranted=(await s.request(s.b.token)).body as typeof pending;
    assert.equal(ungranted.policyRevision,4);assert.equal(ungranted.sourceKind,'office_shared');assert.equal(ungranted.services.gmail.connected,false);assert.deepEqual(ungranted.services.gmail.accounts,[]);assert.equal(s.reads(),reads);
    const serialized=JSON.stringify(ungranted);assert.ok(!serialized.includes(review.candidate.accountId)&&!serialized.includes(review.candidate.emailAddress));
    await s.call('policy',{mode:'personal',expectedRevision:4});const personal=(await s.request()).body as typeof pending;
    assert.equal(personal.sourceKind,'personal');assert.equal(personal.services.gmail.connected,true);assert.equal(s.seen.at(-1),'personal-a');
  }finally{s.f.close();}
});
