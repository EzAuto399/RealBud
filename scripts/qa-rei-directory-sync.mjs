// Refresh from REI: Bud reads the office's REI Tenants and Suppliers lists
// itself through RealBud's work browser, read only, and the person saves each
// preview. Signed out → the "Sign in to REI Cloud" handover → the person signs
// in → Bud reads the list's own grid (the Tenants grid loads more rows as its
// content scrolls), with no report, approval card or download → a preview whose
// row count matches the list's "N records" footer → Save. The saved tenant list
// then puts the REI Reference in a bank file's last column; the saved supplier
// list lets W4's sender check recognise a listed sender. A read shorter than
// the footer cannot be saved; Stop mid-run leaves both directories unchanged; a
// repeat refresh with no change in REI adds no revision.
// Real source service + built UI on the FICTIONAL Austin demo office
// (scripts/seed-austin-demo.mjs) with the fictional REI-style portal behind the
// real browser runtime, broker and recipe runner (server/testing/w1-lab.ts).
// The fictional grids copy live REI's columns, footer and lazy Tenants loading
// (read-only look, 6 Oct 2026). The person is simulated by this script.
//
//   REALBUD_UI_DIR=<scratch vite build> PLAYWRIGHT_MODULE=... CHROME_EXECUTABLE=... QA_OUTPUT=<fresh dir> node scripts/qa-rei-directory-sync.mjs
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { primeBrowserSession } from './local-session.mjs';
import { startAustinDemo } from './seed-austin-demo.mjs';
import { matchSender } from '../shared/supplier-directory.ts';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE to an installed Playwright module.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT || join(root, `outputs/rei-directory-sync-${new Date().toISOString().slice(0, 10)}`));
assert.ok(!existsSync(output), `Choose a fresh QA_OUTPUT; existing evidence at ${output} is preserved.`);
mkdirSync(output, { recursive: true });
const demoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'realbud-rei-directory-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const checks = [], errors = [], denied = [], shots = [];
const pass = text => { checks.push(text); console.log(`PASS ${text}`); };
let demo, browser, page, failure;

