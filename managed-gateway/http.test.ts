import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { fixture } from './testing.ts';
import { createGatewayServer } from './http.ts';
import { GatewayError } from './contracts.ts';
import { PrivateCosts } from './private-costs.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileSecretStore, InstallationProvisioning } from './provisioning.ts';
import { modelviaKeyClient } from './modelvia-keys.ts';
import type { HttpTransport } from './composio-org.ts';

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

/** The real Modelvia client over a stand-in transport shaped like Modelvia's
 * operator routes (`platform-admin.ts`, `accounts.ts` put with versioning). */
async function limitsFixture() {
  const f=fixture(), root=mkdtempSync(join(tmpdir(),'realbud-limits-'));
  const mv={projects:new Map<string,Record<string,unknown>>(),posts:[] as Record<string,unknown>[],conflictOnce:false,offline:false};
  const fetchLike:HttpTransport=async(url,init)=>{
    if(mv.offline) throw new Error('synthetic network failure');
    const path=new URL(url).pathname,body=init.body===undefined?undefined:JSON.parse(String(init.body)) as Record<string,unknown>;
    if(path==='/v1/operator/projects' && init.method==='GET') return Response.json({accounts:[...mv.projects.values()]});
    if(path==='/v1/operator/projects'){
      mv.posts.push(body!);const old=mv.projects.get(body!.id as string);
      // Another writer lands between our read and our write, once.
      if(old && mv.conflictOnce){mv.conflictOnce=false;old.version=(old.version as number)+1;}
      if(body!.version!==((old?.version as number|undefined)??0)) return Response.json({error:'account_version_conflict'},{status:409});
      const saved:Record<string,unknown>={...body!,version:(body!.version as number)+1};mv.projects.set(saved.id as string,saved);return Response.json(saved);
    }
    if(path==='/v1/operator/keys') return Response.json({key:`rbk_0123456789abcdef_${'A'.repeat(43)}`,record:{id:'0123456789abcdef',project:body!.projectId}});
    return Response.json({error:'not_found'},{status:404});
  };
  const modelvia=modelviaKeyClient({serviceOrigin:'https://api.modelvia.dev',environment:'production',clientId:'realbud',allowedModels:['auto'],
    operatorSecret:()=>'fictional-modelvia-operator-secret-32ch',operatorSubject:'realbud-provisioning',fetch:fetchLike,now:f.now});
  const org={async listProjects(){return [];},async createProject(name:string){return {id:'pr_1',name,apiKey:'ak_fictional_project_key_for_tests'};},async deleteProject(){return {revokeJobId:'job-fictional'};}};
  const provisioning=new InstallationProvisioning({ledger:f.ledger,registry:join(root,'devices.json'),endpoint:'https://managed.example.invalid',
    secrets:fileSecretStore(join(root,'secrets')),org,modelvia,authConfigs:{gmail:'ac-fictional-readonly'}});
  await provisioning.provision(f.owner,{companyId:f.tenant.companyId,installationId:'install-one',customerId:'cus-fictional-office',profile:'property'});
  const token='synthetic-portal-token-owner-000001';
  const server=createGatewayServer({gateway:f.gateway(),billing:f.billing,allowedOrigins:new Set(),provisioning,portal:{async authenticate(bearer){if(bearer===token)return f.owner;throw new GatewayError('unauthenticated',401);}}});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  cleanups.push(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();rmSync(root,{recursive:true,force:true});});
  const limits=(caps:Record<string,unknown>)=>fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/portal/limits`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify(caps)});
  return {f,mv,limits};
}
const newCaps={monthlyCapNanoAud:'50000000000',requestCapNanoAud:'500000000',maxConcurrent:2};
test('a cap change reaches the provisioned Modelvia project at its stored version',async()=>{
  const {mv,limits}=await limitsFixture();
  const res=await limits(newCaps);assert.equal(res.status,200);const body=await res.json();
  assert.equal(body.monthlyCapNanoAud,'50000000000');
  assert.deepEqual(body.modelviaCaps,{state:'synced',projects:[{installationId:'install-one',projectId:'rb-install-one',state:'synced'}]});
  const project=mv.projects.get('rb-install-one')!;
  assert.equal(project.monthlyCapNanoAud,'50000000000');assert.equal(project.requestCapNanoAud,'500000000');assert.equal(project.maxConcurrent,2);assert.equal(project.version,2);
});
test('a version conflict is re-read once and then applied',async()=>{
  const {mv,limits}=await limitsFixture();mv.conflictOnce=true;
  const body=await(await limits(newCaps)).json();
  assert.equal(body.modelviaCaps.state,'synced');
  // create (v0), refused write at the stale version, write at the re-read version.
  assert.deepEqual(mv.posts.map(post=>post.version),[0,1,2]);
  assert.equal(mv.projects.get('rb-install-one')!.monthlyCapNanoAud,'50000000000');
});
test('a failed push keeps the local cap change and reports the project as out of sync',async()=>{
  const {f,mv,limits}=await limitsFixture();mv.offline=true;
  const res=await limits(newCaps);assert.equal(res.status,200);const body=await res.json();
  assert.equal(body.monthlyCapNanoAud,'50000000000');assert.equal(f.ledger.tenant('company-a').monthlyCapNanoAud,'50000000000');
  assert.deepEqual(body.modelviaCaps,{state:'out_of_sync',projects:[{installationId:'install-one',projectId:'rb-install-one',state:'out_of_sync',error:'modelvia_unreachable'}]});
  assert.equal(mv.projects.get('rb-install-one')!.monthlyCapNanoAud,f.tenant.monthlyCapNanoAud);
  assert(!JSON.stringify(body).includes('synthetic network failure'));
});
test('without provisioning the limits reply is the ledger view alone',async()=>{
  const f=await serverFixture();
  const res=await fetch(f.base+'/v1/portal/limits',{method:'POST',headers:{Authorization:`Bearer ${f.token}`},body:JSON.stringify(newCaps)});
  assert.equal(res.status,200);const body=await res.json();assert.equal(body.monthlyCapNanoAud,'50000000000');assert.equal('modelviaCaps' in body,false);
});
