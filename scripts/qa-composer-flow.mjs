#!/usr/bin/env node
// Production Composer + Toolkit + AskMessage + ChatMarkdown + AskAppContext + source store against an in-memory fictional
// app boundary. Does not open a real account, desktop workroom, or worker.
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/ask-app-context-2026-10-01'));
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to the installed playwright or playwright-core module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const chrome = process.env.CHROME_EXECUTABLE;
await mkdir(output, { recursive: true });
const checks = [], errors = [], network = [];
let server, browser, page;

const responseMarkdown = [
  'I found **3 reference mismatches** in the fictional notice register. The file is ready to compare with the original notices; it does not confirm that any payment has been made.',
  '',
  '## What needs your attention',
  '',
  '| Property | Observation | Next step |',
  '| :--- | :--- | :--- |',
  '| 14 Fictional Street | Water reference differs from the previous register. | Compare the original water notice. |',
  '| 28 Example Avenue | Two lots share the same council reference. | Confirm whether this is one assessment. |',
  '| 9 Sample Lane | The period is recorded as `2026JAN`. | Confirm January 2026 before changing the label. |',
  '',
  '## Checks completed',
  '',
  '- **References kept as text.** Leading zeros and spaces are preserved.',
  '- **Period labels checked.** The register contains three periods:',
  '  - April 2026: 14 Fictional Street and 28 Example Avenue.',
  '  - January 2026: 9 Sample Lane.',
  '  - October 2025: 7 Demonstration Court.',
  '- **Payment evidence is still missing.** A “PAID” label in the spreadsheet is a source label, not a bank or invoice record.',
  '',
  '### Before updating the register',
  '',
  '1. Match each entry to the original notice using its council or water reference.',
  '2. Check the period and amount, then record any difference.',
  '3. Review the proposed changes before saving them to the office book.',
  '',
  '> No payment status has changed. The source file remains available for comparison.',
  '',
  '## Reference details',
  '',
  'The imported reference `00000000000000000000000000000000000000000000000000000000000000001234567890` stays unchanged. See the [fictional source register](https://office.example.invalid/register/fictional-notices) for the recorded values.',
  '',
  '```text',
  'Property: 14 Fictional Street | Water reference: 00000000000000000000000000001234567890 | Source period: April 2026',
  'Review state: awaiting original notice',
  '```',
  '',
  'Upload the original notices when you are ready and I can prepare the comparison.',
].join('\n');

const fixtureState = `
import {useSyncExternalStore} from 'react';
const listeners = new Set();
export const fixture = {
  scenario:'ready', failCheck:false, failAccount:false, failOperations:false, failAttachment:false, operations:[], selectedAccountId:'', pending:null,
  events:[], speechStarts:0, speechFinishes:0, speechStops:0, transcript:null, speechEnd:null,
  state:{bots:[],askWorkContext:null},
  setState(patch){this.state={...this.state,...patch}; for(const listener of listeners) listener();},
  snapshot(){
    const service={connected:true,status:'ACTIVE',accountSelectionRequired:false,accounts:[{id:'fictional-office',label:'pm@example.invalid',status:'active'}]};
    let services={gmail:service};
    if(this.scenario==='many-apps') services={gmail:service,googledrive:{...service},googlesheets:{...service},outlook:{...service},slack:{...service}};
    if(this.scenario==='empty') services={};
    if(this.scenario==='choose-account') {service.accounts.push({id:'fictional-other',label:'other@example.invalid',status:'active'});service.accountSelectionRequired=!this.selectedAccountId;if(this.selectedAccountId) service.selectedAccountId=this.selectedAccountId;}
    if(this.scenario==='revoked') {service.connected=false;service.status='REVOKED';service.accounts[0].status='revoked';}
    if(this.scenario==='signing-in') {service.connected=false;service.status='INITIATED';service.accounts=[];}
    if(this.scenario==='pending-only') services={};
    if(this.scenario==='no-accounts') {service.accounts=[];service.accountSelectionRequired=true;}
    return {configured:true,checkedAt:new Date(Date.now()-(this.scenario==='stale'?360000:0)).toISOString(),services,tools:{available:this.scenario!=='degraded',names:this.scenario==='degraded'?[]:['FICTIONAL_READ_SOURCE']},...(this.scenario==='excluded'?{excludedApps:['gmail']}:{}),...(this.scenario==='error'?{error:'Could not verify app access.'}:{})};
  },
};
export async function api(path, init){
  const body=init?.body?JSON.parse(init.body):null;
  fixture.events.push({type:'api',path,body});
  if(path==='/api/connected-apps/operations'){if(fixture.failOperations)throw new Error('Fictional activity read unavailable');return {operations:fixture.operations};}
  if(path==='/api/connected-apps/check'){await new Promise(resolve=>setTimeout(resolve,60));if(fixture.failCheck)throw new Error('Fictional connection unavailable');return fixture.snapshot();}
  if(path==='/api/connected-apps/sources/gmail'){
    if(fixture.failAccount)throw new Error('Fictional account selection failed');
    if(body.accountId)fixture.selectedAccountId=body.accountId;
    if(body.enabled&&fixture.scenario==='excluded')fixture.scenario='ready';
    return fixture.snapshot();
  }
  if(path==='/api/ask/attachments'){if(fixture.failAttachment)throw new Error('Fictional attachment copy failed');return {path:'/fictional-workroom/'+body.name,name:body.name,size:body.size};}
  if(path.includes('/queued-message')||path.includes('/steer'))return {};
  throw new Error('Unexpected fixture API: '+path);
}
export function useStore(){const state=useSyncExternalStore(listener=>{listeners.add(listener);return ()=>listeners.delete(listener);},()=>fixture.state);return {state,dispatch,refreshHermes:async()=>{}};}
export function dispatch(action){fixture.events.push({type:'dispatch',action:{...action,onSettled:undefined}});action.onSettled?.();}
export const visibleMessages=bot=>bot.messages;
export const messageVersions=()=>[];
export const formatTime=()=>'';
export const ensureSession=async()=>'';
export const useStreaming=()=>({});
export const StoreProvider=({children})=>children;
`;
const fixtureEntry = `
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import '/src/styles.css';
import {Composer} from '/src/components/Composer.tsx';
import {AskMessage} from '/src/components/AskMessage.tsx';
import {ChatMarkdown} from '/src/components/ChatMarkdown.tsx';
import {useAskAppContext,AskAppContextToggle,AskAppContextPanel} from '/src/components/AskAppContext.tsx';
import {fixture} from '/src/state/store.tsx';
import {officeSources} from '/src/lib/connected-apps-refresh.ts';
window.ogb={platform:'darwin',permStatus:async()=>({mic:'granted'}),permRequestMic:async()=>true,
  speechStart:async()=>{fixture.speechStarts++;},speechStop:async()=>{fixture.speechStops++;},speechFinish:async()=>{fixture.speechFinishes++;fixture.speechEnd?.({code:0});},
  onSpeechTranscript:callback=>{fixture.transcript=callback;return()=>{fixture.transcript=null;};},
  onSpeechEnd:callback=>{fixture.speechEnd=callback;return()=>{fixture.speechEnd=null;};},
};
const initialBot={id:'fictional-bud',threadId:'fictional-thread',name:'Bud',title:'Assistant',description:'',notifications:false,color:'green',unread:false,busy:false,messages:[],modelSelection:{instanceId:'fixture',model:'fixture'}};
function App(){
 const [bot,setBot]=useState(initialBot);
 const [response,setResponse]=useState(null);
 const [streaming,setStreaming]=useState(false);
 const [showAppContext,setShowAppContext]=useState(false);
 const appContext=useAskAppContext({threadId:bot.threadId,messages:bot.messages,enabled:showAppContext});
 window.__composerQa={fixture,officeSources,setBot,setResponse,setStreaming,setShowAppContext,
   scenario(name){fixture.scenario=name;fixture.selectedAccountId='';fixture.failCheck=false;fixture.failAccount=false;officeSources.accept(fixture.snapshot());officeSources.setPending(name==='pending-only'?'gmail':null);},
 };
 return React.createElement('main',{className:'ask-workspace',style:{height:'100dvh',display:'flex',flexDirection:'column',background:'var(--color-paper)'}},
   React.createElement('header',{className:'ask-header',style:{display:'flex',alignItems:'center',justifyContent:'space-between',flexWrap:'wrap',gap:12}},React.createElement('div',null,React.createElement('h1',null,'Ask'),React.createElement('p',{className:'ask-header-description'},'Fictional workspace · composer interaction checks')),React.createElement('div',{style:{display:'flex',alignItems:'center',gap:8}},showAppContext?React.createElement(AskAppContextToggle,{context:appContext}):null,React.createElement('button',{type:'button',id:'outside-action',className:'ask-button ask-button-secondary'},'Outside action'))),
   React.createElement('div',{className:showAppContext?'ask-context-layout':undefined,'data-context-open':showAppContext&&appContext.open?true:undefined,style:showAppContext?undefined:{display:'contents'}},
   React.createElement('div',{className:showAppContext?'ask-conversation-main':undefined,style:showAppContext?undefined:{display:'contents'}},
   React.createElement('section',{className:'ask-thread',id:'fixture-thread',style:{flex:1,minHeight:0,overflow:'auto'}},
     React.createElement('div',{className:'ask-thread-content',style:{display:'flex',flexDirection:'column',maxWidth:900,margin:'0 auto'}},
       response?React.createElement(AskMessage,{text:response,at:1790814600000,user:false,onMakeRepeatable:()=>{}},React.createElement(ChatMarkdown,{text:response,streaming})):React.createElement(React.Fragment,null,React.createElement('h2',{style:{fontSize:20,fontWeight:600}},'Prepare your next piece of work'),React.createElement('p',{style:{marginTop:8,fontSize:14,color:'var(--color-ink-muted)'}},'Describe an outcome, add documents, or name a connected app.')))),
   React.createElement(Composer,{bot,productAsk:true,onConnectApp:label=>fixture.events.push({type:'connections',label:label??null})})),
   showAppContext?React.createElement(AskAppContextPanel,{context:appContext,onManage:()=>fixture.events.push({type:'context-manage'})}):null));
}
officeSources.accept(fixture.snapshot());
createRoot(document.getElementById('root')).render(React.createElement(App));
`;

