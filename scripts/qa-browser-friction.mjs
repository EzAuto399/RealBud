// How many presses a read-only Ask browser task takes. Real source service +
// built UI on the FICTIONAL Austin demo office (scripts/seed-austin-demo.mjs),
// with the fictional REI-style portal behind the real browser runtime, broker
// and sign-in handover (server/testing/w1-lab.ts), signed out at the start:
//   1. Work: the task card → ONE press (Start), no "Connect your browser" step;
//   2. Start opens REI and waits on the tab's address (sign-in strip); the
//      person signs in on REI (the lab plays that); no page picking, no labels;
//   3. Bud (a scripted ACP worker, no model) works in that tab: the account
//      REI shows is confirmed once, then the map's menu and the report link
//      read with no card; only the unmapped Output choice and the download ask;
//   4. the "Bud found how to export…" card is allowed and saved;
//   5. a consequential control (REI's arrears Notice) still asks with its exact
//      details, and is declined; nothing is pressed in REI;
//   6. a second task in the same business asks nothing about the account.
// The person is simulated by this script. A pass proves RealBud's wiring and
// guards, never REI Cloud behaviour.
//
//   REALBUD_UI_DIR=<scratch vite build> PLAYWRIGHT_MODULE=... CHROME_EXECUTABLE=... QA_OUTPUT=<fresh dir> node scripts/qa-browser-friction.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { primeBrowserSession } from './local-session.mjs';
import { startAustinDemo } from './seed-austin-demo.mjs';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT || join(root, `outputs/browser-friction-${new Date().toISOString().slice(0, 10)}`));
assert.ok(!existsSync(output), `Choose a fresh QA_OUTPUT; existing evidence at ${output} is preserved.`);
mkdirSync(output, { recursive: true });
const demoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'realbud-browser-friction-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const checks = [], errors = [], denied = [], shots = [], presses = [], cards = [];
const pass = text => { checks.push(text); console.log(`PASS ${text}`); };
const REPORT = 'Tenant Contact Export (fictional)';
const EXPLORE = 'Find out how to export the tenant list from rei-mock.fictional.test';
const SECOND = 'Open the Suppliers list on rei-mock.fictional.test';
let demo, browser, page, failure;

