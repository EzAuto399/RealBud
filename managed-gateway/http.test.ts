import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fixture } from './testing.ts';
import { createGatewayServer } from './http.ts';
import { GatewayError } from './contracts.ts';
import { PrivateCosts } from './private-costs.ts';

const cleanups:(()=>Promise<void>)[]=[];afterEach(async()=>{while(cleanups.length)await cleanups.pop()!();});
async function serverFixture() {
  const f=fixture();const token='synthetic-portal-token-owner-000001',reader='synthetic-portal-token-reader-00001',foreign='synthetic-portal-token-foreign-0001';
  f.ledger.provisionTenant({...f.tenant,companyId:'company-b',licenseId:'license-b',customerName:'Fictional Agency B'});
  const server=createGatewayServer({gateway:f.gateway(),billing:f.billing,allowedOrigins:new Set(['https://portal.invalid']),portal:{async authenticate(bearer){if(bearer===token)return f.owner;if(bearer===reader)return {...f.owner,role:'billing_reader'};if(bearer===foreign)return {...f.owner,companyId:'company-b'};throw new GatewayError('unauthenticated',401);}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));f.close();});
  const base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get=(path:string,bearer=token,extra:Record<string,string>={})=>fetch(base+path,{headers:{Authorization:`Bearer ${bearer}`,...extra}});
  return {...f,base,token,reader,foreign,get};
}
test('HTTP model dispatch and scoped portal read persist one actual simulated request',async()=>{
  const f=await serverFixture();const grant=Buffer.from(JSON.stringify(f.envelope())).toString('base64url');
  const res=await fetch(f.base+'/v1/model/stream',{method:'POST',headers:{Authorization:`Bearer ${grant}`,'Content-Type':'application/json'},body:JSON.stringify(f.request)});
  assert.equal(res.status,200);const text=await res.text();assert(text.includes('event: settled'));assert(text.includes('Synthetic reply'));
  const usage=await(await f.get('/v1/portal/usage')).json();assert.equal(usage.requests.length,1);assert.equal(usage.requests[0].chargedNanoAud,'19250000');
  assert.equal((await(await f.get('/v1/portal/usage',f.foreign,{'x-company-id':'company-a'})).json()).requests.length,0);
});
test('generic headers, office sessions, cookies and execution grants cannot impersonate a portal account',async()=>{
  const f=await serverFixture();
  assert.equal((await fetch(f.base+'/v1/portal/usage',{headers:{'x-company-id':'company-a','x-member-id':'member-a','x-realbud-member-session':'invented',Cookie:'session=owner'}})).status,401);
  assert.equal((await f.get('/v1/portal/usage',Buffer.from(JSON.stringify(f.envelope())).toString('base64url'))).status,401);
  assert.equal((await f.get('/v1/portal/usage',f.token,{Origin:'https://evil.invalid'})).status,403);
});
test('portal readers cannot change caps or accept rates; invoices enforce tenant scope',async()=>{
  const f=await serverFixture();const rate=(await(await f.get('/v1/portal/rates')).json()).rates[0];
  const res=await fetch(f.base+'/v1/portal/rates/accept',{method:'POST',headers:{Authorization:`Bearer ${f.reader}`},body:JSON.stringify({version:rate.card.version,digest:rate.digest})});assert.equal(res.status,403);
  f.setTime(Date.parse('2026-10-01T00:00:00Z'));const i=f.billing.finalizeLocalInvoice('company-a','2026-09','agreement');
  assert.equal((await f.get(`/v1/portal/invoices/${i.id}`,f.foreign)).status,404);
  const listed=await(await f.get('/v1/portal/invoices')).json();
  assert.equal(listed.invoices.length,1);assert.equal(listed.invoices[0].id,i.id);assert.equal(listed.invoices[0].paid,false);assert.equal(listed.invoices[0].gstCents,i.gstCents);
  assert(!JSON.stringify(listed).includes('basisPoints'));assert(!JSON.stringify(listed).includes('USD'));
  const document=await f.get(`/v1/portal/invoices/${i.id}/document`);assert.equal(document.status,200);assert(document.headers.get('content-security-policy')?.includes("default-src 'none'"));assert((await document.text()).includes('Yo-Da Lai'));
});
test('HTTP errors are generic and deny oversized bodies, prototype extras and unauthorized webhook data',async()=>{
  const f=await serverFixture();
  assert.equal((await fetch(f.base+'/v1/webhooks/payment',{method:'POST',body:'{}'})).status,401);
  assert.equal((await fetch(f.base+'/v1/portal/rates/accept',{method:'POST',headers:{Authorization:`Bearer ${f.token}`},body:' '.repeat(4097)})).status,413);
  const response=await fetch(f.base+'/v1/portal/rates/accept',{method:'POST',headers:{Authorization:`Bearer ${f.token}`},body:'{"version":"fixture-r1","digest":"anything","__proto__":{"role":"billing_owner"}}'});assert.equal(response.status,400);
  const data=await response.text();assert(!data.includes('stack'));assert(!data.includes('node:'));
});
test('private source cost/FX/margin versions persist and never enter tenant views',async()=>{
  const f=await serverFixture();const costs=new PrivateCosts(f.ledger);
  costs.save({id:'cost-one',providerId:f.provider.id,model:f.request.model,sourceReference:'fixture-price-reference',verifiedAt:f.now(),currency:'USD',units:{input_tokens:{nanoCurrency:'1000',perUnits:1}},fx:{numerator:'3',denominator:'2',sourceReference:'fixture-fx-reference',fixedAt:f.now()},policy:{method:'margin',basisPoints:2000}});
  assert.equal(costs.proposal('cost-one').status,'unpublished_draft');
  const portal=JSON.stringify(await(await f.get('/v1/portal/rates')).json())+JSON.stringify(await(await f.get('/v1/portal/usage')).json());assert(!portal.includes('cost-one'));assert(!portal.includes('basisPoints'));assert(!portal.includes('USD'));
  await f.run();const r=f.ledger.requests('company-a')[0];const input={evidenceId:'provider-bill-one',dispatchId:r.id,providerId:f.provider.id,providerRequestId:'provider-one',currency:'USD',actualCostNano:'123',sourceReference:'fixture-provider-bill'};
  costs.reconcileCost(input);costs.reconcileCost(input);assert.throws(()=>costs.reconcileCost({...input,providerRequestId:'someone-else'}),/provider_cost_binding_mismatch/);
});
