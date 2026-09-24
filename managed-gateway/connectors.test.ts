import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ManagedConnectors, newConnectorCredential, validateConnectorDevices, type ConnectorDevice } from './connectors.ts';
import { fixture } from './testing.ts';
import { createGatewayServer } from './http.ts';
import type { MailScanRequest, MailScanResult } from '../shared/mail-ingestion.ts';

function setup() {
  const f=fixture(), credential=newConnectorCredential();
  let devices:ConnectorDevice[]=[{id:'connector-one',companyId:f.tenant.companyId,licenseId:f.tenant.licenseId,
    memberId:'member-a',installationId:'installation-a',profile:'property',tokenHash:credential.tokenHash,active:true,
    expiresAt:f.now()+3600_000,projectKeyEnv:'REALBUD_COMPOSIO_PROJECT_A',authConfigId:'auth-a',userId:'user-a',accountId:'account-a'}];
  let calls=0, captured:unknown;
  const access=async(binding:unknown)=>{calls++;captured=binding;return {checkedAt:new Date(f.now()).toISOString(),services:{gmail:{connected:true,status:'ACTIVE',accounts:[{id:'account-a',status:'ACTIVE'}],accountSelectionRequired:false}},tools:{available:true,names:['GMAIL_GET_PROFILE']}};};
  const make=(overrides:Partial<ConstructorParameters<typeof ManagedConnectors>[0]>={})=>new ManagedConnectors({ledger:f.ledger,devices:()=>devices,
    secret:()=> 'ak_fictional_vendor_secret',access,transport:()=>({async request(method){calls++;return method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'Fictional',version:'1'}}:{content:[{type:'text',text:'Fictional projected result'}]};}}),...overrides});
  const request={token:credential.token,profile:'property',method:'GET',path:'/v1/connectors/status',signal:new AbortController().signal};
  return {f,credential,make,request,calls:()=>calls,captured:()=>captured,device:()=>devices[0]!,set:(next:ConnectorDevice[])=>{devices=next;}};
}
test('registry admits scoped hashed credentials and rejects duplicate or secret-bearing records',()=>{
  const s=setup();try {
    assert.equal(validateConnectorDevices({version:1,devices:[s.device()]}).length,1);
    for(const devices of [[s.device(),s.device()],[{...s.device(),apiKey:'ak_secret'}],[{...s.device(),projectKeyEnv:'PATH'}],[{...s.device(),tokenHash:s.credential.token}]])assert.throws(()=>validateConnectorDevices({version:1,devices}));
  }finally{s.f.close();}
});
test('the per-device apps allowlist defaults to gmail and refuses an unknown or unadmitted app before any binding is read',async()=>{
  const s=setup();try {
    // An older registry entry, written before the allowlist existed, keeps its
    // original Gmail-only grant.
    const legacy={...s.device()};delete (legacy as Partial<ConnectorDevice>).apps;
    assert.deepEqual(validateConnectorDevices({version:1,devices:[legacy]})[0]!.apps,['gmail']);
    for(const apps of [[],'gmail',['gmail','gmail'],['Gmail'],['../gmail'],[1]])assert.throws(()=>validateConnectorDevices({version:1,devices:[{...legacy,apps}]}),/invalid_connector_apps/);

    const broker=s.make();
    // An app with no adapter here is refused even when a registry entry claims it.
    s.set([{...s.device(),apps:['calendar']}]);
    const authorize={...s.request,method:'POST',path:'/v1/connectors/authorize',body:{app:'calendar'}};
    await assert.rejects(()=>broker.handle(authorize),/connector_app_not_admitted/);
    // Gmail requests are refused once the device no longer admits gmail.
    for(const request of [s.request,
      {...s.request,method:'POST',path:'/v1/connectors/authorize',body:{app:'gmail'}},
      {...s.request,method:'POST',path:'/v1/connectors/mcp',body:{jsonrpc:'2.0',id:1,method:'initialize'}},
      {...s.request,method:'POST',path:'/v1/connectors/mail-scan',body:{expectedAccountId:'account-a',scope:mailScope(s.f.now())}}]) {
      await assert.rejects(()=>broker.handle(request),/connector_app_not_admitted/);
    }
    assert.equal(s.calls(),0);
    // Restored, the same requests reach the adapter and the status reports the grant.
    s.set([{...s.device(),apps:['gmail']}]);
    const reply=await broker.handle(s.request);
    assert.deepEqual((reply.body as {apps:string[]}).apps,['gmail']);
    assert.equal(s.calls(),1);
  }finally{s.f.close();}
});
test('service expiry, suspension, token revocation, wrong profile/license deny before provider access',async()=>{
  const s=setup();try {
    const broker=s.make();
    await assert.rejects(()=>broker.handle({...s.request,token:'rbc_'+'0'.repeat(64)}));
    await assert.rejects(()=>broker.handle({...s.request,profile:'property-member-b'}));
    s.f.ledger.setService(s.f.tenant.companyId,false,s.f.tenant.serviceExpiresAt,'fixture-suspension');
    await assert.rejects(()=>broker.handle(s.request),/service_unavailable/);
    s.f.ledger.setService(s.f.tenant.companyId,true,s.f.now(),'fixture-expired');
    await assert.rejects(()=>broker.handle(s.request),/service_unavailable/);
    s.f.ledger.setService(s.f.tenant.companyId,true,s.f.now()+3600_000,'fixture-resumed');
    const original={...s.device()};s.set([{...original,active:false}]);await assert.rejects(()=>broker.handle(s.request));
    s.set([{...original,licenseId:'another-license'}]);await assert.rejects(()=>broker.handle(s.request));
    assert.equal(s.calls(),0);
  }finally{s.f.close();}
});
test('successful account status uses server binding and never returns project credentials',async()=>{
  const s=setup();try {
    const reply=await s.make().handle(s.request);
    assert.equal(reply.status,200);assert.equal(s.calls(),1);
    const {assertAuthority,...binding}=s.captured() as Record<string,unknown>;
    assert.equal(typeof assertAuthority,'function');
    assert.deepEqual(binding,{apiKey:'ak_fictional_vendor_secret',authConfigId:'auth-a',userId:'user-a',accountId:'account-a'});
    assert.ok(!JSON.stringify(reply).includes('ak_fictional'));
  }finally{s.f.close();}
});
test('revocation during a read withholds its data',async()=>{
  const s=setup();try {
    const broker=s.make({access:async()=>{s.set([{...s.device(),active:false}]);return {checkedAt:new Date().toISOString(),services:{},tools:{available:false,names:[]}};}});
    await assert.rejects(()=>broker.handle(s.request),/connector_access_denied/);
  }finally{s.f.close();}
});
test('MCP session is bound to device and configuration and does not survive expiry',async()=>{
  const s=setup();try {
    const broker=s.make(), initialize={...s.request,method:'POST',path:'/v1/connectors/mcp',body:{jsonrpc:'2.0',id:1,method:'initialize'}};
    const reply=await broker.handle(initialize);assert.match(reply.session!,/^[a-f0-9]{64}$/);
    const call={...initialize,session:reply.session,body:{jsonrpc:'2.0',id:2,method:'tools/list'}};
    assert.equal((await broker.handle(call)).status,200);
    const other=newConnectorCredential();s.set([s.device(),{...s.device(),id:'connector-two',tokenHash:other.tokenHash}]);
    await assert.rejects(()=>broker.handle({...call,token:other.token}),/connector_session_expired/);
    s.f.setTime(s.f.now()+300_001);await assert.rejects(()=>broker.handle(call),/connector_session_expired/);
  }finally{s.f.close();}
});
test('unknown sign-in link outcome remains held after retry and service restart',async()=>{
  const s=setup();try {
    const device={...s.device()};delete device.accountId;s.set([device]);let calls=0;
    const options={authorize:async()=>{calls++;throw new Error('Synthetic response loss with confidential provider detail');}};
    const request={...s.request,method:'POST',path:'/v1/connectors/authorize',body:{app:'gmail'}};
    await assert.rejects(()=>s.make(options).handle(request),/connector_check_failed/);
    await assert.rejects(()=>s.make(options).handle(request),/connector_link_outcome_unknown/);assert.equal(calls,1);
  }finally{s.f.close();}
});
test('successful sign-in link is reused, account pinned, changed binding held',async()=>{
  const s=setup();try {
    const device={...s.device()};delete device.accountId;s.set([device]);let calls=0;
    const options={authorize:async()=>{calls++;return {url:'https://connect.composio.dev/fictional',accountId:'account-linked',expiresAt:new Date(s.f.now()+60000).toISOString()};}};
    const request={...s.request,method:'POST',path:'/v1/connectors/authorize',body:{app:'gmail'}};
    await s.make(options).handle(request);const result=await s.make(options).handle(request);assert.equal(calls,1);assert.deepEqual(result.body,{url:'https://connect.composio.dev/fictional'});
    await s.make().handle(s.request);assert.equal((s.captured() as {accountId:string}).accountId,'account-linked');
    s.set([{...s.device(),userId:'user-b'}]);await assert.rejects(()=>s.make().handle(request),/connector_binding_changed_needs_recovery/);
  }finally{s.f.close();}
});
test('a lapsed sign-in link is replaced by a fresh one only once the provider says its account never connected',async()=>{
  const s=setup();try {
    const device={...s.device()};delete device.accountId;s.set([device]);
    let links=0,checks=0,lapsedStatus:'INITIATED'|'ACTIVE'|'unsure'='unsure',loseNext=false,seen:string|undefined;
    const broker=s.make({
      authorize:async()=>{links++;if(loseNext){loseNext=false;throw new Error('Synthetic response loss with confidential provider detail');}
        return {url:`https://connect.composio.dev/fictional-${links}`,accountId:`account-linked-${links}`,expiresAt:new Date(s.f.now()+60_000).toISOString()};},
      access:async binding=>{checks++;seen=binding.accountId;if(lapsedStatus==='unsure')throw new Error('Synthetic provider outage with confidential detail');
        return {checkedAt:new Date(s.f.now()).toISOString(),services:{gmail:{connected:lapsedStatus==='ACTIVE',status:lapsedStatus,accounts:[{id:binding.accountId!,status:lapsedStatus}],accountSelectionRequired:false}},tools:{available:false,names:[]}};},
    });
    const request={...s.request,method:'POST',path:'/v1/connectors/authorize',body:{app:'gmail'}};
    const row=()=>s.f.ledger.db.get<{state:string;result:string|null}>('SELECT state,result FROM connector_links WHERE device=?',device.id)!;
    const events=()=>s.f.ledger.db.all<{kind:string;body:string}>("SELECT kind,body FROM events WHERE kind LIKE 'connector_link_%'").map(e=>e.kind);
    assert.deepEqual((await broker.handle(request)).body,{url:'https://connect.composio.dev/fictional-1'});
    // Live: reused as before, and the provider is not asked about it.
    assert.deepEqual((await broker.handle(request)).body,{url:'https://connect.composio.dev/fictional-1'});
    assert.equal(links,1);assert.equal(checks,0);
    s.f.setTime(s.f.now()+60_001);
    // Lapsed, provider unsure: the hold stays, nothing is replaced.
    await assert.rejects(()=>broker.handle(request),/connector_link_expired_needs_recovery/);
    assert.equal(links,1);assert.equal(checks,1);assert.equal(row().state,'ready');
    // Lapsed, but the account it initiated did connect: it is this device's
    // account, so no fresh link may adopt another one.
    lapsedStatus='ACTIVE';
    await assert.rejects(()=>broker.handle(request),/connector_account_already_bound/);
    assert.equal(links,1);assert.equal(JSON.parse(row().result!).accountId,'account-linked-1');
    // Lapsed and never connected: one fresh link replaces it, on the same row.
    lapsedStatus='INITIATED';
    assert.deepEqual((await broker.handle(request)).body,{url:'https://connect.composio.dev/fictional-2'});
    assert.equal(links,2);
    assert.equal(s.f.ledger.db.all('SELECT device FROM connector_links').length,1);
    assert.deepEqual({...row()},{state:'ready',result:JSON.stringify({url:'https://connect.composio.dev/fictional-2',accountId:'account-linked-2',expiresAt:new Date(s.f.now()+60_000).toISOString()})});
    assert.deepEqual(events(),['connector_link_requested','connector_link_replaced']);
    // The new link is the one reused, and its account is the one status pins.
    assert.deepEqual((await broker.handle(request)).body,{url:'https://connect.composio.dev/fictional-2'});
    assert.equal(links,2);
    await broker.handle(s.request);assert.equal(seen,'account-linked-2');
    // A replacement whose reply is lost is held exactly as a first attempt's would be.
    s.f.setTime(s.f.now()+60_001);loseNext=true;
    await assert.rejects(()=>broker.handle(request),/connector_check_failed/);
    await assert.rejects(()=>broker.handle(request),/connector_link_outcome_unknown/);
    assert.equal(links,3);assert.equal(row().state,'unknown');
  }finally{s.f.close();}
});
test('HTTP bearer is independent of portal auth and rejects browser origin and supplied upstream identity',async()=>{
  const s=setup();const server=createGatewayServer({allowedOrigins:new Set(),portal:{async authenticate(){throw new Error('No portal identity');}},connectors:s.make()});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number},base=`http://127.0.0.1:${address.port}`;
  const headers={authorization:`Bearer ${s.credential.token}`,'x-realbud-profile':'property'};
  try {
    assert.equal((await fetch(`${base}/v1/connectors/status`)).status,403);
    const response=await fetch(`${base}/v1/connectors/status`,{headers});assert.equal(response.status,200);assert.equal((await response.json() as {managed:boolean}).managed,true);
    assert.equal((await fetch(`${base}/v1/connectors/status`,{headers:{...headers,origin:'https://evil.invalid'}})).status,403);
    assert.equal((await fetch(`${base}/v1/connectors/authorize`,{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({app:'gmail',userId:'other-user'})})).status,400);
    s.f.ledger.setService(s.f.tenant.companyId,false,s.f.tenant.serviceExpiresAt,'fixture-unpaid');
    assert.equal((await fetch(`${base}/v1/connectors/status`,{headers})).status,402);assert.equal(s.calls(),1);
  }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));s.f.close();}
});