const expectUntil = async (condition, message, timeout = 8000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise(done => setTimeout(done, 50));
  }
  assert.fail(message);
};
const record = message => checks.push(message);
const screenshot = name => page.screenshot({ path: join(output, name) });
try {
  server = await createServer({ root, logLevel: 'error', server: { port: 0, host: '127.0.0.1', proxy: {} }, plugins: [{
    name: 'composer-flow-fictional-boundary', enforce: 'pre',
    resolveId(id) { if (id === 'virtual:composer-flow-qa') return '\0composer-flow-qa'; },
    load(id) { if (id === '\0composer-flow-qa') return fixtureEntry; },
    transform(code, id) {
      const path = id.split('?')[0];
      if (path === join(root, 'src/state/store.tsx')) return fixtureState;
      if (path === join(root, 'src/components/DesktopCapabilities.tsx')) return 'export const useDesktopCapabilities=()=>({capabilities:{dictation:{available:true}},ready:true});';
    },
    configureServer(vite) {
      vite.middlewares.use(async (req, res, next) => {
        if (req.url?.split('?')[0] !== '/__composer-flow-qa') return next();
        res.setHeader('content-type', 'text/html');
        res.end(await vite.transformIndexHtml(req.url, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:composer-flow-qa"></script></body></html>'));
      });
    },
  }] });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true, ...(chrome ? { executablePath: chrome } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(origin + '/') && !url.includes('/api/')) return route.continue();
    network.push(url);
    return route.abort();
  });
  page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/__composer-flow-qa');
  const composer = page.getByRole('textbox', { name: 'Tell Bud what outcome you need', exact: true });
  await composer.waitFor();
  const trigger = page.getByRole('button', { name: 'Add files or apps', exact: true });
  const panel = () => page.getByRole('dialog', { name: 'Add to your work', exact: true });
  const attach = () => panel().getByRole('button', { name: /^Attach files/ });
  const draft = 'Prepare a repair update for 14 Fictional Street.';
  await composer.fill(draft);
  assert.doesNotMatch(await page.locator('.ask-composer-frame').innerText(), /Gmail|connected apps|office sources/i, 'Ready connections are absent from the persistent composer');
  record('The closed composer shows the request and attachment controls without persistent connected-app names or status badges.');
  await trigger.click();
  await panel().waitFor();
  await expectUntil(() => attach().evaluate(element => element === document.activeElement), 'Add opens with Attach files focused');
  assert.equal(await panel().getByText('Available', { exact: true }).count(), 1);
  assert.doesNotMatch(await panel().innerText(), /app tools available/i);
  const palette = await panel().evaluate(element => ({ panel: getComputedStyle(element).getPropertyValue('--color-sheet').trim(), composer: getComputedStyle(document.querySelector('.ask-composer')).getPropertyValue('--color-sheet').trim() }));
  assert.equal(palette.panel, palette.composer, 'Portal inherits the Ask palette');
  await screenshot('composer-add-desktop.png');
  await panel().screenshot({ path: join(output, 'add-panel.png') });
  await panel().dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true });
  assert.equal(await panel().isVisible(), true, 'IME Escape keeps the panel open');
  const closeButton = panel().getByRole('button', { name: 'Close Add', exact: true });
  await closeButton.focus();
  await page.keyboard.press('Shift+Tab');
  assert.equal(await panel().getByRole('button', { name: 'Manage connections', exact: true }).evaluate(element => element === document.activeElement), true, 'Reverse Tab wraps inside the panel');
  await page.keyboard.press('Tab');
  assert.equal(await closeButton.evaluate(element => element === document.activeElement), true, 'Forward Tab wraps inside the panel');
  await page.keyboard.press('Escape');
  await panel().waitFor({ state: 'hidden' });
  assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
  assert.equal(await composer.inputValue(), draft);
  record('Add focuses Attach files; Escape restores the trigger and keeps the draft; popup uses Ask colors and omits tool counts.');

  await trigger.click();
  await page.getByRole('button', { name: 'Outside action', exact: true }).click();
  await panel().waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#outside-action').evaluate(element => element === document.activeElement), true, 'Outside dismissal preserves the clicked control focus');
  await trigger.click();
  await panel().getByRole('button', { name: 'Manage connections', exact: true }).click();
  await panel().waitFor({ state: 'hidden' });
  assert.equal(await composer.inputValue(), draft);
  assert.deepEqual(await page.evaluate(() => window.__composerQa.fixture.events.filter(event => event.type === 'connections').at(-1)), { type: 'connections', label: null });
  record('Outside click dismisses without stealing focus; Manage connections keeps the draft and opens the connection owner.');

  const chooseFile = async name => {
    await trigger.click();
    const chooserPromise = page.waitForEvent('filechooser');
    await attach().click();
    const chooser = await chooserPromise;
    await chooser.setFiles({ name, mimeType: 'text/plain', buffer: Buffer.from('Fictional repair update for browser QA.') });
    await panel().waitFor({ state: 'hidden' });
  };
  await page.evaluate(() => { window.__composerQa.fixture.failAttachment = true; });
  await chooseFile('fictional-rejected-note.txt');
  await page.getByRole('alert').filter({ hasText: 'fictional-rejected-note.txt — could not copy the file' }).waitFor();
  assert.equal(await composer.inputValue(), draft, 'Failed attachment leaves the draft intact');
  await page.evaluate(() => { window.__composerQa.fixture.failAttachment = false; });
  await chooseFile('fictional-removable-note.txt');
  await page.getByText('fictional-removable-note.txt', { exact: true }).waitFor();
  assert.equal(await page.getByRole('alert').count(), 0, 'Successful retry clears the attachment error');
  const removeFile = page.getByRole('button', { name: 'Remove file', exact: true });
  await page.mouse.move(0, 0);
  const removeStyle = await removeFile.evaluate(element => ({ opacity: getComputedStyle(element).opacity, width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height }));
  assert.equal(removeStyle.opacity, '1', 'Removing an attachment is discoverable without hover');
  assert.ok(removeStyle.width >= 44 && removeStyle.height >= 44, 'Attachment removal has a touch-sized target');
  await removeFile.click();
  await page.getByText('fictional-removable-note.txt', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await composer.inputValue(), draft, 'Removing one attachment preserves the draft');
  await chooseFile('fictional-repair-note.txt');
  await panel().waitFor({ state: 'hidden' });
  await page.getByText('fictional-repair-note.txt', { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), draft);
  record('Attachment failures are announced, retry recovers, and a visible 44px removal control removes only the selected attachment while preserving the draft.');

  const scenario = name => page.evaluate(value => window.__composerQa.scenario(value), name);
  await scenario('choose-account');
  await trigger.click();
  const accounts = panel().getByRole('combobox', { name: 'Gmail account', exact: true });
  await accounts.waitFor();
  await page.evaluate(() => { window.__composerQa.fixture.failAccount = true; });
  await accounts.focus();
  await accounts.selectOption('fictional-other');
  await panel().getByRole('alert').waitFor();
  assert.equal(await panel().evaluate(element => element.contains(document.activeElement)), true, 'Failed account selection keeps keyboard focus in the panel');
  await page.evaluate(() => { window.__composerQa.fixture.failAccount = false; });
  await accounts.focus();
  await accounts.selectOption('fictional-other');
  await panel().getByText('Available', { exact: true }).waitFor();
  assert.equal(await panel().evaluate(element => element.contains(document.activeElement)), true, 'Account selection completion keeps keyboard focus in the panel');
  assert.equal(await composer.inputValue(), draft);
  record('Account selection failure is visible, then retrying the same selection recovers to Available without losing work.');

  for (const name of ['degraded', 'revoked', 'no-accounts', 'stale', 'error']) {
    await scenario(name);
    await expectUntil(async () => await panel().getByText('Available', { exact: true }).count() === 0, `${name} source must not claim Available`);
    if (name === 'degraded' || name === 'revoked' || name === 'no-accounts') await panel().getByRole('button', { name: /Review connection/ }).waitFor();
    await screenshot(`composer-source-${name}.png`);
  }
  record('Degraded, revoked, empty-account, stale, and failed source observations never claim Available; recoverable states expose Review connection.');
  await panel().getByRole('button', { name: /Review connection/ }).first().click();
  await panel().waitFor({ state: 'hidden' });
  assert.deepEqual(await page.evaluate(() => window.__composerQa.fixture.events.filter(event => event.type === 'connections').at(-1)), { type: 'connections', label: null });
  assert.equal(await composer.inputValue(), draft);

  await scenario('pending-only');
  await trigger.click();
  await panel().getByText('Gmail', { exact: true }).waitFor();
  assert.equal(await panel().getByText('Available', { exact: true }).count(), 0);
  await screenshot('composer-source-signing-in.png');
  await scenario('empty');
  await panel().getByRole('button', { name: 'Connect an app', exact: true }).waitFor();
  assert.equal(await panel().getByRole('button', { name: /Connect an app|Manage connections/ }).count(), 1);
  await scenario('ready');
  await page.evaluate(() => { window.__composerQa.fixture.failCheck = true; });
  await panel().getByRole('button', { name: 'Check access', exact: true }).click();
  await panel().getByRole('alert').waitFor();
  assert.equal(await panel().evaluate(element => element.contains(document.activeElement)), true, 'Failed check keeps keyboard focus in the panel');
  assert.equal(await panel().getByText('Available', { exact: true }).count(), 0);
  await page.evaluate(() => { window.__composerQa.fixture.failCheck = false; });
  await panel().getByRole('button', { name: 'Check access', exact: true }).click();
  await panel().getByText('Available', { exact: true }).waitFor();
  assert.equal(await panel().evaluate(element => element.contains(document.activeElement)), true, 'Completed check keeps keyboard focus in the panel');
  record('Pending sign-in is visible before a service snapshot; empty state has one connection action; failed access checks recover explicitly and retain focus.');
  await page.keyboard.press('Escape');

  for (const viewport of [{ width: 390, height: 844 }, { width: 960, height: 500 }]) {
    await page.setViewportSize(viewport);
    await trigger.click();
    await panel().waitFor();
    const box = await panel().boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= viewport.width + 1 && box.y + box.height <= viewport.height + 1, 'Panel stays inside viewport');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'No page horizontal overflow');
    assert.equal(await panel().evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'No panel horizontal overflow');
    await panel().getByRole('button', { name: 'Manage connections', exact: true }).scrollIntoViewIfNeeded();
    await screenshot(`composer-add-${viewport.width}x${viewport.height}.png`);
    await page.keyboard.press('Escape');
  }
  record('390px narrow and 500px-high viewports contain the popup, keep connection controls reachable, and have no horizontal overflow.');

  await page.setViewportSize({ width: 1280, height: 900 });
  await composer.fill(draft);
  await composer.focus();
  const focus = await composer.evaluate(element => {
    const frame = element.closest('.ask-composer-frame');
    return { input: getComputedStyle(element).outlineStyle, frame: getComputedStyle(frame).outlineStyle, shadow: getComputedStyle(frame).boxShadow };
  });
  assert.ok(focus.input !== 'none' || focus.frame !== 'none' || focus.shadow !== 'none', 'Keyboard composer focus is visibly marked');
  record('Keyboard focus on the main request input has a visible indicator.');

  const mic = () => page.getByRole('button', { name: /Hold to speak into the message|Release to stop speaking/ });
  const counts = () => page.evaluate(() => ({ starts: window.__composerQa.fixture.speechStarts, finishes: window.__composerQa.fixture.speechFinishes, stops: window.__composerQa.fixture.speechStops, sends: window.__composerQa.fixture.events.filter(event => event.type === 'dispatch' && event.action.type === 'send').length }));
  for (const key of ['Space', 'Enter']) {
    const before = await counts();
    await mic().focus();
    await page.keyboard.down(key);
    await expectUntil(async () => (await counts()).starts === before.starts + 1, key + ' starts dictation');
    await page.evaluate(() => window.__composerQa.fixture.transcript?.({ text: 'Add the inspection note.' }));
    await page.keyboard.up(key);
    await expectUntil(async () => (await counts()).finishes === before.finishes + 1, key + ' release finishes dictation');
    await page.getByRole('button', { name: 'Hold to speak into the message', exact: true }).waitFor();
    assert.equal((await counts()).sends, before.sends, 'Dictation key must not dispatch work');
    assert.match(await composer.inputValue(), /Add the inspection note/);
  }
  const beforeIme = await counts();
  await mic().dispatchEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true });
  await mic().dispatchEvent('keydown', { key: ' ', ctrlKey: true, bubbles: true });
  assert.equal((await counts()).starts, beforeIme.starts, 'IME and modified keys do not start dictation');
  await mic().focus();
  await page.keyboard.down('Space');
  await expectUntil(async () => (await counts()).starts === beforeIme.starts + 1, 'Space starts before blur check');
  await composer.focus();
  await page.keyboard.up('Space');
  await page.getByRole('button', { name: 'Hold to speak into the message', exact: true }).waitFor();
  assert.ok((await counts()).stops > beforeIme.stops, 'Blur stops dictation');
  assert.equal((await counts()).sends, beforeIme.sends, 'Blur never dispatches work');
  record('Space and Enter hold/release dictate into the editable draft without sending; IME/modified keys are ignored and blur stops recording.');

  const pointerBefore = await counts();
  const micBox = await mic().boundingBox();
  await page.mouse.move(micBox.x + micBox.width / 2, micBox.y + micBox.height / 2);
  await page.mouse.down();
  await expectUntil(async () => (await counts()).starts === pointerBefore.starts + 1, 'Pointer hold starts dictation');
  await page.mouse.up();
  await expectUntil(async () => (await counts()).finishes === pointerBefore.finishes + 1, 'Pointer release finishes dictation');
  await page.evaluate(() => { window.ogb.permRequestMic = () => new Promise(resolve => { window.__resolveMicPermission = resolve; }); });
  const permissionBefore = await counts();
  await mic().focus();
  await page.keyboard.down('Space');
  await expectUntil(() => page.evaluate(() => typeof window.__resolveMicPermission === 'function'), 'Permission check starts');
  await page.keyboard.up('Space');
  await page.evaluate(() => { window.__resolveMicPermission(true); window.ogb.permRequestMic = async () => true; });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal((await counts()).starts, permissionBefore.starts, 'Late permission after release must not restart recording');
  record('Pointer hold/release still works; microphone permission granted after a released key never starts a stale recording.');

  const messageBeforeSend = await composer.inputValue();
  await page.getByRole('button', { name: 'Start this work', exact: true }).click();
  await expectUntil(async () => await composer.inputValue() === '', 'Accepted request clears the draft');
  const sent = await page.evaluate(() => window.__composerQa.fixture.events.filter(event => event.type === 'dispatch' && event.action.type === 'send').at(-1));
  assert.ok(sent.action.text.includes(messageBeforeSend));
  assert.ok(sent.action.text.includes('fictional-repair-note.txt'), 'Attachment is included in submitted work');
  assert.equal(await page.getByText('fictional-repair-note.txt', { exact: true }).count(), 0, 'Accepted attachment chip is cleared');
  record('Start work dispatches the complete draft and attachment once, and clears both only after acceptance.');

  await page.evaluate(() => window.__composerQa.setBot(previous => ({ ...previous, busy: true })));
  await composer.fill('Use the latest inspection date.');
  const updateCurrent = page.getByRole('button', { name: 'Update current work', exact: true });
  const doNext = page.getByRole('button', { name: 'Do this next', exact: true });
  await updateCurrent.waitFor();
  await doNext.waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Busy composer has no narrow overflow');
  await screenshot('composer-working-390x844.png');
  await updateCurrent.click();
  await expectUntil(async () => await composer.inputValue() === '', 'Updating current work clears an accepted draft');
  assert.ok(await page.evaluate(() => window.__composerQa.fixture.events.some(event => event.type === 'api' && event.path.endsWith('/steer') && event.body.text === 'Use the latest inspection date.')));
  await composer.fill('Prepare the next owner update.');
  await page.getByRole('button', { name: 'Do this next', exact: true }).click();
  await expectUntil(async () => await composer.inputValue() === '', 'Do next clears an accepted follow-up');
  assert.ok(await page.evaluate(() => window.__composerQa.fixture.events.some(event => event.type === 'api' && event.path.endsWith('/queued-message') && event.body.text === 'Prepare the next owner update.')));
  record('Update current work and Do next call their separate existing actions, retain narrow-screen usability, and clear only accepted drafts.');

  await page.evaluate(text => {
    window.__composerQa.setBot(previous => ({ ...previous, busy: false }));
    window.__composerQa.setResponse(text);
  }, responseMarkdown);
  const response = page.getByRole('article', { name: 'Bud’s response', exact: true });
  await response.waitFor();
  assert.equal(await response.getByRole('heading', { name: 'What needs your attention', exact: true }).count(), 1, 'Response sections are navigable headings');
  assert.equal(await response.getByRole('heading', { name: 'Before updating the register', exact: true }).count(), 1);
  assert.equal(await response.locator('ul ul > li').count(), 3, 'Nested list structure is preserved');
  assert.equal(await response.locator('ol > li').count(), 3, 'Ordered actions remain a numbered list');
  assert.equal(await response.locator('blockquote').count(), 1);
  const sourceLink = response.getByRole('link', { name: 'fictional source register', exact: true });
  assert.equal(await sourceLink.getAttribute('href'), 'https://office.example.invalid/register/fictional-notices');
  assert.equal(await sourceLink.getAttribute('target'), '_blank');
  const table = response.getByRole('region', { name: 'Response table', exact: true });
  assert.equal(await table.getAttribute('tabindex'), '0', 'Wide tables remain keyboard reachable');
  await expectUntil(async () => await response.locator('pre').innerText() === responseMarkdown.split('```text\n')[1].split('\n```')[0], 'Settled code text is preserved');
  record('Production response preserves section headings, nested bullets, ordered actions, quote, source link, table, and exact code text.');

  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.locator('#fixture-thread').evaluate(element => { element.scrollTop = 0; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Response has no page horizontal overflow');
    assert.equal(await response.evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'Response card contains long references, tables, and code');
    const layout = await response.evaluate(element => {
      const prose = element.querySelector('.chat-md');
      const heading = prose.querySelector('h2,h3,h4,h5,h6');
      return {
        proseWidth: prose.querySelector('p').getBoundingClientRect().width,
        headingMargin: parseFloat(getComputedStyle(heading).marginTop),
        paragraphMargin: parseFloat(getComputedStyle(prose.querySelector('p')).marginTop),
        lineHeight: parseFloat(getComputedStyle(prose).lineHeight),
        fontSize: parseFloat(getComputedStyle(prose).fontSize),
        stickyHeader: getComputedStyle(element.querySelector('header')).position === 'sticky',
      };
    });
    assert.ok(layout.lineHeight >= layout.fontSize * 1.5, 'Prose has readable line spacing');
    assert.ok(layout.headingMargin >= 20, 'Section headings have clear separation');
    assert.equal(layout.stickyHeader, false, 'Response heading does not overlay text while reading');
    if (viewport.width === 1280) assert.ok(layout.proseWidth <= 720, 'Desktop paragraphs use a readable measure');
    await screenshot(`response-${viewport.width}x${viewport.height}.png`);
    await table.focus();
    assert.equal(await table.evaluate(element => element === document.activeElement), true, 'Response table accepts keyboard focus');
    if (viewport.width === 390) {
      assert.equal(await table.evaluate(element => element.scrollWidth > element.clientWidth), true, 'Three-column mobile table scrolls locally instead of squeezing prose');
      assert.ok(await table.locator('td').nth(1).evaluate(element => element.getBoundingClientRect().width >= 170), 'Mobile prose columns remain wide enough to read');
      await page.keyboard.press('ArrowRight');
      await expectUntil(() => table.evaluate(element => element.scrollLeft > 0), 'Keyboard can reveal the next table column');
    }
    const codeRegion = response.getByRole('region', { name: 'text code', exact: true });
    await codeRegion.focus();
    assert.equal(await codeRegion.evaluate(element => element === document.activeElement), true, 'Code scroll region accepts keyboard focus');
    await response.locator('pre').scrollIntoViewIfNeeded();
    const codeOverflow = await response.locator('pre').evaluate(element => {
      const scrollContainer = [element, element.parentElement, element.parentElement?.parentElement].find(candidate => candidate && ['auto', 'scroll'].includes(getComputedStyle(candidate).overflowX));
      return !!scrollContainer && scrollContainer.scrollWidth >= scrollContainer.clientWidth;
    });
    assert.equal(codeOverflow, true, 'Long code stays in its own scroll container');
    await screenshot(`response-details-${viewport.width}x${viewport.height}.png`);
  }
  record('Desktop and 390px responses have readable measure and section spacing, no horizontal page/card overflow, and contained table/code scrolling without a sticky text overlay.');

  await page.setViewportSize({ width: 1280, height: 1600 });
  await page.locator('#fixture-thread').evaluate(element => { element.scrollTop = 0; });
  await response.screenshot({ path: join(output, 'response-card.png') });
  await page.setViewportSize({ width: 390, height: 844 });

  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await response.getByRole('button', { name: 'Copy code', exact: true }).click();
  await expectUntil(async () => (await page.evaluate(() => navigator.clipboard.readText())) === responseMarkdown.split('```text\n')[1].split('\n```')[0], 'Copy code writes exact source text');
  assert.equal(await response.getByRole('button', { name: 'Copy code', exact: true }).innerText(), 'Copied', 'Code copy confirms completion');
  await page.evaluate(() => {
    window.__restoreClipboard = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async () => { throw new Error('Fictional clipboard permission denial'); };
  });
  await response.getByRole('button', { name: 'Copy code', exact: true }).click();
  await response.getByRole('button', { name: 'Try copying code again', exact: true }).waitFor();
  await response.getByText('Couldn’t copy. Try again, or select the code.', { exact: true }).waitFor();
  await page.evaluate(() => { navigator.clipboard.writeText = window.__restoreClipboard; });
  await response.getByRole('button', { name: 'Try copying code again', exact: true }).click();
  await expectUntil(async () => await response.getByRole('button', { name: 'Copy code', exact: true }).innerText() === 'Copied', 'Copy retry recovers after permission denial');
  record('Copy code copies exact fenced text, confirms completion, reports permission failures, and retries successfully.');

  await page.evaluate(text => window.__composerQa.setResponse(text), '## Remaining checks\n\n4. Compare the original notice.\n5. Approve the correction.\n\n- [x] Keep the source reference\n- [ ] Review the notice\n\n| Property | Balance |\n| :--- | ---: |\n| Fictional Street | 123.45 |');
  await response.getByRole('heading', { name: 'Remaining checks', exact: true }).waitFor();
  assert.equal(await response.locator('ol').getAttribute('start'), '4', 'Continued ordered lists preserve their starting number');
  assert.equal(await response.locator('ul.contains-task-list').count(), 1, 'GFM task-list semantics are retained');
  assert.equal(await response.getByRole('checkbox').count(), 2);
  assert.equal(await response.locator('td').last().evaluate(element => getComputedStyle(element).textAlign), 'right', 'GFM table alignment is preserved');
  record('Continued numbering, task-list checkboxes, and numeric table alignment retain source formatting.');

  const streamingCode = '<script>fictional_markup_only()</script>\nReference: 00001234567890';
  await page.evaluate(text => {
    window.__composerQa.setResponse(null);
    window.__composerQa.setStreaming(true);
  });
  await response.waitFor({ state: 'hidden' });
  await page.evaluate(text => window.__composerQa.setResponse('Streaming preview\n\n```text\n' + text + '\n```'), streamingCode);
  await response.locator('pre').waitFor();
  assert.equal(await response.locator('pre').innerText(), streamingCode, 'Streaming plain code preserves partial response text');
  assert.equal(await response.locator('script').count(), 0, 'Code content does not become executable HTML');
  assert.equal(await response.locator('.shiki').count(), 0, 'Streaming code remains plain instead of caching partial highlighting');
  await screenshot('response-streaming-390x844.png');
  record('Streaming code stays plain, exact and contained; HTML-like text is inert.');

  // Enable the production context rail only after the existing composer/response
  // regression cases. Every source observation and message below is fictional.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await scenario('many-apps');
  await page.evaluate(text => {
    window.__composerQa.setStreaming(false);
    window.__composerQa.setResponse(text);
    window.__composerQa.setBot(previous => ({ ...previous, busy: false, messages: [] }));
    window.__composerQa.setShowAppContext(true);
  }, responseMarkdown);
  const contextToggle = page.getByRole('button', { name: 'App context', exact: true });
  const appPanel = () => page.getByRole('region', { name: 'Connected apps context', exact: true });
  const hideContext = () => appPanel().getByRole('button', { name: 'Hide app context', exact: true });
  const retainedDraft = 'Keep this repair update as a draft while I check the apps.';
  const workEvents = () => page.evaluate(() => window.__composerQa.fixture.events.filter(event =>
    event.type === 'dispatch' && event.action.type === 'send' || event.type === 'api' && /\/(steer|queued-message)$/.test(event.path)).length);
  const beforeContextWork = await workEvents();
  const request = (id, text) => page.evaluate(({ id, text }) => {
    window.__composerQa.setBot(previous => ({ ...previous, messages: [...previous.messages, { id, role: 'user', kind: 'text', text, at: Date.now() }] }));
  }, { id, text });
  const settleFrame = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await contextToggle.waitFor();
  await composer.fill(retainedDraft);
  assert.equal(await appPanel().count(), 0, 'Ready accounts alone do not open the context rail');
  assert.doesNotMatch(await page.locator('.ask-composer-frame').innerText(), /Gmail|Outlook|connected apps/i, 'Accounts stay outside the draft');
  await contextToggle.click();
  await appPanel().waitFor();
  await expectUntil(() => hideContext().evaluate(element => element === document.activeElement), 'Manual opening focuses the rail close control');
  assert.equal(await contextToggle.getAttribute('aria-expanded'), 'true');
  await appPanel().getByText('Gmail', { exact: true }).waitFor();
  await screenshot('context-manual-1440x1000.png');
  await hideContext().dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true });
  assert.equal(await appPanel().isVisible(), true, 'IME Escape leaves the context rail open');
  await page.keyboard.press('Escape');
  await appPanel().waitFor({ state: 'hidden' });
  assert.equal(await contextToggle.evaluate(element => element === document.activeElement), true, 'Escape restores the app-context trigger');
  assert.equal(await composer.inputValue(), retainedDraft);
  await contextToggle.click();
  await page.locator('#outside-action').click();
  assert.equal(await appPanel().isVisible(), true, 'Nonmodal rail remains available after outside interaction');
  assert.equal(await page.locator('#outside-action').evaluate(element => element === document.activeElement), true);
  await composer.focus();
  await page.keyboard.press('Escape');
  assert.equal(await appPanel().isVisible(), true, 'Draft Escape does not unexpectedly dismiss the context rail');
  await hideContext().click();
  await appPanel().waitFor({ state: 'hidden' });
  assert.equal(await contextToggle.evaluate(element => element === document.activeElement), true, 'Hide returns focus to its trigger');
  record('App context starts quiet, manually opens with sensible focus, dismisses with Hide or local Escape, and stays nonmodal while the draft remains unchanged.');

  await composer.focus();
  await request('qa-local-reminder-request', 'Create one local Desk reminder. Do not use Gmail, calendar, browser or any external account.');
  await settleFrame();
  assert.equal(await appPanel().count(), 0, 'Negated app mentions do not open the context rail');
  assert.equal(await composer.evaluate(element => element === document.activeElement), true);
  await request('qa-gmail-request-1', 'Summarize the latest repair emails in Gmail.');
  await settleFrame();
  assert.equal(await appPanel().count(), 0, 'Positive app mentions alone do not open the context rail');
  await contextToggle.click();
  await appPanel().waitFor();
  await appPanel().getByText('Gmail', { exact: true }).waitFor();
  await appPanel().getByText('Mentioned in this request', { exact: true }).waitFor();
  await expectUntil(() => hideContext().evaluate(element => element === document.activeElement), 'Mentioned apps remain manually browsable with sensible focus');
  assert.equal(await composer.inputValue(), retainedDraft);
  await screenshot('context-relevant-1440x1000.png');
  await hideContext().click();
  for (let poll = 0; poll < 3; poll++) {
    await page.evaluate(() => window.__composerQa.officeSources.accept(window.__composerQa.fixture.snapshot()));
    await settleFrame();
    assert.equal(await appPanel().count(), 0, 'A dismissed request stays dismissed on status polling');
  }
  await page.evaluate(() => window.__composerQa.setBot(previous => ({ ...previous, messages: [...previous.messages, { id: 'qa-answer-1', role: 'bot', kind: 'text', text: 'Checking Gmail for your repair summary…', at: Date.now() }] })));
  await settleFrame();
  assert.equal(await appPanel().count(), 0, 'Assistant text does not reopen a dismissed request');
  await composer.focus();
  await request('qa-gmail-request-2', 'Use Gmail to review the next repair update.');
  await settleFrame();
  assert.equal(await appPanel().count(), 0, 'A new mention-only request stays quiet');
  await page.evaluate(() => window.__composerQa.setBot(previous => ({ ...previous, messages: [...previous.messages, {
    id: 'qa-mentioned-gmail-activity', role: 'bot', kind: 'activity', text: 'Reading the fictional repair update',
    tool: { name: 'GMAIL_FETCH_EMAILS' }, at: Date.now(),
  }] })));
  await appPanel().waitFor();
  assert.equal(await composer.evaluate(element => element === document.activeElement), true, 'Observed activity opens context without taking draft focus');
  await request('qa-general-request', 'Draft a friendly repair update using these notes.');
  await appPanel().waitFor({ state: 'hidden' });
  assert.equal(await composer.evaluate(element => element === document.activeElement), true, 'Automatic hide retains draft focus');
  record('Positive and negated app mentions stay quiet but remain manually browsable; observed activity can surface context without stealing focus, dismissals survive polling, and unrelated work restores the full conversation.');

  await scenario('pending-only');
  await appPanel().waitFor();
  await appPanel().getByText('Gmail', { exact: true }).waitFor();
  await appPanel().getByText('Finish sign-in in your browser', { exact: true }).waitFor();
  assert.equal(await composer.evaluate(element => element === document.activeElement), true, 'Pending sign-in does not take draft focus');
  await hideContext().click();
  await page.evaluate(() => window.__composerQa.officeSources.accept(window.__composerQa.fixture.snapshot()));
  await settleFrame();
  assert.equal(await appPanel().count(), 0, 'Pending sign-in dismissal survives a refresh');
  await page.evaluate(() => window.__composerQa.officeSources.setPending(null));
  await settleFrame();
  await composer.focus();
  await page.evaluate(() => window.__composerQa.officeSources.setPending('gmail'));
  await settleFrame();
  assert.equal(await appPanel().count(), 0, 'The same app in the same request respects its previous dismissal');
  await page.evaluate(() => window.__composerQa.officeSources.setPending('googledrive'));
  await appPanel().waitFor();
  await appPanel().getByText('Google Drive', { exact: true }).waitFor();
  assert.equal(await composer.evaluate(element => element === document.activeElement), true, 'A newly relevant sign-in can surface without taking focus');
  await screenshot('context-signing-in-1440x1000.png');
  record('Pending sign-in is contextual before an account exists; polling and the same app respect dismissal while a newly relevant app can surface without changing the draft.');

  await scenario('many-apps');
  await request('qa-mail-activity-request', 'Find the original repair notice in the connected office apps.');
  await appPanel().waitFor({ state: 'hidden' });
  await composer.focus();
  await page.evaluate(() => window.__composerQa.setBot(previous => ({ ...previous, messages: [...previous.messages, {
    id: 'qa-gmail-activity', role: 'bot', kind: 'activity', text: 'Reading the fictional repair notice',
    tool: { name: 'GMAIL_FETCH_EMAILS' }, at: Date.now(),
  }] })));
  await appPanel().waitFor();
  await appPanel().getByText('Gmail', { exact: true }).waitFor();
  await appPanel().getByText('App activity in this request', { exact: true }).waitFor();
  assert.equal(await composer.evaluate(element => element === document.activeElement), true);
  assert.equal(await composer.inputValue(), retainedDraft);
  record('Structured app activity can reveal its source in the current request without claiming assistant prose proves app usage or taking draft focus.');

  const operationReads = () => page.evaluate(() => window.__composerQa.fixture.events.filter(event => event.type === 'api' && event.path === '/api/connected-apps/operations').length);
  const genericActivity = id => page.evaluate(id => window.__composerQa.setBot(previous => ({ ...previous, messages: [...previous.messages, {
    id, role: 'bot', kind: 'activity', text: 'Checking fictional office records',
    tool: { name: 'COMPOSIO_MULTI_EXECUTE_TOOL', ok: true }, at: Date.now(),
  }] })), id);
  const receipt = (threadId, fail = false) => page.evaluate(({ threadId, fail }) => {
    window.__composerQa.fixture.failOperations = fail;
    window.__composerQa.fixture.operations = [{
      id: 'fictional-receipt-' + threadId, threadId, toolName: 'COMPOSIO_MULTI_EXECUTE_TOOL',
      toolSlugs: ['GMAIL_FETCH_EMAILS'], status: 'succeeded', startedAt: new Date().toISOString(),
    }];
  }, { threadId, fail });
  await request('qa-other-thread-receipt', 'Find the original repair notice in the office records.');
  await appPanel().waitFor({ state: 'hidden' });
  await receipt('fictional-other-thread');
  const beforeOtherThread = await operationReads();
  await genericActivity('qa-other-thread-activity');
  await expectUntil(async () => (await operationReads()) > beforeOtherThread, 'Generic activity reads existing receipts');
  await settleFrame();
  assert.equal(await appPanel().count(), 0, 'A receipt from another conversation does not reveal app context');
  await request('qa-failed-receipt', 'Find the original repair notice in the office records.');
  await receipt('fictional-thread', true);
  const beforeFailedReceipt = await operationReads();
  await genericActivity('qa-failed-receipt-activity');
  await expectUntil(async () => (await operationReads()) > beforeFailedReceipt, 'The fixture exercises failed receipt access');
  await settleFrame();
  assert.equal(await appPanel().count(), 0, 'A failed receipt read quietly leaves the app unknown');
  await request('qa-current-receipt', 'Find the original repair notice in the office records.');
  await receipt('fictional-thread');
  await composer.focus();
  await genericActivity('qa-current-receipt-activity');
  await appPanel().waitFor();
  await appPanel().getByText('Gmail', { exact: true }).waitFor();
  await appPanel().getByText('App activity in this request', { exact: true }).waitFor();
  assert.equal(await composer.evaluate(element => element === document.activeElement), true);
  const afterCurrentReceipt = await operationReads();
  await page.evaluate(() => {
    window.__composerQa.officeSources.accept(window.__composerQa.fixture.snapshot());
    window.__composerQa.setBot(previous => ({ ...previous, messages: [...previous.messages, { id: 'qa-receipt-prose', role: 'bot', kind: 'text', text: 'Preparing the repair notice comparison.', at: Date.now() }] }));
  });
  await settleFrame();
  assert.equal(await operationReads(), afterCurrentReceipt, 'Source polling and assistant prose do not refetch operation receipts');
  assert.equal(await composer.inputValue(), retainedDraft);
  record('Current-request receipts identify Gmail behind generic app activity; other-chat receipts and failed reads stay quiet, and status/prose updates do not poll the receipt API.');

  await page.evaluate(() => { window.__composerQa.fixture.failCheck = true; });
  await appPanel().getByRole('button', { name: 'Check access', exact: true }).click();
  await appPanel().getByText('Couldn’t check office apps. Your saved settings are kept. Try again.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__composerQa.officeSources.getSnapshot().snapshot), null, 'Failed access read clears stale availability');
  await hideContext().click();
  await appPanel().waitFor({ state: 'hidden' });
  await composer.focus();
  await page.evaluate(async () => {
    window.__composerQa.fixture.failCheck = false;
    await window.__composerQa.officeSources.refresh();
  });
  await settleFrame();
  assert.equal(await appPanel().count(), 0, 'Successful background recovery respects Hide while the source snapshot was unavailable');
  assert.equal(await composer.evaluate(element => element === document.activeElement), true);
  assert.equal(await composer.inputValue(), retainedDraft);
  record('Hide during a failed explicit access check remains respected when a successful background check restores the same app context.');

  await request('qa-focus-recovery', 'Check Gmail for the next repair notice.');
  await contextToggle.click();
  await appPanel().waitFor();
  await scenario('degraded');
  const reviewGmail = appPanel().getByRole('button', { name: 'Review Gmail connection', exact: true });
  await reviewGmail.focus();
  await scenario('ready');
  await expectUntil(() => hideContext().evaluate(element => element === document.activeElement), 'Recovery of a focused Review action returns keyboard focus to Hide');
  assert.equal(await reviewGmail.count(), 0);
  await scenario('many-apps');
  await appPanel().getByRole('button', { name: /View all/ }).focus();
  await scenario('ready');
  await expectUntil(() => hideContext().evaluate(element => element === document.activeElement), 'Removal of focused View all returns keyboard focus to Hide');
  assert.equal(await appPanel().getByRole('button', { name: /View all/ }).count(), 0);
  assert.equal(await composer.inputValue(), retainedDraft);
  record('Keyboard focus stays in the context card when a connection recovers and removes Review, or a source update removes View all.');

  await scenario('many-apps');
  await request('qa-gmail-request-3', 'Check Gmail for the original repair notice.');
  await appPanel().waitFor();
  const viewAll = appPanel().getByRole('button', { name: /View all/ });
  await viewAll.waitFor();
  await viewAll.click();
  await appPanel().getByText('Slack', { exact: true }).waitFor();
  assert.equal(await composer.inputValue(), retainedDraft, 'View all preserves the draft');
  assert.equal(await workEvents(), beforeContextWork, 'View all never submits or updates work');
  await screenshot('context-all-apps-1440x1000.png');
  const manageCount = await page.evaluate(() => window.__composerQa.fixture.events.filter(event => event.type === 'context-manage').length);
  await appPanel().getByRole('button', { name: 'Connections', exact: true }).click();
  await expectUntil(() => page.evaluate(previous => window.__composerQa.fixture.events.filter(event => event.type === 'context-manage').length === previous + 1, manageCount), 'Manage connections calls its existing connection owner');
  assert.equal(await composer.inputValue(), retainedDraft);
  assert.equal(await workEvents(), beforeContextWork, 'Managing apps never submits or updates work');
  record('View all reveals other connected apps, and Manage connections reaches the existing connection owner; neither action sends work or changes the draft.');

  if (!(await appPanel().count())) await contextToggle.click();
  for (const viewport of [{ width: 390, height: 844 }, { width: 390, height: 600 }, { width: 960, height: 500 }, { width: 1440, height: 1000 }]) {
    await page.setViewportSize(viewport);
    await settleFrame();
    const appList = appPanel().locator('.ask-app-context-section');
    await appList.evaluate(element => { element.scrollTop = 0; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Open context has no horizontal page overflow');
    assert.equal(await appPanel().evaluate(element => element.scrollWidth <= element.clientWidth + 1), true, 'App context contains labels and actions');
    const box = await appPanel().boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= viewport.width + 1, 'Context card remains within the viewport width');
    const listBox = await appList.boundingBox();
    const firstAppBox = await appPanel().locator('.ask-app-context-app strong').first().boundingBox();
    assert.ok(firstAppBox && listBox && firstAppBox.y >= listBox.y && firstAppBox.y + firstAppBox.height <= listBox.y + listBox.height + 1, 'At least the first app name is fully visible before scrolling');
    await composer.focus();
    assert.equal(await composer.evaluate(element => element === document.activeElement), true, 'Draft remains reachable with app context open');
    assert.equal(await composer.inputValue(), retainedDraft);
    const draftBox = await composer.boundingBox();
    assert.ok(draftBox && draftBox.y >= 0 && draftBox.y + draftBox.height <= viewport.height + 1, 'The editable draft stays visible inside the viewport');
    const submitBox = await page.getByRole('button', { name: 'Start this work', exact: true }).boundingBox();
    assert.ok(submitBox && submitBox.y >= 0 && submitBox.y + submitBox.height <= viewport.height + 1, 'Draft submission controls stay visible in short viewports');
    if (viewport.width === 960 && viewport.height === 500) {
      const threadBox = await page.locator('#fixture-thread').boundingBox();
      assert.ok(threadBox && threadBox.height >= 100, 'Short landscape retains meaningful response-reading space');
    }
    const overlaps = box.x < draftBox.x + draftBox.width && box.x + box.width > draftBox.x && box.y < draftBox.y + draftBox.height && box.y + box.height > draftBox.y;
    assert.equal(overlaps, false, 'Context never overlays the editable draft');
    await screenshot(`context-open-${viewport.width}x${viewport.height}.png`);
    if (viewport.width === 390) {
      assert.equal(await appList.evaluate(element => element.scrollHeight > element.clientHeight), true, 'Long narrow app lists scroll within the card section');
      const connections = appPanel().getByRole('button', { name: 'Connections', exact: true });
      const connectionsBox = await connections.boundingBox();
      assert.ok(connectionsBox && connectionsBox.y >= box.y && connectionsBox.y + connectionsBox.height <= box.y + box.height + 1, 'The narrow rail footer stays visible without scrolling');
      const hideBox = await hideContext().boundingBox();
      assert.ok(hideBox && hideBox.y >= box.y && hideBox.y + hideBox.height <= box.y + box.height + 1, 'The narrow rail close control stays visible');
      await appPanel().getByText('Slack', { exact: true }).scrollIntoViewIfNeeded();
      assert.equal(await appList.evaluate(element => element.scrollTop > 0), true, 'Other connected apps are reachable through the list scroll');
      assert.deepEqual(await connections.boundingBox(), connectionsBox, 'Scrolling the app list leaves the footer fixed in place');
      assert.deepEqual(await hideContext().boundingBox(), hideBox, 'Scrolling the app list leaves Hide fixed in place');
      await screenshot(`context-footer-${viewport.width}x${viewport.height}.png`);
      await appList.evaluate(element => { element.scrollTop = 0; });
    }
  }
  record('App context adapts across 390px, short 960px, and desktop layouts without horizontal overflow, leaving the response and editable draft reachable.');
  await appPanel().getByRole('button', { name: 'Show relevant apps', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await settleFrame();
  await composer.focus();
  await screenshot('context-relevant-390x844.png');
  assert.equal(await workEvents(), beforeContextWork, 'All context interactions preserve the work submission count');

  assert.deepEqual(errors, [], 'No browser runtime errors');
  assert.deepEqual(network, [], 'No external or real API requests');
  await rm(join(output, 'failure.png'), { force: true });
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ passed: true, checks, fixture: 'Production Composer/Toolkit/AskMessage/ChatMarkdown/AskAppContext/source store; fictional application boundary', liveAccountOperations: 0, modelCalls: 0, screenshots: output }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, output }, null, 2));
} catch (error) {
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ passed: false, checks, error: error.stack, browserErrors: errors, unexpectedNetwork: network }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await server?.close();
}
