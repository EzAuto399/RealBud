// W4 maintenance checks on the actual local HTTP service + built React UI.
// Fictional data only, in a throwaway home/data folder (never ~/.realbud). No
// mail, model, browser-worker or network call: reviewed bills are seeded straight
// into the private bill register (the W2 acceptance path is covered by
// qa-weekly-bills.mjs), then directory, loop, findings and Desk run over HTTP.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSessionToken, primeBrowserSession } from './local-session.mjs';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
import { completeFictionalOnboarding } from './qa-onboarding.mjs';
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud maintenance QA '));
const data = join(temp, 'data'), output = resolve(process.env.QA_OUTPUT || join(root, 'outputs/maintenance-review-2026-10-05'));
mkdirSync(data, { mode: 0o700 }); mkdirSync(output, { recursive: true });
const checks = [], errors = [], wait = ms => new Promise(r => setTimeout(r, ms));
const pass = text => { checks.push(text); console.log(`PASS ${text}`); };
const CSV = 'Reference,Description,Email\nFIC-PLUMB,Fictional Plumbing,accounts@fictional-plumbing.example\nFIC-ELEC,Fictional Electrical,office@fictional-electrical.example';
let child, browser, page, logs = '', failure, register;

// Reviewed bills go through SourceBillRegister.accept (same validation and
// duplicate holds as the Bills screen), in this process, against the QA data dir.
async function openRegister() {
  process.env.HOME = temp; process.env.REALBUD_DATA_DIR = data;
  const [{ SourceBillRegister }, { WorkflowDatabase }] = await Promise.all([import('../server/source-bills.ts'), import('../server/workflow-database.ts')]);
  return new SourceBillRegister(new WorkflowDatabase({ dir: data }), { dataDir: data });
}
let seq = 0;
// Gmail's own Authentication-Results stamp confirming the From domain (fictional selector, signature and IP).
const gmailPass = domain => `mx.google.com; dkim=pass header.i=@${domain} header.s=fictional2026 header.b=FICTIONAL; spf=pass (google.com: domain of bounce@${domain} designates 192.0.2.10 as permitted sender) smtp.mailfrom=bounce@${domain}; dmarc=pass (p=QUARANTINE sp=QUARANTINE dis=NONE) header.from=${domain}`;
function seed({ property, from, replyTo, auth, number, date, cents, work, ref = null, at, subject, kind = 'Maintenance', vendor = 'Fictional Plumbing' }) {
  const id = createHash('sha256').update(`fictional-${++seq}`).digest('hex').slice(0, 16);
  const authResults = auth === undefined ? gmailPass(from.replace(/^.*@|>.*$/g, '')) : auth;
  const source = { accountId: 'fictional-maintenance', receiptId: 'fictional-receipt', threadId: `thread${id}`,
    message: { id, at: at ?? Date.parse(`${date}T00:30:00Z`), from, subject, body: `Fictional invoice ${number} for ${work}.`, bodyTruncated: false, attachments: [], ...(replyTo ? { replyTo } : {}), ...(authResults ? { authResults } : {}) } };
  const facts = { propertyId: property, kind, vendor, amountCents: cents, currency: 'AUD', invoiceDate: date, dueDate: null, note: '',
    invoiceNumber: number, invoiceVersion: null, supplierReference: ref, workDescription: work };
  const body = { expectedSourceDigest: '', sourceReviewed: true, facts, reviewReason: 'Fictional QA review' };
  return { source, body };
}
async function accept(entry) {
  const { previewBillSource } = await import('../server/source-bills.ts');
  entry.body.expectedSourceDigest = previewBillSource(entry.source).digest;
  try { return register.accept(entry.body, entry.source, 'fictional-reviewer'); }
  catch (error) {
    if (error.code !== 'bill_duplicate_review_required') throw error;
    // A copy or reminder of a saved invoice: the reviewer confirms it explicitly, as in Bills.
    const check = register.duplicateCandidates({ expectedSourceDigest: entry.body.expectedSourceDigest, facts: entry.body.facts }, entry.source);
    assert.ok(check.candidates.every(c => c.match !== 'invoice-conflict') && check.reviewDigest);
    return register.accept({ ...entry.body, duplicateReview: { reviewDigest: check.reviewDigest } }, entry.source, 'fictional-reviewer');
  }
}

