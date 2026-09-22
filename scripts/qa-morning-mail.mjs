// Actual desktop HTTP application + fixture connector + deterministic CLI.
// Fictional data only. This proves wiring/recovery, not real Gmail/LLM behavior.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'), temp=mkdtempSync(join(realpathSync(tmpdir()),'rb-morning-'));
const data=join(temp,'data'), output=resolve(process.env.QA_OUTPUT??join(root,'outputs/morning-mail-2026-09-21')); mkdirSync(data,{mode:0o700});mkdirSync(output,{recursive:true});
const wait=ms=>new Promise(r=>setTimeout(r,ms)), checks=[],errors=[]; let child,childClosed,browser,logs='',scanCalls=0,revoked=false;
const historyPages=[],historyWindows=new Map();
const credential=`rbc_${'b'.repeat(64)}`;
const connector=createServer(async(req,res)=>{
  res.setHeader('content-type','application/json');
  if(revoked||req.headers.authorization!==`Bearer ${credential}`||req.headers['x-realbud-profile']!=='property'){res.writeHead(403);res.end('{"error":"fixture_revoked"}');return;}
  if(req.url==='/v1/connectors/status'){res.end(JSON.stringify({managed:true,checkedAt:new Date().toISOString(),serviceExpiresAt:Date.now()+3600000,services:{gmail:{connected:true,status:'ACTIVE',accounts:[{id:'fixture-mail',label:'Fictional accounts inbox',status:'ACTIVE'}],accountSelectionRequired:false}},tools:{available:true,names:['GMAIL_GET_PROFILE','GMAIL_LIST_THREADS','GMAIL_FETCH_MESSAGE_BY_THREAD_ID']}}));return;}
  if(req.url==='/v1/connectors/mail-scan'){
    let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);if(body.expectedAccountId!=='fixture-mail'||!body.scope){res.writeHead(409).end('{}');return;}const request=body.scope;scanCalls++;
    res.end(JSON.stringify({accountId:'fixture-mail',windowStartAt:request.windowStartAt,windowEndAt:request.windowEndAt,pages:1,paginationComplete:true,gaps:[],threads:Array.from({length:45},(_,i)=>{
      const id=(i+1).toString(16);return{id,historyComplete:true,messages:[{id:(i+1001).toString(16),threadId:id,at:1789940000000+i,direction:'incoming',from:'fictional@example.test',to:'office@example.test',subject:`Fictional property request ${i+1}`,body:'Please review this fictional maintenance request. No work has been approved.',bodyTruncated:false,attachments:[]}]};})}));return;
  }
  if(req.url==='/v1/connectors/mail-history-scan'){
    // One bounded historical window, served across two fictional listing pages.
    let raw='';for await(const part of req)raw+=part;const body=JSON.parse(raw);
    if(body.expectedAccountId!=='fixture-mail'||!body.scope){res.writeHead(409).end('{}');return;}
    const request=body.scope,key=`${request.windowStartAt}-${request.windowEndAt}`;
    if(!historyWindows.has(key))historyWindows.set(key,{index:historyWindows.size,startAt:request.windowStartAt,endAt:request.windowEndAt});
    const window=historyWindows.get(key),page=body.pageToken==='page-2'?2:1;historyPages.push({key,page});
    const rows=page===1?[0,1]:[2];
    res.end(JSON.stringify({accountId:'fixture-mail',windowStartAt:request.windowStartAt,windowEndAt:request.windowEndAt,
      ...(page===1?{nextPageToken:'page-2'}:{}),threads:rows.map(i=>{const id=(window.index*16+i+1).toString(16);
        return{id,historyComplete:true,messages:[{id:(window.index*16+i+161).toString(16),threadId:id,at:request.windowStartAt+1000+i,
          direction:'incoming',from:'fictional-vendor@example.test',to:'office@example.test',subject:`Fictional recurring bill ${i+1}`,
          body:'Fictional recurring bill for review. No payment has been arranged.',bodyTruncated:false,attachments:[]}]};})}));return;
  }
  res.writeHead(404);res.end('{}');
});
try{
  connector.listen(0,'127.0.0.1');await once(connector,'listening');const endpoint=`http://127.0.0.1:${connector.address().port}`;
  const reserve=createServer();reserve.listen(0,'127.0.0.1');await once(reserve,'listening');const port=reserve.address().port;await new Promise(r=>reserve.close(r));const base=`http://127.0.0.1:${port}`;
  const worker=join(temp,'fictional-worker.mjs'), workerCalls=join(temp,'worker-calls.json');
  writeFileSync(worker,`#!${process.execPath}\nimport {readFileSync,writeFileSync,existsSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('Hermes Agent v0.21.3 (2026.9.14)');process.exit(0);}
const inputPath=${JSON.stringify(join(data,'vault/workflow-inputs/accounts-inbox.json'))};
if(!existsSync(inputPath)){console.log('{}');process.exit(0);}
const input=JSON.parse(readFileSync(inputPath,'utf8'));
const result={version:1,kind:'accounts-inbox-triage',skillSource:'email-inbox-triage@0.1.0',sourceReference:input.sourceReference,status:'complete',coverageComplete:true,holds:[],actionsPerformed:[],threads:input.threads.map(t=>({threadId:t.threadId,disposition:'action-review',owner:'property-manager',priority:t.threadId==='1'?'high':'normal',sourceMessageIds:t.messages.map(m=>m.messageId),reason:'Fictional source asks for maintenance review.',nextAction:'Review internally; no external action was taken.',missingFacts:[]}))};
const log=${JSON.stringify(workerCalls)};let calls=[];try{calls=JSON.parse(readFileSync(log,'utf8'));}catch{}calls.push({source:input.sourceReference,count:input.threads.length});writeFileSync(log,JSON.stringify(calls));
console.log(JSON.stringify({summary:'Fictional deterministic preparation',evidence:['Fictional fixture sources'],outputs:[JSON.stringify(result)],needsApproval:[]}));\n`,{mode:0o700});chmodSync(worker,0o700);
  writeFileSync(join(data,'config.json'),JSON.stringify({instances:{fixture:{driver:'not-a-real-driver'}},composio:{managed:{endpoint,credential,profile:'property'}}}),{mode:0o600});
  // This fixture exercises a private workspace, not managed-service provisioning.
  child=spawn(process.execPath,[join(root,'server/bootstrap.ts')],{cwd:root,env:{...serviceSmokeEnv({executable:process.execPath,home:temp,data,scratch:temp,port}),REALBUD_MANAGED_SERVICE:'0',REALBUD_HERMES_CLI:worker,REALBUD_TEST_LAB:'1',OMB_STATIC_DIR:process.env.OMB_STATIC_DIR??join(root,'dist')},stdio:['ignore','pipe','pipe']});
  childClosed=new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject);});
  for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{logs=(logs+b).slice(-30000);});
  let ready=false;for(let i=0;i<100;i++){if(child.exitCode!==null||child.signalCode)break;try{if((await(await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)})).json()).pid===child.pid){ready=true;break;}}catch{}await wait(100);}assert.ok(ready,logs);
  assert.equal((await fetch(base+'/api/mail-workspace')).status,401);assert.equal((await fetch(base+'/api/agency-setup')).status,401);
  const token=(await(await fetch(base+'/api/session')).json()).token;
  const request=async(path,method='GET',body,expected=200)=>{const r=await fetch(base+path,{method,signal:AbortSignal.timeout(60000),headers:{'content-type':'application/json','x-realbud-session':token},...(body===undefined?{}:{body:JSON.stringify(body)})}).catch(error=>{throw new Error(`${method} ${path} failed: ${error.message}`,{cause:error});});const v=await r.json();assert.equal(r.status,expected,`${path}: ${JSON.stringify(v)}`);return v;};
  await request('/api/hermes/apply-pack','POST',{});
  const exported=await request('/api/customer-packs/office-core/export');const preview=await request('/api/customer-packs/preview','POST',{pack:exported});
  await request('/api/customer-packs/install','POST',{pack:exported,expectedDigest:preview.digest});
  const recipe=(await request('/api/recipes')).recipes.find(r=>r.id==='wf-office-core-inbox-triage');assert.ok(recipe);
  await request(`/api/recipes/${recipe.id}`,'PATCH',{expectedRevision:recipe.revision,planApproved:true,status:'active'});
  const workerStatus=await request('/api/hermes');assert.ok(workerStatus.workerFingerprint);
  writeFileSync(join(data,'hands-ping.json'),JSON.stringify({at:Date.now(),ok:true,detail:'Deterministic fixture readiness; not a live model test',kind:'ping',workerFingerprint:workerStatus.workerFingerprint}),{mode:0o600});
  await request('/api/connected-apps/check','POST',{});
  let setup=await request('/api/agency-setup');const settings={...setup.state.settings,agencyName:'Fictional Agency One',workflowPackId:'office-core',timeZone:'Australia/Brisbane',gmailAccountId:'fixture-mail',selectedWorkflows:['morning-priorities']};
  setup=await request('/api/agency-setup','PUT',{expectedRevision:setup.state.revision,settings});
  setup=await request('/api/agency-setup/check-gmail','POST',{expectedRevision:setup.state.revision});
  const workflow=setup.workflows.find(w=>w.id==='morning-priorities');assert.ok(workflow.canReview,JSON.stringify(workflow));
  await request('/api/agency-setup/workflows/morning-priorities/review','POST',{expectedRevision:setup.state.revision,expectedEvidenceDigest:workflow.evidenceDigest});
  let state=await request('/api/mail-workspace');assert.equal(state.schedule.enabled,false);
  const reviewRequest={requestId:crypto.randomUUID(),expectedRevision:state.schedule.revision};
  const accepted=await request('/api/mail-workspace/review','POST',reviewRequest,202);assert.ok(accepted.run.id);
  for(let i=0;i<200;i++){state=await request('/api/mail-workspace');if(state.operation?.state!=='running')break;await wait(100);}
  assert.equal(state.operation.state,'complete',JSON.stringify(state.operation));assert.equal(state.version,2);assert.equal(state.counts.total,45);assert.equal(Object.hasOwn(state,'items'),false);
  const items=[];let cursor;
  do {
    const page=await request('/api/mail-workspace/items?group=all&limit=20'+(cursor?'&cursor='+encodeURIComponent(cursor):''));
    assert.equal(page.total,45);assert.equal(page.revision,state.revision);assert.ok(page.items.length<=20);
    items.push(...page.items);cursor=page.nextCursor;
  } while(cursor);
  assert.equal(new Set(items.map(item=>item.id)).size,45);assert.equal(items.filter(i=>i.disposition==='action-review').length,45);
  assert.equal(state.schedule.enabled,false);const calls=JSON.parse(readFileSync(workerCalls,'utf8'));assert.deepEqual(calls.map(c=>c.count),[20,20,5]);
  await request('/api/mail-workspace/review','POST',reviewRequest,202);await wait(100);assert.equal(scanCalls,1);assert.equal(JSON.parse(readFileSync(workerCalls,'utf8')).length,3);
  checks.push('Actual HTTP agency setup, scoped connector acquisition and three deterministic worker batches produce45 persistent source-linked items; manual run leaves schedule disabled; same request is not repeated');
  // Windowed, checkpointed history acquisition over the same fictional connector,
  // started only by checking the selected Gmail account. The app's own wiring is
  // delivered as outputs/mail-history-2026-09-22/index-patch.diff, so this
  // composes the same seams in process; nothing here calls collectHistory.
  const {createMailIngestionService}=await import(join(root,'server/mail-ingestion.ts'));
  const {createAgencySetupService,defaultAgencySettings}=await import(join(root,'server/agency-setup.ts'));
  const historyRoot=join(temp,'history');mkdirSync(historyRoot,{mode:0o700});
  const historySetupRoot=join(temp,'history-setup');mkdirSync(historySetupRoot,{mode:0o700});
  let historyService,historyRun=Promise.resolve();
  const historySetup=createAgencySetupService({directory:historySetupRoot,workspaceId:'fictional-history-workspace',actorId:()=>'fictional-history-owner',
    checkGmail:async accountId=>{
      const response=await fetch(endpoint+'/v1/connectors/status',{signal:AbortSignal.timeout(30000),
        headers:{authorization:`Bearer ${credential}`,'x-realbud-profile':'property'}});
      assert.equal(response.status,200);const status=await response.json();
      if(!status.tools.available||!status.services.gmail.accounts.some(a=>a.id===accountId&&a.status==='ACTIVE'))
        throw Object.assign(new Error('This exact private Gmail source could not be verified.'),{status:409});
    },
    observe:async()=>({gmail:{accounts:[{id:'fixture-mail',label:'Fictional accounts inbox',status:'active'}],accountId:'fixture-mail',
        state:'verified',checkedAt:Date.now(),bindingRevision:'fictional-history-binding'},
      billRegister:{state:'available',count:0},
      ...(historyService?{mailHistory:await historyService.historyStatus()}:{}),
      workflows:{'bills-calendar':{state:'available',bindingRevision:'fictional-history-plan',detail:'Fictional local bill plan admission.'}}}),
    // The host starts acquisition and returns; it never awaits the collection.
    onGmailVerified:event=>{historyRun=historyService.startHistory(event);}});
  historyService=createMailIngestionService({directory:historyRoot,workspaceId:'fictional-history-workspace',key:Buffer.alloc(32,9),
    workroomDirectory:join(historyRoot,'workroom'),
    authorize:async purpose=>{const ready=await historySetup.assertWorkflowReady(purpose);
      return {accountId:ready.settings.gmailAccountId,bindingRevision:'a'.repeat(64),settings:ready.settings,settingsRevision:ready.revision};},
    scan:async(authority,scope)=>{
      const merged={accountId:authority.accountId,windowStartAt:scope.windowStartAt,windowEndAt:scope.windowEndAt,threads:[],pages:0,paginationComplete:false,gaps:[]};
      for(let pageToken;merged.pages<20;){
        const response=await fetch(endpoint+'/v1/connectors/mail-history-scan',{method:'POST',signal:AbortSignal.timeout(30000),
          headers:{'content-type':'application/json',authorization:`Bearer ${credential}`,'x-realbud-profile':'property'},
          body:JSON.stringify({expectedAccountId:authority.accountId,scope,...(pageToken?{pageToken}:{})})});
        assert.equal(response.status,200);const value=await response.json();merged.pages++;merged.threads.push(...value.threads);
        if(!value.nextPageToken){merged.paginationComplete=true;break;}
        pageToken=value.nextPageToken;
      }
      if(!merged.paginationComplete)merged.gaps.push('More mailbox pages remain; this scan is partial.');
      return merged;
    }});
  try{
    const historySettings={...defaultAgencySettings(),agencyName:'Fictional Agency One',workflowPackId:'office-core',
      timeZone:'Australia/Brisbane',gmailAccountId:'fixture-mail',selectedWorkflows:['bills-calendar'],
      mailScope:{historyDays:90,includeSent:true,maxMessages:20,attachments:'metadata-only'}};
    const saved=await historySetup.save({expectedRevision:0,settings:historySettings});
    assert.equal(saved.state.revision,1);
    // Checking the account before its plan review offers the start and holds it:
    // the collection re-verifies authority itself and reads nothing.
    const checkGmail=()=>historySetup.handle('/api/agency-setup/check-gmail','POST',{expectedRevision:1});
    const firstCheck=await checkGmail();await historyRun;
    assert.equal(firstCheck.status,200);
    const heldStatus=await historyService.historyStatus();
    assert.equal(heldStatus.state,'held',JSON.stringify(heldStatus));
    assert.equal(historyPages.length,0);assert.equal(historyWindows.size,0);
    // Approving the plan completes the pair, so acquisition starts on its own.
    const workflow=(await historySetup.get()).workflows.find(w=>w.id==='bills-calendar');
    await historySetup.review('bills-calendar',{expectedRevision:1,expectedEvidenceDigest:workflow.evidenceDigest});
    await historyRun;
    const status=await historyService.historyStatus();
    assert.equal(status.state,'complete',JSON.stringify(status));
    assert.equal(status.detail,'History: complete (3 of 3 windows).');
    assert.equal((await historyService.get()).history.detail,status.detail);
    const gmailCheck=(await historySetup.get()).workflows.find(w=>w.id==='bills-calendar').checks.find(c=>c.id==='gmail');
    assert.equal(gmailCheck.state,'passed');
    assert.ok(gmailCheck.detail.includes('History collection checked all 3 approved windows. Its coverage receipt still lists any provider gaps.'),gmailCheck.detail);
    const coverage=status.coverage;
    assert.deepEqual({windowCount:coverage.windowCount,windowsComplete:coverage.windowsComplete,windowsPartial:coverage.windowsPartial,
      windowsFailed:coverage.windowsFailed,windowsNotChecked:coverage.windowsNotChecked,windowsWithUnfetchedPages:coverage.windowsWithUnfetchedPages,
      messagesSeen:coverage.messagesSeen,complete:coverage.complete,gaps:coverage.gaps,notChecked:coverage.notChecked},
      {windowCount:3,windowsComplete:3,windowsPartial:0,windowsFailed:0,windowsNotChecked:0,windowsWithUnfetchedPages:0,
       messagesSeen:9,complete:true,gaps:[],notChecked:[]},JSON.stringify(coverage));
    const ordered=[...historyWindows.values()];
    assert.equal(ordered.length,3);assert.equal(historyPages.length,6);
    for(let i=0;i+1<ordered.length;i++){assert.equal(ordered[i].startAt,ordered[i+1].endAt);assert.ok(ordered[i].endAt>ordered[i].startAt);}
    assert.equal(ordered[0].endAt,coverage.approvedEndAt);assert.equal(ordered[2].startAt,coverage.approvedStartAt);
    assert.equal(coverage.checkedFromAt,coverage.approvedStartAt);assert.equal(coverage.checkedToAt,coverage.approvedEndAt);
    // A repeat check of the same approval re-requests no completed window.
    await checkGmail();await historyRun;
    assert.equal(historyPages.length,6);
    assert.deepEqual(await historyService.historyCoverage(),coverage);
    assert.equal((await historyService.historyStatus()).state,'complete');
  } finally { await historyService.close(); }
  checks.push('Checking the selected Gmail account starts windowed history acquisition with no separate collect action: it holds before the plan review, then tiles a 90-day approved interval into three checkpointed 30-day windows read across six actual connector pages, reports complete coverage with nothing unchecked in both the workspace read model and the setup check, and a repeat check re-requests no completed window');
  const item=items[0];await request(`/api/mail-workspace/items/${item.id}`,'PATCH',{expectedRevision:item.revision,status:'done',priority:'low',note:'Fictional staff decision'});
  await request(`/api/mail-workspace/items/${item.id}`,'PATCH',{expectedRevision:item.revision,status:'open'},409);
  await request('/api/mail-workspace/scan','POST',{});state=await request('/api/mail-workspace');assert.equal((await request(`/api/mail-workspace/items/${item.id}`)).item.status,'done');assert.equal(state.counts.done,1);
  await request('/api/mail-workspace/schedule','PATCH',{enabled:true});state=await request('/api/mail-workspace');assert.equal(state.schedule.timezone,'Australia/Brisbane');assert.equal(state.schedule.enabled,true);
  setup=await request('/api/agency-setup');await request('/api/agency-setup','PUT',{expectedRevision:setup.state.revision,settings:{...settings,agencyName:'Fictional Agency One revised'}});state=await request('/api/mail-workspace');assert.equal(state.schedule.enabled,false);
  const before=scanCalls;await request('/api/mail-workspace/scan','POST',{},409);assert.equal(scanCalls,before);
  revoked=true;await request('/api/mail-workspace/scan','POST',{},409);assert.equal(scanCalls,before);
  checks.push('Real API enforces stale edits, preserves staff decisions on rescan, reads back office timezone, pauses/requires re-review after settings change and denies revoked/unreviewed sources');
  if(process.env.PLAYWRIGHT_MODULE){const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);browser=await chromium.launch({headless:true,executablePath:process.env.CHROME_EXECUTABLE});const context=await browser.newContext({viewport:{width:1440,height:1000}});await context.route('**/*',r=>new URL(r.request().url()).origin===base?r.continue():r.abort());await context.addInitScript(()=>localStorage.setItem('realbud.first-run-done','1'));const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/#/desk');await page.getByRole('button',{name:'Open mail priorities',exact:true}).click();const panel=page.getByRole('region',{name:'Mail priorities and follow-ups'});await panel.waitFor();await panel.getByRole('button',{name:'Review or edit this item',exact:true}).first().click();const editor=panel.getByRole('form',{name:'Review saved mail item'});await editor.waitFor();await editor.getByLabel('Your note').fill('Browser-reviewed fictional follow-up');await editor.getByRole('button',{name:'Save reviewed item',exact:true}).click();await editor.waitFor({state:'hidden'});await panel.getByRole('button',{name:'View source conversation',exact:true}).first().click();const source=panel.getByRole('complementary',{name:'Saved source conversation'});await source.waitFor();assert.equal(await source.evaluate(el=>el===document.activeElement),true);await page.screenshot({path:join(output,'morning-source-desktop.png')});await panel.getByRole('button',{name:'Close source conversation',exact:true}).click();await panel.getByRole('heading',{name:'Mail priorities and follow-ups',exact:true}).evaluate(el=>el.scrollIntoView({block:'start'}));await page.screenshot({path:join(output,'morning-desktop.png')});await page.setViewportSize({width:390,height:844});await panel.getByRole('heading',{name:'Mail priorities and follow-ups',exact:true}).evaluate(el=>el.scrollIntoView({block:'start'}));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(output,'morning-mobile.png')});assert.deepEqual(errors,[]);checks.push('Actual application renders45 fixture conversations at desktop and390px without page errors or horizontal overflow');}
  writeFileSync(join(output,'receipt.json'),JSON.stringify({at:new Date().toISOString(),layer:'actual local HTTP app; fictional connector and deterministic CLI; not live Gmail/LLM/Windows proof',checks,scanCalls,
    historyTrigger:'agency-setup check-gmail and plan review only; no collectHistory call in this script',
    historyWindows:[...historyWindows.values()],historyPageReads:historyPages.length,workerBatches:calls.map(c=>c.count),errors,
    limits:['Fictional connector and deterministic CLI: no live Gmail OAuth, no real pagination or mailbox mutation.',
      'History acquisition is composed in process from the same seams; the app server does not wire it yet (outputs/mail-history-2026-09-22/index-patch.diff).',
      'No packaged, Electron, Windows or backup/restore evidence; the history checkpoint is not carried by backup.',
      'Coverage is acquisition progress only: no bill records, no recurrence detection and no schedule activation follow from it.']},null,2));console.log(JSON.stringify({output,checks},null,2));
}catch(e){writeFileSync(join(output,'failure.log'),logs);throw e;}finally{await browser?.close();if(child?.exitCode===null&&!child.signalCode){child.kill('SIGTERM');const force=setTimeout(()=>child.kill('SIGKILL'),4000);try{await childClosed;}finally{clearTimeout(force);}}await new Promise(r=>connector.close(r));rmSync(temp,{recursive:true,force:true});}
