// REI sign-in wait: a W1 bank import reaches REI while the work browser is not
// signed in. Bud hands REI Cloud's sign-in page to the person and waits; the
// other loops (W4 maintenance checks, W3 morning priorities) run and finish
// meanwhile; a service restart mid-wait keeps the run waiting at sign-in (not
// lost, not failed); after the person signs in the same run carries on by
// itself and uploads exactly once.
// Real source service + built UI on the FICTIONAL Austin demo office
// (scripts/seed-austin-demo.mjs): loopback fakes for Gmail, Redbark and the
// model, the fictional REI-style portal, and the lab's "handover" action, which
// runs the real sign-in handover (server/browser-sign-in.ts) over a tab that
// follows the portal's address. The person is simulated by this script.
//
//   REALBUD_UI_DIR=<scratch vite build> PLAYWRIGHT_MODULE=... CHROME_EXECUTABLE=... QA_OUTPUT=<fresh dir> node scripts/qa-rei-signin-wait.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { primeBrowserSession } from './local-session.mjs';
import { seed, startAustinDemo } from './seed-austin-demo.mjs';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT || join(root, `outputs/rei-signin-wait-${new Date().toISOString().slice(0, 10)}`));
assert.ok(!existsSync(output), `Choose a fresh QA_OUTPUT; existing evidence at ${output} is preserved.`);
mkdirSync(output, { recursive: true });
const demoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'realbud-rei-signin-wait-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const checks = [], errors = [], denied = [], shots = [];
const pass = text => { checks.push(text); console.log(`PASS ${text}`); };
let demo, browser, context, page, failure;

const request = (...args) => demo.request(...args);
const lab = action => request('/api/w1/lab', 'POST', { action });
const status = () => request('/api/w1/status');
const until = async (read, done, label, tries = 600) => { let value; for (let i = 0; i < tries; i++) { value = await read(); if (done(value)) return value; await wait(100); } throw new Error(`${label}: ${JSON.stringify(value)}`); };
const settle = () => until(status, s => !s.working || s.ask, 'bank import settles');
const waitingForSignIn = () => until(status, s => s.working && s.signIn && !s.ask, 'bank import waits for REI sign-in');
/** The simulated person answers every ask with Allow. */
async function allowAll() {
  const tools = []; let now = await settle();
  while (now.ask) { tools.push(now.ask.tool); await request(`/api/w1/runs/${now.run.id}/answer`, 'POST', { requestId: now.ask.requestId, allowed: true }); now = await settle(); }
  return { now, tools };
}
/** One loop run through its route, as Schedule's Run now sends it; resolves when it stops running. */
async function runLoop(id) {
  const loop = (await request('/api/loops')).loops.find(l => l.id === id);
  assert.ok(loop, `loop ${id}`);
  const { run } = await request(`/api/loops/${id}/run`, 'POST', { requestId: randomUUID(), expectedRevision: loop.revision }, 201);
  return until(async () => (await request('/api/loops')).runs.find(r => r.id === run.id), r => r && !['queued', 'running'].includes(r.status), `${id} run`);
}
const strip = () => page.getByRole('region', { name: 'Bank import', exact: true });
const handover = () => page.getByRole('region', { name: 'Sign in to REI Cloud', exact: true });
async function openBankJob() {
  await page.goto(`${demo.base}/#/desk`);
  await page.getByRole('button', { name: /^Schedule\b/ }).first().click();
  await page.getByRole('button', { name: 'Open job: Bank reference review', exact: true }).click();
  await strip().waitFor();
}
async function capture(name, locator) {
  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    await page.setViewportSize({ width, height });
    await locator.scrollIntoViewIfNeeded();
    if (width === 390) assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal page scroll at 390px');
    const file = `${name}-${width}.png`; await page.screenshot({ path: join(output, file), animations: 'disabled' }); shots.push(file);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
}

