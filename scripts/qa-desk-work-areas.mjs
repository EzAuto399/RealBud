// Desk work areas (docs/DESK-WORK-AREAS-2026-10-10.md, slices 2–4): Needs you on the Tasks tab, area tab
// counts, the Bank references area and the split Arrange Desk sheet, in the built React UI against a real
// disposable local service. Needs you items come from the fictional Gmail connector and deterministic worker
// that qa-mail-retention.mjs uses; two labelled browser injections show a failed read and an unreadable
// source. Fictional data only; no network, model or customer account; never reads ~/.realbud or dist/.
// Node 24, PLAYWRIGHT_MODULE, REALBUD_UI_DIR (scratch `vite build --outDir`), optional CHROME_EXECUTABLE and QA_OUTPUT.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { completeFictionalOnboarding } from './qa-onboarding.mjs';
import { readSessionToken, primeBrowserSession } from './local-session.mjs';

assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module.');
assert.ok(process.env.REALBUD_UI_DIR, 'Set REALBUD_UI_DIR to a scratch `vite build --outDir` folder; dist/ is shared.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/desk-work-areas-integration-2026-10-10'));
assert.ok(!existsSync(output), 'Choose a fresh QA_OUTPUT; existing evidence is preserved.');
mkdirSync(output, { recursive: true });
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'fictional-desk-areas-'));
const data = join(temp, 'data'); mkdirSync(data, { mode: 0o700 });
const checks = [], errors = [], screenshots = [], injections = [];
let child, browser, page, failure, logs = '', partial = false;
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
const until = async (check, message) => { for (let i = 0; i < 300; i++) { const value = await check(); if (value) return value; await wait(50); } assert.fail(message); };
const shot = async (name, target = page) => { await target.screenshot({ path: join(output, name), animations: 'disabled' }); screenshots.push(name); };
const noPageScroll = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal page scroll');

// The fictional Gmail connector: eight fictional conversations; `partial` makes the next scan report a missing page.
const credential = `rbc_${'c'.repeat(64)}`, sourceAt = Date.now() - 86_400_000;
const connector = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.headers.authorization !== `Bearer ${credential}` || req.headers['x-realbud-profile'] !== 'property') { res.writeHead(403); res.end('{"error":"fixture_refused"}'); return; }
  if (req.url === '/v1/connectors/status') {
    res.end(JSON.stringify({ managed: true, checkedAt: new Date().toISOString(), serviceExpiresAt: Date.now() + 3_600_000,
      services: { gmail: { connected: true, status: 'ACTIVE', accounts: [{ id: 'fixture-mail', label: 'Fictional accounts inbox', status: 'ACTIVE' }], accountSelectionRequired: false } },
      tools: { available: true, names: ['GMAIL_GET_PROFILE', 'GMAIL_LIST_THREADS', 'GMAIL_FETCH_MESSAGE_BY_THREAD_ID'] } }));
    return;
  }
  if (req.url === '/v1/connectors/mail-scan') {
    let raw = ''; for await (const part of req) raw += part;
    const body = JSON.parse(raw);
    if (body.expectedAccountId !== 'fixture-mail' || !body.scope) { res.writeHead(409); res.end('{}'); return; }
    res.end(JSON.stringify({ accountId: 'fixture-mail', windowStartAt: body.scope.windowStartAt, windowEndAt: body.scope.windowEndAt, pages: 1,
      paginationComplete: !partial, gaps: partial ? ['A page of fictional mail was unavailable.'] : [],
      threads: Array.from({ length: 8 }, (_, index) => {
        const id = (index + 1).toString(16);
        return { id, historyComplete: true, messages: [{ id: (index + 1001).toString(16), threadId: id, at: sourceAt + index, direction: 'incoming', from: 'fictional@example.test', to: 'office@example.test',
          subject: `Fictional tenant request ${String(index + 1).padStart(2, '0')}`, body: 'Please review this fictional request. No work has been approved.', bodyTruncated: false, attachments: [] }] };
      }) }));
    return;
  }
  res.writeHead(404); res.end('{}');
});