try {
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const base = `http://127.0.0.1:${port}`;
  const networkGuard = join(temp, 'network-guard.mjs');
  writeFileSync(networkGuard, 'globalThis.fetch=()=>{throw new Error("QA denied outbound fetch");};', { mode: 0o600 });
  child = spawn(process.execPath, ['--import', networkGuard, join(root, 'server/index.ts')], { cwd: root, env: { ...serviceSmokeEnv({ executable: process.execPath, home: temp, data, scratch: temp, port }), REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', OMB_STATIC_DIR: resolve(process.env.REALBUD_UI_DIR || join(root, 'dist')) }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-24000); });
  let ready = false; for (let i = 0; i < 150; i++) { if (child.exitCode !== null) break; try { if ((await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).json()).pid === child.pid) { ready = true; break; } } catch {} await wait(100); } assert.ok(ready, logs);
  const token = await readSessionToken(data);
  const request = async (path, method = 'GET', body, expected = 200, headers = {}) => { const res = await fetch(base + path, { method, signal: AbortSignal.timeout(60000), headers: { 'content-type': 'application/json', 'x-realbud-session': token, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await res.json(); assert.equal(res.status, expected, `${path}: ${JSON.stringify(value)}`); return value; };

  assert.equal((await fetch(base + '/api/supplier-directory')).status, 401);
  assert.equal((await fetch(base + '/api/maintenance-review')).status, 401);
  await request('/api/supplier-directory/import', 'POST', { csv: CSV, expectedRevision: 0 }, 415, { 'content-type': 'text/plain' });
  const imported = await request('/api/supplier-directory/import', 'POST', { csv: CSV, expectedRevision: 0 });
  assert.equal(imported.directory.suppliers.length, 2);
  await request('/api/supplier-directory/import', 'POST', { csv: CSV, expectedRevision: 0 }, 409);
  const aliased = await request('/api/supplier-directory/aliases', 'POST', { reference: 'FIC-PLUMB', email: 'Jobs@Fictional-Plumbing.example', expectedRevision: 1 });
  assert.deepEqual(aliased.directory.aliases.map(a => a.email), ['jobs@fictional-plumbing.example']);
  pass('Supplier directory routes require the owner session and JSON, import the fictional CSV, reject a stale revision and add an accepted alias');

  await completeFictionalOnboarding(request);
  const add = async address => (await request('/api/desk/properties', 'POST', { address, tenantName: 'Fictional Tenant', tenantPhone: '0400 000 000', weeklyRentCents: 50000 }, 201)).properties.find(p => p.address === address).id;
  const oak = await add('Fictional Oak Street'), pine = await add('Fictional Pine Street'), elm = await add('Fictional Elm Street');
  register = await openRegister();
  const plumb = 'Fictional Plumbing <accounts@fictional-plumbing.example>';
  for (const entry of [
    seed({ property: oak, from: plumb, number: 'INV-1001', date: '2026-09-03', cents: 18000, work: 'Fictional blocked kitchen drain cleared', subject: 'Fictional invoice INV-1001' }),
    seed({ property: oak, from: plumb, number: 'INV-1001', date: '2026-09-03', cents: 18000, work: 'Fictional blocked kitchen drain cleared', subject: 'Reminder: fictional invoice INV-1001', at: Date.parse('2026-09-24T00:30:00Z') }),
    seed({ property: oak, from: plumb, number: 'INV-1002', date: '2026-09-17', cents: 22000, work: 'Fictional hot water valve replaced', subject: 'Fictional invoice INV-1002' }),
    seed({ property: oak, from: 'Fictional Office <office@fictional-agency.example>', number: 'INV-1002', date: '2026-09-17', cents: 22000, work: 'Fictional hot water valve replaced', ref: 'FIC-PLUMB', subject: 'Fwd: Fictional invoice INV-1002' }),
    seed({ property: pine, from: plumb, number: 'INV-1003', date: '2026-09-20', cents: 15000, work: 'Fictional leaking tap washer', subject: 'Fictional invoice INV-1003' }),
    seed({ property: elm, from: 'office@fictional-electrical.example', number: 'INV-2001', date: '2026-09-11', cents: 30000, work: 'Fictional smoke alarm check', vendor: 'Fictional Electrical', subject: 'Fictional invoice INV-2001' }),
    seed({ property: elm, from: 'Fictional Sparks <new@fictional-sparks.example>', number: 'INV-3001', date: '2026-09-25', cents: 41000, work: 'Fictional switchboard repair', kind: 'Repairs', vendor: 'Fictional Sparks', subject: 'Fictional invoice INV-3001' }),
  ]) await accept(entry);
  assert.equal(register.counts().occurrences, 7);

  let loops = await request('/api/loops');
  const loop = () => loops.loops.find(l => l.id === 'maintenance-review');
  assert.equal(loop().enabled, false); assert.equal(loop().available, true);
  assert.equal(loop().schedule.time, '08:30'); assert.deepEqual(loop().schedule.weekdays, [1, 2, 3, 4, 5]);
  await request('/api/loops/maintenance-review/run', 'POST', {}, 400);
  const launch = async () => {
    loops = await request('/api/loops');
    const accepted = await request('/api/loops/maintenance-review/run', 'POST', { requestId: randomUUID(), expectedRevision: loop().revision }, 201);
    for (let i = 0; i < 300; i++) {
      loops = await request('/api/loops');
      const run = loops.runs.find(r => r.id === accepted.run.id);
      if (run && !['queued', 'running'].includes(run.status)) return run;
      await wait(100);
    }
    throw new Error('Maintenance checks did not settle');
  };
  pass('Maintenance checks loop is listed, available and off by default at weekdays 08:30, and a run needs its request id and revision');

  const first = await launch();
  assert.equal(first.status, 'partial', JSON.stringify(first)); assert.ok(!first.seenAt, 'first run must stay unseen to alert');
  assert.match(first.detail, /3 findings to review, 3 new or changed/); assert.match(first.detail, /Check is partial/);
  let review = await request('/api/maintenance-review');
  const byKind = kind => review.findings.filter(f => f.finding.kind === kind);
  const multiple = byKind('multiple-invoices'), sender = byKind('sender-verification');
  assert.equal(review.findings.length, 3);
  assert.equal(multiple.length, 1);
  assert.equal(multiple[0].finding.propertyId, oak); assert.equal(multiple[0].finding.supplierRef, 'FIC-PLUMB');
  assert.deepEqual(multiple[0].finding.invoices.map(i => [i.invoiceNumber, i.sourceIds.length]).sort(), [['INV-1001', 2], ['INV-1002', 2]]);
  pass('Two distinct September invoices from the approved FIC-PLUMB address for Oak Street create one multiple-invoices finding; the reminder and forwarded copy count once each');
  assert.ok(!review.findings.some(f => f.finding.propertyId === pine), 'Pine Street single invoice must not be grouped with Oak Street');
  pass('The same supplier\'s invoice for Pine Street stays separate and raises nothing on its own');
  assert.ok(!review.findings.some(f => f.finding.invoices.some(i => i.invoiceNumber === 'INV-2001')));
  assert.ok(!sender.some(f => ['accounts@fictional-plumbing.example', 'office@fictional-electrical.example'].includes(f.finding.senderEmail)));
  pass('Listed addresses (FIC-PLUMB, FIC-ELEC) that Gmail confirmed (DMARC/DKIM pass) match their suppliers and raise no sender finding');
  assert.deepEqual(sender.map(f => f.finding.senderEmail).sort(), ['new@fictional-sparks.example', 'office@fictional-agency.example']);
  assert.equal(sender.find(f => f.finding.senderEmail === 'new@fictional-sparks.example').finding.supplierRef, null);
  pass('An unlisted sender creates a sender-verification finding; the forwarder of a copy is flagged, not trusted');
  assert.equal(review.lastRun.coverage.complete, false); assert.ok(review.lastRun.gaps.length > 0);
  assert.ok(review.findings.every(f => f.finding.notes.some(n => /may be missing/.test(n))));
  pass('With no checked mailbox history the run is partial, saved gaps say so and every finding carries the coverage note');

  const second = await launch();
  assert.ok(second.seenAt, 'unchanged rerun must be quiet'); assert.match(second.detail, /3 findings to review\./);
  review = await request('/api/maintenance-review');
  assert.equal(review.findings.length, 3); assert.equal(review.lastRun.alerts, 0);
  pass('Rerun with unchanged bills creates no duplicate finding and no new alert (run saved as already seen)');

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, base, token);
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/#/desk');
  await page.getByRole('button', { name: /^Work\b/ }).first().click();
  const chatCard = page.locator('div.rounded-2xl').filter({ hasText: /^Maintenance checks/ }).filter({ hasText: '3 findings to review, 3 new or changed' });
  await chatCard.first().waitFor();
  assert.equal(await page.locator('div.rounded-2xl').filter({ hasText: /^Maintenance checks/ }).count(), 1, 'one chat card: the first run alerts, the unchanged rerun stays quiet');
  await page.screenshot({ path: join(output, 'chat-card.png') });
  await chatCard.getByRole('button', { name: /Open$/ }).click();
  await page.locator('.desk-more > summary').filter({ hasText: /^More$/ }).waitFor();
  pass('Bud posts one chat card for the new findings (none for the quiet rerun), and its Open button goes to Desk');
  await page.locator('.desk-more > summary').filter({ hasText: /^More$/ }).click();
  await page.getByRole('group', { name: 'More Desk tools', exact: true }).getByRole('button', { name: 'Arrange Desk', exact: true }).click();
  const arrange = page.getByRole('dialog', { name: 'Arrange Desk', exact: true });
  const showBills = arrange.getByLabel('Show Bills and calendar on my Desk', { exact: true });
  if (!await showBills.isChecked()) { await showBills.check(); await arrange.getByRole('button', { name: 'Save', exact: true }).click(); await arrange.getByText('Desk arrangement saved.', { exact: true }).waitFor(); }
  await arrange.getByRole('button', { name: 'Close Arrange Desk', exact: true }).click();
  await page.getByRole('navigation', { name: 'Desk workspace', exact: true }).getByRole('button', { name: 'Bills and calendar', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Maintenance checks' }); await panel.waitFor();
  await panel.getByText(/Partial check · bills from/).waitFor();
  const repeat = panel.getByRole('listitem', { name: 'Several invoices this month · Fictional Oak Street' });
  await repeat.waitFor();
  const repeatText = await repeat.innerText();
  for (const text of ['FIC-PLUMB · Fictional Plumbing', 'Invoice INV-1001', 'Invoice INV-1002', 'Fictional blocked kitchen drain cleared', 'Fictional hot water valve replaced', '2 copies counted once', 'Fwd: Fictional invoice INV-1002']) assert.ok(repeatText.includes(text), `missing ${text}`);
  assert.ok(repeatText.includes('$180.00') && repeatText.includes('$220.00'));
  await panel.getByRole('listitem', { name: 'Sender needs checking · Fictional Elm Street' }).waitFor();
  await page.screenshot({ path: join(output, 'findings-desktop.png'), fullPage: true });
  await panel.getByRole('button', { name: 'Mark seen: Several invoices this month · Fictional Oak Street', exact: true }).click();
  await panel.getByRole('button', { name: 'Mark seen: Several invoices this month · Fictional Oak Street', exact: true }).waitFor({ state: 'detached' });
  await panel.getByRole('button', { name: 'Dismiss: Sender needs checking · Fictional Elm Street', exact: true }).click();
  await panel.getByText('Dismissed · 1', { exact: true }).waitFor();
  review = await request('/api/maintenance-review');
  assert.equal(review.findings.find(f => f.finding.id === multiple[0].finding.id).state, 'seen');
  assert.equal(review.findings.find(f => f.finding.senderEmail === 'new@fictional-sparks.example').state, 'dismissed');
  await request('/api/maintenance-review/findings', 'PATCH', { id: multiple[0].finding.id, action: 'dismissed', expectedRevision: review.revision - 1 }, 409);
  pass('Desk Bills panel shows reason labels, property, supplier, dates, amounts, descriptions and sources side by side; Mark seen and Dismiss save, a stale change is refused');
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'findings-390.png'), fullPage: true });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'horizontal scroll at 390px');
  pass('Panel fits 390x844 without horizontal scroll');

  await accept(seed({ property: oak, from: plumb, number: 'INV-1004', date: '2026-09-28', cents: 9000, work: 'Fictional cracked basin trap', subject: 'Fictional invoice INV-1004' }));
  const third = await launch();
  assert.ok(!third.seenAt); assert.match(third.detail, /1 new or changed/);
  review = await request('/api/maintenance-review');
  const updated = review.findings.filter(f => f.finding.kind === 'multiple-invoices');
  assert.equal(updated.length, 1); assert.equal(updated[0].finding.id, multiple[0].finding.id);
  assert.equal(updated[0].finding.invoices.length, 3); assert.equal(updated[0].state, 'new');
  assert.equal(review.findings.find(f => f.finding.senderEmail === 'new@fictional-sparks.example').state, 'dismissed');
  pass('A third distinct invoice updates the same monthly finding, raises exactly one new alert and leaves the unchanged dismissed finding alone');

  // REI Suppliers export through the panel's import control: a blank-email supplier, a Xero-billing
  // supplier, and one email shared by two supplier records.
  await page.setViewportSize({ width: 1440, height: 1000 });
  const reiCsv = ['Reference,Description,Phone,Phone A/H,Mobile,Fax,Email,Address,Category',
    'FIC-PLUMB,Fictional Plumbing,07 0000 0001,,,,accounts@fictional-plumbing.example,"1 Fictional Rd, Synthetic",Plumbing',
    'FIC-ELEC,Fictional Electrical,,,,,office@fictional-electrical.example,,Electrical',
    'FIC-ROOF,"Fictional Roofing, Pty Ltd",,,,,"accounts@fictional-roofing.example; jobs@fictional-roofing.example",,Roofing',
    'FIC-LOCK,Fictional Locks,07 0000 0004,,,,,,Locksmith',
    'FIC-DUPE,Fictional Duplicate Electrical,,,,,office@fictional-electrical.example,,Electrical'].join('\r\n');
  await panel.getByLabel('Import REI suppliers (CSV)').setInputFiles({ name: 'fictional-rei-suppliers.csv', mimeType: 'text/csv', buffer: Buffer.from(reiCsv) });
  await panel.getByText('Imported 5 suppliers · 1 without email · 1 conflict.', { exact: true }).waitFor();
  await panel.getByRole('list', { name: 'Supplier list conflicts' }).getByText('Same email on two suppliers: FIC-DUPE, FIC-ELEC (office@fictional-electrical.example)').waitFor();
  const directory = await request('/api/supplier-directory');
  assert.equal(directory.directory.revision, 3); assert.deepEqual(directory.directory.aliases.map(a => a.email), ['jobs@fictional-plumbing.example']);
  assert.deepEqual(directory.directory.suppliers.find(s => s.reference === 'FIC-LOCK').emails, []);
  await panel.getByRole('heading', { name: /^Maintenance checks/ }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'supplier-import.png') });
  pass('The panel imports an REI-format Suppliers CSV with the revision check, shows imported / without-email / conflict counts and names the email shared by two supplier records');

  const xero = 'Fictional Roofing via Xero <messaging-service@post.xero.com>';
  for (const entry of [
    seed({ property: pine, from: xero, replyTo: 'Ben <accounts@fictional-roofing.example>', number: 'INV-4001', date: '2026-09-22', cents: 52000, work: 'Fictional roof leak sealed', vendor: 'Fictional Roofing', subject: 'Fictional invoice INV-4001 via Xero' }),
    seed({ property: elm, from: xero, replyTo: 'ben@fictional-roofing-billing.example', number: 'INV-4002', date: '2026-09-23', cents: 61000, work: 'Fictional gutter replacement', vendor: 'Fictional Roofing', subject: 'Fictional invoice INV-4002 via Xero' }),
    seed({ property: pine, from: xero, number: 'INV-4003', date: '2026-09-24', cents: 33000, work: 'Fictional ridge cap repair', vendor: 'Fictional Roofing', subject: 'Fictional invoice INV-4003 via Xero' }),
    // Forged: the listed FIC-PLUMB From address, but Gmail's stamp says DMARC failed and nothing was signed.
    seed({ property: elm, from: plumb, number: 'INV-5001', date: '2026-09-26', cents: 87000, work: 'Fictional urgent pipe replacement', subject: 'Fictional invoice INV-5001 (new bank details)',
      auth: 'mx.google.com; dkim=none; spf=softfail (google.com: domain of transitioning scam@fictional-evil.example does not designate 198.51.100.7 as permitted sender) smtp.mailfrom=scam@fictional-evil.example; dmarc=fail (p=NONE sp=NONE dis=NONE) header.from=fictional-plumbing.example' }),
  ]) await accept(entry);
  const fourth = await launch();
  assert.match(fourth.detail, /4 new or changed/, fourth.detail);
  review = await request('/api/maintenance-review');
  const senders = review.findings.filter(f => f.finding.kind === 'sender-verification' && f.state !== 'dismissed');
  const invoiceOf = number => senders.filter(f => f.finding.invoices.some(i => i.invoiceNumber === number));
  assert.equal(invoiceOf('INV-4001').length, 0, 'listed Reply-To on a Xero relay must not be flagged');
  assert.deepEqual(invoiceOf('INV-4002').map(f => [f.finding.senderEmail, f.finding.notes.includes('Sent via Xero for ben@fictional-roofing-billing.example.')]), [['ben@fictional-roofing-billing.example', true]]);
  assert.deepEqual(invoiceOf('INV-4003').map(f => f.finding.senderEmail), [`unclear sender: ${xero}`.toLowerCase()]);
  assert.deepEqual(invoiceOf('INV-2001').map(f => [f.finding.senderEmail, f.finding.reasons, f.finding.supplierRef]), [['office@fictional-electrical.example', ['conflicting-sender', 'supplier-unresolved'], null]]);
  assert.ok(review.lastRun.gaps.includes('Same email on two suppliers: FIC-DUPE, FIC-ELEC. Correct the supplier list.'));
  assert.deepEqual(invoiceOf('INV-5001').map(f => [f.finding.senderEmail, f.finding.reasons, f.finding.supplierRef, f.finding.notes.includes('Mail server did not confirm this sender, so it could be forged (DMARC fail, DKIM none).')]),
    [['accounts@fictional-plumbing.example', ['unverified-sender'], 'FIC-PLUMB', true]]);
  pass('A forged From of the listed FIC-PLUMB address (Gmail: DMARC fail, no DKIM) is not trusted: it raises a "Sender not verified" finding naming the failed check');
  pass('A Xero relay is checked on its Reply-To: a listed Reply-To raises nothing, an unlisted or missing Reply-To is flagged with a "Sent via Xero" note, and an invoice from the email shared by two suppliers is flagged as a conflict');
  await panel.getByRole('listitem', { name: 'Sender needs checking · Fictional Elm Street' }).filter({ hasText: 'Sent via Xero for ben@fictional-roofing-billing.example.' }).waitFor();
  const forgedCard = panel.getByRole('listitem', { name: 'Sender not verified · Fictional Elm Street' });
  await forgedCard.waitFor();
  assert.ok((await forgedCard.innerText()).includes('could be forged (DMARC fail, DKIM none)'));
  await panel.screenshot({ path: join(output, 'xero-and-conflict-findings.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'horizontal scroll at 390px after import');
  pass('The panel shows the Xero note and the "Sender not verified" finding, and still fits 390px');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(base + '/#/schedule');
  await page.getByText('Maintenance checks', { exact: false }).first().waitFor();
  await page.screenshot({ path: join(output, 'schedule.png'), fullPage: true });
  assert.deepEqual(errors, []);
  pass('Schedule lists Maintenance checks and the renderer recorded no page errors');
} catch (error) { failure = error instanceof Error ? error.stack : String(error); if (page) await page.screenshot({ path: join(output, 'failure.png'), fullPage: true }).catch(() => {}); }
finally {
  await browser?.close();
  if (child && child.exitCode === null && child.signalCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(4000)]); if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await Promise.race([once(child, 'exit'), wait(4000)]); } }
  const childExited = !child || child.exitCode !== null || child.signalCode !== null;
  if (childExited) rmSync(temp, { recursive: true, force: true }); else failure ??= 'Owned child did not exit; scratch preserved.';
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure,
    layer: 'Actual local HTTP app + built UI from source; fictional supplier list and reviewed bills; not live Gmail/customer/Windows proof', checks, errors,
    limits: ['Reviewed bills were seeded through SourceBillRegister.accept in the QA process, not through Gmail collection and the Bills review form.',
      'Reply-To and Gmail Authentication-Results headers were seeded on the saved messages (fictional values); Gmail header collection is unit-tested only, and real Gmail stamps are not checked here.',
      'No weekly bills review result exists, so coverage is partial by design; complete-coverage wording is unit-tested only.',
      'Daily weekdays 08:30, the calendar-month/invoice-date rule and the in-app alert destination are pending Sherry.',
      'Fictional data; Mac browser rendering only; no packaged build, Windows or customer acceptance.'],
    failure, ...(failure ? { diagnostic: logs } : {}) }, null, 2));
  if (failure) { console.error(failure); process.exitCode = 1; } else console.log(JSON.stringify({ output, checks }, null, 2));
}
