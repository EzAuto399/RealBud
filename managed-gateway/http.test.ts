import { syncTestResalePolicy } from './testing-resale-policy.ts';
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { careTermsDraft, fixture } from './testing.ts';
import { createGatewayServer } from './http.ts';
import { BillingService, type HostedPaymentAdapter } from './billing.ts';
import { GatewayError } from './contracts.ts';
import { bindOfficeCustomer, fileSecretStore, InstallationProvisioning, modelviaOperatorState } from './provisioning.ts';
import { modelviaKeyClient } from './modelvia-keys.ts';
import type { HttpTransport } from './composio-org.ts';
import { composeGateway } from './composition.ts';
import { signOperatorToken, verifyOperatorToken } from './operator-token.ts';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { readServiceEntitlement } from '../server/service-entitlement.ts';
import { serviceIssuerFromEnv, type ServiceIssuer } from './service-entitlement-issuer.ts';

const cleanups:(()=>Promise<void>)[]=[];afterEach(async()=>{while(cleanups.length)await cleanups.pop()!();});
const OWNER='synthetic-portal-token-owner-000001',READER='synthetic-portal-token-reader-00001',UNKNOWN='synthetic-portal-token-unknown-0001';

test('the public connection return shows RealBud and treats all callback data as unverified', async () => {
  let authenticated = 0;
  const server = createGatewayServer({ allowedOrigins: new Set(), portal: { async authenticate() {
    authenticated++; throw new Error('completion must not authenticate or change an account');
  } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  cleanups.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/connections/complete`;
  const response = await fetch(base), html = await response.text();
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type')!, /^text\/html/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(response.headers.get('content-security-policy')!, /default-src 'none'/);
  assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(html, /https:\/\/realbud\.app\/realbud-mark-email\.png/);
  assert.match(html, /Continue in RealBud/); assert.match(html, /Check access/);
  for (const status of ['success', 'failed']) {
    const query = new URLSearchParams({ status, connected_account_id: 'untrusted-account', user_id: 'untrusted-user',
      error: '<script>alert(1)</script>', next: 'https://untrusted.invalid/', token: 'private-callback-token' });
    const callback = await fetch(`${base}?${query}`);
    assert.equal(callback.status, 200);
    assert.equal(await callback.text(), html);
    assert.equal(callback.headers.get('location'), null);
    assert.equal(callback.headers.get('set-cookie'), null);
  }
  assert.equal(authenticated, 0);
});

/** The real Modelvia client over a stand-in shaped like Modelvia's operator
 * routes, and a provisioning composition around it. Everything is fictional. */
const OPERATOR_SECRET='fictional-gateway-operator-secret-000001';
async function serverFixture(options:{provisioning?:boolean;customer?:Record<string,unknown>;serviceIssuer?:ServiceIssuer;operator?:boolean}={}) {
  const f=fixture(),root=mkdtempSync(join(tmpdir(),'realbud-http-'));
  bindOfficeCustomer(f.ledger,f.tenant.companyId,'cus-fictional-office');
  const modelviaCalls:string[]=[];
  const customer={id:'cus-fictional-office',clientId:'realbud',name:'Fictional office',active:true,monthlyCapNanoAud:'100000000000',maxConcurrent:4,allowedModels:['auto'],version:1,...options.customer};
  const projects=new Map<string,Record<string,unknown>>();
  const fetchLike:HttpTransport=async(url,init)=>{
    const path=new URL(url).pathname,body=init.body===undefined?undefined:JSON.parse(String(init.body)) as Record<string,unknown>;
    modelviaCalls.push(`${init.method} ${path}`);
    if(path==='/v1/operator/customers' && init.method==='GET') return Response.json({accounts:[customer]});
    if(path==='/v1/operator/projects' && init.method==='GET') return Response.json({accounts:[...projects.values()]});
    if(path==='/v1/operator/projects'){const saved:Record<string,unknown>={...body!,version:1};projects.set(saved.id as string,saved);return Response.json(saved);}
    if(path==='/v1/operator/keys') return Response.json({key:`rbk_0123456789abcdef_${'A'.repeat(43)}`,record:{id:'0123456789abcdef',project:body!.projectId}});
    if(/\/revoke$/.test(path)) return Response.json({});
    return Response.json({error:'not_found'},{status:404});
  };
  const modelvia=modelviaKeyClient({serviceOrigin:'https://api.modelvia.dev',environment:'production',clientId:'realbud',allowedModels:['auto'],
    scopedSecret:()=>'fictional-modelvia-operator-secret-32ch',operatorSubject:'realbud-provisioning',fetch:fetchLike,now:f.now});
  const created:{id:string;name:string}[]=[];
  const org={async listProjects(){return created.map(p=>({...p}));},async createProject(name:string){const project={id:`pr_${created.length+1}`,name};created.push(project);return {...project,apiKey:'ak_fictional_project_key_for_tests'};},async deleteProject(){return {revokeJobId:'job-fictional'};}};
  const provisioning=options.provisioning===false?undefined:new InstallationProvisioning({ledger:f.ledger,registry:join(root,'devices.json'),endpoint:'https://managed.example.invalid',
    secrets:fileSecretStore(join(root,'secrets')),org,modelvia,authConfigs:{resolveGmail:async () => 'ac-fictional-readonly'},
    ...(options.serviceIssuer?{serviceIssuer:options.serviceIssuer}:{})});
  const server=createGatewayServer({allowedOrigins:new Set(['https://portal.invalid']),...(provisioning?{provisioning}:{}),
    ...(options.operator?{operator:{authenticate:async(bearer:string)=>verifyOperatorToken(bearer,OPERATOR_SECRET)}}:{}),portal:{async authenticate(bearer){
    if(bearer===OWNER)return f.owner;if(bearer===READER)return {...f.owner,role:'billing_reader'};
    // A signed-in portal user whose company the operator has not entitled.
    if(bearer===UNKNOWN)return {...f.owner,companyId:'company-unentitled'};
    throw new GatewayError('unauthenticated',401);}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();rmSync(root,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request=(method:string,path:string,bearer:string|null=OWNER,body?:unknown,extra:Record<string,string>={})=>fetch(base+path,{method,
    headers:{...(bearer?{Authorization:`Bearer ${bearer}`}:{}),...(body===undefined?{}:{'Content-Type':'application/json'}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const provisionBody={companyId:f.tenant.companyId,installationId:'install-one',customerId:'cus-fictional-office',profile:'property'};
  return {...f,base,request,provisionBody,modelviaCalls,projects,created};
}

test('an operator creates an office connector project at office creation; the first desktop link reuses it', async()=>{
  const s=await serverFixture({operator:true});
  const token=signOperatorToken('ops@realbud.example',OPERATOR_SECRET,Date.now());
  const path=`/v1/operator/offices/${s.tenant.companyId}/connector-project`;
  // Operator bearer only: none, a portal token, a foreign secret's token.
  for(const bearer of [null,OWNER,signOperatorToken('ops@realbud.example','another-secret-that-is-long-enough-000001')]) {
    const refused=await s.request('POST',path,bearer);
    assert.equal(refused.status,401);assert.deepEqual(await refused.json(),{error:'operator_unauthenticated'});
  }
  assert.equal(s.created.length,0);
  const first=await s.request('POST',path,token);
  assert.equal(first.status,200);
  const body=await first.json() as Record<string,unknown>;
  assert.deepEqual(body,{companyId:s.tenant.companyId,projectName:`realbud-${s.tenant.companyId}`,projectId:'pr_1',state:'ready'});
  assert.ok(!JSON.stringify(body).includes('ak_'));
  // Idempotent: a repeat returns the same project and creates nothing.
  const again=await s.request('POST',path,token,{});
  assert.equal(again.status,200);assert.deepEqual(await again.json(),body);
  assert.equal(s.created.length,1);
  // A body with fields, or a malformed company id, is refused before anything external.
  assert.equal((await s.request('POST',path,token,{name:'x'})).status,400);
  assert.equal((await s.request('POST','/v1/operator/offices/bad%2Fid/connector-project',token)).status,404);
  // An office the ledger does not know gets no project.
  const unknown=await s.request('POST','/v1/operator/offices/company-unknown/connector-project',token);
  assert.equal(unknown.status,404);assert.deepEqual(await unknown.json(),{companyId:'company-unknown',projectName:'realbud-company-unknown',state:'held',error:'tenant_unavailable'});
  assert.equal(s.created.length,1);
  // The first desktop link then provisions into that same project.
  const linked=await s.request('POST','/v1/portal/installations/provision',OWNER,s.provisionBody);
  assert.equal(linked.status,200);
  const descriptor=await linked.json() as {provisioning:{connector:{projectId:string}}};
  assert.equal(descriptor.provisioning.connector.projectId,'pr_1');
  assert.equal(s.created.length,1);
});

test('AI rate, usage, limit and model routes are gone; care routes answer 503 without billing composed', async()=>{
  const f=await serverFixture();
  for(const [method,path] of [['GET','/v1/portal/usage'],['GET','/v1/portal/rates'],['POST','/v1/portal/rates/accept'],['POST','/v1/portal/limits']] as const) {
    const response=await f.request(method,path,OWNER,method==='POST'?{}:undefined);
    assert.equal(response.status,404,`${method} ${path}`);assert.deepEqual(await response.json(),{error:'not_found'});
  }
  // Unauthenticated routes that used to exist answer 404 before any auth or body is read.
  for(const path of ['/v1/webhooks/payment','/v1/webhooks/refund','/v1/model/stream']) {
    assert.equal((await f.request('POST',path,null,{})).status,404,path);
  }
  for(const [method,path] of [['GET','/v1/portal/commercial-terms?period=2026-09'],['POST','/v1/portal/commercial-terms/accept'],
    ['GET','/v1/portal/invoices'],['GET','/v1/portal/invoices/inv-1'],['GET','/v1/portal/invoices/inv-1/document'],['GET','/v1/portal/invoices/inv-1/receipt'],['POST','/v1/portal/invoices/inv-1/checkout']] as const) {
    const response=await f.request(method,path,OWNER,method==='POST'?{}:undefined);
    assert.equal(response.status,503,`${method} ${path}`);assert.deepEqual(await response.json(),{error:'billing_unavailable'});
  }
  assert.equal((await f.request('POST','/v1/webhooks/square',null,{})).status,503);
  assert.deepEqual(f.modelviaCalls,[]);
});

test('care invoice routes report collection mode, stay tenant-scoped and refuse checkout without a payment adapter', async()=>{
  const f=await serverFixture();
  f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const billing=new BillingService(f.ledger,undefined,{internalCompanyId:'realbud-internal'});
  const published=billing.commercialTerms!.publish(careTermsDraft(f,'care-v1','12500'));
  billing.commercialTerms!.accept(f.owner,'2026-09','care-v1',published.digest);
  const invoice=billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','care-v1');
  const portal={async authenticate(bearer:string){
    if(bearer===OWNER)return f.owner;if(bearer===READER)return {...f.owner,role:'billing_reader' as const};if(bearer===UNKNOWN)return {...f.owner,companyId:'company-unentitled'};
    throw new GatewayError('unauthenticated',401);}};
  const server=createGatewayServer({allowedOrigins:new Set(),billing,portal});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request=(method:string,path:string,bearer:string=OWNER)=>fetch(base+path,{method,headers:{Authorization:`Bearer ${bearer}`,...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:'{}'}:{})});
  const list=await request('GET','/v1/portal/invoices');assert.equal(list.status,200);
  const expectedInvoices=[{id:invoice.id,kind:'Tax Invoice',period:'2026-09',currency:'AUD',gstInclusive:true,totalCents:'12500',gstCents:'1136',paid:false,aiUsageCsv:false,
    dueAt:invoice.issuedAt+7*86_400_000,status:'unpaid',overdue:false,paidCents:'0',outstandingCents:'12500',receiptKind:null}];
  const noInstructions={payId:null,bank:null};
  assert.deepEqual(await list.json(),{collectionMode:'off',invoices:expectedInvoices,paymentInstructions:noInstructions});
  assert.deepEqual(await (await request('GET',`/v1/portal/invoices/${invoice.id}`)).json(),{...invoice,links:{document:`/api/account/invoices/${invoice.id}?kind=document`}});
  assert.deepEqual(await (await request('GET',`/v1/portal/invoices/${invoice.id}/ai-usage`)).json(),{error:'ai_usage_not_on_invoice'});
  const document=await request('GET',`/v1/portal/invoices/${invoice.id}/document`,READER);
  assert.equal(document.status,200);assert.match(document.headers.get('content-type')??'',/text\/html/);
  const html=await document.text();assert.match(html,/monthly care/);assert.doesNotMatch(html,/AI usage —/);
  assert.equal((await request('GET',`/v1/portal/invoices/${invoice.id}/receipt`)).status,409);
  assert.equal((await request('GET',`/v1/portal/invoices/${invoice.id}`,UNKNOWN)).status,404);
  assert.deepEqual(await (await request('GET','/v1/portal/invoices',UNKNOWN)).json(),{collectionMode:'off',invoices:[],paymentInstructions:noInstructions});
  assert.equal((await request('POST',`/v1/portal/invoices/${invoice.id}/checkout`,READER)).status,403);
  const checkout=await request('POST',`/v1/portal/invoices/${invoice.id}/checkout`);
  assert.equal(checkout.status,503);assert.deepEqual(await checkout.json(),{error:'payment_provider_unselected'});
  assert.equal(f.ledger.db.get('SELECT * FROM checkouts'),undefined);

  const liveAdapter:HostedPaymentAdapter={id:'square-live',mode:'live',
    async createCheckout(){throw new Error('checkout must not be called');},async verifyWebhook(){return null;},
    async requestRefund(){throw new Error('refund must not be called');},async verifyRefundWebhook(){return null;}};
  const liveBilling=new BillingService(f.ledger,liveAdapter,{authorizeCollection:true,internalCompanyId:'realbud-internal'});
  const liveServer=createGatewayServer({allowedOrigins:new Set(),billing:liveBilling,portal});
  liveServer.listen(0,'127.0.0.1');await once(liveServer,'listening');
  cleanups.push(async()=>{liveServer.closeAllConnections();await new Promise<void>(resolve=>liveServer.close(()=>resolve()));});
  const liveUrl=`http://127.0.0.1:${(liveServer.address() as AddressInfo).port}/v1/portal/invoices`;
  assert.equal((await fetch(liveUrl)).status,401);
  assert.deepEqual(await (await fetch(liveUrl,{headers:{Authorization:`Bearer ${OWNER}`}})).json(),{collectionMode:'live',invoices:expectedInvoices,paymentInstructions:noInstructions});
  assert.deepEqual(await (await fetch(liveUrl,{headers:{Authorization:`Bearer ${UNKNOWN}`}})).json(),{collectionMode:'live',invoices:[],paymentInstructions:noInstructions});
});

test('an unentitled company is refused on provision before any Modelvia call; revoke needs no entitlement', async()=>{
  const f=await serverFixture();
  const provision=await f.request('POST','/v1/portal/installations/provision',UNKNOWN,{...f.provisionBody,companyId:'company-unentitled'});
  assert.equal(provision.status,403);assert.deepEqual(await provision.json(),{error:'tenant_unavailable'});
  assert.deepEqual(f.modelviaCalls,[]);
  // No blanket tenant lookup: revoke reaches provisioning and answers for the installation.
  const revoke=await f.request('POST','/v1/portal/installations/revoke',UNKNOWN,{companyId:'company-unentitled',installationId:'install-one'});
  assert.equal(revoke.status,404);assert.deepEqual(await revoke.json(),{error:'installation_not_provisioned'});
});

test('provision and revoke work for an entitled company, and revoke still works once service lapses', async()=>{
  const f=await serverFixture();
  const created=await f.request('POST','/v1/portal/installations/provision',OWNER,f.provisionBody);
  assert.equal(created.status,200);
  const descriptor=(await created.json() as {provisioning:{model:{spendCapLabel:string}}}).provisioning;
  // Caps come from the Modelvia customer, never the ledger tenant.
  assert.equal(descriptor.model.spendCapLabel,'A$100/month, A$4/request, 4 at once');
  assert.equal(f.projects.get('rb-install-one')!.monthlyCapNanoAud,'100000000000');
  f.ledger.putEntitlement({...f.tenant,active:false},'fixture-suspension');
  assert.equal((await f.request('POST','/v1/portal/installations/provision',OWNER,{...f.provisionBody,installationId:'install-two'})).status,402);
  assert.equal((await f.request('POST','/v1/portal/installations/revoke',OWNER,{companyId:f.tenant.companyId,installationId:'install-one'})).status,200);
});

test('a Modelvia customer that is not ready is refused with its own code', async()=>{
  for(const customer of [{active:false},{monthlyCapNanoAud:'0'},{clientId:'another-platform-client'},{id:'cus-someone-else'}]) {
    const f=await serverFixture({customer});
    const response=await f.request('POST','/v1/portal/installations/provision',OWNER,f.provisionBody);
    assert.equal(response.status,409,JSON.stringify(customer));assert.deepEqual(await response.json(),{error:'modelvia_customer_not_ready'});
    // One read, no effect: no project, no key.
    assert.deepEqual(f.modelviaCalls,['GET /v1/operator/customers']);
    assert.equal(f.ledger.db.get('SELECT tenant FROM installation_provisioning'),undefined);
  }
});

test('portal auth still gates the remaining portal routes', async()=>{
  const f=await serverFixture();
  assert.equal((await f.request('POST','/v1/portal/installations/provision',null,f.provisionBody,{'x-company-id':'company-a',Cookie:'session=owner'})).status,401);
  assert.equal((await f.request('POST','/v1/portal/installations/provision',OWNER,f.provisionBody,{Origin:'https://evil.invalid'})).status,403);
  assert.equal((await f.request('POST','/v1/portal/installations/provision',READER,f.provisionBody)).status,403);
  const oversized=await fetch(f.base+'/v1/portal/installations/provision',{method:'POST',headers:{Authorization:`Bearer ${OWNER}`},body:' '.repeat(4097)});
  assert.equal(oversized.status,413);const text=await oversized.text();assert(!text.includes('stack'));assert(!text.includes('node:'));
});

test('/health carries no billing state and /ready reports the Modelvia operator configuration without calling it', async()=>{
  const f=await serverFixture();
  assert.deepEqual(await(await f.request('GET','/health',null)).json(),{service:'realbud-managed-ai'});
  const ready=await f.request('GET','/ready',null);assert.equal(ready.status,200);
  assert.deepEqual(await ready.json(),{ready:true,provisioning:'composed',modelviaOperator:'configured',operatorAccess:'missing',serviceIssuer:'missing'});
  const bare=await serverFixture({provisioning:false});
  const unready=await bare.request('GET','/ready',null);assert.equal(unready.status,503);
  assert.deepEqual(await unready.json(),{ready:false,error:'provisioning_unavailable',modelviaOperator:'missing',operatorAccess:'missing',serviceIssuer:'missing'});
  assert.deepEqual([...f.modelviaCalls,...bare.modelviaCalls],[]);
});

test('modelviaOperatorState reports only a distinct RealBud-scoped credential', ()=>{
  const full={REALBUD_MODELVIA_BASE_URL:'https://api.modelvia.dev',REALBUD_MODELVIA_SCOPED_SECRET:'fictional-operator-secret-of-32-chars',REALBUD_MODELVIA_OPERATOR_SUBJECT:'realbud-provisioning',REALBUD_MODELVIA_CLIENT_ID:'realbud',REALBUD_MODELVIA_MODELS:'fictional-model'};
  assert.equal(modelviaOperatorState(full),'configured');
  for(const name of Object.keys(full)) assert.equal(modelviaOperatorState({...full,[name]:' '}),'missing',name);
  assert.equal(modelviaOperatorState({...full,REALBUD_MODELVIA_SCOPED_SECRET:'short'}),'missing');
  assert.equal(modelviaOperatorState({...full,REALBUD_MODELVIA_SCOPED_SECRET:`${full.REALBUD_MODELVIA_SCOPED_SECRET} `}),'missing');
  assert.equal(modelviaOperatorState({...full,REALBUD_MODELVIA_SCOPED_SECRET:'',REALBUD_MODELVIA_OPERATOR_SECRET:full.REALBUD_MODELVIA_SCOPED_SECRET}),'missing');
  for(const name of ['REALBUD_MODELVIA_OPERATOR_SECRET','REALBUD_GATEWAY_PORTAL_SECRET','REALBUD_GATEWAY_OPERATOR_SECRET'])
    assert.equal(modelviaOperatorState({...full,[name]:full.REALBUD_MODELVIA_SCOPED_SECRET}),'missing',name);
});

test('operator billing desk routes: operator bearer only, fixed error codes, record and undo a transfer, close a month; the portal shows payment instructions', async()=>{
  const f=fixture();f.setTime(Date.parse('2026-10-02T00:00:00Z'));
  const operatorSecret='fictional-gateway-operator-secret-000001';
  const env:NodeJS.ProcessEnv={REALBUD_GATEWAY_OPERATOR_SECRET:operatorSecret,REALBUD_GATEWAY_PORTAL_SECRET:'fictional-gateway-portal-secret-00000001',REALBUD_INTERNAL_COMPANY_ID:'realbud-internal',
    REALBUD_PAYID:'0455123764',REALBUD_PAYID_NAME:'Fictional RealBud Pty Ltd',REALBUD_BANK_ACCOUNT_NAME:'Fictional RealBud Pty Ltd',REALBUD_BANK_BSB:'064-000',REALBUD_BANK_ACCOUNT_NUMBER:'12345678'};
  const never=async()=>{throw new Error('network must stay off');};
  const composed=composeGateway({env,ledger:f.ledger,fetch:never,allowedOrigins:new Set(),portal:{async authenticate(bearer){if(bearer===OWNER)return f.owner;throw new GatewayError('unauthenticated',401);}}});
  const billing=composed.server.billing!;
  const published=billing.commercialTerms!.publish(careTermsDraft(f,'care-v1','12500'));
  billing.commercialTerms!.accept(f.owner,'2026-09','care-v1',published.digest);
  const server=createGatewayServer(composed.server);
  server.listen(0,'127.0.0.1');await once(server,'listening');
  cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();});
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token=signOperatorToken('ops@realbud.example',operatorSecret,Date.now());
  const call=async(method:string,path:string,body?:unknown,bearer:string|null=token)=>{
    const response=await fetch(base+path,{method,headers:{...(bearer?{Authorization:`Bearer ${bearer}`}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json() as Record<string,any>};
  };
  // Operator bearer only: none, a portal token, or another secret's token are refused.
  for(const bearer of [null,OWNER,signOperatorToken('ops@realbud.example','another-secret-that-is-long-enough-000001')]) {
    const refused=await call('GET','/v1/operator/billing/invoices',undefined,bearer);
    assert.equal(refused.status,401);assert.deepEqual(refused.body,{error:'operator_unauthenticated'});
  }
  assert.deepEqual((await call('GET','/v1/operator/billing/close?period=2026-09')).body,{period:'2026-09',offices:[{companyId:f.tenant.companyId,officeName:f.tenant.customerName,invoiceId:null,termsVersion:'care-v1',state:'ready',blocker:null}]});
  assert.deepEqual((await call('GET','/v1/operator/billing/close?period=2026-9')).body,{error:'invalid_billing_period'});
  assert.deepEqual((await call('GET','/v1/operator/billing/close?period=2026-09&x=1')).body,{error:'invalid_query'});
  const closed=await call('POST','/v1/operator/billing/close',{companyId:f.tenant.companyId,period:'2026-09'});
  assert.equal(closed.status,200);assert.deepEqual([closed.body.ai,closed.body.alreadyClosed,closed.body.invoice.status,closed.body.invoice.dueAt],['care_only',false,'unpaid',f.now()+7*86_400_000]);
  const id=closed.body.invoice.id as string;
  assert.equal((await call('POST','/v1/operator/billing/close',{companyId:f.tenant.companyId,period:'2026-09'})).body.alreadyClosed,true);
  const payment={paymentId:'00000000-0000-4000-8000-000000000001',method:'payid',amountCents:'4000',receivedOn:'2026-10-02',reference:`${id} Agency A`};
  const recorded=await call('POST',`/v1/operator/billing/invoices/${id}/payments`,payment);
  assert.equal(recorded.status,200);
  assert.deepEqual([recorded.body.status,recorded.body.outstandingCents,recorded.body.payments[0].recordedBy],['part_paid','8500','operator:ops@realbud.example']);
  assert.equal((await call('POST',`/v1/operator/billing/invoices/${id}/payments`,payment)).status,200);
  assert.deepEqual(await call('POST',`/v1/operator/billing/invoices/${id}/payments`,{...payment,amountCents:'4001'}),{status:409,body:{error:'payment_conflict'}});
  assert.deepEqual(await call('POST',`/v1/operator/billing/invoices/${id}/payments`,{...payment,paymentId:'00000000-0000-4000-8000-000000000002',amountCents:'8501'}),{status:409,body:{error:'payment_exceeds_outstanding'}});
  assert.deepEqual(await call('POST',`/v1/operator/billing/invoices/${id}/payments`,{...payment,paymentId:'00000000-0000-4000-8000-000000000002',receivedOn:'2026-10-03'}),{status:400,body:{error:'invalid_received_on'}});
  assert.deepEqual(await call('POST','/v1/operator/billing/invoices/RB-999999/payments',payment),{status:404,body:{error:'invoice_not_found'}});
  // The portal shows the balance and how to pay it.
  const portal=await (await fetch(base+'/v1/portal/invoices',{headers:{Authorization:`Bearer ${OWNER}`}})).json() as Record<string,any>;
  assert.deepEqual(portal.paymentInstructions,{payId:{id:'0455123764',name:'Fictional RealBud Pty Ltd'},bank:{accountName:'Fictional RealBud Pty Ltd',bsb:'064-000',accountNumber:'12345678'}});
  assert.deepEqual([portal.invoices[0].status,portal.invoices[0].paidCents,portal.invoices[0].outstandingCents,portal.invoices[0].overdue,portal.invoices[0].paid],['part_paid','4000','8500',false,false]);
  const html=await (await fetch(base+`/v1/portal/invoices/${id}/document`,{headers:{Authorization:`Bearer ${OWNER}`}})).text();
  assert.match(html,/How to pay/);assert.match(html,/PayID<\/b> 0455123764/);assert.doesNotMatch(html,/<b>Card<\/b>/);
  const undone=await call('POST',`/v1/operator/billing/invoices/${id}/payments/${payment.paymentId}/reverse`,{reason:'Recorded against the wrong invoice'});
  assert.deepEqual([undone.status,undone.body.status,undone.body.payments[0].reversed.by],[200,'unpaid','operator:ops@realbud.example']);
  assert.deepEqual(await call('POST',`/v1/operator/billing/invoices/${id}/payments/${payment.paymentId}/reverse`,{reason:'no'}),{status:400,body:{error:'invalid_reason'}});
  assert.deepEqual(await call('POST',`/v1/operator/billing/invoices/${id}/payments/square-sandbox%3Atxn/reverse`,{reason:'Wrong'}),{status:404,body:{error:'payment_not_found'}});
  const list=await call('GET','/v1/operator/billing/invoices');
  assert.equal(list.body.now,f.now());assert.deepEqual(list.body.invoices.map((i:{id:string})=>i.id),[id]);
  assert.deepEqual(await call('DELETE','/v1/operator/billing/invoices'),{status:404,body:{error:'not_found'}});
  f.db.verify();
});

test('operator billing desk answers 503 without an operator secret', async()=>{
  const f=fixture();
  const server=createGatewayServer({allowedOrigins:new Set(),portal:{async authenticate(){throw new GatewayError('unauthenticated',401);}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();});
  const response=await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/operator/billing/invoices`,{headers:{Authorization:'Bearer synthetic-operator-token-0000000001'}});
  assert.equal(response.status,503);assert.deepEqual(await response.json(),{error:'operator_unconfigured'});
});

test('billing plan routes: operator bearer only; PUT sets and rolls forward, GET reads; the portal terms read shows the plan without basis points and a plan acceptance syncs Modelvia resale', async()=>{
  const f=fixture();f.setTime(Date.parse('2026-09-15T00:00:00Z'));
  const operatorSecret='fictional-gateway-operator-secret-000001';
  const env:NodeJS.ProcessEnv={REALBUD_GATEWAY_OPERATOR_SECRET:operatorSecret,REALBUD_GATEWAY_PORTAL_SECRET:'fictional-gateway-portal-secret-00000001',REALBUD_INTERNAL_COMPANY_ID:'realbud-internal',
    REALBUD_MODELVIA_RESALE_MARKUP_BASIS_POINTS:'3000',REALBUD_MODELVIA_RESALE_TERMS_REFERENCE:'realbud-office-terms-2026-09-26-ai-resale-30pct',REALBUD_MODELVIA_CLIENT_FUNDED_COMPANIES:'company-owner',
    REALBUD_SELLER_LEGAL_NAME:'Fictional RealBud Seller',REALBUD_SELLER_ABN:'12345678901',REALBUD_SELLER_ADDRESS:'1 Example Seller Street, Brisbane QLD',REALBUD_TAX_TREATMENT_REF:'synthetic-tax-review',
    REALBUD_SELLER_VERIFICATION_REF:'synthetic-seller-review',REALBUD_CUSTOMER_TERMS_REF:'synthetic-customer-contract',REALBUD_CARE_AGREEMENT_REF:'synthetic-care-agreement'};
  const never=async()=>{throw new Error('network must stay off');};
  const composed=composeGateway({env,ledger:f.ledger,fetch:never,allowedOrigins:new Set(),portal:{async authenticate(bearer){if(bearer===OWNER)return f.owner;throw new GatewayError('unauthenticated',401);}}});
  assert.equal(composed.billingPlanConfig,'configured');
  assert.equal(composeGateway({env:{...env,REALBUD_CARE_AGREEMENT_REF:''},ledger:f.ledger,fetch:never,allowedOrigins:new Set(),portal:{async authenticate(){throw new GatewayError('unauthenticated',401);}}}).billingPlanConfig,'billing_plan_unconfigured:REALBUD_CARE_AGREEMENT_REF');
  bindOfficeCustomer(f.ledger,f.tenant.companyId,'realbud-company-a');
  const synced:string[]=[];
  const server=createGatewayServer({...composed.server,afterTermsAccepted:async companyId=>{synced.push(companyId);await syncTestResalePolicy(f.ledger,companyId);}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();});
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token=signOperatorToken('ops@realbud.example',operatorSecret,Date.now());
  const call=async(method:string,path:string,body?:unknown,bearer:string|null=token)=>{
    const response=await fetch(base+path,{method,headers:{...(bearer?{Authorization:`Bearer ${bearer}`}:{}),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:response.status,body:await response.json() as Record<string,any>};
  };
  const plan={companyId:f.tenant.companyId,startPeriod:'2026-09',includedMonths:2,careCents:'12500',aiBilling:'resale'};
  for(const bearer of [null,OWNER]) assert.deepEqual(await call('PUT','/v1/operator/offices/billing-plan',plan,bearer),{status:401,body:{error:'operator_unauthenticated'}});
  assert.deepEqual(await call('GET',`/v1/operator/offices/billing-plan?companyId=${f.tenant.companyId}`),{status:200,body:{plan:null,acceptance:{state:'none',acceptedAt:null},months:[],rollForward:{published:[],blocker:null}}});
  assert.deepEqual(await call('GET','/v1/operator/offices/billing-plan'),{status:400,body:{error:'invalid_id'}});
  assert.deepEqual(await call('GET',`/v1/operator/offices/billing-plan?companyId=${f.tenant.companyId}&x=1`),{status:400,body:{error:'invalid_query'}});
  assert.deepEqual(await call('PUT','/v1/operator/offices/billing-plan',{...plan,version:'plan-v1'}),{status:400,body:{error:'invalid_fields'}});
  assert.deepEqual(await call('PUT','/v1/operator/offices/billing-plan',{...plan,companyId:'company-owner'}),{status:403,body:{error:'tenant_unavailable'}});
  const set=await call('PUT','/v1/operator/offices/billing-plan',plan);
  assert.equal(set.status,200);
  assert.deepEqual([set.body.plan.version,set.body.plan.markupBasisPoints,set.body.acceptance.state,set.body.rollForward.published,set.body.months.map((m:{period:string;state:string})=>[m.period,m.state])],
    ['plan-v1',3000,'awaiting_owner',['2026-09','2026-10'],[['2026-09','published'],['2026-10','published']]]);
  assert.deepEqual((await call('PUT','/v1/operator/offices/billing-plan',plan)).body.plan.version,'plan-v1');
  assert.deepEqual((await call('GET',`/v1/operator/offices/billing-plan?companyId=${f.tenant.companyId}`)).body.plan,set.body.plan);
  assert.deepEqual((await call('GET','/v1/operator/billing/close?period=2026-09')).body.offices[0].blocker,'plan_awaiting_owner');
  // The owner reads September: the plan in words, no basis points anywhere; accepting it accepts the plan and syncs Modelvia resale.
  const portal=await (await fetch(base+'/v1/portal/commercial-terms?period=2026-09',{headers:{Authorization:`Bearer ${OWNER}`}})).json() as Record<string,any>;
  assert.deepEqual(portal.plan,{version:'plan-v1',startPeriod:'2026-09',includedMonths:2,includedUntil:'2026-10',careCents:'12500',careFrom:'2026-11',aiBilling:'resale',aiBilledFrom:'2026-11',month:1,included:true,accepted:false});
  assert.deepEqual([portal.terms.version,portal.terms.careCents,portal.acceptance,'aiUsage' in portal.terms,portal.pricingSync],['plan-v1-2026-09','0',null,false,'awaiting_acceptance']);
  assert.equal(portal.terms.billingPlan.markupBasisPoints,3000);
  const accepted=await fetch(base+'/v1/portal/commercial-terms/accept',{method:'POST',headers:{Authorization:`Bearer ${OWNER}`,'Content-Type':'application/json'},body:JSON.stringify({period:'2026-09',version:portal.terms.version,digest:portal.digest})});
  assert.equal(accepted.status,200);
  assert.deepEqual(synced,[f.tenant.companyId]);
  const october=await (await fetch(base+'/v1/portal/commercial-terms?period=2026-10',{headers:{Authorization:`Bearer ${OWNER}`}})).json() as Record<string,any>;
  assert.deepEqual([october.plan.accepted,october.plan.month,october.acceptance.subject.startsWith('standing:'),october.pricingSync],[true,2,true,'synced']);
  assert(!JSON.stringify({pricingSync:october.pricingSync}).includes('realbud-company-a'));
  assert.deepEqual((await call('GET',`/v1/operator/offices/billing-plan?companyId=${f.tenant.companyId}`)).body.months.map((m:{state:string})=>m.state),['accepted','standing']);
  // Later, the portal read itself publishes the next months with their standing acceptance.
  f.setTime(Date.parse('2026-11-03T00:00:00Z'));
  const november=await (await fetch(base+'/v1/portal/commercial-terms?period=2026-11',{headers:{Authorization:`Bearer ${OWNER}`}})).json() as Record<string,any>;
  assert.deepEqual([november.terms.careCents,november.terms.aiUsage,november.plan.included,november.acceptance.subject.startsWith('standing:')],['12500',{billing:'resale',markupBasisPoints:3000,termsReference:'realbud-office-terms-2026-09-26-ai-resale-30pct'},false,true]);
  assert.deepEqual((await call('GET','/v1/operator/billing/close?period=2026-10')).body.offices[0].state,'ready');
  const closed=await call('POST','/v1/operator/billing/close',{companyId:f.tenant.companyId,period:'2026-10'});
  assert.deepEqual([closed.status,closed.body.ai,closed.body.invoice.totalCents,closed.body.invoice.status],[200,'included','0','nothing_due']);
  f.db.verify();
});

// ── Desktop service grant, pulled with the installation's own credential ──
const GRANT_REQUEST={version:1,purpose:'desktop-service-entitlement-request'};
function fictionalIssuer():ServiceIssuer { return {keyId:'fictional-issuer-a',privateKey:generateKeyPairSync('ed25519').privateKey}; }
async function provisioned(issuer?:ServiceIssuer) {
  const f=await serverFixture(issuer?{serviceIssuer:issuer}:{});
  const created=await f.request('POST','/v1/portal/installations/provision',OWNER,f.provisionBody);
  assert.equal(created.status,200);
  const reply=await created.json() as {provisioning:Record<string,unknown>&{connector:{credential:string}}};
  // The provision reply is unchanged: older desktops parse it with exact keys.
  assert.deepEqual(Object.keys(reply.provisioning).sort(),['connector','model','service','version']);
  const credential=reply.provisioning.connector.credential;
  const ask=(bearer=credential,body:unknown=GRANT_REQUEST)=>f.request('POST','/v1/installations/service-entitlement',bearer,body);
  return {...f,credential,ask};
}
type Delivery={version:number;purpose:string;companyId:string;hostInstallationId:string;publicKeySha256:string;bundle:{entitlement:{payload:string};trust:{keys:{publicKeyPem:string}[]}}};

test('a provisioned desktop receives its own verifiable service grant, the same one on retry', async()=>{
  const issuer=fictionalIssuer();
  const f=await provisioned(issuer);
  const first=await f.ask();assert.equal(first.status,200);
  const text=await first.text();
  assert.doesNotMatch(text,/PRIVATE KEY|rbc_|rbk_|ak_/);
  const delivery=JSON.parse(text) as Delivery;
  assert.equal(delivery.purpose,'desktop-service-entitlement');
  assert.equal(delivery.companyId,f.tenant.companyId);assert.equal(delivery.hostInstallationId,'install-one');
  const spki=createHash('sha256').update(createPublicKey(issuer.privateKey).export({type:'spki',format:'der'})).digest('hex');
  assert.equal(delivery.publicKeySha256,spki);
  const root=mkdtempSync(join(tmpdir(),'realbud-grant-'));cleanups.push(async()=>rmSync(root,{recursive:true,force:true}));
  writeFileSync(join(root,'grant.json'),JSON.stringify(delivery.bundle.entitlement));writeFileSync(join(root,'trust.json'),JSON.stringify(delivery.bundle.trust));
  assert.equal(readServiceEntitlement({managed:true,path:join(root,'grant.json'),trustedKeysPath:join(root,'trust.json'),companyId:f.tenant.companyId,hostInstallationId:'install-one',now:f.now()}).state,'active');
  // Idempotent: a retry is the stored grant, the same signature, and one audit line.
  assert.deepEqual(await(await f.ask()).json(),delivery);
  assert.equal((f.ledger.db.get<{n:number}>("SELECT count(*) AS n FROM events WHERE kind='desktop_service_grant_issued'"))!.n,1);
  const audit=JSON.stringify(f.ledger.db.all("SELECT body FROM events WHERE kind='desktop_service_grant_issued'"));assert.doesNotMatch(audit,/PRIVATE KEY|BEGIN PUBLIC KEY|signature/);
  assert.doesNotMatch(JSON.stringify(f.ledger.db.all('SELECT body FROM events')),/PRIVATE KEY/);
  const ready=await f.request('GET','/ready',null);assert.equal((await ready.json() as {serviceIssuer:string}).serviceIssuer,'configured');
});

const issuedCount=(f:{ledger:{db:{get:<T>(sql:string)=>T|undefined}}})=>f.ledger.db.get<{n:number}>("SELECT count(*) AS n FROM events WHERE kind='desktop_service_grant_issued'")!.n;
test('a grant capped by the office expiry is signed once, and renewed when the office renews', async()=>{
  const f=await provisioned(fictionalIssuer());
  const first=await(await f.ask()).json() as Delivery;
  // Its last month: a new grant could last no longer, so no re-signing storm.
  f.setTime(f.now()+340*86_400_000);
  for(let i=0;i<5;i++) assert.deepEqual(await(await f.ask()).json(),first);
  assert.equal(issuedCount(f),1);
  f.ledger.setService(f.tenant.companyId,true,f.now()+500*86_400_000,'fictional-renewal');
  const extended=await(await f.ask()).json() as Delivery;
  assert.equal(JSON.parse(extended.bundle.entitlement.payload).expiresAt,f.now()+366*86_400_000);
  assert.equal(issuedCount(f),2);
  // Capped at 366 days: renewed only inside its last 30 days, once.
  f.setTime(f.now()+300*86_400_000);
  assert.deepEqual(await(await f.ask()).json(),extended);
  f.setTime(f.now()+40*86_400_000);
  const renewed=await(await f.ask()).json() as Delivery;
  assert.notEqual(renewed.bundle.entitlement.payload,extended.bundle.entitlement.payload);
  assert.deepEqual(await(await f.ask()).json(),renewed);
  assert.equal(issuedCount(f),3);
  // A shortened office expiry replaces a grant that would outlive it.
  f.ledger.setService(f.tenant.companyId,true,f.now()+10*86_400_000,'fictional-shortened');
  assert.equal(JSON.parse((await(await f.ask()).json() as Delivery).bundle.entitlement.payload).expiresAt,f.now()+10*86_400_000);
});

test('grant asks are limited per installation', async()=>{
  const f=await provisioned(fictionalIssuer());
  for(let i=0;i<30;i++) assert.equal((await f.ask()).status,200);
  const limited=await f.ask();assert.equal(limited.status,429);assert.deepEqual(await limited.json(),{error:'rate_limited'});
  f.setTime(f.now()+61*60_000);
  assert.equal((await f.ask()).status,200);
});

test('no signer, suspended office, revoked installation and foreign credentials get no grant', async()=>{
  const bare=await provisioned();
  const unsigned=await bare.ask();assert.equal(unsigned.status,503);assert.deepEqual(await unsigned.json(),{error:'service_issuer_unconfigured'});
  const f=await provisioned(fictionalIssuer());
  assert.equal((await f.ask(`rbc_${'0'.repeat(64)}`)).status,403);
  assert.equal((await f.ask('not-a-connector-credential-000000')).status,401);
  assert.equal((await f.ask(f.credential,{...GRANT_REQUEST,companyId:'company-b'})).status,400);
  assert.equal((await f.ask()).status,200);
  f.ledger.setService(f.tenant.companyId,false,f.now()+86_400_000,'fictional-suspension');
  const suspended=await f.ask();assert.equal(suspended.status,403);assert.deepEqual(await suspended.json(),{error:'service_unavailable'});
  f.ledger.setService(f.tenant.companyId,true,f.now()+86_400_000,'fictional-resume');
  assert.equal((await f.request('POST','/v1/portal/installations/revoke',OWNER,{companyId:f.tenant.companyId,installationId:'install-one'})).status,200);
  assert.equal((await f.ask()).status,403);
});

test('serviceIssuerFromEnv reports state only and never fails composition', ()=>{
  assert.equal(serviceIssuerFromEnv({}).state,'missing');
  assert.equal(serviceIssuerFromEnv({REALBUD_SERVICE_ISSUER_KEY_ID:'fictional-issuer-a'}).state,'invalid');
  assert.equal(serviceIssuerFromEnv({REALBUD_SERVICE_ISSUER_KEY_FILE:'/synthetic/absent.pem',REALBUD_SERVICE_ISSUER_KEY_ID:'fictional-issuer-a'}).state,'invalid');
  const root=mkdtempSync(join(tmpdir(),'realbud-signer-'));
  try {
    const pem=generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8',format:'pem'}).toString();
    writeFileSync(join(root,'signer.pem'),pem,{mode:0o600});
    const loaded=serviceIssuerFromEnv({REALBUD_SERVICE_ISSUER_KEY_FILE:join(root,'signer.pem'),REALBUD_SERVICE_ISSUER_KEY_ID:'fictional-issuer-a'});
    assert.equal(loaded.state,'configured');assert.equal(loaded.issuer?.keyId,'fictional-issuer-a');
    assert.doesNotMatch(JSON.stringify({state:loaded.state}),/PRIVATE/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