function mailScope(now: number): MailScanRequest {
  return { windowStartAt: now - 7 * 86_400_000, windowEndAt: now, includeSent: true, maxMessages: 100, carryThreadIds: [] };
}
function mailResult(scope: MailScanRequest): MailScanResult {
  return { accountId: 'account-a', windowStartAt: scope.windowStartAt, windowEndAt: scope.windowEndAt, pages: 1, paginationComplete: true, threads: [], gaps: [] };
}
test('mail scan uses the server-owned account binding and refuses caller authority fields before upstream', async () => {
  const s = setup(); let calls = 0;
  try {
    const scope = mailScope(s.f.now());
    const broker = s.make({ scan: async (binding, request) => {
      calls++; binding.assertAuthority?.();
      assert.deepEqual({ ...binding, assertAuthority: undefined }, { apiKey: 'ak_fictional_vendor_secret', authConfigId: 'auth-a', userId: 'user-a', accountId: 'account-a', assertAuthority: undefined });
      assert.deepEqual(request, scope); return mailResult(request);
    } });
    const request = { ...s.request, method: 'POST', path: '/v1/connectors/mail-scan', body: { expectedAccountId: 'account-a', scope } };
    for (const patch of [{ accountId: 'other-account' }, { userId: 'other-user' }, { apiKey: 'ak_hostile_key' }, { maxMessages: 501 }, { carryThreadIds: ['abc', 'abc'] }]) {
      await assert.rejects(() => broker.handle({ ...request, body: { expectedAccountId: 'account-a', scope: { ...scope, ...patch } } }));
    }
    assert.equal(calls, 0);
    const result = await broker.handle(request);
    assert.deepEqual(result, { status: 200, body: mailResult(scope) });
    assert.equal(calls, 1); assert.ok(!JSON.stringify(result).includes('ak_fictional'));
  } finally { s.f.close(); }
});

