// Actual application + company PostgreSQL + admitted Hermes + fictional HTTP
// provider. No customer account or real model provider is used by this fixture.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createServer as socketServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createCompanyInstallation } from '../server/company-installation.ts';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { createDepartmentWorkerFixture, departmentWorkerFixtureKey } from './testing/department-worker-fixture.mjs';
import { parse, stringify } from 'yaml';

if(!process.env.PLAYWRIGHT_MODULE||!process.env.REALBUD_DEPARTMENT_TEST_RUNTIME)throw new Error('Set PLAYWRIGHT_MODULE and REALBUD_DEPARTMENT_TEST_RUNTIME.');
const { chromium }=await import(process.env.PLAYWRIGHT_MODULE);
const root=process.cwd(),resources=process.env.REALBUD_QA_RESOURCES?resolve(process.env.REALBUD_QA_RESOURCES):null;
const output=resolve(process.env.QA_OUTPUT??'outputs/department-work-2026-09-22/gui-source');mkdirSync(output,{recursive:true});
const temp=mkdtempSync(join(realpathSync(tmpdir()),'rb-department-gui-')),data=join(temp,'data');mkdirSync(data);
const key=randomBytes(32),bin=realpathSync(process.env.REALBUD_TEST_POSTGRES_BIN??'/opt/homebrew/opt/postgresql@16/bin');
let setup,child,closed,browser,page,base,token,ownerToken,ownerId,logs='',provider;
const checks=[],errors=[],captures=[];let readinessProbes=0,providerGate=null;
const wait=ms=>new Promise(done=>setTimeout(done,ms));
async function eventually(fn){for(let i=0;i<150;i++){if(await fn())return;await wait(200);}throw new Error('Fixture observation deadline exceeded.');}
async function stop(){if(!child||child.exitCode!==null||child.signalCode)return;child.kill('SIGTERM');const timeout=setTimeout(()=>child.kill('SIGKILL'),8000);try{await closed;}finally{clearTimeout(timeout);}}
async function start(){
  const socket=socketServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(done=>socket.close(done));base=`http://127.0.0.1:${port}`;
  child=spawn(process.execPath,[resources?join(resources,'server/bootstrap.js'):join(root,'server/bootstrap.ts')],{cwd:resources??root,env:{...serviceSmokeEnv({executable:process.execPath,home:temp,data,scratch:temp,port}),REALBUD_MANAGED_SERVICE:'0',REALBUD_TEST_LAB:'1',REALBUD_DESK_KEY:key.toString('hex'),REALBUD_COMPANY_POSTGRES_BIN:bin,OMB_STATIC_DIR:resources?join(resources,'ui'):join(root,'dist')},stdio:['ignore','pipe','pipe']});
  closed=new Promise((done,reject)=>{child.once('close',done);child.once('error',reject);});
  for(const stream of[child.stdout,child.stderr])stream.on('data',part=>{logs=(logs+part).slice(-60_000);});
  await eventually(async()=>{if(child.exitCode!==null)throw new Error(logs);try{return (await(await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)})).json()).pid===child.pid;}catch{return false;}});
  token=(await(await fetch(base+'/api/session')).json()).token;
}
async function app(path,body,expected=200,method=body===undefined?'GET':'POST',allowStarting=false){
  const response=await fetch(base+path,{method,headers:{'content-type':'application/json','x-realbud-session':token,'x-realbud-member-session':ownerToken},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json();if(allowStarting&&response.status===503)return null;assert.equal(response.status,expected,JSON.stringify(result));return result;
}
const pass=message=>{checks.push(message);console.log('PASS '+message);};
try{
  provider=createServer(async(req,res)=>{
    try {
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'){req.resume();res.writeHead(404);res.end();return;}
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks));
    if(!JSON.stringify(body).includes('ASSIGNED COMPANY CASE SOURCE')){readinessProbes++;res.writeHead(503,{'content-type':'application/json'});res.end('{"error":"Fictional readiness probe is outside case preparation"}');return;}
    assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer '+departmentWorkerFixtureKey);
    captures.push(body);if(providerGate)await providerGate;
    const content=JSON.stringify({summary:'Assigned case prepared',evidence:['Fictional case source only'],outputs:['Confirm Friday access with the property owner.'],needsApproval:[]});
    const completion={id:'fictional-department',object:'chat.completion',created:1,model:'fictional-case-model'};
    if(body.stream){res.writeHead(200,{'content-type':'text/event-stream'});res.end(`data: ${JSON.stringify({...completion,choices:[{index:0,delta:{role:'assistant',content},finish_reason:null}]})}\n\ndata: ${JSON.stringify({...completion,choices:[{index:0,delta:{},finish_reason:'stop'}]})}\n\ndata: [DONE]\n\n`);}
    else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({...completion,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}]}));}
    }catch(error){errors.push('Fictional provider: '+String(error));if(!res.headersSent)res.writeHead(500);res.end('{}');}
  });provider.listen(0,'127.0.0.1');await once(provider,'listening');
  const {runtimeDirectory:runtime,profileDirectory:profile}=createDepartmentWorkerFixture({root:join(data,'hermes'),runtimeDirectory:process.env.REALBUD_DEPARTMENT_TEST_RUNTIME,baseUrl:`http://127.0.0.1:${provider.address().port}/v1`});
  writeFileSync(join(runtime,'.env'),'HERMES_EPHEMERAL_SYSTEM_PROMPT=RUNTIME_CANARY\n',{mode:0o600});
  const config=parse(readFileSync(join(profile,'config.yaml'),'utf8'));config.agent={...config.agent,system_prompt:'PRIVATE_CONFIG_CANARY'};writeFileSync(join(profile,'config.yaml'),stringify(config),{mode:0o600});
  mkdirSync(join(profile,'memories'),{recursive:true});
  for(const name of['SOUL.md','USER.md','MEMORY.md','AGENTS.md'])writeFileSync(join(profile,name),'PRIVATE_PROFILE_CANARY',{mode:0o600});
  writeFileSync(join(profile,'memories/MEMORY.md'),'PRIVATE_MEMORY_CANARY',{mode:0o600});
  writeFileSync(join(data,'config.json'),JSON.stringify({profile:{name:'Practice owner'},instances:{fixture:{driver:'not-a-real-driver'}}}),{mode:0o600});
  setup=createCompanyInstallation({dataDirectory:data,binaryDirectory:bin,previewEnabled:true,privateStateKey:key,hasAdminSession:()=>true,authorizeAdmin:()=>({ok:true,expiresAt:Date.now()+60_000})});
  const prepare=(path,body,member='')=>setup.handle('/api/company/'+path,body===undefined?'GET':'POST',{headers:{'x-realbud-member-session':member}},body);
  assert.equal((await prepare('setup',{})).status,200);
  const made=await prepare('create',{name:'Fictional Acacia Agency',ownerName:'Practice owner',credential:{loginName:'practice.owner',password:'Fictional-company-password-2026'}});assert.equal(made.status,201);ownerToken=made.body.memberToken;ownerId=made.body.member.id;
  assert.equal((await prepare('network',{hostname:'127.0.0.1'},ownerToken)).status,200);await setup.close();setup=null;await start();
  const departmentId=randomUUID();await app('/api/company/departments',{requestId:departmentId,name:'Fictional Operations'},201);
  const department=(await app('/api/company/departments/list',{offset:0})).departments.find(d=>d.id===departmentId);assert(department);
  const caseId=randomUUID();await app('/api/company/departments/cases/create',{requestId:caseId,departmentId,title:'Friday access review',description:'Fictional property inspection on Friday. Access needs owner confirmation.',assigneeMemberId:ownerId},201);await app('/api/company/department-outbox/ack',{requestId:caseId});
  await app('/api/recipes',{draft:{id:'fictional-case-review',title:'Fictional case review plan',description:'Prepare the assigned case for owner review.',steps:['Summarize the supplied facts.','List missing information.'],allowedOrigins:[],evidence:'Use the assigned case only.',capabilities:['analyse','draft'],limits:{maxRuntimeMinutes:1,maxTurns:2},schedule:null}},201);
  const recipe=(await app('/api/recipes')).recipes.find(r=>r.id==='fictional-case-review');await app('/api/recipes/'+recipe.id,{expectedRevision:recipe.revision,planApproved:true,status:'active'},200,'PATCH');
  browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
  const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.addInitScript(value=>{localStorage.setItem('realbud.first-run-done','1');sessionStorage.setItem('realbud.company-member-session',value);},ownerToken);
  page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  async function open(){
    await page.goto(base+'/#/you');
    await page.locator('summary').filter({hasText:/^This office/}).first().evaluate(n=>{n.parentElement.open=true;});
    await page.locator('summary').filter({hasText:/^Departments and access$/}).evaluate(n=>{n.parentElement.open=true;});
    const work=page.getByRole('button',{name:'View work in Fictional Operations',exact:true});
    await work.waitFor();
    if(await work.getAttribute('aria-pressed')!=='true')await work.click();
    await page.getByRole('button',{name:'Refresh preparations',exact:true}).waitFor();
    await page.getByRole('button',{name:'Refresh department work',exact:true}).click();
  }
  async function openRequest(){await page.getByText('Request preparation for my assigned case',{exact:true}).evaluate(n=>{n.parentElement.open=true;});}
  await open();await openRequest();
  await page.getByLabel('Open case assigned to me',{exact:true}).selectOption(caseId);await page.getByLabel('Reviewed preparation plan',{exact:true}).selectOption(recipe.id);
  await page.getByRole('checkbox',{name:'I reviewed the complete plan and case. I request one preparation on my assigned instance after the owner approves.',exact:true}).check();
  await page.getByRole('button',{name:'Request one preparation',exact:true}).click();
  await page.getByRole('button',{name:'Review and approve preparation',exact:true}).waitFor();
  assert.equal(captures.length,0);let history=await app('/api/company/department-work/list',{departmentId,offset:0,limit:10});assert.equal(history.grants.length,1);assert.equal(history.grants[0].phase,'pending');
  await page.getByRole('button',{name:'Review and approve preparation',exact:true}).click();const review=page.getByRole('form',{name:'Owner approval of department preparation'});await review.scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'desktop-owner-review.png')});
  await review.getByRole('checkbox').check();await review.getByRole('button',{name:'Approve one preparation',exact:true}).click();
  await eventually(async()=>{history=await app('/api/company/department-work/list',{departmentId,offset:0,limit:10});return ['review-required','held'].includes(history.local[0]?.phase);});
  assert.equal(history.local[0].phase,'review-required',JSON.stringify(history.local));assert.equal(history.local[0].result.status,'completed');assert.equal(captures.length,1);assert(!JSON.stringify(captures).includes('CANARY'));assert.equal(captures[0].model,'fictional-case-model');assert.deepEqual(captures[0].tools.map(t=>t.function.name),['todo_list']);
  await page.getByRole('button',{name:'Refresh preparations',exact:true}).click();await page.getByText('Confirm Friday access with the property owner.',{exact:true}).waitFor();await page.getByText('Confirm Friday access with the property owner.',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'desktop-result.png')});
  const cases=await app('/api/company/departments/cases',{departmentId,offset:0,filter:'all'});assert.equal(cases.cases[0].status,'recovery_required');
  pass('Rendered member request and exact owner review start one actual Hermes preparation; only assigned case context reaches the fictional provider and the case remains held for human review.');
  const runId=history.local[0].runId;await stop();await start();await open();await page.getByRole('button',{name:'Refresh preparations',exact:true}).click();await page.getByText('Confirm Friday access with the property owner.',{exact:true}).waitFor();
  history=await app('/api/company/department-work/list',{departmentId,offset:0,limit:10});assert.equal(history.local[0].runId,runId);assert.equal(captures.length,1);
  pass('Actual service restart preserves the result and original run ID without a second provider request.');
  await page.setViewportSize({width:390,height:844});await page.getByText('Confirm Friday access with the property owner.',{exact:true}).scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'mobile-result.png')});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1));assert.deepEqual(errors,[]);
  pass('Mobile result view has no horizontal overflow; no uncaught browser errors.');
  await page.setViewportSize({width:1440,height:1000});
  async function startAnother(title){
    const id=randomUUID();await app('/api/company/departments/cases/create',{requestId:id,departmentId,title,description:'Fictional inspection on Friday; prepare only the supplied case.',assigneeMemberId:ownerId},201);await app('/api/company/department-outbox/ack',{requestId:id});
    await open();await openRequest();
    await page.getByLabel('Open case assigned to me',{exact:true}).selectOption(id);await page.getByLabel('Reviewed preparation plan',{exact:true}).selectOption(recipe.id);
    await page.getByRole('checkbox',{name:'I reviewed the complete plan and case. I request one preparation on my assigned instance after the owner approves.',exact:true}).check();await page.getByRole('button',{name:'Request one preparation',exact:true}).click();
    const card=page.getByRole('article',{name:'Preparation for '+title});await card.getByRole('button',{name:'Review and approve preparation',exact:true}).click();
    const ownerReview=page.getByRole('form',{name:'Owner approval of department preparation'});await ownerReview.getByRole('checkbox').check();await ownerReview.getByRole('button',{name:'Approve one preparation',exact:true}).click();return {id,card};
  }
  let release;providerGate=new Promise(done=>{release=done;});
  const revoked=await startAnother('Permission withdrawal check');await eventually(async()=>captures.length===2);
  const admittedRefresh=page.waitForResponse(response=>response.url()===base+'/api/company/department-work/list'&&response.request().method()==='POST');
  await page.getByRole('button',{name:'Refresh preparations',exact:true}).click();assert.equal((await admittedRefresh).status(),200);
  await revoked.card.getByRole('button',{name:'Review withdrawal',exact:true}).click();
  const withdrawal=page.getByRole('form',{name:'Withdraw department preparation permission'});await withdrawal.getByLabel('Reason for withdrawal',{exact:true}).fill('Fictional owner stopped this preparation.');
  const withdrawalReply=page.waitForResponse(response=>response.url()===base+'/api/company/department-work/revoke'&&response.request().method()==='POST');
  await withdrawal.getByRole('button',{name:'Withdraw preparation permission',exact:true}).click();assert.equal((await withdrawalReply).status(),200);
  release();providerGate=null;
  let revokedState;await eventually(async()=>{const list=await app('/api/company/department-work/list',{departmentId,offset:0,limit:10});revokedState=list.local.find(s=>s.caseId===revoked.id);return revokedState?.phase==='held'&&revokedState.result;});
  assert.equal(revokedState.result.status,'failed');assert.deepEqual(revokedState.result.outputs,[]);assert.equal(captures.length,2);
  await page.getByRole('button',{name:'Refresh preparations',exact:true}).click();await revoked.card.getByRole('button',{name:'Retry saved result delivery',exact:true}).click();assert.equal(captures.length,2);
  await revoked.card.scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'desktop-revoked-result.png')});
  pass('Actual owner withdrawal aborts in-flight department preparation; a late provider response is not accepted and retrying factual delivery does not invoke the worker again.');
  providerGate=new Promise(done=>{release=done;});
  const interrupted=await startAnother('Interrupted service check');await eventually(async()=>captures.length===3);
  const beforeCrash=(await app('/api/job-runs')).runs.find(r=>r.status==='running');assert(beforeCrash);
  child.kill('SIGKILL');await closed;release();providerGate=null;await start();
  let recovered;await eventually(async()=>{const list=await app('/api/company/department-work/list',{departmentId,offset:0,limit:10},200,'POST',true);if(!list)return false;recovered=list.local.find(s=>s.caseId===interrupted.id);return recovered?.phase==='review-required'&&recovered.result;});
  assert.equal(recovered.runId,beforeCrash.id);assert.equal(recovered.result.status,'interrupted');assert.deepEqual(recovered.result.outputs,[]);assert.equal(captures.length,3);
  await open();await page.getByRole('button',{name:'Refresh preparations',exact:true}).click();await page.getByRole('article',{name:'Preparation for Interrupted service check'}).scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'desktop-interrupted-result.png')});
  pass('SIGKILL after durable enqueue is recovered by a cold actual service as the same interrupted run, with no second provider attempt and the case held for human review.');
  assert.deepEqual(errors,[]);
  writeFileSync(join(output,'receipt.json'),JSON.stringify({ok:true,at:new Date().toISOString(),layer:resources?'Compiled application+native Hermes fixture':'Source application+native Hermes fixture',checks,providerRequests:captures.length,readinessProbesDenied:readinessProbes,runId,errors,limits:['Fictional identities and provider only','No native installer, Windows device, website department authority or live customer acceptance']},null,2));
}catch(error){if(page){await page.screenshot({path:join(output,'failure.png')}).catch(()=>{});writeFileSync(join(output,'failure-ui.txt'),await page.locator('body').innerText().catch(()=>''));}writeFileSync(join(output,'failure.log'),logs+'\n'+String(error));throw error;}
finally{await browser?.close();await stop();await setup?.close();provider?.closeAllConnections();if(provider)await new Promise(done=>provider.close(done));rmSync(temp,{recursive:true,force:true});writeFileSync(join(output,'cleanup.json'),JSON.stringify({complete:true}));}
