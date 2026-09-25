import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { careTermsDraft, fixture } from './testing.ts';
import { createGatewayServer } from './http.ts';
import { BillingService } from './billing.ts';
import { GatewayError } from './contracts.ts';
import { fileSecretStore, InstallationProvisioning, modelviaOperatorState } from './provisioning.ts';
import { modelviaKeyClient } from './modelvia-keys.ts';
import type { HttpTransport } from './composio-org.ts';

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
    operatorSecret:()=>'fictional-modelvia-operator-secret-32ch',operatorSubject:'realbud-provisioning',fetch:fetchLike,now:f.now});
  const org={async listProjects(){return [];},async createProject(name:string){return {id:'pr_1',name,apiKey:'ak_fictional_project_key_for_tests'};},async deleteProject(){return {revokeJobId:'job-fictional'};}};
  const provisioning=options.provisioning===false?undefined:new InstallationProvisioning({ledger:f.ledger,registry:join(root,'devices.json'),endpoint:'https://managed.example.invalid',
    secrets:fileSecretStore(join(root,'secrets')),org,modelvia,authConfigs:{gmail:'ac-fictional-readonly'}});
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

test('care invoice routes are tenant-scoped, render the document and refuse checkout without a payment adapter', async()=>{
  const f=await serverFixture();
  f.setTime(Date.parse('2026-10-01T00:00:00Z'));
  const billing=new BillingService(f.ledger,undefined,{internalCompanyId:'realbud-internal'});
  const published=billing.commercialTerms!.publish(careTermsDraft(f,'care-v1','12500'));
  billing.commercialTerms!.accept(f.owner,'2026-09','care-v1',published.digest);
  const invoice=billing.finalizeCommercialInvoice(f.tenant.companyId,'2026-09','care-v1');
  const server=createGatewayServer({allowedOrigins:new Set(),billing,portal:{async authenticate(bearer){
    if(bearer===OWNER)return f.owner;if(bearer===READER)return {...f.owner,role:'billing_reader'};if(bearer===UNKNOWN)return {...f.owner,companyId:'company-unentitled'};
    throw new GatewayError('unauthenticated',401);}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request=(method:string,path:string,bearer:string=OWNER)=>fetch(base+path,{method,headers:{Authorization:`Bearer ${bearer}`,...(method==='POST'?{'Content-Type':'application/json'}:{})},...(method==='POST'?{body:'{}'}:{})});
  const list=await request('GET','/v1/portal/invoices');assert.equal(list.status,200);
  assert.deepEqual(await list.json(),{invoices:[{id:invoice.id,kind:'Tax Invoice',period:'2026-09',currency:'AUD',gstInclusive:true,totalCents:'12500',gstCents:'1136',paid:false}]});
  assert.deepEqual(await (await request('GET',`/v1/portal/invoices/${invoice.id}`)).json(),invoice);
  const document=await request('GET',`/v1/portal/invoices/${invoice.id}/document`,READER);
  assert.equal(document.status,200);assert.match(document.headers.get('content-type')??'',/text\/html/);
  const html=await document.text();assert.match(html,/monthly care/);assert.doesNotMatch(html,/AI usage —/);
  assert.equal((await request('GET',`/v1/portal/invoices/${invoice.id}/receipt`)).status,409);
  assert.equal((await request('GET',`/v1/portal/invoices/${invoice.id}`,UNKNOWN)).status,404);
  assert.deepEqual(await (await request('GET','/v1/portal/invoices',UNKNOWN)).json(),{invoices:[]});
  assert.equal((await request('POST',`/v1/portal/invoices/${invoice.id}/checkout`,READER)).status,403);
  const checkout=await request('POST',`/v1/portal/invoices/${invoice.id}/checkout`);
  assert.equal(checkout.status,503);assert.deepEqual(await checkout.json(),{error:'payment_provider_unselected'});
  assert.equal(f.ledger.db.get('SELECT * FROM checkouts'),undefined);
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

test('modelviaOperatorState names presence only', ()=>{
  const full={REALBUD_MODELVIA_BASE_URL:'https://api.modelvia.dev',REALBUD_MODELVIA_OPERATOR_SECRET:'fictional-operator-secret-of-32-chars',REALBUD_MODELVIA_OPERATOR_SUBJECT:'realbud-provisioning',REALBUD_MODELVIA_CLIENT_ID:'realbud',REALBUD_MODELVIA_MODELS:'fictional-model'};
  assert.equal(modelviaOperatorState(full),'configured');
  for(const name of Object.keys(full)) assert.equal(modelviaOperatorState({...full,[name]:' '}),'missing',name);
  assert.equal(modelviaOperatorState({...full,REALBUD_MODELVIA_OPERATOR_SECRET:'short'}),'missing');
});