test('mail scan enforces token, profile, current subscription and device authority before upstream', async () => {
  const s = setup(); let calls = 0;
  try {
    const broker = s.make({ scan: async (_binding, scope) => { calls++; return mailResult(scope); } });
    const request = { ...s.request, method: 'POST', path: '/v1/connectors/mail-scan', body: { expectedAccountId: 'account-a', scope: mailScope(s.f.now()) } };
    await assert.rejects(() => broker.handle({ ...request, token: 'rbc_' + '0'.repeat(64) }));
    await assert.rejects(() => broker.handle({ ...request, profile: 'another-profile' }));
    const original = { ...s.device() };
    for (const patch of [{ active: false }, { licenseId: 'another-license' }]) {
      s.set([{ ...original, ...patch }]); await assert.rejects(() => broker.handle(request));
    }
    s.set([original]);
    s.f.ledger.setService(s.f.tenant.companyId, true, s.f.now(), 'fixture-expired');
    await assert.rejects(() => broker.handle(request), /service_unavailable/);
    assert.equal(calls, 0);
  } finally { s.f.close(); }
});

test('a renewed entitlement keeps an existing connector working past its stored device expiry; an expired one still refuses', async () => {
  const s = setup(); let calls = 0;
  try {
    const broker = s.make({ scan: async (_binding, scope) => { calls++; return mailResult(scope); } });
    const original = s.f.tenant.serviceExpiresAt;
    // The device carries the entitlement expiry copied at provisioning time.
    s.set([{ ...s.device(), expiresAt: original }]);
    const entitlement = { companyId: s.f.tenant.companyId, licenseId: s.f.tenant.licenseId, active: true, customerName: s.f.tenant.customerName,
      customerAddress: s.f.tenant.customerAddress, goLiveAt: s.f.tenant.goLiveAt, goLiveEvidence: s.f.tenant.goLiveEvidence };
    s.f.ledger.putEntitlement({ ...entitlement, serviceExpiresAt: original + 365 * 86_400_000 }, 'fixture-renewal');
    s.f.setTime(original + 86_400_000);
    const request = { ...s.request, method: 'POST', path: '/v1/connectors/mail-scan', body: { expectedAccountId: 'account-a', scope: mailScope(s.f.now()) } };
    assert.equal((await broker.handle(request)).status, 200);
    assert.equal(calls, 1);
    // The current entitlement, not the stored copy, decides: once it lapses the connector stops.
    s.f.ledger.putEntitlement({ ...entitlement, serviceExpiresAt: s.f.now() }, 'fixture-lapsed');
    await assert.rejects(() => broker.handle({ ...request, body: { expectedAccountId: 'account-a', scope: mailScope(s.f.now()) } }), /service_unavailable/);
    assert.equal(calls, 1);
  } finally { s.f.close(); }
});

