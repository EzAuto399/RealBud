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
import { fileSecretStore, InstallationProvisioning, modelviaOperatorState } from './provisioning.ts';
import { modelviaKeyClient } from './modelvia-keys.ts';
import type { HttpTransport } from './composio-org.ts';
import { composeGateway } from './composition.ts';
import { signOperatorToken } from './operator-token.ts';

const cleanups:(()=>Promise<void>)[]=[];afterEach(async()=>{while(cleanups.length)await cleanups.pop()!();});
const OWNER='synthetic-portal-token-owner-000001',READER='synthetic-portal-token-reader-00001',UNKNOWN='synthetic-portal-token-unknown-0001';

/** The real Modelvia client over a stand-in shaped like Modelvia's operator
 * routes, and a provisioning composition around it. Everything is fictional. */
async function serverFixture(options:{provisioning?:boolean;customer?:Record<string,unknown>}={}) {
  const f=fixture(),root=mkdtempSync(join(tmpdir(),'realbud-http-'));
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
  const org={async listProjects(){return [];},async createProject(name:string){return {id:'pr_1',name,apiKey:'ak_fictional_project_key_for_tests'};},async deleteProject(){return {revokeJobId:'job-fictional'};}};
  const provisioning=options.provisioning===false?undefined:new InstallationProvisioning({ledger:f.ledger,registry:join(root,'devices.json'),endpoint:'https://managed.example.invalid',
    secrets:fileSecretStore(join(root,'secrets')),org,modelvia,authConfigs:{resolveGmail:async () => 'ac-fictional-readonly'}});
  const server=createGatewayServer({allowedOrigins:new Set(['https://portal.invalid']),...(provisioning?{provisioning}:{}),portal:{async authenticate(bearer){
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
  return {...f,base,request,provisionBody,modelviaCalls,projects};
}

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
    dueAt:invoice.issuedAt+7*86_400_000,status:'unpaid',overdue:false,paidCents:'0',outstandingCents:'12500'}];
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
  assert.deepEqual(await ready.json(),{ready:true,provisioning:'composed',modelviaOperator:'configured',operatorAccess:'missing'});
  const bare=await serverFixture({provisioning:false});
  const unready=await bare.request('GET','/ready',null);assert.equal(unready.status,503);
  assert.deepEqual(await unready.json(),{ready:false,error:'provisioning_unavailable',modelviaOperator:'missing',operatorAccess:'missing'});
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
  const synced:string[]=[];
  const server=createGatewayServer({...composed.server,afterTermsAccepted:async companyId=>{synced.push(companyId);}});
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
  assert.deepEqual([portal.terms.version,portal.terms.careCents,portal.acceptance,'aiUsage' in portal.terms],['plan-v1-2026-09','0',null,false]);
  assert.equal(portal.terms.billingPlan.markupBasisPoints,3000);
  const accepted=await fetch(base+'/v1/portal/commercial-terms/accept',{method:'POST',headers:{Authorization:`Bearer ${OWNER}`,'Content-Type':'application/json'},body:JSON.stringify({period:'2026-09',version:portal.terms.version,digest:portal.digest})});
  assert.equal(accepted.status,200);
  assert.deepEqual(synced,[f.tenant.companyId]);
  const october=await (await fetch(base+'/v1/portal/commercial-terms?period=2026-10',{headers:{Authorization:`Bearer ${OWNER}`}})).json() as Record<string,any>;
  assert.deepEqual([october.plan.accepted,october.plan.month,october.acceptance.subject.startsWith('standing:')],[true,2,true]);
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
