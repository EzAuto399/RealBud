import { readSessionToken, primeBrowserSession } from './local-session.mjs';
// W5 inspection planning: built React UI from REALBUD_UI_DIR against a real, disposable
// local service. Fictional sample book + fictional history from
// pack/workflows/austin-inspections/fixtures. Never reads ~/.realbud or dist/; never calls
// Zapier or Property Inspect (all non-local requests are aborted).
// Node 24, PLAYWRIGHT_MODULE, REALBUD_UI_DIR (scratch `vite build --outDir`), optional CHROME_EXECUTABLE.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to an installed Playwright module.');
assert.ok(process.env.REALBUD_UI_DIR, 'Set REALBUD_UI_DIR to a scratch `vite build --outDir` folder; dist/ is shared.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/inspections-2026-10-05'));
mkdirSync(output, { recursive: true });
const portfolio = JSON.parse(readFileSync(join(root, 'pack/workflows/austin-inspections/fixtures/synthetic-portfolio.json'), 'utf8'));
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'fictional-inspections-'));
const data = join(temp, 'data'); mkdirSync(data, { mode: 0o700 });
const checks = [], errors = [], screenshots = [], external = [];
let child, browser, page, failure, logs = '';
const wait = ms => new Promise(r => setTimeout(r, ms));
const pass = message => { checks.push(message); console.log(`PASS ${message}`); };
const shot = async name => { await page.screenshot({ path: join(output, name), animations: 'disabled', fullPage: false }); screenshots.push(name); };
const noOverflow = async () => assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'No horizontal document overflow');
const PLAN_START = '2026-10-05';
// Fictional rules in Sherry's shape. Capacity 2 (not her 5) so the fictional book exercises overflow; 10 Nov closed so a group must shift.
const RULES = { horizonMonths: 6, cycleMonths: 6, cycleBasis: 'completed', workingDays: [1, 2, 3, 4, 5], inspectors: ['fictional-inspector-A', 'fictional-inspector-B'],
  dayStart: '09:30', appointmentMinutes: 45, travelMinutes: 20, dailyCapacity: 2,
  closedDates: ['2026-11-10', ...Array.from({ length: 10 }, (_, i) => new Date(Date.UTC(2026, 11, 24 + i)).toISOString().slice(0, 10))] };