// Bud's CLI for this run: a scripted ACP peer that drives RealBud's browser broker like a worker would. Never calls a model.
const WORKER = String.raw`
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
if (process.argv.includes('--version')) { console.log('Hermes Agent v0.21.3 (2026.9.14)'); process.exit(0); }
const log = entry => { try { appendFileSync(LOG, JSON.stringify({ at: Date.now(), ...entry }) + '\n'); } catch {} };
if (!process.argv.includes('acp')) { console.log('{}'); process.exit(0); }
let browser = null, sequence = 1;
const out = value => process.stdout.write(JSON.stringify(value) + '\n');
const say = (sessionId, text) => out({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
const rpc = async (method, params) => {
  const response = await fetch(browser.url, { method: 'POST', signal: AbortSignal.timeout(15 * 60_000), headers: { 'content-type': 'application/json', ...Object.fromEntries(browser.headers.map(h => [h.name, h.value])) },
    body: JSON.stringify({ jsonrpc: '2.0', id: sequence++, method, ...(params ? { params } : {}) }) });
  return (await response.json()).result;
};
const tool = async (name, args = {}) => {
  const result = await rpc('tools/call', { name, arguments: args }); const text = String(result?.content?.[0]?.text ?? '');
  log({ tool: name, args: name === 'browser_read' ? undefined : args, isError: Boolean(result?.isError), text: name === 'browser_read' ? undefined : text.slice(0, 300) });
  if (result?.isError) throw new Error(name + ': ' + text);
  return text;
};
let page = '';
const read = async tab => { for (let i = 0; i < 6; i++) { page = JSON.parse(await tool('browser_read', { tab_id: tab })).text; if (!page.includes('Loading')) return page; await new Promise(r => setTimeout(r, 100)); } return page; };
const ref = (role, name) => { const want = role + ' ' + JSON.stringify(name); const line = page.split('\n').map(l => l.trim()).find(l => / /.test(l) && (l.endsWith(want) || l.includes(want + ' '))); const found = line?.match(/@e\d+/); if (!found) throw new Error('No ' + role + ' ' + name); return found[0]; };
const lines = createInterface({ input: process.stdin });
lines.on('line', line => { void (async () => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') return out({ jsonrpc: '2.0', id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
  if (method === 'session/new' || method === 'session/load') {
    browser = (params?.mcpServers ?? []).find(s => s.name === 'workbrowser' && typeof s.url === 'string') ?? null;
    return out({ jsonrpc: '2.0', id, result: { sessionId: 'fictional-browser-friction', modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] } } });
  }
  if (method === 'session/prompt') {
    const sessionId = params?.sessionId ?? 'fictional-browser-friction';
    const text = JSON.stringify(params?.prompt ?? []);
    if (!browser || !/Start this task/.test(text)) { say(sessionId, 'This is the fictional browser-friction worker.'); return out({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } }); }
    try {
      await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fictional-browser-friction-worker', version: '1' } });
      const tab = JSON.parse(await tool('browser_tabs')).tabs.find(t => t.site === 'https://rei-mock.fictional.test').tab_id;
      await tool('browser_borrow', { tab_id: tab }); await read(tab);
      if (/Suppliers list/.test(text)) {
        await tool('browser_click_semantic', { tab_id: tab, ref: ref('link', 'Suppliers') }); await read(tab);
        await tool('browser_release');
        say(sessionId, 'The Suppliers list is open in REI. Nothing in REI was changed.');
      } else {
        await tool('browser_click_semantic', { tab_id: tab, ref: ref('link', 'Reports') }); await read(tab);
        await tool('browser_click_semantic', { tab_id: tab, ref: ref('link', REPORT) }); await read(tab);
        await tool('browser_select', { tab_id: tab, ref: ref('combobox', 'Output'), values: ['Export Only'] }); await read(tab);
        await tool('browser_download', { tab_id: tab, ref: ref('button', 'Export') });
        const saved = await tool('portal_propose_path', { slot: 'tenant-list', steps: [{ verb: 'nav', label: 'Reports' }, { verb: 'click', label: REPORT }, { verb: 'select', label: 'Output', option: 'Export Only' }, { verb: 'download', label: 'Export' }] });
        // A consequential control: it must still ask with its exact details. The person declines it.
        await tool('browser_navigate', { tab_id: tab, url: 'https://rei-mock.fictional.test/customers/arrears/' }); await read(tab);
        let notice = 'not pressed';
        try { await tool('browser_click_semantic', { tab_id: tab, ref: ref('button', 'Notice') }); notice = 'pressed'; } catch (error) { log({ notice: String(error.message ?? error).slice(0, 200) }); }
        await tool('browser_release');
        say(sessionId, 'The tenant list export is under Reports → ' + REPORT + ', with Output set to Export Only. ' + saved + ' The arrears Notice was ' + notice + '.');
      }
    } catch (error) { log({ error: String(error.message ?? error) }); say(sessionId, 'I stopped: ' + String(error.message ?? error)); }
    return out({ jsonrpc: '2.0', id, result: { stopReason: 'end_turn' } });
  }
  if (id !== undefined) out({ jsonrpc: '2.0', id, result: {} });
})().catch(() => { process.exitCode = 1; lines.close(); }); });
`;

