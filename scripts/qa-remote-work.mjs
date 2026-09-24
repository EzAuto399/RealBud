// Actual desktop HTTP/UI -> actual Next routes -> disposable PostgreSQL RPCs.
// The preload maps only the fixed website origin to that local fixture. Mail
// and CLI responses are fictional, so this is not deployed/provider acceptance.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync,existsSync } from 'node:fs';
import { join,dirname,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { startCommandSite } from '../website/scripts/testing/command-site.mjs';
if(!process.env.PLAYWRIGHT_MODULE)throw new Error('Set PLAYWRIGHT_MODULE.');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),temp=mkdtempSync(join(realpathSync(tmpdir()),'rb-remote-work-')),data=join(temp,'data');mkdirSync(data,{mode:0o700});
const output=resolve(process.env.QA_OUTPUT??join(root,'outputs/remote-work-2026-09-22/gui-source'));mkdirSync(output,{recursive:true});
// Slice 3 portal UX evidence: portal renders at phone, tablet and desktop
// widths plus the confirm dialog's keyboard contract.
const uxOutput=resolve(process.env.PORTAL_UX_OUTPUT??join(root,'outputs/portal-ux-2026-09-22/slice3/remote-work'));mkdirSync(uxOutput,{recursive:true});
const uxWidths=[360,768,1280],uxLayout=[];
const measurePortal=async(view,path,width)=>{await view.setViewportSize({width,height:width===360?780:1000});const measured=await view.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,wide:[...document.querySelectorAll('main *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).map(el=>({tag:el.tagName,class:String(el.className)})).slice(0,10)}));uxLayout.push({path,width,...measured});assert.ok(measured.scroll<=measured.width+1,`${path} at ${width}px scrolls to ${measured.scroll}`);return measured;};
const executable=process.env.REALBUD_QA_EXECUTABLE??process.execPath,resources=process.env.REALBUD_QA_RESOURCES;
if(!!resources!==!!process.env.REALBUD_QA_EXECUTABLE)throw new Error('Specify both compiled executable and resources.');
const entry=resources?join(resources,'server/bootstrap.js'):join(root,'server/bootstrap.ts');
// Readiness probes are fixture setup, recorded separately from preparation work.
function fixtureCallSummary(){
 try{
  const read=name=>existsSync(join(temp,name))?JSON.parse(readFileSync(join(temp,name),'utf8')):[];
  const work=read('worker-calls.json'),readiness=read('readiness-calls.json');
  return {readinessCalls:readiness.length,preparationCalls:work.length,lastWorkShapes:work.slice(-5).map(({argv})=>({argumentCount:argv.length,hasPrompt:argv.includes('-q'),readinessPrompt:argv.some(arg=>arg.startsWith('Readiness check ')),boundedTodo:argv[argv.indexOf('--toolsets')+1]==='todo',oneTurn:argv[argv.indexOf('--max-turns')+1]==='1'}))};
 }catch{return {diagnosticsUnavailable:true};}
}
const wait=ms=>new Promise(r=>setTimeout(r,ms));let site,child,closed,browser,page,context,base,token,logs='',scanCalls=0,statusUnavailable=false;
const checks=[],errors=[],denied=[],mutations=[];
const credential=`rbc_${'a'.repeat(64)}`;
const connector=createServer(async(req,res)=>{res.setHeader('content-type','application/json');
 if(req.headers.authorization!==`Bearer ${credential}`){res.writeHead(403).end('{}');return;}
 if(req.url==='/v1/connectors/status'){if(statusUnavailable){res.writeHead(503).end('{}');return;}res.end(JSON.stringify({managed:true,checkedAt:new Date().toISOString(),serviceExpiresAt:Date.now()+3600000,services:{gmail:{connected:true,status:'ACTIVE',accounts:[{id:'fixture-mail',label:'Fictional mail',status:'ACTIVE'}],accountSelectionRequired:false}},tools:{available:true,names:['GMAIL_GET_PROFILE','GMAIL_LIST_THREADS','GMAIL_FETCH_MESSAGE_BY_THREAD_ID']}}));return;}
 if(req.url==='/v1/connectors/mail-scan'){let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);if(body.expectedAccountId!=='fixture-mail'||!body.scope){res.writeHead(409).end('{}');return;}const input=body.scope;scanCalls++;res.end(JSON.stringify({accountId:'fixture-mail',windowStartAt:input.windowStartAt,windowEndAt:input.windowEndAt,pages:1,paginationComplete:true,gaps:[],threads:[{id:'a1',historyComplete:true,messages:[{id:'a2',threadId:'a1',at:input.windowEndAt-1000,direction:'incoming',from:'fictional@example.test',to:'office@example.test',subject:'Private fictional maintenance',body:'Review the fictional maintenance request.',bodyTruncated:false,attachments:[]}]}]}));return;}
 res.writeHead(404).end('{}');
});
async function stop(signal='SIGTERM'){if(!child||child.exitCode!==null||child.signalCode)return;child.kill(signal);const timer=setTimeout(()=>child.kill('SIGKILL'),5000);try{await closed;}finally{clearTimeout(timer);}}
async function start(){const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));base=`http://127.0.0.1:${port}`;
 child=spawn(executable,['--import',join(temp,'website-preload.mjs'),entry],{cwd:resources??root,env:{...serviceSmokeEnv({executable,home:temp,data,scratch:temp,port}),REALBUD_MANAGED_SERVICE:'0',REALBUD_TEST_LAB:'1',REALBUD_HERMES_CLI:join(temp,'worker.mjs'),OMB_STATIC_DIR:resources?join(resources,'ui'):join(root,'dist')},stdio:['ignore','pipe','pipe']});
 closed=new Promise((r,j)=>{child.once('close',r);child.once('error',j);});for(const stream of[child.stdout,child.stderr])stream.on('data',b=>logs=(logs+b).slice(-80000));
 let ready=false;for(let i=0;i<150;i++){if(child.exitCode!==null||child.signalCode)break;try{if((await(await fetch(base+'/api/health',{signal:AbortSignal.timeout(400)})).json()).pid===child.pid){ready=true;break;}}catch{}await wait(100);}assert.ok(ready,logs);token=(await(await fetch(base+'/api/session')).json()).token;
}
async function request(path,method='GET',body,expected=200){if(method!=='GET')mutations.push({at:Date.now(),source:'harness',method,path});const response=await fetch(base+path,{method,signal:AbortSignal.timeout(45000),headers:{'content-type':'application/json','x-realbud-session':token},...(body===undefined?{}:{body:JSON.stringify(body)})}),value=await response.json();assert.equal(response.status,expected,`${path}: ${JSON.stringify(value)}`);return value;}
async function website(path,method='GET',body,expected=200,actor='a'){const response=await fetch(site.origin+path,{method,headers:site.headers(actor),...(body===undefined?{}:{body:JSON.stringify(body)})}),value=await response.json();assert.equal(response.status,expected,`${path}: ${JSON.stringify(value)}`);return value;}
const card=()=>page.getByRole('heading',{name:'Requests from the website',exact:true}).locator('..');
async function open(){await page.goto(base+'/#/you');const section=page.locator('details#you-office');await section.waitFor();if(!await section.evaluate(el=>el.open))await section.locator(':scope > summary').click();await card().getByRole('button',{name:'Refresh saved status',exact:true}).waitFor();}
async function state(){return request('/api/website-requests');}
try{
 site=await startCommandSite({remoteWork:true});connector.listen(0,'127.0.0.1');await once(connector,'listening');
 const calls=join(temp,'worker-calls.json'),drops=join(temp,'drop-work-replies.json'),wire=join(temp,'work-wire.jsonl'),crashControl=join(temp,'crash-control.json'),crashMarker=join(temp,'crash-marker.json');
 writeFileSync(join(temp,'website-preload.mjs'),`import{existsSync,readFileSync,writeFileSync,appendFileSync}from'node:fs';import{createHash}from'node:crypto';const original=globalThis.fetch;const drops=${JSON.stringify(drops)},wire=${JSON.stringify(wire)};globalThis.fetch=async(input,init)=>{const url=String(input);if(url.startsWith('https://realbud.app/')){const path=new URL(url).pathname,raw=typeof init?.body==='string'?init.body:'';if(path==='/api/installations/v2/work/review'){const body=JSON.parse(raw);const forbidden=new Set(['binding','commandToken','credential','gmailAccountId','bookRevision','providerKey']);function check(v){if(v&&typeof v==='object')for(const[k,x]of Object.entries(v)){if(forbidden.has(k))throw new Error('Private binding upload blocked by fixture');check(x);}}check(body);if(raw.includes('fixture-mail')||raw.includes('Private fictional maintenance')||raw.includes('fictional@example.test'))throw new Error('Private source upload blocked by fixture');}const result=await original(${JSON.stringify(site.origin)}+url.slice('https://realbud.app'.length),init);if(path.startsWith('/api/installations/v2/work/')){let map={};if(existsSync(drops))map=JSON.parse(readFileSync(drops,'utf8'));const lost=result.ok&&map[path]>0;if(lost){map[path]--;writeFileSync(drops,JSON.stringify(map));}appendFileSync(wire,JSON.stringify({path,ok:result.ok,lost,bytes:Buffer.byteLength(raw),bodyDigest:createHash('sha256').update(raw).digest('hex')})+'\\n');if(lost)throw new TypeError('Fixture lost committed desktop reply');}if(result.ok&&existsSync(${JSON.stringify(crashControl)})){const control=JSON.parse(readFileSync(${JSON.stringify(crashControl)},'utf8'));if(path===control.path&&JSON.parse(raw).requestId===control.requestId){writeFileSync(${JSON.stringify(crashMarker)},JSON.stringify(control));await new Promise(()=>{});}}Object.defineProperty(result,'url',{value:url});return result;}if(new URL(url).hostname!=='127.0.0.1')throw new Error('Fixture external transport denied');return original(input,init);};`);
 writeFileSync(join(temp,'worker.mjs'),`#!${process.execPath}\nimport{readFileSync,writeFileSync,existsSync}from'node:fs';if(process.argv.includes('--version')){console.log('Hermes Agent v0.21.3 (2026.9.14)');process.exit(0);}const args=process.argv.slice(2);if(args.length===10&&args[0]==='--profile'&&args[1]==='property'&&args[2]==='chat'&&args[3]==='-Q'&&args[4]==='--toolsets'&&args[5]==='todo'&&args[6]==='-q'&&/^Readiness check [0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}[.] Reply with exactly OK, without punctuation or explanation[.] Do not use tools[.]$/.test(args[7])&&args[8]==='--max-turns'&&args[9]==='1'){const p=${JSON.stringify(join(temp,'readiness-calls.json'))};let probes=[];try{probes=JSON.parse(readFileSync(p,'utf8'));}catch{}probes.push({at:Date.now()});writeFileSync(p,JSON.stringify(probes));console.log('OK');process.exit(0);}const path=${JSON.stringify(join(data,'vault/workflow-inputs/accounts-inbox.json'))};let output='Prepared fictional briefing.';if(existsSync(path)){const input=JSON.parse(readFileSync(path,'utf8'));output=JSON.stringify({version:1,kind:'accounts-inbox-triage',skillSource:'email-inbox-triage@0.1.0',sourceReference:input.sourceReference,status:'complete',coverageComplete:true,holds:[],actionsPerformed:[],threads:input.threads.map(t=>({threadId:t.threadId,disposition:'action-review',owner:'property-manager',priority:'normal',sourceMessageIds:t.messages.map(m=>m.messageId),reason:'Fictional review.',nextAction:'Review internally.',missingFacts:[]}))});}let calls=[];try{calls=JSON.parse(readFileSync(${JSON.stringify(calls)},'utf8'));}catch{}calls.push({at:Date.now(),argv:process.argv.slice(2)});writeFileSync(${JSON.stringify(calls)},JSON.stringify(calls));console.log(JSON.stringify({summary:'Fictional preparation',evidence:['Fictional evidence'],outputs:[output],needsApproval:[]}));`,{mode:0o700});
 writeFileSync(join(data,'config.json'),JSON.stringify({instances:{fixture:{driver:'not-a-real-driver'}},composio:{managed:{endpoint:`http://127.0.0.1:${connector.address().port}`,credential,profile:'property'}}}),{mode:0o600});
 await start();assert.equal((await fetch(base+'/api/website-requests')).status,401);
 // Complete the fixture's persisted welcome flow; a browser flag is not setup authority.
 let welcome=await request('/api/onboarding');assert.equal(welcome.stage,'profile');
 for(const stage of ['office-rules','complete']){
  const previous=welcome;welcome=await request('/api/onboarding','PUT',{expectedScope:previous.scope,expectedRevision:previous.revision,stage});
  assert.equal(welcome.scope,previous.scope);assert.equal(welcome.revision,previous.revision+1);assert.equal(welcome.stage,stage);
 }
 assert.deepEqual(await request('/api/onboarding'),welcome);
 await request('/api/hermes/apply-pack','POST',{});const pack=await request('/api/customer-packs/office-core/export'),preview=await request('/api/customer-packs/preview','POST',{pack});await request('/api/customer-packs/install','POST',{pack,expectedDigest:preview.digest});
 let recipes=(await request('/api/recipes')).recipes;const morning=recipes.find(r=>r.id==='wf-office-core-inbox-triage');await request(`/api/recipes/${morning.id}`,'PATCH',{expectedRevision:morning.revision,planApproved:true,status:'active'});
 await request('/api/recipes','POST',{draft:{id:'fictional-briefing',title:'Fictional briefing',description:'Prepare a fictional internal briefing.',steps:['Review the fictional facts.'],allowedOrigins:[],evidence:'Fictional notes',capabilities:['analyse','draft'],limits:{maxRuntimeMinutes:1,maxTurns:4},schedule:null}},201);
 const recipe=(await request('/api/recipes')).recipes.find(r=>r.id==='fictional-briefing');await request(`/api/recipes/${recipe.id}`,'PATCH',{expectedRevision:recipe.revision,planApproved:true,status:'active'});
 const worker=await request('/api/hermes');writeFileSync(join(data,'hands-ping.json'),JSON.stringify({at:Date.now(),ok:true,detail:'Fictional fixture readiness',kind:'ping',workerFingerprint:worker.workerFingerprint}),{mode:0o600});
 await request('/api/connected-apps/check','POST',{});let setup=await request('/api/agency-setup');setup=await request('/api/agency-setup','PUT',{expectedRevision:setup.state.revision,settings:{...setup.state.settings,agencyName:'Fictional local agency',workflowPackId:'office-core',gmailAccountId:'fixture-mail',timeZone:'Australia/Brisbane',selectedWorkflows:['morning-priorities']}});setup=await request('/api/agency-setup/check-gmail','POST',{expectedRevision:setup.state.revision});const ready=setup.workflows.find(w=>w.id==='morning-priorities');await request('/api/agency-setup/workflows/morning-priorities/review','POST',{expectedRevision:setup.state.revision,expectedEvidenceDigest:ready.evidenceDigest});
 const link=await website('/api/account/installations','POST',{},201);await request('/api/office-link','POST',{code:link.code,label:'Fictional reception Mac'});
 browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});context=await browser.newContext({viewport:{width:1440,height:1100}});page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await open();
 const remoteCard=()=>page.getByRole('heading',{name:'People who can review from the website',exact:true}).locator('..');
 await remoteCard().getByRole('checkbox',{name:'Fictional briefing',exact:true}).check();await remoteCard().getByRole('checkbox',{name:'Morning priorities',exact:true}).check();await remoteCard().getByLabel('Workspace name',{exact:true}).fill('Fictional private work');
 await remoteCard().getByRole('button',{name:'Review what may be shared',exact:true}).click();const disclosure=page.getByRole('region',{name:'Review disclosure template'});await disclosure.waitFor();assert(!await disclosure.textContent().then(t=>t.includes('fixture-mail')));await disclosure.scrollIntoViewIfNeeded();await page.screenshot({path:join(output,'disclosure-review-desktop.png')});
 site.loseNextRpcReply('realbud_enroll_remote_commands');await disclosure.getByRole('checkbox').check();await disclosure.getByRole('button',{name:'Create invitation'}).click();await remoteCard().getByRole('alert').waitFor();await remoteCard().getByRole('button',{name:'Disable all remote access here'}).click();await remoteCard().getByRole('button',{name:'Review what may be shared'}).waitFor();assert.equal((await request('/api/website-requests/remote')).enabled,false);await disclosure.getByRole('checkbox').check();await disclosure.getByRole('button',{name:'Create invitation'}).click();const codeField=remoteCard().getByRole('textbox',{name:'Invitation code',exact:true});await codeField.waitFor();const code=await codeField.inputValue(),enrollmentId=code.split('.')[0];assert.equal(code.length,101);
 let remoteState=await request('/api/website-requests/remote');assert.equal(remoteState.enrollments[0].phase,'pending');assert.equal(remoteState.grant.protocol,2);assert.equal(scanCalls,0);assert(!existsSync(calls));assert.equal((await state()).status.remoteMode,true);
 checks.push('Actual desktop GUI reviews complete templates for both adapters, saves encrypted consent, recovers a lost parent-publication reply through atomic withdrawal, then establishes a new protocol2 generation and publishes a pending invitation through actual Next/PostgreSQL, with zero source scans or worker calls.');
 const login=async email=>{const hash=site.otp({id:randomUUID(),email,aud:'authenticated',role:'authenticated',email_confirmed_at:new Date(Date.now()-10000).toISOString(),app_metadata:{},user_metadata:{}});const r=await fetch(site.origin+'/auth/callback?token_hash='+hash+'&type=email',{redirect:'manual'});assert.equal(new URL(r.headers.get('location')).pathname,'/account');return r.headers.getSetCookie().find(c=>c.startsWith('rb_session=')).split(';')[0];};
 const ownerCookie=await login(site.accounts.a.email),otherCookie=await login(site.accounts.b.email);
 const personApi=async(cookie,path,method='GET',body,expected=200)=>{const r=await fetch(site.origin+'/api/account/remote-approvers'+path,{method,headers:{cookie,origin:site.origin,'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();assert.equal(r.status,expected,JSON.stringify(value));return value;};
 await personApi(site.cookie('a'),'/accept','POST',{protocol:2,enrollmentId,challengeSecret:code.split('.')[1]},401);
 await personApi(otherCookie,'/accept','POST',{protocol:2,enrollmentId,challengeSecret:code.split('.')[1]},403);
 const portalContext=await browser.newContext({viewport:{width:1100,height:900}});await portalContext.addCookies([{name:'rb_session',value:ownerCookie.slice('rb_session='.length),url:site.origin,httpOnly:true,sameSite:'Lax'}]);const portal=await portalContext.newPage();portal.on('pageerror',e=>errors.push(e.message));await portal.goto(site.origin+'/account/remote-approvers');await portal.getByLabel('Connection code from RealBud').fill(code);await portal.getByRole('button',{name:'Continue on this account',exact:true}).click();await portal.getByText('Confirm on the computer',{exact:true}).waitFor();assert.equal(await portal.getByLabel('Connection code from RealBud').inputValue(),'');await portal.screenshot({path:join(output,'portal-candidate-desktop.png'),fullPage:true});
 remoteState=await request('/api/website-requests/remote/sync','POST',{});assert.equal(remoteState.enrollments[0].phase,'candidate');assert.equal(remoteState.enrollments[0].candidate.email,site.accounts.a.email);assert.equal(scanCalls,0);assert(!existsSync(calls));
 await remoteCard().getByRole('button',{name:'Refresh access',exact:true}).click();const candidate=page.getByRole('region',{name:'Confirm invited person'});await candidate.waitFor();assert.equal(await candidate.getByRole('button',{name:'Confirm this person'}).isEnabled(),false);await page.setViewportSize({width:390,height:844});await candidate.scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(output,'desktop-candidate-mobile.png')});
 site.loseNextRpcReply('realbud_remote_enrollment_confirm');await candidate.getByRole('checkbox').check();await candidate.getByRole('button',{name:'Confirm this person'}).click();await remoteCard().getByRole('alert').waitFor();await remoteCard().getByRole('button',{name:'Refresh access',exact:true}).click();await remoteCard().getByText('Person confirmed',{exact:true}).waitFor();
 remoteState=await request('/api/website-requests/remote');assert.equal(remoteState.enrollments[0].phase,'confirmed');const grantId=remoteState.grant.grantId;assert.equal((await personApi(ownerCookie,'')).enrollments[0].phase,'confirmed');assert.equal((await personApi(otherCookie,'')).enrollments.length,0);
 checks.push('Legacy and other-agency acceptance are denied. Actual portal acceptance stays pending until attended desktop confirmation; lost committed confirmation response reconciles the same permission, and other agency sees no connection.');
 await portal.getByRole('button',{name:'Refresh connections',exact:true}).click();await portal.getByText('Identity connection confirmed',{exact:true}).waitFor();assert.equal(await portal.getByText('Your identity was recorded. Return to the computer to review the person, workspace and selected work before confirming.',{exact:true}).count(),0);await portal.setViewportSize({width:390,height:844});assert(await portal.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await portal.screenshot({path:join(output,'portal-confirmed-mobile.png'),fullPage:true});
 const workCard=()=>page.getByRole('heading',{name:'Shared reviews and remote preparation',exact:true}).locator('..');
 const workerCount=()=>existsSync(calls)?JSON.parse(readFileSync(calls,'utf8')).length:0;
 const workState=()=>request('/api/website-requests/remote-work');
 const workApi=async(path='',method='GET',body,expected=200,cookie=ownerCookie)=>{
  const response=await fetch(site.origin+'/api/account/remote-work'+path,{method,headers:{cookie,origin:site.origin,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();assert.equal(response.status,expected,`${path}: ${JSON.stringify(value)}`);return value;
 };
 const setLoss=paths=>writeFileSync(drops,JSON.stringify(Object.fromEntries(paths.map(path=>['/api/installations/v2/work/'+path,1]))));
 const attempts=[];
 portal.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname.startsWith('/api/account/remote-work/')){const body=r.postDataJSON();attempts.push({operation:new URL(r.url()).pathname.split('/').at(-1),requestId:body.requestId,decisionId:body.decisionId??null,reviewId:body.reviewId??null});}});
 async function syncWork(){
  const response=await fetch(base+'/api/website-requests/remote-work/sync',{method:'POST',signal:AbortSignal.timeout(45000),headers:{'content-type':'application/json','x-realbud-session':token},body:'{}'});
  const value=await response.json();assert([200,409,502,503].includes(response.status),JSON.stringify(value));return {status:response.status,value};
 }
 async function until(check,{processWork=false,message='Expected state was not reached',attempts=100}={}){
  for(let i=0;i<attempts;i++){if(processWork)await syncWork();const result=await check();if(result)return result;await wait(150);}throw new Error(message);
 }
 async function refreshPortal(){await portal.getByRole('button',{name:'Refresh work status',exact:true}).click();await until(async()=>!await portal.getByRole('button',{name:'Refresh work status',exact:true}).isDisabled(),{message:'Portal refresh remained busy'});}
 async function portalSubmit(operation){
  const account=await workApi();const entry=account.catalog.find(c=>c.grantId===grantId&&c.enrollmentId===enrollmentId&&c.descriptors.some(d=>d.operation===operation));assert(entry,'Invited preparation missing from catalog');const descriptor=entry.descriptors.find(d=>d.operation===operation);
  await refreshPortal();await portal.getByLabel('Workspace and preparation').selectOption(`${entry.grantId}.${entry.enrollmentId}.${descriptor.id}`);
  const prior=attempts.length;await portal.getByRole('button',{name:'Request computer review',exact:true}).click();
  const action=await until(async()=>attempts.slice(prior).find(a=>a.operation==='submit'),{message:'Browser did not submit a work request'});
  const state=await until(async()=>(await workApi()).requests.find(r=>r.envelope.id===action.requestId),{message:'Submitted request did not persist'});
  assert.equal(state.envelope.requesterEnrollmentId,enrollmentId);assert.equal(state.envelope.descriptor.operation,operation);return state;
 }
 async function reviewReady(id){return until(async()=>{const row=(await workApi()).requests.find(r=>r.envelope.id===id);return row?.review&&!row.review.prunedAt?row:null;},{processWork:true,message:'Computer did not publish the exact review'});}
 async function inspectReview(id){
  const state=(await workApi()).requests.find(r=>r.envelope.id===id);assert(state?.review);await refreshPortal();
  const article=portal.getByRole('article').filter({has:portal.getByRole('heading',{name:state.envelope.descriptor.label,exact:true})}).filter({has:portal.getByText('Review ready',{exact:true})});
  await article.getByRole('button',{name:'Read complete review',exact:true}).click();const region=portal.getByRole('region',{name:'Complete shared review'});await region.waitFor();
  const body=await workApi('/read','POST',{protocol:2,requestId:id,reviewId:state.review.id});assert(body.review);const canonical=(v)=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')}}`;
  const hash=v=>createHash('sha256').update(canonical(v)).digest('hex');assert.equal(hash(body.review.template),body.review.templateDigest);assert.equal(hash(body.review),state.review.digest);
  const displayed=await region.textContent();for(const section of body.review.template.sections){assert(displayed.includes(section.label));assert(displayed.includes(section.value));}
  assert(!displayed.includes('fixture-mail'));assert(!displayed.includes('Private fictional maintenance'));assert(!JSON.stringify(body).includes('"binding"'));
  assert.equal(await region.getByRole('button',{name:'Approve this preparation',exact:true}).isEnabled(),false);return {region,body};
 }
 async function approveReview(id,{lostDecision=false}={}){
  const {region,body}=await inspectReview(id);if(lostDecision)site.loseNextRpcReply('realbud_remote_work_decide');
  await region.getByRole('checkbox').check();const before=attempts.length;await region.getByRole('button',{name:'Approve this preparation',exact:true}).click();
  const action=await until(async()=>attempts.slice(before).find(a=>a.operation==='decide'),{message:'Browser decision was not submitted'});
  const decided=await until(async()=>{const row=(await workApi()).requests.find(r=>r.envelope.id===id);return row?.review?.decision?row:null;},{message:'Decision did not persist'});
  assert.equal(decided.review.decision.decisionId,action.decisionId);assert.equal(decided.review.decision.reviewId,body.review.reviewId);assert.equal(decided.review.decision.choice,'approve');
  await refreshPortal();assert.equal(attempts.filter(a=>a.operation==='decide'&&a.requestId===id).length,1,'Refresh must not resubmit a decision');return decided;
 }
 async function finish(id,phase){
  return until(async()=>{const local=(await workState()).records.find(r=>r.id===id);if(!local||!['completed','needs-review','partial','failed','interrupted','cancelled','rejected','expired','stale'].includes(local.phase))return false;assert.equal(local.phase,phase,JSON.stringify(local));const remote=(await workApi()).requests.find(r=>r.envelope.id===id);return remote?.phase===phase?local:false;},{processWork:true,message:`Work ${id} did not finish as ${phase}`});
 }
 // Requesting is allowed while this computer's sharing switch remains off.
 await page.setViewportSize({width:1440,height:1100});await workCard().getByRole('button',{name:'Refresh saved sharing status',exact:true}).click();await workCard().getByText('Sharing and remote preparation are off',{exact:true}).waitFor();
 await portal.setViewportSize({width:1100,height:900});await portal.goto(site.origin+'/account/remote-work');await portal.getByLabel('Workspace and preparation').waitFor();
 const queued=await portalSubmit('prepare-recipe');assert.equal(queued.review,null);assert.equal(queued.phase,'queued');await syncWork();assert.equal((await workState()).status.enabled,false);assert.equal(workerCount(),0);assert.equal(scanCalls,0);
 const otherInventory=await workApi('','GET',undefined,200,otherCookie);assert.equal(otherInventory.catalog.length,0);assert.equal(otherInventory.requests.length,0);
 checks.push('An invited portal user requests the existing recipe adapter while desktop sharing defaults off; request persists queued, another agency sees nothing, and no review upload, worker or mailbox scan starts.');
 for(const width of uxWidths){await measurePortal(portal,'/account/remote-work',width);await portal.screenshot({path:join(uxOutput,`remote-work-${width}.png`),fullPage:true});}
 const cancelTrigger=portal.getByRole('button',{name:'Cancel my request',exact:true}).first();await cancelTrigger.click();
 const cancelDialog=portal.locator('dialog.confirm-dialog');await cancelDialog.waitFor();
 assert.equal(await cancelDialog.evaluate(el=>el.matches(':modal')),true,'The cancel confirm must be a modal dialog');
 assert.equal(await portal.evaluate(()=>document.activeElement?.textContent),'Keep request','Focus must start on the control that changes nothing');
 await portal.screenshot({path:join(uxOutput,'cancel-dialog-1280.png')});
 await portal.keyboard.press('Escape');await cancelDialog.waitFor({state:'detached'});
 assert.equal(await cancelTrigger.evaluate(el=>el===document.activeElement),true,'Escape must return focus to the trigger');
 assert.equal((await workApi()).requests.find(r=>r.envelope.id===queued.envelope.id)?.phase,'queued','Escape must not cancel anything');
 writeFileSync(join(uxOutput,'layout.json'),JSON.stringify(uxLayout,null,2));
 checks.push('Remote work renders at 360, 768 and 1280 with no horizontal overflow; the cancel confirm opens as a modal dialog with focus on Keep request, Escape closes it, focus returns to the trigger and the request stays queued.');
 // Lose only committed success replies. A hash-only wire log proves same-body retries.
 setLoss(['review','claim','ack']);
 await workCard().getByRole('checkbox').check();await workCard().getByRole('button',{name:'Enable shared reviews and approved preparation',exact:true}).click();
 await workCard().getByText('Sharing enabled · approved preparation may run',{exact:true}).waitFor();
 const published=await reviewReady(queued.envelope.id);assert.equal(workerCount(),0);assert.equal(scanCalls,0);
 await until(async()=>{const local=(await workState()).records.find(r=>r.id===queued.envelope.id);return local&&!local.sharingPending;},{processWork:true,message:'Lost review reply was not reconciled'});
 const inspected=await inspectReview(queued.envelope.id);await inspected.region.scrollIntoViewIfNeeded();await portal.screenshot({path:join(output,'complete-recipe-review-desktop.png'),fullPage:true});await inspected.region.getByRole('button',{name:'Close review',exact:true}).click();
 await approveReview(queued.envelope.id,{lostDecision:true});await finish(queued.envelope.id,'completed');assert.equal(workerCount(),1);assert.equal(scanCalls,0);
 assert.equal(Number(await site.sql(`select count(*) from office_remote_work_reviews where request_id='${queued.envelope.id}'`)),1);
 assert.equal(Number(await site.sql(`select count(*) from office_remote_work_claims where request_id='${queued.envelope.id}'`)),1);
 const wireRows=readFileSync(wire,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
 for(const operation of ['review','claim','ack']){const lost=wireRows.find(r=>r.path.endsWith('/'+operation)&&r.lost);assert(lost,`${operation} lost reply did not occur`);assert(wireRows.some(r=>r.path===lost.path&&!r.lost&&r.ok&&r.bodyDigest===lost.bodyDigest),`${operation} must retry the identical persisted body`);}
 checks.push('Explicit desktop GUI opt-in shares the complete reviewed recipe template. Portal verifies and approves the exact review; lost committed review, decision, claim and event replies reconcile with identical persisted IDs/bodies, one SQL review/claim and exactly one existing-executor worker call.');
 // Existing morning adapter reads one fictional scoped mailbox and stores its real local review item.
 await portal.getByRole('button',{name:'Close review',exact:true}).click();const morningRequest=await portalSubmit('morning-review');await reviewReady(morningRequest.envelope.id);
 const morningReview=await inspectReview(morningRequest.envelope.id);await portal.setViewportSize({width:390,height:844});await morningReview.region.scrollIntoViewIfNeeded();await portal.screenshot({path:join(output,'complete-morning-review-mobile.png'),fullPage:true});const overflow=await portal.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,elements:[...document.querySelectorAll('main *')].filter(el=>el.getBoundingClientRect().right>innerWidth+1).map(el=>({tag:el.tagName,class:el.className,width:el.getBoundingClientRect().width,right:el.getBoundingClientRect().right})).slice(0,30)}));writeFileSync(join(output,'mobile-layout.json'),JSON.stringify(overflow,null,2));assert(overflow.scroll<=overflow.width+1);await morningReview.region.getByRole('button',{name:'Close review',exact:true}).click();
 await approveReview(morningRequest.envelope.id);await finish(morningRequest.envelope.id,'needs-review');assert.equal(workerCount(),2);assert.equal(scanCalls,1);
 const mail=await request('/api/mail-workspace');assert.equal(mail.counts.total,1);assert.equal(mail.schedule.enabled,false);
 await workCard().getByRole('button',{name:'Refresh saved sharing status',exact:true}).click();await until(()=>workCard().getByRole('button',{name:'Refresh saved sharing status',exact:true}).isEnabled(),{message:'Desktop status refresh did not settle'});await workCard().getByRole('button',{name:/Show completed and restored history/}).click();await page.setViewportSize({width:1440,height:1100});await workCard().screenshot({path:join(output,'desktop-remote-work.png')});await page.setViewportSize({width:390,height:844});await page.getByRole('region',{name:'Remote preparation history'}).scrollIntoViewIfNeeded();assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(output,'desktop-work-history-mobile.png')});
 checks.push('The morning adapter renders the full typed mailbox-alias review on mobile, then invokes the existing loop and fictional scoped connector exactly once, retaining one local review item and leaving its schedule off. Both desktop and portal render without horizontal overflow.');
 // Kill the actual desktop on both sides of durable enqueue, while an exact reply is held.
 await page.close();
 for(const checkpoint of ['claim','ack']) {
  await portal.getByRole('button',{name:'Close review',exact:true}).click();
  const interrupted=await portalSubmit('prepare-recipe');await reviewReady(interrupted.envelope.id);
  const beforeCalls=workerCount(),activation=(await workState()).status.activationId;
  const priorRuns=new Set((await request('/api/job-runs?jobId=fictional-briefing')).runs.map(r=>r.id));
  writeFileSync(crashControl,JSON.stringify({path:'/api/installations/v2/work/'+checkpoint,requestId:interrupted.envelope.id}));
  await approveReview(interrupted.envelope.id);
  const flight=syncWork().catch(()=>null);
  await until(()=>existsSync(crashMarker),{message:`The ${checkpoint} reply was not held`});
  if(checkpoint==='ack')await until(async()=>{const runs=(await request('/api/job-runs?jobId=fictional-briefing')).runs;return runs.some(r=>!priorRuns.has(r.id)&&r.status==='completed');},{message:'Durable enqueued execution did not settle before crash'});
  assert.equal(workerCount(),beforeCalls+(checkpoint==='ack'?1:0));
  await stop('SIGKILL');await flight;rmSync(crashControl);rmSync(crashMarker);await start();
  await finish(interrupted.envelope.id,checkpoint==='claim'?'interrupted':'completed');
  assert.equal((await workState()).status.activationId,activation);
  assert.equal(workerCount(),beforeCalls+(checkpoint==='ack'?1:0));assert.equal(scanCalls,1);
 }
 checks.push('Actual SIGKILL after a committed claim but before enqueue settles interrupted without a worker. SIGKILL after durable enqueue and completed executor result, with the running acknowledgement held, reattaches that same result and reports completion. Neither cold restart replays execution.');
 const callsBeforeRevocation=workerCount();
 // Publish a fresh review, stop the desktop, approve and revoke remotely, then cold-start headless.
 await portal.getByRole('button',{name:'Close review',exact:true}).click();const fenced=await portalSubmit('prepare-recipe');await reviewReady(fenced.envelope.id);
 const beforeRestart=await workState(),activation=beforeRestart.status.activationId;await stop('SIGKILL');
 await approveReview(fenced.envelope.id);await personApi(ownerCookie,'/revoke','POST',{protocol:2,enrollmentId});
 await start();await until(async()=>{const remote=await request('/api/website-requests/remote');return remote.enrollments.find(e=>e.id===enrollmentId)?.phase==='revoked';},{message:'Headless startup did not observe revocation'});
 const afterRestart=await workState();assert.equal(afterRestart.status.activationId,activation);assert.equal(afterRestart.status.enabled,true);assert.equal(afterRestart.status.ready,false);
 for(let i=0;i<5;i++){await syncWork();await wait(100);}assert.equal(workerCount(),callsBeforeRevocation);assert.equal(scanCalls,1);
 const finalLocal=await workState();for(const [id,phase] of [[queued.envelope.id,'completed'],[morningRequest.envelope.id,'needs-review']])assert.equal(finalLocal.records.find(r=>r.id===id)?.phase,phase);
 assert(!['accepted','running','completed'].includes(finalLocal.records.find(r=>r.id===fenced.envelope.id)?.phase),'Revoked person cannot trigger new preparation');
 const retained=await site.sql('select coalesce(jsonb_agg(projection),\'[]\'::jsonb) from office_remote_work_reviews');assert(!retained.includes('fixture-mail'));assert(!retained.includes('Private fictional maintenance'));assert(!retained.includes('"binding"'));
 checks.push('A cold headless restart preserves activation and completed local outcomes. Approval followed by portal revocation while the computer is stopped cannot produce another worker or source scan; the original sharing setting remains visible but held. SQL shared projections contain neither raw mailbox identifier, source message nor private execution binding.');
 assert.deepEqual(errors,[]);assert.deepEqual(site.stats().violations,[]);assert.deepEqual(site.stats().authRejections,[]);assert(site.stats().databaseErrors.every(code=>code==='remote_work_conflict'),'Only the expected stale-revision recovery conflict is permitted');
 const finalWire=readFileSync(wire,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
 writeFileSync(join(output,'receipt.json'),JSON.stringify({ok:true,at:new Date().toISOString(),layer:'Actual desktop service/executors and rendered desktop+portal UI + built Next + disposable PostgreSQL; fictional connector and Hermes CLI',checks,errors,scanCalls,fixtureCalls:fixtureCallSummary(),workerCalls:workerCount(),lostReplies:finalWire.filter(r=>r.lost).map(r=>({path:r.path,bodyDigest:r.bodyDigest})),decisionAttempts:attempts.filter(a=>a.operation==='decide'),site:site.stats(),limits:['No hosted deployment, real provider/customer accounts or native Windows proof','Fixture CLI output proves integration with existing executors, not real model quality']},null,2));console.log(JSON.stringify({ok:true,checks},null,2));
}catch(error){writeFileSync(join(output,'failure.log'),logs+'\n'+(site?.logs()??'')+'\n'+String(error));writeFileSync(join(output,'fixture-failure.json'),JSON.stringify(fixtureCallSummary(),null,2));throw error;}finally{await browser?.close();await stop();await site?.stop();connector.closeAllConnections();await new Promise(r=>connector.close(r));rmSync(temp,{recursive:true,force:true});writeFileSync(join(output,'cleanup.json'),JSON.stringify({complete:true}));}
