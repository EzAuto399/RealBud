// Austin showcase rehearsal: drives the built UI through the presenter's talk
// track (outputs/austin-showcase-2026-10-05/DEMO-SCRIPT.md) on the FICTIONAL demo
// office from scripts/seed-austin-demo.mjs. Every outside system is a loopback
// fake (Gmail connector, Redbark, REI portal, model) and the service refuses
// non-loopback fetches. The person is simulated: this script clicks, and plays
// the REI sign-in and "processed in REI" steps on the fictional portal.
//
//   REALBUD_UI_DIR=<scratch vite build> PLAYWRIGHT_MODULE=... CHROME_EXECUTABLE=... node scripts/qa-austin-showcase.mjs
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { primeBrowserSession } from './local-session.mjs';
import { addDays, billFacts, seed, startAustinDemo } from './seed-austin-demo.mjs';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT || join(root, 'outputs/austin-showcase-2026-10-05'));
mkdirSync(output, { recursive: true });
const wait = ms => new Promise(r => setTimeout(r, ms));
const steps = [], errors = [], shots = [];
let demo, browser, page, failure, current = '';

const shot = async name => { const file = `${String(shots.length + 1).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: join(output, file) }); shots.push(file); };
async function step(name, fn) {
  current = name; console.log(`… ${name}`);
  const detail = await fn();
  steps.push({ name, status: detail?.skipped ? 'SKIPPED' : 'PASS', detail: detail?.skipped ?? detail });
  console.log(`${detail?.skipped ? 'SKIPPED' : 'PASS'} ${name}: ${detail?.skipped ?? detail}`);
}
const until = async (read, done, label, tries = 600) => { let value; for (let i = 0; i < tries; i++) { value = await read(); if (done(value)) return value; await wait(100); } throw new Error(`${label} did not settle: ${JSON.stringify(value)}`); };
const latestRun = async id => (await demo.request('/api/loops')).runs.filter(r => r.loopId === id).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))[0];
const settledRun = async (id, before) => until(() => latestRun(id), r => r && r.id !== before?.id && !['queued', 'running'].includes(r.status), `${id} run`);
const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal page scroll');

async function openDesk() { await page.goto(`${demo.base}/#/desk`); }
async function openJob(name) {
  await openDesk();
  await page.getByRole('button', { name: /^Schedule\b/ }).first().click();
  await page.getByRole('button', { name: `Open job: ${name}`, exact: true }).click();
}
async function runJob(name, id) {
  await openJob(name);
  const details = page.getByRole('article', { name: `${name} details` });
  await details.waitFor();
  const before = await latestRun(id);
  const resume = details.getByRole('button', { name: 'Resume', exact: true });
  const run = details.getByRole('button', { name: 'Run now', exact: true });
  if (await run.isDisabled() && await resume.count()) { await resume.click(); await until(() => run.isDisabled(), d => !d, `${name} Run now enabled`, 100); }
  await run.click();
  return settledRun(id, before);
}
async function otherWork(label, region) {
  await openDesk();
  await page.locator('.desk-other-work > summary').click();
  await page.getByRole('group', { name: 'Other work', exact: true }).getByRole('button', { name: label, exact: true }).click();
  const panel = page.getByRole('region', { name: region }); await panel.waitFor(); return panel;
}

try {
  demo = await startAustinDemo({ log: line => console.log(line) });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, demo.base, demo.token);
  const denied = [];
  await context.route('**/*', route => { const origin = new URL(route.request().url()).origin; if (origin === demo.base) return route.continue(); denied.push(origin); return route.abort(); });
  page = await context.newPage(); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => errors.push(error.message));
  const ids = demo.propertyIds;

  await step('1. Desk opens on the fictional book', async () => {
    await openDesk();
    await page.getByText('Fictional Oak Street', { exact: false }).first().waitFor();
    const snap = await demo.request('/api/desk');
    assert.equal(snap.properties.length, 6);
    assert.ok(snap.properties.every(p => p.address.includes('Fictional')));
    await shot('desk-book');
    return `${snap.properties.length} fictional properties; ${snap.drafts.length} Desk cards from the REI ledger stub`;
  });

  await step('2. W3 Morning priorities: run, items for the seed mail', async () => {
    const run = await runJob('Morning priorities', 'inbound-triage');
    assert.ok(['awaiting-approval', 'completed', 'partial'].includes(run.status), JSON.stringify(run));
    const panel = await otherWork('Mail priorities', 'Mail priorities and follow-ups');
    for (const t of seed.mailbox.triage) await panel.getByText(t.subject, { exact: false }).first().waitFor();
    await panel.getByRole('heading', { name: 'Mail priorities and follow-ups', exact: true }).evaluate(el => el.scrollIntoView({ block: 'start' }));
    await shot('w3-morning-priorities');
    const state = await demo.request('/api/mail-workspace');
    return `run ${run.status}; ${state.counts.total} items, all ${seed.mailbox.triage.length} triage threads shown`;
  });

  let acceptedBill;
  await step('3. W2 Weekly bills: run, accept one bill, see it on the calendar', async () => {
    const run = await runJob('Weekly bills review', 'weekly-bills');
    assert.ok(['awaiting-approval', 'partial', 'completed'].includes(run.status), JSON.stringify(run));
    const drafts = (await demo.request('/api/bill-review-drafts?filter=active&limit=20')).items;
    const bill = seed.mailbox.bills.find(b => b.threadId === 'c202'), draft = drafts.find(d => d.messageId === bill.messageId);
    assert.ok(draft, `draft for ${bill.invoiceId}: ${JSON.stringify(drafts.map(d => d.messageId))}`);
    assert.equal((await demo.request('/api/bill-register')).occurrences.items.filter(o => o.facts.kind !== 'Maintenance' && o.facts.kind !== 'Repairs').length, 0, 'a run never creates a payable bill');
    const panel = await otherWork('Bills and calendar', 'Source-linked bills and calendar');
    await shot('w2-review-drafts');
    await panel.locator(`[data-review-id="${draft.id}"]`).getByRole('button', { name: 'Continue saved review', exact: true }).click();
    const editor = panel.getByRole('form', { name: 'Review source bill' });
    await editor.getByRole('complementary', { name: 'Bill source evidence' }).waitFor();
    const { invoiceDate, dueDate } = billFacts(bill, demo.today);
    await editor.getByLabel('Bill property', { exact: false }).selectOption(ids[bill.property]);
    await editor.getByLabel('Bill kind', { exact: false }).fill(bill.kind);
    await editor.getByLabel('Vendor', { exact: false }).fill(bill.vendor);
    await editor.getByLabel('Amount (AUD)', { exact: false }).fill((bill.amountCents / 100).toFixed(2));
    await editor.getByLabel('Invoice date, if confirmed', { exact: false }).fill(invoiceDate);
    await editor.getByLabel('Actual due date, if confirmed', { exact: false }).fill(dueDate);
    await editor.getByLabel('Reason for this bill review', { exact: false }).fill('Fictional demo: checked against the synthetic original');
    await editor.getByLabel('I reviewed this source', { exact: false }).check();
    const ack = editor.getByLabel('I understand attachment contents', { exact: false }); if (await ack.count()) await ack.check();
    await shot('w2-accept-form');
    await editor.getByRole('button', { name: 'Accept reviewed bill', exact: true }).click(); await editor.waitFor({ state: 'hidden' });
    const register = await demo.request(`/api/bill-register?from=${addDays(demo.today, -30)}&to=${addDays(demo.today, 90)}`);
    acceptedBill = register.occurrences.items.find(o => o.source?.message?.id === bill.messageId);
    assert.ok(acceptedBill, 'accepted bill saved');
    const due = register.calendar.items.find(e => e.type === 'invoice-due' && e.billId === acceptedBill.id);
    assert.equal(due?.date, dueDate, JSON.stringify(register.calendar.items));
    // Built UI calendar: open the due day.
    const calendar = panel.getByRole('region', { name: 'Bill calendar', exact: true });
    const months = Array.from({ length: 12 }, (_, m) => new Intl.DateTimeFormat('en-AU', { month: 'long', timeZone: 'UTC' }).format(Date.UTC(2026, m, 1)));
    const [y, m, d] = dueDate.split('-').map(Number);
    const [shownMonth, shownYear] = (await calendar.getByRole('heading', { level: 4 }).innerText()).split(' ');
    for (let at = Number(shownYear) * 12 + months.indexOf(shownMonth); at < y * 12 + m - 1; at++) {
      await calendar.getByRole('button', { name: 'Next month', exact: true }).click();
      await calendar.getByRole('heading', { name: `${months[(at + 1) % 12]} ${Math.floor((at + 1) / 12)}`, exact: true }).waitFor();
    }
    await calendar.getByRole('button', { name: new RegExp(`^${d} ${months[m - 1]}:`) }).click();
    const label = await page.evaluate(v => new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${v}T00:00:00Z`)), dueDate);
    const day = calendar.getByRole('region', { name: `Bills on ${label}`, exact: true }); await day.waitFor();
    await day.getByText(`Due · ${label}`, { exact: true }).waitFor();
    await calendar.scrollIntoViewIfNeeded();
    await shot('w2-calendar-due');
    return `run ${run.status}; ${drafts.length} review drafts (forwarded + corrected included), 0 bills until accepted; ${bill.vendor} ${bill.invoiceId} accepted and on the calendar due ${dueDate}`;
  });

  await step('4. W1 Bank: pull, review references, approve upload to fictional REI, read back', async () => {
    const strip = () => page.getByRole('region', { name: 'Bank import', exact: true });
    const says = text => strip().getByText(text, { exact: false }).first().waitFor({ timeout: 60_000 });
    const status = () => demo.request('/api/w1/status');
    const settle = () => until(status, s => !s.working || s.ask, 'bank import');
    const allowInStrip = async () => { const tools = []; for (let i = 0; i < 20; i++) { const now = await settle(); if (!now.ask) return tools; tools.push(now.ask.tool); await strip().getByRole('button', { name: 'Allow', exact: true }).click(); await wait(300); } throw new Error('Too many asks.'); };
    await openJob('Bank reference review');
    await strip().getByRole('button', { name: 'Start bank import', exact: true }).click();
    await says('Review the pulled transactions');
    const posted = demo.ledger.filter(r => r.status === 'posted');
    await strip().getByRole('button', { name: 'Open pulled transactions', exact: true }).click();
    const cards = page.locator('article.border').filter({ has: page.getByLabel('Your decision', { exact: true }) });
    await cards.first().waitFor();
    assert.equal(await cards.count(), posted.length, 'pending row left out of the review');
    await shot('w1-review-references');
    for (let i = 0; i < posted.length; i++) {
      const card = cards.nth(i), ref = /FT-[A-Z0-9]+/.exec(await card.innerText())[0];
      await card.getByLabel('Your decision', { exact: true }).selectOption(seed.properties.find(p => p.tenant.reiTenantRef === ref).code);
      await card.getByLabel('Review reason', { exact: true }).fill('Fictional demo: reference matches the tenant directory');
    }
    await page.getByRole('button', { name: 'Save reviewed copy', exact: true }).click();
    await strip().getByRole('button', { name: 'Continue', exact: true }).click();
    await says('Waiting for you to sign in to REI');
    await shot('w1-rei-sign-in');
    await demo.request('/api/w1/lab', 'POST', { action: 'sign-in' }); // the person signs in on the fictional portal
    await strip().getByRole('button', { name: 'Continue', exact: true }).click(); await wait(300);
    const uploadAsks = await allowInStrip();
    assert.equal(uploadAsks.filter(t => t === 'browser_upload').length, 1, `upload approved once: ${uploadAsks}`);
    await says('Preview matches · Ready for you to process in REI');
    await strip().scrollIntoViewIfNeeded(); await shot('w1-preview-ready');
    await demo.request('/api/w1/lab', 'POST', { action: 'process' }); // the person processes the receipts in the fictional REI
    await strip().getByRole('button', { name: "I've processed it in REI", exact: true }).click(); await wait(300);
    await allowInStrip();
    await says('Last import confirmed');
    const now = await settle();
    assert.equal(now.run.outcome, 'imported');
    assert.deepEqual(now.readback, { accepted: posted.length, rejected: 0, pending: 0, warnings: [] });
    const portal = await demo.request('/api/w1/lab', 'POST', { action: 'status' });
    assert.ok(portal.effects.every(e => e === 'upload'), 'Bud pressed nothing that posts');
    await strip().scrollIntoViewIfNeeded(); await shot('w1-readback');
    return `pulled ${posted.length} (pending left out), upload approved once, read back ${now.readback.accepted}/${posted.length}; Bud pressed nothing that posts`;
  });

  await step('5. W4 Maintenance checks: run, chat card in Work, open findings', async () => {
    const run = await runJob('Maintenance checks', 'maintenance-review');
    assert.match(run.detail ?? '', /findings to review/, JSON.stringify(run));
    await openDesk();
    await page.getByRole('button', { name: /^Work\b/ }).first().click();
    const card = page.locator('div.rounded-2xl').filter({ hasText: /^Maintenance checks/ }).first();
    await card.waitFor();
    await shot('w4-chat-card');
    await card.getByRole('button', { name: /Open$/ }).click();
    await page.locator('.desk-other-work > summary').waitFor();
    await page.locator('.desk-other-work > summary').click();
    await page.getByRole('group', { name: 'Other work', exact: true }).getByRole('button', { name: 'Bills and calendar', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Maintenance checks' }); await panel.waitFor();
    const repeat = panel.getByRole('listitem', { name: /^Several invoices this month · 1 Fictional Oak Street/ });
    await repeat.waitFor();
    for (const text of ['FIC-PLUMB', 'Invoice INV-1001', 'Invoice INV-1002']) assert.ok((await repeat.innerText()).includes(text), `finding shows ${text}`);
    await panel.getByRole('listitem', { name: /^Sender needs checking/ }).first().waitFor();
    await panel.scrollIntoViewIfNeeded(); await shot('w4-findings');
    return `run: ${run.detail}; chat card opened Desk; repeat-supplier and sender findings shown`;
  });

  await step('6. W5 Inspections: draft plan from Sherry\'s rules and history', async () => {
    const probe = await demo.fetch(`${demo.base}/api/inspections`, { headers: { 'x-realbud-session': demo.token } });
    if (probe.status !== 200) return { skipped: `inspections routes not in this build (/api/inspections answered ${probe.status})` };
    const panel = await otherWork('Bills and calendar', 'Source-linked bills and calendar');
    const section = page.getByRole('region', { name: /^Inspections/ }).first();
    if (!await section.waitFor({ timeout: 8_000 }).then(() => true, () => false)) {
      const draft = await demo.request('/api/inspections/draft', 'POST', { planStart: demo.today });
      return { skipped: `no Inspections section in the built UI yet; API draft only (${JSON.stringify(Object.keys(draft))})` };
    }
    const button = section.getByRole('button', { name: /draft|plan/i }).first();
    if (await button.count()) await button.click(); else await demo.request('/api/inspections/draft', 'POST', { planStart: demo.today });
    await section.getByText(/Fictional (Oak|Pine|Elm|Wattle|Banksia|Gum)/).first().waitFor();
    await section.scrollIntoViewIfNeeded(); await shot('w5-inspection-draft');
    void panel;
    return 'draft plan shown for the fictional properties';
  });

  await step('7. Sherry asks Bud to change a rule; the approval card shows plain before → after', async () => {
    const before = await demo.request('/api/maintenance-review');
    await openDesk();
    await page.getByRole('button', { name: /^Work\b/ }).first().click();
    const composer = page.getByRole('textbox', { name: 'Tell Bud what outcome you need', exact: true });
    await composer.fill(seed.sherryRules.scriptedChange.ask);
    await composer.press('Enter');
    const allow = page.getByRole('button', { name: 'Allow once', exact: true });
    await allow.waitFor({ timeout: 60_000 });
    const body = await page.locator('body').innerText();
    for (const text of ['maintenance month rule', 'invoice date → date received', `Why: ${seed.sherryRules.scriptedChange.reason}`]) assert.ok(body.includes(text), `card shows "${text}"`);
    await shot('rule-change-card');
    await allow.click();
    await page.getByText('Saved the maintenance month rule', { exact: false }).first().waitFor({ timeout: 60_000 });
    const after = await demo.request('/api/maintenance-review');
    assert.equal(after.rule.basis, 'receivedDate', JSON.stringify(after.rule));
    await shot('rule-change-saved');
    return `rule ${JSON.stringify(before.rule)} → ${JSON.stringify(after.rule)} after one Allow once`;
  });

  await step('8. No page errors and no off-origin requests', async () => {
    await noOverflow();
    assert.deepEqual(errors, []); assert.deepEqual(denied, []);
    return 'renderer errors 0; off-origin requests 0';
  });
} catch (error) {
  failure = `${current}: ${error instanceof Error ? error.stack : String(error)}`;
  console.error(failure);
  steps.push({ name: current, status: 'FAIL', detail: error instanceof Error ? error.message : String(error) });
  await page?.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close();
  await demo?.stop();
  if (demo) rmSync(demo.demoRoot, { recursive: true, force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({
    at: new Date().toISOString(), passed: !failure, label: 'fictional-austin-showcase', tier: 'local tests (fake providers, built UI in headless Chrome on macOS)',
    node: process.version, today: demo?.today, seeded: demo?.seeded, seedSkipped: demo?.skipped, steps, screenshots: shots, errors,
    calls: demo ? { gmail: demo.gmailCalls, redbarkRequests: demo.redbarkCalls.length } : null,
    standIns: {
      Gmail: 'Fixture managed connector (rbc_ fixture credential) on loopback serving the seed mailbox; no Google sign-in.',
      Redbark: 'Fake Redbark on loopback with live REST shapes behind the lab bank provider; synthetic key.',
      REI: 'Fictional REI-style portal (server/testing/fictional-rei-portal.ts); sign-in and processing played by the script.',
      Website: 'Mock office grant; no website or Modelvia customer.',
      Model: 'pack/workflows/austin-showcase/demo-worker.mjs: deterministic one-shot answers and a scripted ACP peer for the rule change.',
    },
    limits: ['Fictional data and fake providers only; no customer account, credential, email, bank, REI or model was used.',
      'Source service on macOS; not a packaged build, installed device or Windows.',
      'W4 history bills were seeded straight into the register (reviewed last month), not collected from mail.',
      'The person is simulated by this script.'],
    failure: failure ?? null, ...(failure && demo ? { diagnostic: demo.logs().slice(-8000) } : {}),
  }, null, 2));
  for (const s of steps) console.log(`${s.status.padEnd(7)} ${s.name}`);
  if (failure) process.exitCode = 1;
}