const request = (...args) => demo.request(...args);
const lab = action => request('/api/w1/lab', 'POST', { action });
const status = () => request('/api/rei-directory/status');
const until = async (read, done, label, tries = 300) => { let value; for (let i = 0; i < tries; i++) { value = await read(); if (done(value)) return value; await wait(100); } throw new Error(`${label}: ${JSON.stringify(value)}`); };
const tenantsPanel = () => page.getByRole('region', { name: 'Refresh tenant list from REI', exact: true });
const suppliersPanel = () => page.getByRole('region', { name: 'Refresh supplier list from REI', exact: true });
async function openBankJob() {
  await page.goto(`${demo.base}/#/desk`);
  await page.getByRole('button', { name: /^Schedule\b/ }).first().click();
  await page.getByRole('button', { name: 'Open job: Bank reference review', exact: true }).click();
  await tenantsPanel().waitFor();
}
async function openMaintenance() {
  await page.goto(`${demo.base}/#/desk`);
  await page.getByRole('navigation', { name: 'Desk workspace', exact: true }).getByRole('button', { name: 'Bills and calendar', exact: true }).click();
  await page.getByRole('region', { name: 'Maintenance checks' }).waitFor();
  await suppliersPanel().waitFor();
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
/** A grid read asks nothing: the panel never shows an approval card. */
const noApprovalCard = async panel => assert.equal(await panel.getByRole('group', { name: 'Approval for REI', exact: true }).count(), 0, 'no approval card for a grid read');

try {
  demo = await startAustinDemo({ demoRoot });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, demo.base, demo.token);
  await context.route('**/*', route => { const origin = new URL(route.request().url()).origin; if (origin === demo.base) return route.continue(); denied.push(origin); return route.abort(); });
  page = await context.newPage(); page.setDefaultTimeout(30_000);
  page.on('pageerror', error => errors.push(error.message));
  await lab('handover'); // the real sign-in handover over the fictional portal's address

  // ── 1. Signed out: Refresh → "Sign in to REI Cloud" handover → the person signs in ──
  let now = await status();
  assert.equal(now.account, 'FICT1'); assert.equal(now.tenants.revision, 0);
  await openBankJob();
  await tenantsPanel().getByText('No tenant list saved from REI yet.', { exact: true }).waitFor();
  await tenantsPanel().getByRole('button', { name: 'Refresh tenant list from REI', exact: true }).click();
  now = await until(status, s => s.run?.signIn, 'tenant refresh waits for REI sign-in');
  const handover = page.getByRole('region', { name: 'Sign in to REI Cloud', exact: true });
  await tenantsPanel().getByText(/Waiting for you to sign in to REI Cloud/).waitFor();
  await handover.getByRole('button', { name: 'Done signing in to REI Cloud', exact: true }).waitFor();
  await handover.getByRole('button', { name: 'Stop signing in to REI Cloud', exact: true }).waitFor();
  await capture('tenants-sign-in-handover', tenantsPanel());
  assert.equal((await lab('status')).effects.length, 0);
  pass('Signed out at REI: Refresh from REI shows the "Sign in to REI Cloud" handover (Done and Stop) in the bank review; nothing pressed in REI');

  // ── 2. Sign in → Bud reads the whole Tenants grid → preview counts match REI's footer → Save ──
  await lab('sign-in');
  const preview = tenantsPanel().getByRole('group', { name: 'REI tenant list preview', exact: true });
  await preview.getByText('9 tenants ready to save · 1 skipped', { exact: true }).waitFor();
  await preview.getByText("10 rows read from REI's list · matches the 10 records REI lists", { exact: true }).waitFor();
  await preview.getByText(/^REI Tenants list \(read from the page\) · sha256 [a-f0-9]{16}…$/).waitFor();
  await noApprovalCard(tenantsPanel());
  await preview.getByText('9 new · 0 removed · 0 changed', { exact: true }).waitFor();
  now = await status();
  assert.deepEqual([now.run.preview.rows, now.run.preview.footer, now.run.preview.countMatches, now.run.preview.accepted], [10, 10, true, 9]);
  assert.match(now.run.preview.rejected[0].reason, /FT-KILO\) has no Property/);
  assert.match(now.run.preview.file.sha256, /^[a-f0-9]{64}$/);
  assert.equal(now.tenants.revision, 0, 'nothing saved before Save');
  await preview.getByText('Skipped rows · 1').click();
  await capture('tenants-preview', tenantsPanel());
  await preview.getByRole('button', { name: 'Save tenant list', exact: true }).click();
  await tenantsPanel().getByText('Saved the tenant list from REI.', { exact: true }).waitFor();
  now = await status();
  assert.deepEqual([now.tenants.revision, now.tenants.count], [1, 9]);
  await tenantsPanel().getByText(/^Saved: 9 tenants/).waitFor();
  const portal = await lab('status');
  assert.deepEqual(portal.effects, [], 'nothing pressed in REI');
  pass(`After sign-in Bud read every row of the Tenants grid (it renders 4 until its content scrolls) with no approval card or download: the preview showed 10 rows = 10 records, 9 tenants, 1 skipped with its reason, and Save stored revision 1`);

  // ── 3. The saved list is the bank batch's directory: REI Reference in the ANZ file's last column ──
  const anz = Buffer.from(`${demo.today.slice(8, 10)}/${demo.today.slice(5, 7)}/${demo.today.slice(0, 4)},"540.00",FICTIONAL PAYMENT 4470002,,,,,\n`);
  const batch = await request('/api/bank-reference', 'POST', { source: { filename: 'fictional-anz-directory.csv', bytesBase64: anz.toString('base64') }, columns: { date: '', amount: '', narrative: '', reference: '' }, dateFormat: 'DD/MM/YYYY', rules: [] });
  assert.ok(batch.value.batch.input.rules.some(rule => rule.reference === 'FT-BRAVO' && rule.propertyId === 'FP-02'), 'saved tenant list became the directory');
  assert.deepEqual(batch.value.batch.rows[0].candidates, ['FP-02']);
  const reviewed = await request(`/api/bank-reference/${batch.id}/review`, 'POST', { revision: batch.revision, decisions: [{ rowId: batch.value.batch.rows[0].id, action: 'import', propertyId: 'FP-02', reason: 'Fictional BPay reference matched the REI tenant list' }] });
  const exported = await request(`/api/bank-reference/${reviewed.id}/export`, 'POST', {});
  const csv = Buffer.from(exported.bytesBase64, 'base64').toString('utf8');
  assert.equal(csv.trim().split(',').at(-1), 'FT-BRAVO', csv);
  pass(`A fictional ANZ row paid with BPay ref 4470002 matched FP-02 from the saved REI tenant list, and the reviewed file carries the REI Reference in its last column: ${csv.trim()}`);

  // ── 4. Repeat refresh with no change in REI: no new revision ──
  await tenantsPanel().getByRole('button', { name: 'Refresh tenant list from REI', exact: true }).click();
  await preview.getByText('No changes since the last save.', { exact: true }).waitFor();
  await preview.getByRole('button', { name: 'Confirm', exact: true }).click();
  await tenantsPanel().getByText('The tenant list in REI matches the saved one. Nothing changed.', { exact: true }).waitFor();
  assert.equal((await status()).tenants.revision, 1);
  pass('A repeat refresh with nothing changed in REI previewed "No changes" and kept revision 1');

  // ── 5. A read shorter than REI's own record count is shown and cannot be saved ──
  await lab('short-export'); // the fictional grid shows 9 of the 10 rows its footer counts
  await tenantsPanel().getByRole('button', { name: 'Refresh tenant list from REI', exact: true }).click();
  await preview.getByText("9 rows read from REI's list · REI lists 10 records", { exact: true }).waitFor();
  await tenantsPanel().getByText("Bud read 9 rows but REI's list shows 10 records. Nothing can be saved from it; refresh again.", { exact: true }).waitFor();
  assert.equal(await preview.getByRole('button', { name: 'Save tenant list', exact: true }).isDisabled(), true, 'Save is disabled for a short read');
  await capture('tenants-short-read', tenantsPanel());
  await preview.getByRole('button', { name: 'Discard', exact: true }).click();
  await tenantsPanel().getByText('Stopped. Nothing was saved.', { exact: true }).waitFor();
  await lab('clear');
  assert.equal((await status()).tenants.revision, 1);
  pass('A Tenants read of 9 rows against REI\'s 10 records was shown with Save disabled; Discard kept revision 1');

  // ── 6. Stop mid-run (while Bud waits for sign-in) leaves both directories unchanged ──
  const before = await status();
  await lab('sign-out');
  await openMaintenance();
  await suppliersPanel().getByRole('button', { name: 'Refresh supplier list from REI', exact: true }).click();
  await until(status, s => s.run?.signIn, 'supplier refresh waits for REI sign-in');
  await suppliersPanel().getByText(/Waiting for you to sign in to REI Cloud/).waitFor();
  await suppliersPanel().getByRole('button', { name: 'Stop', exact: true }).click();
  await suppliersPanel().getByText('Stopped. Nothing was saved.', { exact: true }).waitFor();
  now = await status();
  assert.deepEqual([now.run.phase, now.tenants.revision, now.suppliers.revision], ['stopped', before.tenants.revision, before.suppliers.revision]);
  assert.equal((await request('/api/supplier-directory')).directory.revision, before.suppliers.revision);
  pass(`Stop mid-run ended the supplier refresh: tenant list revision ${now.tenants.revision} and supplier list revision ${now.suppliers.revision} unchanged`);

  // ── 7. Supplier refresh → preview → Save → W4 recognises a listed sender ──
  await lab('sign-in');
  await suppliersPanel().getByRole('button', { name: 'Refresh supplier list from REI', exact: true }).click();
  const supplierPreview = suppliersPanel().getByRole('group', { name: 'REI supplier list preview', exact: true });
  await supplierPreview.getByText('5 suppliers ready to save · 1 skipped · 2 without email', { exact: true }).waitFor();
  await supplierPreview.getByText("5 rows read from REI's list · matches the 5 records REI lists", { exact: true }).waitFor();
  await noApprovalCard(suppliersPanel());
  // Every seeded supplier is gone from REI's list: a big drop, saved only when the person confirms it.
  await supplierPreview.getByRole('alert').getByText("REI returned far fewer suppliers than before — check REI's Suppliers list before approving.", { exact: true }).waitFor();
  await supplierPreview.getByRole('list', { name: 'Suppliers added in REI' }).getByText('FS-PLUMB · Fictional Plumbing Co · accounts@fictional-plumbing.test', { exact: true }).waitFor();
  await capture('suppliers-preview', suppliersPanel());
  await supplierPreview.getByRole('button', { name: 'Save anyway', exact: true }).click();
  await suppliersPanel().getByText('Saved the supplier list from REI.', { exact: true }).waitFor();
  const directory = (await request('/api/supplier-directory')).directory;
  assert.equal(directory.revision, before.suppliers.revision + 1);
  assert.deepEqual(matchSender(directory, 'accounts@fictional-plumbing.test'), { kind: 'listed', supplierRef: 'FS-PLUMB' });
  assert.deepEqual(matchSender(directory, 'someone@unlisted.fictional.test'), { kind: 'unlisted' });
  await page.getByRole('region', { name: 'Maintenance checks' }).getByText(/^5 suppliers · 2 without email/).waitFor();
  pass(`Supplier refresh previewed 5 rows = 5 records (1 email skipped, 2 without email) and listed who was added; replacing every seeded supplier was held as a big drop until Save anyway stored revision ${directory.revision}; W4's sender check now lists accounts@fictional-plumbing.test as FS-PLUMB`);

  const effects = (await lab('status')).effects;
  assert.deepEqual(effects, [], `Bud pressed nothing in REI: ${effects}`);
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  pass('Nothing pressed in the fictional REI, no renderer errors and no off-origin browser requests');
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
    layer: 'Real local source service and built UI on the fictional Austin demo office; real browser runtime, broker, recipe runner and sign-in handover over the fictional REI-style portal',
    limits: [
      'Fictional REI-style portal: no REI Cloud evidence. Its lazy Tenants grid (4 rows, 4 more per scroll of its own content) models a read-only look at live REI; how many rows live REI loads per scroll is not modelled.',
      'The sign-in tab is a lab stand-in that reports the portal\'s address; the real work browser tab was not opened.',
      'The person (sign-in, Stop, Save) is simulated by this script.',
      'Source service only: no packaged, installed or Windows evidence.'],
    ...(failure ? { failure, serviceLog: logs.slice(-8000) } : {}) }, null, 2) + '\n');
}
if (failure) process.exitCode = 1;