test('mail scan suppresses returned evidence when subscription or device changes while the provider is pending', async () => {
  for (const mutation of ['revoked', 'expired', 'rebound'] as const) {
    const s = setup(); let release!: () => void, entered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    try {
      const broker = s.make({ scan: async (_binding, scope) => { entered(); await pending; return mailResult(scope); } });
      const scan = broker.handle({ ...s.request, method: 'POST', path: '/v1/connectors/mail-scan', body: { expectedAccountId: 'account-a', scope: mailScope(s.f.now()) } });
      await started;
      if (mutation === 'expired') s.f.ledger.setService(s.f.tenant.companyId, true, s.f.now(), 'fixture-expired');
      else s.set([{ ...s.device(), ...(mutation === 'revoked' ? { active: false } : { accountId: 'other-account' }) }]);
      release();
      await assert.rejects(() => scan, mutation === 'expired' ? /service_unavailable/ : mutation === 'revoked' ? /connector_access_denied/ : /connector_binding_changed/);
    } finally { release(); s.f.close(); }
  }
});

test('mail scan admits one active operation per device and releases the guard after a cancelled operation', async () => {
  const s = setup(); const abort = new AbortController(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
  try {
    let calls = 0;
    const broker = s.make({ scan: async (binding, scope) => { calls++; if (calls === 1) { entered(); await pending; binding.assertAuthority?.(); } return mailResult(scope); } });
    const request = { ...s.request, method: 'POST', path: '/v1/connectors/mail-scan', body: { expectedAccountId: 'account-a', scope: mailScope(s.f.now()) } };
    const first = broker.handle({ ...request, signal: abort.signal });
    await started;
    await assert.rejects(() => broker.handle(request), /connector_busy/);
    abort.abort(); release(); await assert.rejects(() => first);
    assert.equal((await broker.handle(request)).status, 200);
    assert.equal(calls, 2);
  } finally { release(); s.f.close(); }
});

test('HTTP mail scan rejects malformed scope and returns bounded projected evidence with independent device authentication', async () => {
  const s = setup(); let calls = 0;
  const server = createGatewayServer({ allowedOrigins: new Set(),
    portal: { async authenticate() { throw new Error('No portal identity'); } },
    connectors: s.make({ scan: async (_binding, scope) => { calls++; return mailResult(scope); } }) });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/connectors/mail-scan`;
  const headers = { authorization: `Bearer ${s.credential.token}`, 'x-realbud-profile': 'property', 'content-type': 'application/json' };
  try {
    const scope = mailScope(s.f.now());
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify(scope) })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ expectedAccountId: 'other-account', scope }) })).status, 409);
    assert.equal((await fetch(url, { method: 'POST', headers, body: JSON.stringify({ expectedAccountId: 'account-a', scope: { ...scope, accountId: 'other' } }) })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'x-realbud-profile': 'other-profile' }, body: JSON.stringify({ expectedAccountId: 'account-a', scope }) })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, origin: 'https://evil.invalid' }, body: JSON.stringify({ expectedAccountId: 'account-a', scope }) })).status, 403);
    assert.equal(calls, 0);
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ expectedAccountId: 'account-a', scope }) });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), mailResult(scope)); assert.equal(calls, 1);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); s.f.close(); }
});

test('mail scan account precondition rejects missing legacy input and stale reviewed identity before any provider call', async () => {
  const s = setup(); let calls = 0;
  try {
    const broker = s.make({ scan: async (binding, scope) => { calls++; return { ...mailResult(scope), accountId: binding.accountId! }; } });
    const scope = mailScope(s.f.now()), request = { ...s.request, method: 'POST', path: '/v1/connectors/mail-scan' };
    for (const body of [scope, { scope }, { scope, expectedAccountId: null }, { scope, expectedAccountId: '' }, { scope, expectedAccountId: '../account-a' }, { scope, expectedAccountId: 17 }]) {
      await assert.rejects(() => broker.handle({ ...request, body }), /mail_scan_account_review_required/);
    }
    await assert.rejects(() => broker.handle({ ...request, body: { expectedAccountId: 'account-a', scope, accountId: 'account-a' } }));
    // Status was reviewed for A; the protected registry is rebound to B before scan.
    await broker.handle(s.request);
    s.set([{ ...s.device(), accountId: 'account-b' }]);
    await assert.rejects(() => broker.handle({ ...request, body: { expectedAccountId: 'account-a', scope } }), /mail_scan_account_binding_changed/);
    assert.equal(calls, 0);
    const result = await broker.handle({ ...request, body: { expectedAccountId: 'account-b', scope } });
    assert.equal((result.body as MailScanResult).accountId, 'account-b'); assert.equal(calls, 1);
  } finally { s.f.close(); }
});

test('mail scan precondition resolves the saved connected account and holds an unbound or changed saved connection before provider', async () => {
  const s = setup(); let calls = 0;
  try {
    const device = { ...s.device() }; delete device.accountId; s.set([device]);
    const saved = { url: 'https://connect.composio.dev/fictional', accountId: 'account-a', expiresAt: new Date(s.f.now() + 60_000).toISOString() };
    const broker = s.make({ authorize: async () => saved, scan: async (_binding, scope) => { calls++; return mailResult(scope); } });
    const request = { ...s.request, method: 'POST', path: '/v1/connectors/mail-scan', body: { expectedAccountId: 'account-a', scope: mailScope(s.f.now()) } };
    await assert.rejects(() => broker.handle(request), /mail_scan_account_binding_changed/); assert.equal(calls, 0);
    await broker.handle({ ...s.request, method: 'POST', path: '/v1/connectors/authorize', body: { app: 'gmail' } });
    assert.equal((await broker.handle(request)).status, 200); assert.equal(calls, 1);
    s.f.ledger.db.run('UPDATE connector_links SET result=? WHERE device=?', JSON.stringify({ ...saved, accountId: 'account-b' }), device.id);
    await assert.rejects(() => broker.handle(request), /mail_scan_account_binding_changed/); assert.equal(calls, 1);
  } finally { s.f.close(); }
});

test('saved-account rebinding during scan fails its next authority checkpoint before another provider read', async () => {
  const s = setup(); let reads = 0;
  try {
    const device = { ...s.device() }; delete device.accountId; s.set([device]);
    const saved = { url: 'https://connect.composio.dev/fictional', accountId: 'account-a', expiresAt: new Date(s.f.now() + 60_000).toISOString() };
    const broker = s.make({ authorize: async () => saved, scan: async (binding, scope) => {
      binding.assertAuthority?.(); reads++;
      s.f.ledger.db.run('UPDATE connector_links SET result=? WHERE device=?', JSON.stringify({ ...saved, accountId: 'account-b' }), device.id);
      binding.assertAuthority?.(); reads++; return mailResult(scope);
    } });
    await broker.handle({ ...s.request, method: 'POST', path: '/v1/connectors/authorize', body: { app: 'gmail' } });
    await assert.rejects(() => broker.handle({ ...s.request, method: 'POST', path: '/v1/connectors/mail-scan', body: { expectedAccountId: 'account-a', scope: mailScope(s.f.now()) } }), /mail_scan_account_binding_changed/);
    assert.equal(reads, 1);
  } finally { s.f.close(); }
});

const pdfSource={accountId:'account-a',threadId:'abc',messageId:'ab',attachment:{id:'pdf-a',name:'fictional.pdf',mimeType:'application/pdf' as const,size:10}};
test('PDF acquisition is bound to the device account and withholds data after revocation',async()=>{
  const s=setup();let calls=0;const bytes={...pdfSource,bytesBase64:'JVBERi0xLjQKAA==',sha256:'a'.repeat(64)};
  try {
    const broker=s.make({attachment:async(binding,source)=>{calls++;binding.assertAuthority?.();assert.deepEqual(source,pdfSource);return bytes;}});
    const request={...s.request,method:'POST',path:'/v1/connectors/mail-attachment',body:pdfSource};
    assert.deepEqual((await broker.handle(request)).body,bytes);assert.equal(calls,1);
    await assert.rejects(()=>broker.handle({...request,body:{...pdfSource,accountId:'other'}}),/mail_attachment_account_binding_changed/);assert.equal(calls,1);
    const revoked=s.make({attachment:async()=>{s.set([{...s.device(),active:false}]);return bytes;}});
    await assert.rejects(()=>revoked.handle(request),/connector_access_denied/);
  }finally{s.f.close();}
});
test('PDF acquisition refuses unadmitted apps and caller-supplied upstream authority',async()=>{
  const s=setup();let calls=0;try {
    const broker=s.make({attachment:async()=>{calls++;throw Error('must not call');}});
    const request={...s.request,method:'POST',path:'/v1/connectors/mail-attachment',body:pdfSource};
    await assert.rejects(()=>broker.handle({...request,body:{...pdfSource,url:'https://evil.invalid'}}));assert.equal(calls,0);
    s.set([{...s.device(),apps:['calendar']}]);await assert.rejects(()=>broker.handle(request));assert.equal(calls,0);
  }finally{s.f.close();}
});
