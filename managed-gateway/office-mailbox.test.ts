import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fixture } from './testing.ts';
import type { PortalPrincipal } from './contracts.ts';
import { ManagedConnectors, newConnectorCredential, type ConnectorDevice, type ConnectorOptions } from './connectors.ts';
import { createGatewayServer } from './http.ts';
import { createHmac } from 'node:crypto';
import { officeUserId } from './composio-triggers.ts';
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
test('shared mailbox full access: read-only by default, owner-only versioned grant with exact wording, enforced by the gateway, revocable', async () => {
  const executed: string[] = [];
  const apps = { async listAccounts() { return []; }, async authorize(): Promise<never> { throw new Error('unused'); },
    async upsertTrigger(): Promise<never> { throw new Error('unused'); }, async setTriggerStatus(): Promise<never> { throw new Error('unused'); },
    async listTools(_b: unknown, slug: string) { return ['GMAIL_LIST_THREADS', 'GMAIL_SEND_EMAIL'].map(name => ({ name, description: name, inputSchema: { type: 'object', properties: {} }, policy: (name.includes('SEND') ? 'review' : 'read') as 'read' | 'review' })).filter(() => slug === 'gmail'); },
    async execute(_b: unknown, _s: string, tool: string) { executed.push(tool); return { content: [{ type: 'text', text: '{}' }] }; } };
  const s = setup({ apps });
  try {
    await s.shared();
    s.options.transport = undefined; // The gateway's own transport choice from here on.
    const company = s.f.tenant.companyId;
    const sendOnce = async (id: number) => {
      const opened = await s.request(s.a.token, '/v1/connectors/mcp', { jsonrpc: '2.0', id, method: 'initialize' });
      const reply = await s.request(s.a.token, '/v1/connectors/mcp', { jsonrpc: '2.0', id: id + 1, method: 'tools/call', params: { name: 'GMAIL_SEND_EMAIL', arguments: { recipient_email: 'tenant@example.invalid' } } }, opened.session);
      return (reply.body as { result: { isError?: boolean; content: { text: string }[] } }).result;
    };
    // Default: an existing shared grant stays on the three bounded reads.
    let status = await s.call('status') as { revision: number; fullMailboxAccess: { granted: boolean } };
    assert.deepEqual(status.fullMailboxAccess, { granted: false });
    assert.equal((((await s.request()).body) as { mailboxAccess: string }).mailboxAccess, 'read_only');
    const refused = await sendOnce(1);
    assert.equal(refused.isError, true); assert.match(refused.content[0]!.text, /three fixed Gmail read tools/); assert.deepEqual(executed, []);
    // Only the owner, only with the exact wording, only for the shared mailbox.
    const grant = { mode: 'shared', expectedRevision: status.revision, fullMailboxAccess: true, acknowledgement: 'Bud can draft, label and archive, and send after a per-message approval, from the shared mailbox' };
    await assert.rejects(() => s.call('policy', grant, { ...s.f.owner, role: 'billing_reader' }), /forbidden/);
    await assert.rejects(() => s.call('policy', { ...grant, acknowledgement: 'ok' }), /office_mailbox_access_wording_required/);
    await assert.rejects(() => s.call('policy', { ...grant, extra: true }), /./);
    assert.equal(s.broker.officeMailbox.mailboxAccess(company), 'read_only');
    status = await s.call('policy', grant) as typeof status & { fullMailboxAccess: { granted: boolean; version: number; grantedBy: string; grantedAt: string } };
    assert.deepEqual(status.fullMailboxAccess, { granted: true, version: 1, grantedBy: s.f.owner.subject, grantedAt: new Date(s.f.now()).toISOString() });
    assert.equal(status.revision, 5);
    assert.equal(s.f.ledger.db.all<{ kind: string }>('SELECT kind FROM events WHERE kind LIKE ?', 'office_mailbox_full_access%').length, 1);
    // The desktop is told, and the gateway now runs the mailbox policy for this shared mailbox.
    assert.equal((((await s.request()).body) as { mailboxAccess: string }).mailboxAccess, 'full');
    assert.equal((await sendOnce(3)).isError, undefined); assert.deepEqual(executed, ['GMAIL_SEND_EMAIL']);
    // Revoke: back to the three reads, recorded, revision moved.
    status = await s.call('policy', { mode: 'shared', expectedRevision: 5, fullMailboxAccess: false }) as typeof status;
    assert.deepEqual(status.fullMailboxAccess, { granted: false }); assert.equal(status.revision, 6);
    assert.equal((await sendOnce(5)).isError, true); assert.deepEqual(executed, ['GMAIL_SEND_EMAIL']);
    assert.equal(s.f.ledger.db.all<{ kind: string }>('SELECT kind FROM events WHERE kind = ?', 'office_mailbox_full_access_revoked').length, 1);
    // A grant never survives a mode change, and a personal mailbox cannot carry one.
    await s.call('policy', { ...grant, expectedRevision: 6 });
    await s.call('policy', { mode: 'personal', expectedRevision: 7 });
    assert.equal(s.broker.officeMailbox.policy(company).fullMailboxAccess, undefined);
    await assert.rejects(() => s.call('policy', { ...grant, expectedRevision: 8 }), /office_mailbox_shared_required/);
  } finally { s.f.close(); }
});
test('unfinished Google consent: verify says which step applies, and a lapsed link is replaced only when its account never connected',async()=>{
  let status='INITIATED';
  const s=setup({access:async(binding)=>({checkedAt:'',services:{gmail:{connected:status==='ACTIVE',status,accounts:[{id:binding.accountId!,status}],accountSelectionRequired:false}},tools:{available:false,names:[]}})});
  try{
    await s.call('policy',{mode:'shared',expectedRevision:0});await s.call('authorize',{expectedRevision:1});
    // The live case: link issued, Google sign-in not finished (Composio INITIATED).
    await assert.rejects(()=>s.call('verify',{expectedRevision:1}),/office_mailbox_consent_pending/);
    assert.equal((await s.call('status') as {state:string}).state,'pending');
    // A still-valid link is handed back, never a second provider link.
    await s.call('authorize',{expectedRevision:1});assert.equal(s.connects(),1);
    status='EXPIRED';await assert.rejects(()=>s.call('verify',{expectedRevision:1}),/office_mailbox_link_expired/);
    // Expired by time while still INITIATED: same next step.
    status='INITIATED';s.f.setTime(s.f.now()+120_000);await assert.rejects(()=>s.call('verify',{expectedRevision:1}),/office_mailbox_link_expired/);
    // Lapsed link whose account did connect: verify it instead of issuing another.
    status='ACTIVE';await assert.rejects(()=>s.call('authorize',{expectedRevision:1}),/office_mailbox_verify_required/);assert.equal(s.connects(),1);
    // Lapsed and never connected: one fresh link, journaled, same revision.
    status='INITIATED';const fresh=await s.call('authorize',{expectedRevision:1}) as {revision:number};assert.equal(s.connects(),2);assert.equal(fresh.revision,1);
    assert.equal(s.f.ledger.db.all<{kind:string}>('SELECT kind FROM events WHERE kind=?','office_mailbox_link_replaced').length,1);
    status='ACTIVE';const review=await s.call('verify',{expectedRevision:1}) as {state:string};assert.equal(review.state,'review');
  }finally{s.f.close();}
});
test('a provider that cannot answer keeps a lapsed shared link on hold',async()=>{
  const s=setup();try{
    await s.call('policy',{mode:'shared',expectedRevision:0});await s.call('authorize',{expectedRevision:1});s.f.setTime(s.f.now()+120_000);
    s.options.access=async()=>{throw new Error('provider unavailable');};
    await assert.rejects(()=>s.call('authorize',{expectedRevision:1}),/office_mailbox_link_needs_recovery/);assert.equal(s.connects(),1);
  }finally{s.f.close();}
});
test('both mode: own Gmail per computer, office mailbox only on a granted computer and only when selected',async()=>{
  const s=setup();try{
    await s.shared();const company=s.f.tenant.companyId,office=s.broker.officeMailbox.binding(s.base)!.accountId!;
    // shared -> both keeps the confirmed mailbox, its grants and full access; every desktop re-reviews.
    const both=await s.call('policy',{mode:'both',expectedRevision:4}) as {mode:string;revision:number;state:string;installations:{installationId:string;allowed:boolean}[]};
    assert.equal(both.mode,'both');assert.equal(both.revision,5);assert.equal(both.state,'ready');
    assert.deepEqual(both.installations.filter(i=>i.allowed).map(i=>i.installationId),['desktop-a']);
    await assert.rejects(()=>s.request(s.a.token,'/v1/connectors/mcp',{jsonrpc:'2.0',id:1,method:'initialize'},undefined,4),/office_mailbox_review_required/);
    // A person's own Gmail connects again (refused only in shared).
    s.set(s.getDevices().map(d=>d.id==='b'?{...d,accountId:undefined}:d));
    assert.equal(((await s.request(s.b.token,'/v1/connectors/authorize',{app:'gmail'})).body as {url:string}).url,'https://connect.example.invalid/oauth');assert.equal(s.seen.at(-1),'staff-b');
    // Status: own mailbox by default, the office mailbox beside it on the granted computer only.
    const granted=(await s.request()).body as {sourceKind:string;mailboxMode:string;services:{gmail:{accounts:{id:string}[]}};officeShared:{connected:boolean;accounts:{id:string}[]};mailboxAccess:string;officeMailboxAccess:string};
    assert.equal(granted.sourceKind,'personal');assert.equal(granted.mailboxMode,'both');assert.equal(granted.services.gmail.accounts[0]!.id,'personal-a');
    assert.equal(granted.officeShared.connected,true);assert.equal(granted.officeShared.accounts[0]!.id,office);assert.equal((granted.officeShared.accounts[0] as {label?:string}).label,'office@example.invalid');assert.equal(granted.mailboxAccess,'full');assert.equal(granted.officeMailboxAccess,'read_only');
    const ungranted=(await s.request(s.b.token)).body as typeof granted;assert.equal(ungranted.officeShared.connected,false);assert.deepEqual(ungranted.officeShared.accounts,[]);assert.ok(!JSON.stringify(ungranted).includes(office));
    // MCP: default is the person's own mailbox; the office one needs the selection and the grant.
    const used:string[]=[];s.options.transport=(binding)=>({async request(method){used.push(binding.accountId!);return method==='tools/list'?{tools:[{name:'GMAIL_LIST_THREADS',description:'List threads'}]}:{};}});
    const own=await s.broker.handle({token:s.a.token,profile:'property',method:'POST',path:'/v1/connectors/mcp',policyRevision:5,body:{jsonrpc:'2.0',id:1,method:'initialize'},signal:new AbortController().signal});
    const shared=await s.broker.handle({token:s.a.token,profile:'property',method:'POST',path:'/v1/connectors/mcp',policyRevision:5,mailbox:'office',body:{jsonrpc:'2.0',id:1,method:'initialize'},signal:new AbortController().signal});
    assert.deepEqual(used,['personal-a',office]);
    const list=async(session:string|undefined,mailbox?:'office')=>((await s.broker.handle({token:s.a.token,profile:'property',method:'POST',path:'/v1/connectors/mcp',policyRevision:5,session,...(mailbox?{mailbox}:{}),body:{jsonrpc:'2.0',id:2,method:'tools/list'},signal:new AbortController().signal})).body as {result:{tools:{description:string}[]}}).result.tools[0]!.description;
    assert.match(await list(own.session),/^Your own Gmail/);assert.match(await list(shared.session,'office'),/^Office shared Gmail/);
    // A session is pinned to its mailbox: the other selection cannot reuse it.
    await assert.rejects(()=>list(own.session,'office'),/session_expired/);
    await assert.rejects(()=>s.broker.handle({token:s.b.token,profile:'property',method:'POST',path:'/v1/connectors/mcp',policyRevision:5,mailbox:'office',body:{jsonrpc:'2.0',id:1,method:'initialize'},signal:new AbortController().signal}),/office_mailbox_desktop_denied/);
    // A saved scan names its account: the office account routes to the office mailbox (grant still required).
    let scanned='';s.options.scan=async(binding)=>{scanned=binding.accountId!;return {} as never;};
    const scope={windowStartAt:s.f.now()-60000,windowEndAt:s.f.now(),includeSent:true,maxMessages:20,carryThreadIds:[]};
    await s.request(s.a.token,'/v1/connectors/mail-scan',{expectedAccountId:office,scope});assert.equal(scanned,office);
    await s.request(s.a.token,'/v1/connectors/mail-scan',{expectedAccountId:'personal-a',scope});assert.equal(scanned,'personal-a');
    await assert.rejects(()=>s.request(s.b.token,'/v1/connectors/mail-scan',{expectedAccountId:office,scope}),/office_mailbox_desktop_denied/);
    assert.equal(s.broker.officeMailbox.mailboxAccess(company,'personal'),'full');
    // both -> personal starts the office mailbox over; personal refuses an office selection.
    await s.call('policy',{mode:'personal',expectedRevision:5});
    await assert.rejects(()=>s.broker.handle({token:s.a.token,profile:'property',method:'POST',path:'/v1/connectors/mcp',policyRevision:6,mailbox:'office',body:{jsonrpc:'2.0',id:1,method:'initialize'},signal:new AbortController().signal}),/office_mailbox_shared_required/);
    const back=await s.call('policy',{mode:'both',expectedRevision:6}) as {state:string;installations:{allowed:boolean}[]};
    assert.equal(back.state,'pending');assert.ok(back.installations.every(i=>!i.allowed));
    await assert.rejects(()=>s.call('policy',{mode:'office',expectedRevision:7}),/invalid_mailbox_mode/);
  }finally{s.f.close();}
});
test('mailbox route failures log the operation and code only',async()=>{
  const s=setup();const server=createGatewayServer({connectors:s.broker,allowedOrigins:new Set(),portal:{async authenticate(){return s.f.owner;}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/portal/mailbox`;
  const logged:string[]=[],warn=console.warn;console.warn=(line:string)=>{logged.push(line);};
  try{
    const post=(suffix:string,body:unknown)=>fetch(base+suffix,{method:'POST',headers:{authorization:'Bearer owner-fictional-token-00000000000000','content-type':'application/json'},body:JSON.stringify(body)});
    await post('/policy',{mode:'shared',expectedRevision:0});await post('/authorize',{expectedRevision:1});
    s.options.access=async(binding)=>({checkedAt:'',services:{gmail:{connected:false,status:'INITIATED',accounts:[{id:binding.accountId!,status:'INITIATED'}],accountSelectionRequired:false}},tools:{available:false,names:[]}});
    const res=await post('/verify',{expectedRevision:1});assert.equal(res.status,409);assert.deepEqual(await res.json(),{error:'office_mailbox_consent_pending'});
    assert.deepEqual(logged.map(line=>JSON.parse(line)),[{officeMailbox:'verify',error:'office_mailbox_consent_pending'}]);
  }finally{console.warn=warn;server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));s.f.close();}
});
test('two owner authorizes racing on a lapsed link: one fresh link, the other a clear 409',async()=>{
  let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});let waiting=0,arrived!:()=>void;const both=new Promise<void>(resolve=>{arrived=resolve;});
  const s=setup({access:async(binding)=>{if(++waiting===2)arrived();await gate;return {checkedAt:'',services:{gmail:{connected:false,status:'INITIATED',accounts:[{id:binding.accountId!,status:'INITIATED'}],accountSelectionRequired:false}},tools:{available:false,names:[]}};}});
  try{
    await s.call('policy',{mode:'shared',expectedRevision:0});await s.call('authorize',{expectedRevision:1});s.f.setTime(s.f.now()+120_000);
    const first=s.call('authorize',{expectedRevision:1}),second=s.call('authorize',{expectedRevision:1});await both;release();
    const results=await Promise.allSettled([first,second]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const refused=results.find(r=>r.status==='rejected') as PromiseRejectedResult;assert.match(String(refused.reason?.code??refused.reason),/office_mailbox_link_in_progress/);
    assert.equal(s.connects(),2);assert.equal(s.f.ledger.db.all<{kind:string}>('SELECT kind FROM events WHERE kind=?','office_mailbox_link_replaced').length,1);
  }finally{s.f.close();}
});
test('shared mode refuses a request that asks for the personal mailbox instead of using the office one',async()=>{
  const s=setup();try{
    await s.shared();
    await assert.rejects(()=>s.broker.handle({token:s.a.token,profile:'property',method:'POST',path:'/v1/connectors/mcp',policyRevision:4,mailbox:'personal',body:{jsonrpc:'2.0',id:1,method:'initialize'},signal:new AbortController().signal}),/office_mailbox_personal_not_allowed/);
    assert.equal(s.broker.officeMailbox.source(s.f.tenant.companyId),'office');
  }finally{s.f.close();}
});
test('both mode: revoking a computer ends its office access (shared -> both -> revoke) and leaves its own Gmail',async()=>{
  const s=setup();try{
    await s.shared();await s.call('policy',{mode:'both',expectedRevision:4});
    const mcp=(revision:number,mailbox?:'office')=>s.broker.handle({token:s.a.token,profile:'property',method:'POST',path:'/v1/connectors/mcp',policyRevision:revision,...(mailbox?{mailbox}:{}),body:{jsonrpc:'2.0',id:1,method:'initialize'},signal:new AbortController().signal});
    await mcp(5,'office');
    const revoked=await s.call('grants',{expectedRevision:5,installationId:'desktop-a',allowed:false}) as {installations:{installationId:string;allowed:boolean}[]};
    assert.ok(revoked.installations.every(i=>!i.allowed));
    await assert.rejects(()=>mcp(5,'office'),/office_mailbox_review_required/);
    await assert.rejects(()=>mcp(6,'office'),/office_mailbox_desktop_denied/);
    const status=(await s.request()).body as {officeShared:{connected:boolean;accounts:unknown[]};services:{gmail:{accounts:{id:string}[]}}};
    assert.equal(status.officeShared.connected,false);assert.deepEqual(status.officeShared.accounts,[]);assert.equal(status.services.gmail.accounts[0]!.id,'personal-a');
    await mcp(6);
  }finally{s.f.close();}
});
test('office mailbox trigger events reach granted computers only, and leaving shared mode stops the trigger', async () => {
  const calls: unknown[][] = [];
  const apps = { async listAccounts() { return []; }, async authorize(): Promise<never> { throw new Error('unused'); }, async listTools() { return []; }, async execute(): Promise<never> { throw new Error('unused'); },
    async upsertTrigger(binding: { userId: string; accountId?: string }) { calls.push(['upsert', binding.userId, binding.accountId]); return 'ti_office'; },
    async setTriggerStatus(_binding: unknown, id: string, enabled: boolean) { calls.push(['status', id, enabled]); } };
  const s = setup({ apps });
  try {
    await s.shared();
    const company = s.f.tenant.companyId, account = s.broker.officeMailbox.binding(s.base)!.accountId!;
    // The granted computer turns the trigger on; the gateway binds the office user and account.
    const on = await s.request(s.a.token, '/v1/connectors/triggers', { app: 'gmail', event: 'new-message', enabled: true });
    assert.deepEqual(on.body, { app: 'gmail', event: 'new-message', source: 'office', enabled: true, state: 'enabled' });
    assert.deepEqual(calls[0], ['upsert', officeUserId(company), account]);
    await assert.rejects(() => s.request(s.b.token, '/v1/connectors/triggers', { app: 'gmail', event: 'new-message', enabled: true }), /office_mailbox_desktop_denied/);
    // The office webhook secret is read from the same store (here every name reads the synthetic value).
    const deliver = (id: string) => {
      const raw = JSON.stringify({ type: 'composio.trigger.message', metadata: { trigger_id: 'ti_office', connected_account_id: account, user_id: officeUserId(company) }, data: { message_id: 'gm_office', subject: 'PRIVATE' } });
      const timestamp = String(Math.floor(s.f.now() / 1000));
      return s.broker.triggers.webhook(company, { id, timestamp, signature: `v1,${createHmac('sha256', 'ak_synthetic_office_secret').update(`${id}.${timestamp}.${raw}`).digest('base64')}` }, Buffer.from(raw));
    };
    assert.deepEqual(deliver('msg_office_1'), { received: true });
    const pull = async (token: string) => ((await s.request(token, '/v1/connectors/events', { after: 0 })).body as { events: Array<{ source: string }> }).events;
    assert.deepEqual((await pull(s.a.token)).map(event => event.source), ['office']);
    assert.deepEqual(await pull(s.b.token), []);
    assert.deepEqual(await pull(s.other.token), []);
    // Back to personal: the office mailbox is retired, so is its trigger.
    await s.call('policy', { mode: 'personal', expectedRevision: s.broker.officeMailbox.policy(company).revision });
    assert.deepEqual(calls.at(-1), ['status', 'ti_office', false]);
    assert.deepEqual(deliver('msg_office_2'), { received: true, ignored: true });
  } finally { s.f.close(); }
});