try {
  const listener = createServer().listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = listener.address().port; await new Promise(r => listener.close(r));
  const origin = `http://127.0.0.1:${port}`;
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver', displayName: 'Offline fixture' } } }), { mode: 0o600 });
  const worker = join(temp, 'worker.mjs');
  writeFileSync(worker, `#!${process.execPath}\nconsole.log('Hermes Agent v0.21.3 (2026.9.14)');\n`); chmodSync(worker, 0o755);
  child = spawn(process.execPath, [join(root, 'server/index.ts')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: temp, USERPROFILE: temp, REALBUD_DATA_DIR: data, REALBUD_HERMES_CLI: worker, OMB_PORT: String(port), OMB_STATIC_DIR: resolve(process.env.REALBUD_UI_DIR), ELECTRON_RUN_AS_NODE: '1', VITEST: 'true' } });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs = (logs + bytes).slice(-20_000); });
  let ready = false;
  for (let i = 0; i < 100 && child.exitCode === null; i++) { try { if ((await fetch(origin + '/api/health')).ok) { ready = true; break; } } catch {} await wait(200); }
  assert.ok(ready, logs.slice(-1500));
  const token = await readSessionToken(data);
  const call = async (path, method = 'GET', body) => {
    const res = await fetch(origin + path, { method, headers: { 'x-realbud-session': token, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const json = await res.json(); assert.ok(res.ok, `${method} ${path}: ${res.status} ${JSON.stringify(json)}`); return json;
  };
  assert.equal((await fetch(origin + '/api/inspections')).status, 401, 'The plan sits behind the owner session');

  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 940 }, reducedMotion: 'reduce' });
  await primeBrowserSession(context, origin, token);
  await context.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin === origin) return route.continue(); external.push(url.origin); return route.abort(); });
  page = await context.newPage(); page.setDefaultTimeout(15_000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin);
  await page.getByLabel('Your name', { exact: true }).fill('Fictional Inspections Reviewer');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Open the sample desk first', exact: true }).click();
  await page.getByRole('heading', { name: 'Desk', exact: true }).waitFor();

  // Fictional history from the fixture, laid onto the sample book's properties in order, plus one row no Desk property matches.
  const desk = (await call('/api/desk')).properties;
  assert.ok(desk.length >= 6, `Sample book has properties (${desk.length})`);
  // Fixture rows chosen to cover a 3-property area group (overflows capacity 2), an overdue visit (SYN-P10) and no history (SYN-P11).
  const picked = ['SYN-P01', 'SYN-P02', 'SYN-P03', 'SYN-P05', 'SYN-P10', 'SYN-P11', 'SYN-P08', 'SYN-P12'].map(id => portfolio.properties.find(p => p.id === id));
  const rows = desk.slice(0, picked.length).map((p, i) => {
    const f = picked[i];
    return [p.address, f.area, f.lastCompleted ?? '', f.lastPlanned ?? '', f.accessNote ?? ''];
  });
  rows.push(['99 Nowhere Lane, Fictionalville', 'Northvale', '2026-05-01', '', '']);
  const csv = ['Property address or id,Area,Last completed date,Last planned date,Access notes', ...rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','))].join('\n');
  const rulesState = await call('/api/inspection-rules');
  await call('/api/inspection-rules', 'PUT', { expectedRevision: rulesState.revision, rules: RULES });

  // Desk → Bills → Inspections.
  await page.getByRole('tablist', { name: 'Desk views', exact: true }).getByRole('tab', { name: /^Bills/ }).click();
  const panel = page.getByRole('region', { name: 'Inspections', exact: true });
  await panel.waitFor();
  await panel.getByText('Draft plan · not booked in Property Inspect').waitFor();
  await panel.getByText('fictional-inspector-A and fictional-inspector-B', { exact: false }).waitFor();
  pass('Desk → Bills shows Inspections with the "not booked in Property Inspect" label and the rules summary');

  // 1. Import history CSV through the file control: one unmatched row held, never guessed.
  await panel.locator('input[type="file"]').setInputFiles({ name: 'fictional-history.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
  await panel.getByText('Held from the last import · 1').waitFor();
  await panel.getByText('99 Nowhere Lane, Fictionalville · No Desk property has this id or exact address.', { exact: false }).waitFor();
  let view = await call('/api/inspections');
  assert.equal(view.history.unmatched.length, 1); assert.equal(Object.keys(view.history.records).length, rows.length - 1);
  pass(`History CSV imported: ${rows.length - 1} matched by exact address, 1 unmatched row held with its reason`);

  // 2. Draft respects closed days, weekends, capacity and inspectors.
  await panel.getByLabel('Plan from', { exact: true }).fill(PLAN_START);
  await panel.getByRole('button', { name: 'Draft plan', exact: true }).click();
  await panel.getByRole('list', { name: 'Draft plan by day', exact: true }).waitFor();
  view = await call('/api/inspections');
  const plan = () => view.plan.draft.plan;
  assert.ok(plan().appointments.length >= 4, `Draft has visits (${plan().appointments.length})`);
  const perDay = new Map();
  for (const a of plan().appointments) {
    assert.ok(!RULES.closedDates.includes(a.date), `No visit on closed ${a.date}`);
    assert.ok(RULES.workingDays.includes(new Date(`${a.date}T00:00:00Z`).getUTCDay()), `No weekend visit (${a.date})`);
    assert.ok(RULES.inspectors.includes(a.inspector), `Known inspector (${a.inspector})`);
    const k = `${a.date}|${a.inspector}`; perDay.set(k, (perDay.get(k) ?? 0) + 1);
  }
  assert.ok([...perDay.values()].every(n => n <= RULES.dailyCapacity), 'No inspector-day over capacity');
  assert.ok(plan().appointments.every(a => ['09:30', '10:35'].includes(a.time)), 'Times follow 09:30 + 45 min + 20 min travel');
  pass(`Draft of ${plan().appointments.length} visits: no closed days or weekends, ≤${RULES.dailyCapacity} per inspector-day, only the two rule inspectors, times 09:30/10:35`);

  // 3. Holds show plain reasons.
  const kinds = new Set(plan().holds.map(h => h.kind));
  assert.ok(kinds.has('overdue') && kinds.has('no-history'), `Overdue and no-history holds present (${[...kinds]})`);
  const holds = panel.getByRole('group', { name: 'Held for you', exact: true });
  await holds.getByText('Overdue since', { exact: false }).first().waitFor();
  await holds.getByText('No completed inspection date on file', { exact: false }).first().waitFor();
  pass(`Holds show reasons in the UI: ${[...kinds].join(', ')}`);
  await noOverflow(); await shot('01-draft-1440.png');

  // 4. Accept 3 via checkboxes; rerun keeps them.
  const picks = plan().appointments.filter(a => a.status === 'draft').slice(0, 3);
  for (const a of picks) await panel.locator(`[data-appointment-id="${a.id}"]`).getByRole('checkbox').check();
  await panel.getByRole('button', { name: 'Accept selected (3)', exact: true }).click();
  await panel.getByText('3 accepted into the plan.').waitFor();
  view = await call('/api/inspections');
  const accepted = picks.map(p => plan().appointments.find(a => a.id === p.id));
  assert.deepEqual(accepted.map(a => a.status), ['accepted', 'accepted', 'accepted']);
  await panel.getByRole('button', { name: 'Redraft plan', exact: true }).click();
  await panel.getByText('Draft plan updated.', { exact: false }).waitFor();
  view = await call('/api/inspections');
  for (const a of accepted) assert.deepEqual(plan().appointments.find(x => x.id === a.id), a, `Accepted ${a.id} unchanged on rerun`);
  pass('Accepted 3 by stable id; a rerun keeps all three exactly');

  // 5. Move one (keyboard-reachable form); rerun keeps it.
  const target = plan().appointments.find(a => a.status === 'draft');
  const row = panel.locator(`[data-appointment-id="${target.id}"]`);
  await row.getByRole('button', { name: /^Move / }).click();
  await row.getByLabel('New date', { exact: true }).fill('2026-11-11');
  await row.getByLabel('New time', { exact: true }).fill('14:00');
  await row.getByLabel('New time', { exact: true }).press('Enter');
  await panel.getByText('Visit moved.', { exact: false }).waitFor();
  await panel.getByRole('button', { name: 'Redraft plan', exact: true }).click();
  await panel.getByText('Draft plan updated.', { exact: false }).waitFor();
  view = await call('/api/inspections');
  assert.ok(plan().appointments.find(a => a.id === target.id && a.date === '2026-11-11' && a.time === '14:00' && a.status === 'manual'), 'Moved visit kept on rerun');
  await panel.locator(`[data-appointment-id="${target.id}"]`).getByText('Moved', { exact: true }).waitFor();
  pass(`Moved ${target.id} to 2026-11-11 14:00 with the keyboard; a rerun keeps it`);

  // 6. A move onto a closed day is refused with a plain reason.
  const other = plan().appointments.find(a => a.id !== target.id);
  const otherRow = panel.locator(`[data-appointment-id="${other.id}"]`);
  await otherRow.getByRole('button', { name: /^Move / }).click();
  await otherRow.getByLabel('New date', { exact: true }).fill('2026-12-24');
  await otherRow.getByRole('button', { name: 'Save move', exact: true }).click();
  await panel.getByText('The office is closed that day.').waitFor();
  pass('A move onto a closed day is refused: "The office is closed that day."');
  await panel.scrollIntoViewIfNeeded(); await shot('02-accepted-moved-1440.png');

  // 7. 390px: no horizontal scroll, controls still reachable.
  await page.setViewportSize({ width: 390, height: 844 });
  await panel.getByRole('button', { name: 'Redraft plan', exact: true }).waitFor();
  await noOverflow();
  const target44 = await panel.getByRole('button', { name: 'Redraft plan', exact: true }).boundingBox();
  assert.ok(target44.height >= 44, `44px targets (${target44.height})`);
  await panel.getByRole('button', { name: 'Redraft plan', exact: true }).scrollIntoViewIfNeeded(); await shot('03-plan-390.png');
  pass('At 390×844 the plan has no horizontal scroll and 44px targets');
  await page.setViewportSize({ width: 1440, height: 940 });

  // 8. Ask Bud to change opens Work with the rules attached.
  await panel.getByRole('button', { name: 'Ask Bud to change', exact: true }).click();
  await page.waitForURL(url => url.hash === '#/ask');
  pass('"Ask Bud to change" opens Work');

  assert.deepEqual(errors, [], 'No renderer page errors');
  assert.deepEqual([...new Set(external)].filter(o => !/^(data|blob):/.test(o)), [], 'No request left the local service');
  pass('Zero renderer page errors and no external requests');
} catch (error) {
  failure = error;
  if (page) await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
  console.error(error); console.error(logs.slice(-3000));
} finally {
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([once(child, 'exit'), wait(3000)]); }
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ topic: 'inspections', date: '2026-10-05', evidence: 'local tests (built UI against disposable local service, fictional data)',
    notCustomerProof: true,
    limits: ['Fictional sample book and fixture history, not Austin data', 'Fictional rules with capacity 2 (Sherry uses 5)', 'Source build, not a packaged or installed app',
      'Nothing booked or read from Property Inspect / Zapier; that integration needs Austin\'s account'], checks, screenshots, pageErrors: errors, failure: failure ? String(failure.message ?? failure) : null }, null, 2));
  rmSync(temp, { recursive: true, force: true });
}
if (failure) process.exit(1);
