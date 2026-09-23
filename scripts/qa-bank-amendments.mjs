// Real HTTP + built UI; only disposable fictional bank data. No provider/REI calls.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {once} from 'node:events';
import {realpathSync} from 'node:fs';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {serviceSmokeEnv} from './service-smoke-env.mjs';
import {completeFictionalOnboarding} from './qa-onboarding.mjs';

assert.ok(process.env.PLAYWRIGHT_MODULE,'Set PLAYWRIGHT_MODULE.');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE);
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),out=resolve(process.env.QA_OUTPUT||join(root,'outputs/bank-amendments-2026-09-22/gui'));
const resources=process.env.REALBUD_QA_RESOURCES&&resolve(process.env.REALBUD_QA_RESOURCES);
const executable=process.env.REALBUD_QA_EXECUTABLE||process.execPath;
assert.equal(Boolean(resources),Boolean(process.env.REALBUD_QA_EXECUTABLE),'Supply both packaged resources and executable.');
const scratch=await mkdtemp(join(realpathSync(tmpdir()),'RealBud bank amendment QA ')),data=join(scratch,'data');
const checks=[],errors=[],unexpectedNetwork=[],cleanup={};
let child,closed,browser,page,token,base,port,logs='',failure;
const record=text=>{checks.push(text);console.log(`PASS ${text}`);};
const request=async(path,method='GET',body,expected=200)=>{
  const response=await fetch(base+path,{method,headers:{'x-realbud-session':token,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(15000)});
  const value=await response.json();assert.equal(response.status,expected,`${path}: ${JSON.stringify(value)}`);return value;
};
async function start(){
  child=spawn(executable,[resources?join(resources,'server/bootstrap.js'):join(root,'server/bootstrap.ts')],{cwd:root,env:{...serviceSmokeEnv({executable,home:scratch,data,scratch,port}),OMB_STATIC_DIR:resolve(process.env.REALBUD_UI_DIR||join(resources||root,resources?'ui':'dist'))},stdio:['ignore','pipe','pipe']});
  closed=once(child,'close');for(const stream of [child.stdout,child.stderr])stream.on('data',bytes=>{logs=(logs+bytes).slice(-16000);});
  let ready=false;
  for(let i=0;i<150;i++){
    if(child.exitCode!==null||child.signalCode)throw new Error('Fixture exited during startup.');
    const health=await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)}).then(r=>r.json()).catch(()=>null);
    if(health?.pid===child.pid){ready=true;break;}await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.ok(ready,'Fixture service ready');token=(await (await fetch(base+'/api/session')).json()).token;
}
async function stop(){
  if(!child)return;
  const owned=child;owned.kill('SIGTERM');
  const deadline=setTimeout(()=>owned.kill('SIGKILL'),10000);
  try{await closed;}finally{clearTimeout(deadline);}
  assert.ok(owned.exitCode!==null||owned.signalCode);child=undefined;
}
try{
  await mkdir(out,{recursive:true});await mkdir(data,{mode:0o700});
  await writeFile(join(data,'config.json'),JSON.stringify({instances:{fixture:{driver:'not-a-real-driver'}}}),{mode:0o600});
  const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');port=listener.address().port;await new Promise(resolve=>listener.close(resolve));base=`http://127.0.0.1:${port}`;
  await start();
  await completeFictionalOnboarding(request);
  const csv='\uFEFFDate,Amount,Narrative,Reference,Extra\r\n2026-09-21,500.00,"Fictional café 🏡","old",保留\n2026-09-21,-1.00,Fee,,保留\r\n';
  const mapping={columns:{date:'Date',amount:'Amount',narrative:'Narrative',reference:'Reference'},dateFormat:'YYYY-MM-DD',rules:[{propertyId:'Fictional Unit 1',reference:'00127',aliases:['Fictional','Alpha; Beta | literal punctuation',' padded payer ']}]};
  const row=await request('/api/bank-reference','POST',{...mapping,source:{filename:'Fictional original.csv',bytesBase64:Buffer.from(csv).toString('base64')}});
  assert.equal((await fetch(`${base}/api/bank-reference/${row.id}/amend`,{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
  browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===base)return route.continue();unexpectedNetwork.push(route.request().url());return route.abort();});
  page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base+'/#/schedule');await page.getByLabel('Saved reviews',{exact:true}).selectOption(row.id);
  const decide=async()=>{
    await page.getByLabel('Your decision',{exact:true}).nth(0).selectOption('Fictional Unit 1');
    await page.getByLabel('Your decision',{exact:true}).nth(1).selectOption('keep');
    await page.getByLabel('Review reason',{exact:true}).nth(0).fill('Confirmed the fictional property directory.');
    await page.getByLabel('Review reason',{exact:true}).nth(1).fill('Fee kept unchanged.');
    await page.getByRole('button',{name:'Save reviewed copy',exact:true}).click();
    await page.getByRole('button',{name:'Download reviewed REI copy',exact:true}).waitFor();
  };
  await decide();const first=await request(`/api/bank-reference/${row.id}`),original=await request(`/api/bank-reference/${row.id}/original`,'POST',{}),earlier=await request(`/api/bank-reference/${row.id}/export`,'POST',{});
  assert.equal(first.value.decisions.length,2);assert.equal(first.value.decisions[1].reason,'Fee kept unchanged.');
  record('Staff UI saves both changed and unchanged transaction decisions with exact original bytes');
  await page.getByRole('button',{name:'Correct mapping or decisions',exact:true}).click();
  await page.getByLabel('Corrected reference for property 1',{exact:true}).fill('00234');
  const reason='Corrected reference after checking the fictional property record.';
  await page.getByLabel('Correction reason',{exact:true}).fill(reason);
  assert.equal(await page.getByLabel('Saved reviews',{exact:true}).isDisabled(),true);
  await page.getByRole('heading',{name:'Create a corrected review',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:join(out,'01-correction-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No mobile overflow');
  await page.getByRole('heading',{name:'Create a corrected review',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:join(out,'02-correction-mobile.png')});
  await page.getByLabel('Payer alias 2 for property 1',{exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:join(out,'02b-correction-mobile-fields.png')});
  await page.getByRole('button',{name:'Create corrected review',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:join(out,'02c-correction-mobile-save.png')});
  await page.setViewportSize({width:1440,height:1000});
  const lost=url=>url.pathname===`/api/bank-reference/${row.id}/amend`;
  await page.route(lost,async route=>{const committed=await route.fetch();assert.equal(committed.status(),200);await route.abort('failed');});
  await page.getByRole('button',{name:'Create corrected review',exact:true}).click();
  await page.locator('[aria-labelledby="bank-review-title"]').getByRole('alert').waitFor();
  assert.equal((await request('/api/bank-reference')).total,2);
  await page.unroute(lost);await page.getByRole('button',{name:'Create corrected review',exact:true}).click();
  await page.getByText('Review version 2',{exact:true}).waitFor();
  assert.equal((await request('/api/bank-reference')).total,2);
  record('Lost amendment response reconciles the committed version on explicit retry without a duplicate');
  const secondId=`${row.id}:r2`,second=await request(`/api/bank-reference/${secondId}`);
  assert.deepEqual(second.value.batch.input.rules,[{...mapping.rules[0],reference:'00234'}]);
  record('Correction form preserves structured payer aliases, punctuation and whitespace without text round-trip changes');
  assert.equal(second.value.result,undefined);assert.equal(second.value.decisions,undefined);
  assert.deepEqual(await request(`/api/bank-reference/${secondId}/original`,'POST',{}),original);
  await request(`/api/bank-reference/${row.id}/amend`,'POST',{revision:first.revision,mapping,reason:'Stale competing correction.'},409);
  await request(`/api/bank-reference/${secondId}/export`,'POST',{},409);
  record('Corrected mapping needs fresh row decisions; stale concurrent correction and premature download are refused');
  await decide();
  const event=page.waitForEvent('download');await page.getByRole('button',{name:'Download reviewed REI copy',exact:true}).click();const download=await event;
  assert.deepEqual(await readFile(await download.path()),Buffer.from(csv.replace('"old"','"00234"')));
  const corrected=await request(`/api/bank-reference/${secondId}/export`,'POST',{});
  await page.getByRole('button',{name:'Open previous review',exact:true}).click();
  await page.getByRole('button',{name:'Download earlier reviewed copy',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Correct mapping or decisions',exact:true}).count(),0);
  assert.deepEqual(await request(`/api/bank-reference/${row.id}/export`,'POST',{}),earlier);
  await page.getByText('Review version 1',{exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:join(out,'03-retained-earlier-review.png')});
  record('Both versions remain reachable with distinct byte-checked downloads and an earlier-version warning');
  await stop();await start();await page.reload();await page.getByLabel('Saved reviews',{exact:true}).selectOption(secondId);
  await page.getByText('Review version 2',{exact:true}).waitFor();
  assert.deepEqual(await request(`/api/bank-reference/${row.id}/export`,'POST',{}),earlier);assert.deepEqual(await request(`/api/bank-reference/${secondId}/export`,'POST',{}),corrected);
  assert.deepEqual(await request(`/api/bank-reference/${secondId}/original`,'POST',{}),original);
  await page.getByText('Saved transaction decisions',{exact:true}).click();await page.getByText(/Fee kept unchanged\./).waitFor();
  await page.screenshot({path:join(out,'04-corrected-after-restart.png')});
  record('Actual service restart retains linked review history, all decisions and both exact artifacts');
  assert.deepEqual(errors,[]);assert.deepEqual(unexpectedNetwork,[]);record('No browser errors or off-origin browser requests');
}catch(error){failure=error;console.error(error.message);if(page)await page.screenshot({path:join(out,'failure.png'),fullPage:true}).catch(()=>{});}
finally{
  try{await browser?.close();cleanup.browserClosed=true;}catch{cleanup.browserClosed=false;}
  try{await stop();cleanup.serviceStopped=true;}catch{cleanup.serviceStopped=false;}
  await rm(scratch,{recursive:true,force:true});cleanup.fixtureRemoved=await stat(scratch).then(()=>false,()=>true);
  await writeFile(join(out,'receipt.json'),JSON.stringify({ok:!failure&&Object.values(cleanup).every(Boolean),checks,errors,unexpectedNetwork,cleanup,runtime:resources?'Packaged Electron Node service and packaged UI':'Source Node service and built UI',scope:'Real local HTTP and built browser UI; fictional sources; no bank, Gmail, REI, provider or installed-device acceptance',...(failure?{failure:failure.message,serviceLog:logs}:{})},null,2)+'\n');
}
if(failure||!Object.values(cleanup).every(Boolean))process.exitCode=1;