try {
  connector.listen(0, '127.0.0.1'); await once(connector, 'listening');
  const endpoint = `http://127.0.0.1:${connector.address().port}`;
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(resolveClose => reserve.close(resolveClose));
  const base = `http://127.0.0.1:${port}`;
  // Deterministic worker: every fictional conversation needs a person's review; it reports partial coverage as partial.
  const worker = join(temp, 'fictional-worker.mjs');
  writeFileSync(worker, `#!${process.execPath}\nimport {readFileSync,existsSync} from 'node:fs';
if(process.argv.includes('--version')){console.log('Hermes Agent v0.21.3 (2026.9.14)');process.exit(0);}
const inputPath=${JSON.stringify(join(data, 'vault/workflow-inputs/accounts-inbox.json'))};
if(!existsSync(inputPath)){console.log('{}');process.exit(0);}
const input=JSON.parse(readFileSync(inputPath,'utf8'));const complete=input.coverage?.complete!==false;
const result={version:1,kind:'accounts-inbox-triage',skillSource:'email-inbox-triage@0.1.0',sourceReference:input.sourceReference,status:complete?'complete':'partial',coverageComplete:complete,holds:[],actionsPerformed:[],threads:input.threads.map(t=>({threadId:t.threadId,disposition:'action-review',owner:'property-manager',priority:'normal',sourceMessageIds:t.messages.map(m=>m.messageId),reason:'A fictional tenant asks for a repair to be reviewed.',nextAction:'Review the repair request',missingFacts:[]}))};
console.log(JSON.stringify({summary:'Fictional deterministic preparation',evidence:['Fictional fixture sources'],outputs:[JSON.stringify(result)],needsApproval:[]}));\n`, { mode: 0o700 });
  chmodSync(worker, 0o700);
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } }, composio: { managed: { endpoint, credential, profile: 'property' } } }), { mode: 0o600 });
  child = spawn(process.execPath, [join(root, 'server/index.ts')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: {
    ...serviceSmokeEnv({ executable: process.execPath, home: temp, data, scratch: temp, port }),
    REALBUD_MANAGED_SERVICE: '0', REALBUD_HERMES_CLI: worker, REALBUD_TEST_LAB: '1', OMB_STATIC_DIR: resolve(process.env.REALBUD_UI_DIR) } });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-30_000); });
  let ready = false;
  for (let i = 0; i < 150 && child.exitCode === null; i++) { try { if ((await (await fetch(base + '/api/health')).json()).pid === child.pid) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, logs.slice(-1500));
  const token = await readSessionToken(data);
  const request = async (path, method = 'GET', body, expected = 200) => {
    const response = await fetch(base + path, { method, signal: AbortSignal.timeout(60_000), headers: { 'content-type': 'application/json', 'x-realbud-session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const value = await response.json();
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`);
    return value;
  };
  await completeFictionalOnboarding(request);
  await request('/api/hermes/apply-pack', 'POST', {});
  const exported = await request('/api/customer-packs/office-core/export');
  const preview = await request('/api/customer-packs/preview', 'POST', { pack: exported });
  await request('/api/customer-packs/install', 'POST', { pack: exported, expectedDigest: preview.digest });
  const recipe = (await request('/api/recipes')).recipes.find(row => row.id === 'wf-office-core-inbox-triage');
  assert.ok(recipe);
  await request(`/api/recipes/${recipe.id}`, 'PATCH', { expectedRevision: recipe.revision, planApproved: true, status: 'active' });
  const workerStatus = await request('/api/hermes');
  writeFileSync(join(data, 'hands-ping.json'), JSON.stringify({ at: Date.now(), ok: true, detail: 'Deterministic fixture readiness; not a live model test', kind: 'ping', workerFingerprint: workerStatus.workerFingerprint }), { mode: 0o600 });
  await request('/api/connected-apps/check', 'POST', {});
  // The office runs Morning priorities and Bank references, so the preset offers a Bank references area.
  let setup = await request('/api/agency-setup');
  setup = await request('/api/agency-setup', 'PUT', { expectedRevision: setup.state.revision, settings: { ...setup.state.settings, agencyName: 'Fictional Agency One', workflowPackId: 'office-core',
    timeZone: 'Australia/Brisbane', gmailAccountId: 'fixture-mail', selectedWorkflows: ['morning-priorities', 'bank-references'] } });
  setup = await request('/api/agency-setup/check-gmail', 'POST', { expectedRevision: setup.state.revision });
  assert.deepEqual((await request('/api/workspace-tabs')).office.areas.filter(area => area.available).map(area => area.id), ['mail', 'bills', 'bank', 'shared-work']);
  assert.deepEqual(await request('/api/needs-you').then(body => [body.items.length, body.unavailable.length]), [0, 0]);

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, base, token);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/#/desk');
  await page.getByRole('heading', { name: 'Desk', exact: true }).waitFor();
  const deskRow = page.locator('.pm-desk-header').getByRole('navigation', { name: 'Desk workspace', exact: true });
  const rowTabs = async () => (await deskRow.locator('.desk-workspace-tabs > button').allTextContents()).map(text => text.replace(/[!\d]+$/, '').trim());
  const tasksTab = deskRow.getByRole('button', { name: /^Tasks(?:\s*\d+)?$/ });
  // None of the office's area jobs is switched on yet (each is opt-in), so an empty read is not "nothing to review".
  const quietSection = page.getByRole('region', { name: 'From your workflows', exact: true }).and(page.locator('.needs-you-quiet'));
  const quiet = quietSection.getByText(/^Nothing to review yet · Not checked yet: Mail priorities, Bills and calendar, Bank references$/);
  await quiet.waitFor();
  await quietSection.getByRole('button', { name: 'Finish setup', exact: true }).waitFor();
  assert.deepEqual(await rowTabs(), ['Tasks', 'Mail priorities', 'Bills and calendar', 'Bank references', 'Shared work', 'Hermios']);
  for (const name of ['Mail priorities', 'Bills and calendar', 'Bank references']) await deskRow.getByRole('button', { name, exact: true }).waitFor();
  await shot('01-needs-you-nothing-1280.png');
  pass('After a full read that found nothing while no area job is set up, Tasks says "Nothing to review yet · Not checked yet: Mail priorities, Bills and calendar, Bank references" in one line with Finish setup, never "nothing from your workflows"; the area tabs carry no count, and Bank references is a tab for an office that runs it');

  // This computer last showed the panel now (a reload marks it); everything found after it is New.
  await page.reload();
  await quiet.waitFor();
  const seenAt = await page.evaluate(() => Number(localStorage.getItem('realbud.needsYouSeenAt')));
  assert.ok(seenAt > 0, 'Leaving the page marks the panel as seen');
  setup = await request('/api/agency-setup');
  const workflow = setup.workflows.find(row => row.id === 'morning-priorities');
  assert.ok(workflow.canReview, JSON.stringify(workflow));
  await request('/api/agency-setup/workflows/morning-priorities/review', 'POST', { expectedRevision: setup.state.revision, expectedEvidenceDigest: workflow.evidenceDigest });
  let mail = await request('/api/mail-workspace');
  for (let i = 0; i < 300 && mail.history?.state === 'checking'; i++) { await wait(100); mail = await request('/api/mail-workspace'); }
  partial = true;
  await request('/api/mail-workspace/scan', 'POST', {});
  const needs = await request('/api/needs-you');
  const mailCounts = needs.counts.mail;
  assert.ok(mailCounts?.problem === 1 && mailCounts.review >= 6, `The fixture gives Mail priorities one problem and six or more to review: ${JSON.stringify(needs.counts)}`);
  const problem = needs.items.find(item => item.level === 'problem');
  assert.equal(problem.area, 'mail');
  // Desk hears that something changed (as after a job run) and reads Needs you once more, without a reload.
  await page.evaluate(() => window.dispatchEvent(new Event('realbud:needs-you-stale')));
  const panel = page.getByRole('region', { name: 'From your workflows', exact: true });
  await panel.getByRole('heading', { name: 'Problems', exact: true }).waitFor();
  const rows = panel.locator('.needs-you-row');
  assert.equal(await rows.count(), 5, 'Five rows first');
  const groups = await panel.locator('.needs-you-group > h3').allTextContents();
  assert.deepEqual(groups, ['Problems', 'To review']);
  const first = await rows.first().innerText();
  assert.match(first, /^Problem\s+(New\s+)?Mail priorities\s+/);
  assert.ok(first.includes(problem.title) && first.includes(problem.reason));
  const problemAction = `${problem.next}: ${problem.title}`;
  await rows.first().getByRole('button', { name: problemAction, exact: true }).waitFor();
  assert.equal(await rows.first().getByRole('button', { name: problemAction, exact: true }).innerText(), problem.next, 'The visible label starts the spoken name');
  assert.ok(await panel.getByText('New', { exact: true }).count() >= 1, 'Items found since the panel was last shown are New');
  const announced = await page.locator('p.sr-only[aria-live="polite"]').filter({ hasText: /new items from your workflows|^New from / }).count();
  assert.equal(announced, 1, 'Arrivals are announced once through a polite live region');
  const total = needs.items.length + needs.unavailable.length;
  assert.match(await panel.locator('.needs-you-head > p').innerText(), new RegExp(`^${total} items · checked \\d{1,2}:\\d{2} [ap]m$`));
  const more = panel.getByRole('button', { name: `Show all ${total}`, exact: true });
  assert.equal(await more.getAttribute('aria-expanded'), 'false');
  const mailName = `Mail priorities, ${mailCounts.problem + mailCounts.review} need you, 1 problem`;
  const mailTab = deskRow.getByRole('button', { name: mailName, exact: true });
  await mailTab.waitFor();
  assert.match(await mailTab.innerText(), /^Mail priorities\s*!\s*\d+$/, 'The problem shows as a "!" before the count, not colour alone');
  await deskRow.getByRole('button', { name: 'Bills and calendar', exact: true }).waitFor();
  await shot('02-needs-you-1280.png');
  await more.click();
  assert.equal(await rows.count(), total);
  await panel.getByRole('button', { name: 'Show fewer', exact: true }).click();
  assert.equal(await rows.count(), 5);
  pass(`Needs you lists the problem first, then To review, five rows then "Show all ${total}"; the head counts "${total} items"; each row names its workflow, what was found, why and a button showing the next step and named "<next step>: <item>"; New marks items found since the panel was last shown and a polite live region announces them; the Mail priorities tab reads "${mailName}" with a visible "!"`);

  await rows.first().getByRole('button', { name: problemAction, exact: true }).click();
  await page.locator('.desk-area-surface[data-other-work="mail"]').waitFor();
  assert.equal(await mailTab.getAttribute('aria-pressed'), 'true');
  await tasksTab.click();
  await panel.waitFor();
  await deskRow.getByRole('button', { name: 'Bank references', exact: true }).click();
  const bank = page.locator('.desk-area-surface[data-other-work="bank"]');
  await bank.getByRole('heading', { name: 'Prepare bank references', exact: true }).waitFor();
  assert.equal(await bank.getAttribute('aria-label'), 'Bank references');
  await shot('03-bank-area-1280.png');
  await tasksTab.click();
  pass('A row\'s button opens its area (Mail priorities); the Bank references tab opens bank review as a Desk area');

  // Arrange Desk: Bills notices and layout, moved above Mail priorities; Reset to office default; Undo last change.
  const openArrange = async () => {
    const menu = page.locator('.pm-desk-header details.desk-more').filter({ has: page.getByRole('group', { name: 'More Desk tools', exact: true, includeHidden: true }) });
    if (!await menu.evaluate(element => element.open)) await menu.locator(':scope > summary').click();
    await menu.getByRole('group', { name: 'More Desk tools', exact: true }).getByRole('button', { name: 'Arrange Desk', exact: true }).click();
  };
  await openArrange();
  const sheet = page.getByRole('dialog', { name: 'Arrange Desk', exact: true });
  await sheet.getByText("Changes this computer's Desk. Your office's workflows and permissions stay the same.", { exact: true }).waitFor();
  const areasGroup = sheet.getByRole('group', { name: 'Work areas (tabs)', exact: true });
  const cardsGroup = sheet.getByRole('group', { name: 'Cards on Tasks', exact: true });
  const names = async (group, role) => Promise.all((await group.getByRole(role).all()).map(item => item.getAttribute('aria-label')));
  assert.deepEqual(await names(areasGroup, 'checkbox'), ['Show Mail priorities on my Desk', 'Show Bills and calendar on my Desk', 'Show Bank references on my Desk', 'Show Shared work on my Desk']);
  assert.deepEqual(await names(areasGroup, 'combobox'), ['Mail priorities notices', 'Bills and calendar notices', 'Bills and calendar layout', 'Bank references notices']);
  assert.deepEqual(await names(cardsGroup, 'checkbox'), ['Show Get started on my Desk', 'Show Morning brief on my Desk', 'Needs you always shows', 'Show Activity on my Desk']);
  assert.equal(await cardsGroup.getByRole('button').count(), 0, 'Cards on Tasks have no movers');
  assert.equal(await sheet.getByRole('button', { name: 'Undo last change', exact: true }).isDisabled(), true);
  await sheet.getByText('Nothing to undo: no earlier saved layout yet.', { exact: true }).waitFor();
  await areasGroup.getByRole('combobox', { name: 'Bills and calendar notices', exact: true }).selectOption({ label: 'Each new item' });
  await areasGroup.getByRole('combobox', { name: 'Bills and calendar layout', exact: true }).selectOption({ label: 'List' });
  await areasGroup.getByRole('button', { name: 'Move Bills and calendar up', exact: true }).click();
  await shot('04-arrange-desk-draft-1280.png');
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await sheet.getByText('Desk arrangement saved.', { exact: true }).waitFor();
  const stored = JSON.parse(readFileSync(join(data, 'workspace-views/tabs.json'), 'utf8')).state;
  assert.equal(stored.version, 3);
  const custom = ['brief', 'bills', 'mail', 'bank', 'shared-work', 'go-live', 'queue', 'activity'];
  assert.deepEqual(stored.desk.sections.map(section => section.id), custom);
  assert.deepEqual(stored.desk.sections.find(section => section.id === 'bills'), { id: 'bills', visible: true, notify: 'each', layout: 'review-list' });
  assert.ok(stored.desk.sections.filter(section => section.id !== 'bills').every(section => section.visible && !('notify' in section) && !('layout' in section)), 'Only Bills carries a choice of its own');
  await sheet.getByRole('button', { name: 'Close Arrange Desk', exact: true }).click();
  const customTabs = ['Tasks', 'Bills and calendar', 'Mail priorities', 'Bank references', 'Shared work', 'Hermios'];
  await until(async () => JSON.stringify(await rowTabs()) === JSON.stringify(customTabs), `Desk tabs read ${customTabs.join(', ')}`);
  await deskRow.getByRole('button', { name: 'Bills and calendar', exact: true }).click();
  const bills = page.locator('.desk-area-surface[data-other-work="bills"]');
  await bills.locator('details > summary').filter({ hasText: /^Calendar · / }).waitFor();
  await shot('05-bills-list-1280.png');
  await tasksTab.click();
  pass('Arrange Desk lists the four office areas with show, move, Notices and (for bills) Layout, and the cards on Tasks as show or hide only; Bills set to "Each new item" and List and moved up saves a version 3 file with only those choices, and the Bills tab comes first and opens as a list with the calendar folded beneath');

  await openArrange();
  await sheet.getByRole('button', { name: 'Reset to office default', exact: true }).click();
  await sheet.getByRole('button', { name: 'Save', exact: true }).click();
  await sheet.getByText('Desk arrangement saved.', { exact: true }).waitFor();
  const reset = (await request('/api/workspace-tabs')).state.desk.sections;
  assert.deepEqual(reset, ['brief', 'mail', 'bills', 'bank', 'shared-work', 'go-live', 'queue', 'activity'].map(id => ({ id, visible: true })));
  await sheet.getByRole('button', { name: 'Undo last change', exact: true }).click();
  await sheet.getByText('Last change undone.', { exact: true }).waitFor();
  const undone = (await request('/api/workspace-tabs')).state.desk.sections;
  assert.deepEqual(undone, stored.desk.sections);
  await sheet.getByRole('button', { name: 'Close Arrange Desk', exact: true }).click();
  await until(async () => JSON.stringify(await rowTabs()) === JSON.stringify(customTabs), 'Undo puts Bills back first');
  pass('Reset to office default saves the office order with no personal choices; Undo last change puts the earlier saved layout back');

  // Labelled browser injections: a failed read keeps the last snapshot; a source that can't be read is a problem row.
  await panel.waitFor();
  await page.route('**/api/needs-you', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Needs you could not be checked. Refresh to try again.' }) }));
  injections.push('503 for GET /api/needs-you (failed read)');
  await page.evaluate(() => window.dispatchEvent(new Event('realbud:needs-you-stale')));
  await panel.getByRole('alert').getByText('Needs you could not be checked. Refresh to try again.', { exact: true }).waitFor();
  assert.equal(await rows.count(), 5, 'The last snapshot stays on screen');
  await panel.getByRole('alert').getByRole('button', { name: 'Try again', exact: true }).waitFor();
  await panel.getByRole('alert').scrollIntoViewIfNeeded();
  await shot('06-needs-you-read-failed-1280.png');
  await page.unroute('**/api/needs-you');
  await page.route('**/api/needs-you', async route => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...body, unavailable: [{ area: 'bills', reason: "Bills and calendar couldn't be checked." }] }) });
  });
  injections.push('GET /api/needs-you answered from the real service with Bills and calendar marked unavailable');
  await panel.getByRole('alert').getByRole('button', { name: 'Try again', exact: true }).click();
  const unreadable = rows.filter({ hasText: "Couldn't check Bills and calendar" });
  await unreadable.waitFor();
  assert.equal(await panel.getByRole('alert').count(), 0, 'A good read clears the error');
  assert.match(await unreadable.innerText(), /^Problem\s+Bills and calendar\s+Couldn't check Bills and calendar/);
  assert.equal(await page.getByText(/^Nothing (from your workflows|to review yet)/).count(), 0);
  await deskRow.getByRole('button', { name: 'Bills and calendar, 1 needs you, 1 problem', exact: true }).waitFor();
  await shot('07-needs-you-unavailable-1280.png');
  await page.unroute('**/api/needs-you');
  await unreadable.getByRole('button', { name: 'Try again', exact: true }).click();
  await unreadable.waitFor({ state: 'detached' });
  await deskRow.getByRole('button', { name: 'Bills and calendar', exact: true }).waitFor();
  pass('Labelled injections: a failed read keeps the last rows with the error and Try again; a source that cannot be read is a Problem row "Couldn\'t check Bills and calendar" with Try again, never an empty list, and its tab carries a "!"; Try again reads the real service again');

  for (const [width, height] of [[1280, 900], [768, 1024], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await panel.scrollIntoViewIfNeeded();
    await noPageScroll();
    const strip = await deskRow.evaluate(element => {
      const centers = [...element.querySelectorAll('button')].filter(button => button.getBoundingClientRect().width > 0).map(button => { const box = button.getBoundingClientRect(); return box.top + box.height / 2; });
      return { spread: Math.max(...centers) - Math.min(...centers), overflow: getComputedStyle(element).overflowX, scrolls: element.scrollWidth > element.clientWidth, cue: element.hasAttribute('data-more-end'), mask: getComputedStyle(element).maskImage };
    });
    assert.ok(strip.spread < 4 && strip.overflow === 'auto', `One tab line at ${width}px (${JSON.stringify(strip)})`);
    if (strip.scrolls) assert.ok(strip.cue && strip.mask.includes('gradient'), `A visible fade at the overflowing edge at ${width}px (${JSON.stringify(strip)})`);
    if (width === 390) assert.ok(strip.scrolls, 'The tab strip scrolls sideways at 390px');
    await shot(`08-desk-tasks-${width}.png`);
  }
  await openArrange();
  await sheet.waitFor();
  await noPageScroll();
  await shot('09-arrange-desk-390.png');
  await sheet.getByRole('button', { name: 'Close Arrange Desk', exact: true }).click();
  pass('At 1280, 768 and 390 px the page never scrolls sideways; the Desk tabs stay on one line that scrolls in its own strip at 390 px with a fade at the edge, and the Arrange Desk sheet fits');
  assert.deepEqual(errors, []);
  pass('Zero renderer page errors');
} catch (cause) {
  failure = cause instanceof Error ? cause.stack : String(cause);
  await page?.screenshot({ path: join(output, 'failure.png'), animations: 'disabled' }).catch(() => {});
  console.error(failure);
} finally {
  await browser?.close().catch(() => {});
  if (child?.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(5000)]); if (child.exitCode === null) child.kill('SIGKILL'); }
  connector.close();
  rmSync(temp, { recursive: true, force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure,
    layer: 'Built React UI (scratch build) in headless Chrome against a real disposable local service; fictional Gmail connector and deterministic worker; fictional data', checks, screenshots, injections, errors, failure: failure ?? null,
    ...(failure ? { diagnostic: logs.slice(-3000) } : {}),
    limits: ['Needs you items come from a fictional mail fixture (open conversations and one incomplete scan); bills, bank and scheduled-job items are not produced here.',
      'The failed read and the unreadable source are browser injections, labelled above; the service itself answered normally.',
      'Not a packaged app, installed-device or live Gmail check; no customer acceptance.'] }, null, 2) + '\n');
  if (failure) process.exitCode = 1;
}
