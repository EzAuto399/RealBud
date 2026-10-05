// Refresh from REI: Bud reads the office's REI Tenants and Suppliers lists
// itself through RealBud's work browser, read only, and the person saves each
// preview. Signed out → the "Sign in to REI Cloud" handover → the person signs
// in → approval cards for the report's Export Only choice and the download →
// a preview whose row count matches the list's "N records" footer → Save. The
// saved tenant list then puts the REI Reference in a bank file's last column;
// the saved supplier list lets W4's sender check recognise a listed sender.
// Stop mid-run leaves both directories unchanged; a repeat refresh with no
// change in REI adds no revision.
// Real source service + built UI on the FICTIONAL Austin demo office
// (scripts/seed-austin-demo.mjs) with the fictional REI-style portal behind the
// real browser runtime, broker and recipe runner (server/testing/w1-lab.ts).
// The REI export location in the pack is a PLACEHOLDER until the real one is
// mapped; the fictional portal follows the pack's names. The person is
// simulated by this script.
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
  await page.locator('.desk-other-work > summary').click();
  await page.getByRole('group', { name: 'Other work', exact: true }).getByRole('button', { name: 'Bills and calendar', exact: true }).click();
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
/** The simulated person allows each approval card in the panel: the report's Export Only choice, then the download. */
async function allowInPanel(panel, list) {
  const card = panel.getByRole('group', { name: 'Approval for REI', exact: true });
  await card.getByText('Allow Bud to choose Export Only on REI\'s report?', { exact: true }).waitFor();
  await card.getByRole('button', { name: 'Allow', exact: true }).click();
  await card.getByText(`Allow Bud to download REI's ${list}?`, { exact: true }).waitFor();
  return card;
}

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

  // ── 2. Sign in → approval cards → preview counts match REI's footer → Save ──
  await lab('sign-in');
  const card = await allowInPanel(tenantsPanel(), 'tenant list');
  await capture('tenants-download-approval', tenantsPanel());
  await card.getByRole('button', { name: 'Allow', exact: true }).click();
  const preview = tenantsPanel().getByRole('group', { name: 'REI tenant list preview', exact: true });
  await preview.getByText('9 tenants ready to save · 1 skipped', { exact: true }).waitFor();
  await preview.getByText("10 rows in REI's export · matches the 10 records REI lists", { exact: true }).waitFor();
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
  pass(`After sign-in Bud read the Tenants list (footer 10 records), the person allowed Export Only and the download, the preview showed 10 rows = 10 records, 9 tenants, 1 skipped with its reason (sha256 ${now.run.preview?.file.sha256.slice(0, 12) ?? 'shown'}…), and Save stored revision 1`);

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
  const again = await allowInPanel(tenantsPanel(), 'tenant list');
  await again.getByRole('button', { name: 'Allow', exact: true }).click();
  await preview.getByText('No changes since the last save.', { exact: true }).waitFor();
  await preview.getByRole('button', { name: 'Confirm', exact: true }).click();
  await tenantsPanel().getByText('The tenant list in REI matches the saved one. Nothing changed.', { exact: true }).waitFor();
  assert.equal((await status()).tenants.revision, 1);
  pass('A repeat refresh with nothing changed in REI previewed "No changes" and kept revision 1');

  // ── 5. Stop mid-run (at the approval card) leaves both directories unchanged ──
  const before = await status();
  await openMaintenance();
  await suppliersPanel().getByRole('button', { name: 'Refresh supplier list from REI', exact: true }).click();
  const stopCard = suppliersPanel().getByRole('group', { name: 'Approval for REI', exact: true });
  await stopCard.waitFor();
  await stopCard.getByRole('button', { name: 'Stop', exact: true }).click();
  await suppliersPanel().getByText('Stopped. Nothing was saved.', { exact: true }).waitFor();
  now = await status();
  assert.deepEqual([now.run.phase, now.tenants.revision, now.suppliers.revision], ['stopped', before.tenants.revision, before.suppliers.revision]);
  assert.equal((await request('/api/supplier-directory')).directory.revision, before.suppliers.revision);
  pass(`Stop at the approval card ended the supplier refresh: tenant list revision ${now.tenants.revision} and supplier list revision ${now.suppliers.revision} unchanged`);

  // ── 6. Supplier refresh → preview → Save → W4 recognises a listed sender ──
  await suppliersPanel().getByRole('button', { name: 'Refresh supplier list from REI', exact: true }).click();
  const supplierCard = await allowInPanel(suppliersPanel(), 'supplier list');
  await supplierCard.getByRole('button', { name: 'Allow', exact: true }).click();
  const supplierPreview = suppliersPanel().getByRole('group', { name: 'REI supplier list preview', exact: true });
  await supplierPreview.getByText('5 suppliers ready to save · 1 skipped · 2 without email', { exact: true }).waitFor();
  await supplierPreview.getByText("5 rows in REI's export · matches the 5 records REI lists", { exact: true }).waitFor();
  await capture('suppliers-preview', suppliersPanel());
  await supplierPreview.getByRole('button', { name: 'Save supplier list', exact: true }).click();
  await suppliersPanel().getByText('Saved the supplier list from REI.', { exact: true }).waitFor();
  const directory = (await request('/api/supplier-directory')).directory;
  assert.equal(directory.revision, before.suppliers.revision + 1);
  assert.deepEqual(matchSender(directory, 'accounts@fictional-plumbing.test'), { kind: 'listed', supplierRef: 'FS-PLUMB' });
  assert.deepEqual(matchSender(directory, 'someone@unlisted.fictional.test'), { kind: 'unlisted' });
  await page.getByRole('region', { name: 'Maintenance checks' }).getByText(/^5 suppliers · 2 without email/).waitFor();
  pass(`Supplier refresh previewed 5 rows = 5 records (1 email skipped, 2 without email); Save stored revision ${directory.revision}; W4's sender check now lists accounts@fictional-plumbing.test as FS-PLUMB`);

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
      'Fictional REI-style portal: no REI Cloud evidence. The REI export location in the pack is a placeholder until the real one is mapped.',
      'The sign-in tab is a lab stand-in that reports the portal\'s address; the real work browser tab was not opened.',
      'The person (sign-in, approvals, Save) is simulated by this script.',
      'Source service only: no packaged, installed or Windows evidence.'],
    ...(failure ? { failure, serviceLog: logs.slice(-8000) } : {}) }, null, 2) + '\n');
}
if (failure) process.exitCode = 1;