try {
  demo = await startAustinDemo({ demoRoot });
  await lab('handover');
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, demo.base, demo.token);
  // The test restart moves the service to a new port (the app keeps a fixed one),
  // so the previous service origin is still this office, not an outside site.
  const ownOrigins = new Set([demo.base]);
  await context.route('**/*', route => { const origin = new URL(route.request().url()).origin; if (origin === demo.base || ownOrigins.has(origin)) return route.continue(); denied.push(origin); return route.abort(); });
  page = await context.newPage(); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => errors.push(error.message));

  // ── 1. Pull and review through the API, then continue to REI (signed out) ──
  await request('/api/w1/runs/start', 'POST', {});
  let now = await settle();
  assert.equal(now.run.step, 'review', JSON.stringify([now.note, now.run.attention]));
  const runId = now.run.id, batchId = now.run.fetch.batchId;
  const saved = await request(`/api/bank-reference/${batchId}`);
  const decisions = saved.value.batch.rows.map(row => {
    const ref = /FT-[A-Z0-9]+/.exec(`${row.narrative ?? ''} ${row.reference ?? ''}`)?.[0];
    const property = seed.properties.find(p => p.tenant.reiTenantRef === ref);
    assert.ok(property, `fictional tenant reference in ${row.narrative}`);
    return { rowId: row.id, action: 'assign', propertyId: property.code, reason: 'Fictional reference matches the tenant directory' };
  });
  await request(`/api/bank-reference/${batchId}/review`, 'POST', { revision: saved.revision, decisions });
  now = await status();
  await request(`/api/w1/runs/${runId}/advance`, 'POST', { expectedRevision: now.run.revision });
  now = await waitingForSignIn();
  assert.equal(now.run.id, runId); assert.equal(now.run.step, 'sign_in'); assert.equal(now.run.outcome, null);
  const handovers = (await request(`/api/browser/sign-in?threadId=${encodeURIComponent(now.signIn)}`)).handovers;
  assert.equal(handovers.length, 1, JSON.stringify(handovers));
  assert.deepEqual([handovers[0].site, handovers[0].state], ['REI Cloud', 'waiting']);
  assert.equal((await lab('status')).uploads, 0);
  await openBankJob();
  await strip().getByText('Waiting for you to sign in to REI Cloud', { exact: true }).waitFor();
  await handover().getByText('Sign in to REI Cloud here. Bud carries on when you\'re signed in.', { exact: true }).waitFor();
  await handover().getByRole('button', { name: 'Done signing in to REI Cloud', exact: true }).waitFor();
  await handover().getByRole('button', { name: 'Stop signing in to REI Cloud', exact: true }).waitFor();
  await capture('w1-waiting-for-rei-sign-in', strip());
  pass(`Signed out at REI: run ${runId} waits at sign-in with the "Sign in to REI Cloud" handover (Done and Stop) in Schedule; nothing uploaded`);

  // ── 2. Other loops keep running while W1 waits ──
  const maintenance = await runLoop('maintenance-review');
  // Partial here means only hand-reviewed bills were compared (no weekly bills run yet); the run finished.
  assert.ok(['completed', 'partial'].includes(maintenance.status) && maintenance.finishedAt, JSON.stringify(maintenance));
  assert.match(maintenance.detail ?? '', /findings to review/, JSON.stringify(maintenance));
  const morning = await runLoop('inbound-triage');
  assert.ok(['completed', 'awaiting-approval', 'partial'].includes(morning.status) && morning.finishedAt, JSON.stringify(morning));
  const mail = await request('/api/mail-workspace');
  assert.ok(mail.counts.total >= seed.mailbox.triage.length, JSON.stringify(mail.counts));
  now = await status();
  assert.ok(now.working && now.signIn && now.run.id === runId && now.run.step === 'sign_in', JSON.stringify(now));
  assert.equal((await lab('status')).uploads, 0);
  pass(`While W1 waited: W4 maintenance checks ${maintenance.status} (${maintenance.detail}); W3 morning priorities ${morning.status} with ${mail.counts.total} items; W1 still waiting, nothing uploaded`);

  // ── 3. Restart the service mid-wait: the run is still there, waiting at sign-in ──
  await demo.stop();
  demo = await startAustinDemo({ demoRoot });
  ownOrigins.add(demo.base);
  await lab('handover');
  await primeBrowserSession(context, demo.base, demo.token);
  now = await status();
  assert.equal(now.run.id, runId); assert.equal(now.run.step, 'sign_in'); assert.equal(now.run.outcome, null);
  assert.equal(now.run.fetch.batchId, batchId); assert.equal(now.working, false); assert.equal(now.run.upload, null);
  await openBankJob();
  await strip().getByText('Ready to check REI', { exact: true }).waitFor();
  await capture('w1-after-restart', strip());
  pass('Service restart mid-wait: the same run is still at sign-in with its review and nothing uploaded (not lost, not failed); Schedule offers Continue');

  // ── 4. Continue: the handover opens again; the person signs in; the run carries on by itself, uploads once ──
  await strip().getByRole('button', { name: 'Continue', exact: true }).click();
  now = await waitingForSignIn();
  await handover().waitFor();
  await lab('sign-in'); // the person signs in on the fictional portal's own page
  const { now: atHandoff, tools: uploadAsks } = await allowAll();
  assert.equal(atHandoff.run.id, runId);
  assert.equal(atHandoff.run.step, 'handoff', JSON.stringify([atHandoff.note, atHandoff.run.attention]));
  assert.equal(uploadAsks.filter(t => t === 'browser_upload').length, 1, `upload asked once: ${uploadAsks}`);
  await lab('process'); // the person processes the receipts in REI
  await request(`/api/w1/runs/${runId}/posting`, 'POST', { expectedRevision: atHandoff.run.revision, outcome: 'posted' });
  const { now: done } = await allowAll();
  assert.equal(done.run.id, runId); assert.equal(done.run.outcome, 'imported', JSON.stringify([done.note, done.run.attention]));
  const portal = await lab('status');
  assert.equal(portal.uploads, 1, 'exactly one upload');
  assert.ok(portal.effects.every(effect => effect === 'upload'), 'Bud pressed nothing that posts');
  const posted = demo.ledger.filter(r => r.status === 'posted').length;
  assert.deepEqual(done.readback, { accepted: posted, rejected: 0, pending: 0, warnings: [] });
  await openBankJob();
  await strip().getByText('Last import confirmed', { exact: false }).first().waitFor();
  await capture('w1-imported-after-sign-in', strip());
  pass(`After sign-in the same run carried on without another Continue: upload approved once, 1 upload in REI, read back ${posted}/${posted}, imported`);

  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  pass('No renderer errors and no off-origin browser requests');
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  console.error(failure);
  if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close().catch(() => {});
  const logs = demo?.logs?.() ?? '';
  await demo?.stop().catch(() => {});
  rmSync(demoRoot, { recursive: true, force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ ok: !failure, at: new Date().toISOString(), checks, shots, errors, denied,
    layer: 'Real local source service and built UI on the fictional Austin demo office; real sign-in handover over the fictional REI-style portal',
    limits: [
      'Fictional REI-style portal, Gmail connector, Redbark and model: no REI Cloud, Gmail, bank or model evidence.',
      'The sign-in tab is a lab stand-in that reports the portal\'s address; the real work browser tab was not opened.',
      'The person (review, sign-in, approvals, processing in REI) is simulated by this script.',
      'The 15-minute handover limit was not exercised: when it passes the run stays at sign-in and asks the person to Continue.',
      'Source service only: no packaged, installed or Windows evidence.'],
    ...(failure ? { failure, serviceLog: logs.slice(-8000) } : {}) }, null, 2) + '\n');
}
if (failure) process.exitCode = 1;