const request = (...args) => demo.request(...args);
const lab = action => request('/api/w1/lab', 'POST', { action });
const logFile = () => join(demo.data, 'vault', 'bud-work', 'browser-friction-worker.jsonl');
const workerLog = () => demo && existsSync(logFile()) ? readFileSync(logFile(), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
async function shot(name, locator) {
  if (locator) await locator.scrollIntoViewIfNeeded().catch(() => {});
  const file = `${name}.png`; await page.screenshot({ path: join(output, file), animations: 'disabled' }); shots.push(file);
}
/** The person's presses, counted as they happen. */
async function press(locator, what) { await locator.click(); presses.push(what); }
/** Answers each approval as it appears, until `done` says the flow has reached its end. Returns the cards seen. */
async function answerCards(done, answer, limit = 10) {
  const seen = [];
  for (let i = 0; i < limit; i++) {
    const buttons = page.getByRole('button', { name: /^(Allow once|Continue in this account|Decline\b.*)$/ });
    await buttons.first().waitFor({ timeout: 60_000 });
    // A consequential step has its own card (exact details, Approve / Decline); the others share the approval strip.
    const consequential = /^Decline/.test(await buttons.first().innerText());
    const panel = consequential ? buttons.first().locator('xpath=ancestor::div[.//dl][1]')
      : page.getByText('Pending approval', { exact: true }).last().locator('xpath=ancestor::div[contains(@class, "rounded-t-2xl")][1]');
    const text = (await panel.innerText().catch(() => page.locator('body').innerText())).replace(/\s+/g, ' ');
    const kind = consequential ? 'consequential' : /Check the account/.test(text) ? 'account' : /Bud found how to export/.test(text) ? 'proposal' : 'step';
    seen.push({ kind, text: text.slice(0, 400) }); cards.push({ kind, text: text.slice(0, 400) });
    await shot(`card-${cards.length}-${kind}`);
    const name = answer(kind);
    await press(page.getByRole('button', { name, exact: true }).first(), `${kind}: ${name}`); await wait(300);
    if (await done(kind)) return seen;
  }
  throw new Error(`Too many cards: ${JSON.stringify(seen)}`);
}
async function startTask(text) {
  await page.goto(`${demo.base}/#/desk`);
  await page.getByRole('button', { name: /^Work\b/ }).first().click();
  const composer = page.getByRole('textbox', { name: 'Tell Bud what outcome you need', exact: true });
  await composer.fill(text); await composer.press('Enter');
  const card = page.getByRole('region', { name: 'Browser task', exact: true }).last();
  await card.getByText(/rei-mock\.fictional\.test/).first().waitFor();
  return card;
}

try {
  demo = await startAustinDemo({ demoRoot });
  writeFileSync(join(demoRoot, 'demo-worker.mjs'), `#!${process.execPath}\nconst LOG = ${JSON.stringify(logFile())};\nconst REPORT = ${JSON.stringify(REPORT)};\n${WORKER}`, { mode: 0o700 });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, demo.base, demo.token);
  await context.route('**/*', route => { const origin = new URL(route.request().url()).origin; if (origin === demo.base) return route.continue(); denied.push(origin); return route.abort(); });
  page = await context.newPage(); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => errors.push(error.message));
  // REI's tenant export carries a name the pack does not know, so Bud has to find it. The lab starts signed out.
  await lab('rename-reports');

  // ── 1. One press: Start ──
  const card = await startTask(EXPLORE);
  assert.equal(await card.getByRole('button', { name: /Connect your browser/ }).count(), 0, 'no Connect step on the card');
  await shot('1-task-card', card);
  await press(card.getByRole('button', { name: 'Start this task', exact: true }), 'Start this task');
  pass('The task card offers Start only (no Connect your browser step); the person pressed Start once');

  // ── 2. Sign-in handover on the task's own tab: no page picking, no labels ──
  const strip = page.getByRole('region', { name: 'Sign in to REI Cloud', exact: true });
  await strip.getByText("Sign in to REI Cloud here. Bud carries on when you're signed in.", { exact: true }).waitFor({ timeout: 30_000 });
  await shot('2-sign-in-strip', strip);
  assert.equal(await page.getByRole('button', { name: 'Find my signed-in page' }).count(), 0);
  await lab('sign-in'); // the person signs in on REI themselves
  presses.push('(the person signs in on REI)');
  pass('Start opened REI and waited on its sign-in page; the person signed in there; no "Find my signed-in page" or page labels were asked');

  // ── 3–5. Account once, then only the asks the rules require, the proposal, and a consequential Notice ──
  const seen = await answerCards(async kind => kind === 'consequential', kind => kind === 'account' ? 'Continue in this account' : kind === 'consequential' ? (/^Decline/) : 'Allow once');
  const steps = seen.filter(item => item.kind === 'step');
  assert.deepEqual(seen.map(item => item.kind), ['account', 'step', 'step', 'proposal', 'consequential'], JSON.stringify(seen));
  assert.match(seen[0].text, /Signed in to rei-mock\.fictional\.test as FICT1\. Continue in this account\?/);
  assert.match(steps[0].text, /Export Only/); assert.match(steps[1].text, /Download/i);
  assert.match(seen[3].text, new RegExp(`Bud found how to export the Tenants list: Reports → ${REPORT.replace(/[()]/g, '\\$&')} → Export Only → Export\\.`));
  assert.match(seen[4].text, /Arrears/);
  const clicks = workerLog().filter(entry => entry.tool === 'browser_click_semantic' && !entry.isError).map(entry => entry.text);
  assert.equal(clicks.length, 2, JSON.stringify(workerLog()));
  pass(`After sign-in: the account (FICT1) was confirmed once; REI's Reports menu and the "${REPORT}" link opened with no card; only the Output choice and the download asked (${steps.length} step asks); the "Bud found how to export…" card was allowed`);
  await page.getByText(/The arrears Notice was not pressed/).first().waitFor({ timeout: 60_000 });
  pass(`The arrears Notice still asked with its exact details ("${seen[4].text.match(/Issue the notice[^?]*\?/)?.[0] ?? 'notice'}") and was declined: not pressed`);
  const progress = page.getByRole('region', { name: 'Browser task', exact: true }).last().getByLabel('Progress');
  await progress.waitFor();
  const progressText = await progress.innerText();
  assert.match(progressText, /Signed in to REI Cloud/); assert.match(progressText, /Opened Reports/);
  await shot('5-progress', page.getByRole('region', { name: 'Browser task', exact: true }).last());
  pass(`The task card shows progress: "${progressText}"`);
  const saved = JSON.parse(readFileSync(join(demo.data, 'portal-path-overrides.json'), 'utf8')).slots['rei-cloud/tenant-list'];
  assert.equal(saved.current, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(demo.data, 'portal-accounts.json'), 'utf8')).accounts, { 'rei-cloud': 'FICT1' });
  const firstPresses = presses.length;

  // ── 6. A second task in the same business: Start, and no account question ──
  const second = await startTask(SECOND);
  await press(second.getByRole('button', { name: 'Start this task', exact: true }), 'Start this task (second task)');
  await page.getByText(/The Suppliers list is open in REI/).first().waitFor({ timeout: 60_000 });
  assert.equal(await page.getByRole('button', { name: 'Continue in this account', exact: true }).count(), 0);
  assert.equal(presses.length - firstPresses, 1);
  await shot('6-second-task');
  pass('A second task in the same REI business took one press (Start): no sign-in (already signed in), no account question, no card for the Suppliers menu');

  // ── 7. Nothing pressed in REI; no renderer errors; no off-origin requests; 390 px ──
  assert.deepEqual((await lab('status')).effects, []);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('region', { name: 'Browser task', exact: true }).last().scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no horizontal scroll at 390 px');
  await shot('7-card-390');
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  pass('Nothing pressed in the fictional REI, no renderer errors, no off-origin browser requests, no horizontal scroll at 390 px');
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  console.error(failure);
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close();
  await demo?.stop();
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({
    at: new Date().toISOString(), passed: !failure, label: 'fictional-browser-friction',
    layer: 'Real local source service and built UI (headless Chrome, macOS) on the fictional Austin demo office; real browser runtime, broker, sign-in handover, path and account stores over the fictional REI-style portal; a scripted ACP worker stands in for the model',
    checks, presses, cards, screenshots: shots, errors, deniedOrigins: denied,
    worker: workerLog().map(entry => entry.text ? { ...entry, text: entry.text.replace(/"path":"[^"]*("|$)/g, '"path":"<temp>"') } : entry),
    limits: ['Fictional REI-style portal and data only; no REI account, credential, customer record or model was used.',
      'The worker is scripted: it proves RealBud asks only where its rules require, not that a model explores well.',
      'The lab browser is the helper-protocol runtime with a simulated sign-in tab; the native work browser and live REI sign-in (b2clogin) were not driven.',
      'Source service on macOS; not a packaged build, installed device or Windows. The person is simulated by this script.'],
    failure: failure ?? null, ...(failure && demo ? { diagnostic: demo.logs().slice(-8000) } : {}),
  }, null, 2));
  rmSync(demoRoot, { recursive: true, force: true });
  if (failure) process.exitCode = 1;
}
