// Actual local HTTP service and renderer, with fictional retained instructions.
// Seeded history is a fixture, not evidence of 100 past customer approvals.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE.');
if (process.platform === 'win32' || process.getuid?.() === 0) throw new Error('This filesystem fault fixture needs a non-root POSIX account.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'rb-skill-history-')), data = join(temp, 'data');
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/skill-history-2026-09-22/gui-source'));
mkdirSync(data, { mode: 0o700 }); mkdirSync(output, { recursive: true });
const executable = process.env.REALBUD_QA_EXECUTABLE || process.execPath, resources = process.env.REALBUD_QA_RESOURCES;
if (!!resources !== !!process.env.REALBUD_QA_EXECUTABLE) throw new Error('Specify both compiled resources and executable.');
const entry = resources ? join(resources, 'server/bootstrap.js') : join(root, 'server/bootstrap.ts');
let child, closed, browser, page, context, origin, token, lockedDirectory, logs = '';
const checks = [], errors = [], denied = [], wait = ms => new Promise(r => setTimeout(r, ms));
const hash = value => createHash('sha256').update(value).digest('hex');
const journalPath = join(data, 'customer-packs.json'), journal = () => JSON.parse(readFileSync(journalPath, 'utf8'));
const card = () => page.getByRole('region', { name: 'Customer workflow pack setup', exact: true });
async function stop(signal = 'SIGTERM') {
  if (page && !page.isClosed()) await page.goto('about:blank');
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill(signal); const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  try { await closed; } finally { clearTimeout(timer); }
}
async function start({ holdWrite = false } = {}) {
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(r => reserve.close(r)); origin = `http://127.0.0.1:${port}`;
  child = spawn(executable, [...(holdWrite ? ['--import', join(temp, 'hold-archive.mjs')] : []), entry], { cwd: resources || root,
    env: { ...serviceSmokeEnv({ executable, home: temp, data, scratch: temp, port }), REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', REALBUD_HERMES_CLI: join(temp, 'worker.mjs'), OMB_STATIC_DIR: resources ? join(resources, 'ui') : join(root, 'dist') }, stdio: ['ignore', 'pipe', 'pipe'] });
  closed = new Promise((r, j) => { child.once('close', r); child.once('error', j); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { logs = (logs + b).slice(-80000); });
  let ready = false;
  for (let i = 0; i < 150; i++) { if (child.exitCode !== null || child.signalCode) break; try { if ((await (await fetch(origin + '/api/health', { signal: AbortSignal.timeout(500) })).json()).pid === child.pid) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, logs); token = (await (await fetch(origin + '/api/session')).json()).token;
}
async function request(path, method = 'GET', body, expected = 200) {
  const response = await fetch(origin + path, { method, signal: AbortSignal.timeout(35000), headers: { 'content-type': 'application/json', 'x-realbud-session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json(); if (expected !== null) assert.equal(response.status, expected, `${path}: ${JSON.stringify(value)}`);
  return expected === null ? { status: response.status, body: value } : value;
}
async function open() { await page.goto(origin + '/#/schedule'); await card().waitFor(); }
async function settled() { await page.waitForFunction(() => document.querySelector('[aria-label="Customer workflow pack setup"]')?.getAttribute('aria-busy') === 'false'); }
try {
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } } }), { mode: 0o600 });
  writeFileSync(join(temp, 'worker.mjs'), `#!${process.execPath}\nif(process.argv.includes('--version'))console.log('Hermes Agent v0.21.3 (2026.9.14)');else{console.error('Fixture does not admit reasoning');process.exitCode=1;}\n`, { mode: 0o700 });
  writeFileSync(join(temp, 'hold-archive.mjs'), `import {createRequire,syncBuiltinESMExports} from 'node:module';const fs=createRequire(import.meta.url)('node:fs/promises'),open=fs.open;fs.open=async function(path,...args){const h=await open.call(this,path,...args);if(String(path).includes('customer-skill-history/')&&String(path).endsWith('.tmp')){const write=h.writeFile.bind(h);h.writeFile=async function(value,...options){const bytes=Buffer.from(value);await write(bytes.subarray(0,Math.max(1,Math.floor(bytes.length/2))),...options);process.stdout.write('REALBUD_QA_SKILL_PARTIAL_WRITE_HELD\\n');await new Promise(()=>{});};}return h;};syncBuiltinESMExports();`, { mode: 0o600 });
  await start(); assert.equal((await fetch(origin + '/api/customer-packs')).status, 401);
  const pack = await request('/api/customer-packs/office-core/export'), preview = await request('/api/customer-packs/preview', 'POST', { pack });
  await request('/api/customer-packs/install', 'POST', { pack, expectedDigest: preview.digest });
  const skillId = pack.skills[0].id, profile = join(data, 'hermes/profiles/property');
  const native = join(profile, 'skills', `realbud-office-core-${skillId}`, 'SKILL.md'), baseline = readFileSync(native, 'utf8');
  const route = `/api/customer-packs/office-core/skills/${skillId}`;
  await stop(); const saved = journal();
  const versions = Array.from({ length: 100 }, (_, i) => { const content = i === 0 ? baseline : baseline + `\nFictional reviewed retention revision ${i + 1}.\n`; return { revision: i + 1, content, digest: hash(content), createdAt: '2026-09-21T00:00:00.000Z', reason: i === 0 ? 'Published pack baseline' : `Fictional retained revision ${i + 1}` }; });
  saved.installs['office-core'].overrides = { [skillId]: { activeRevision: 100, versions } };
  writeFileSync(journalPath, JSON.stringify(saved), { mode: 0o600 }); writeFileSync(native, versions.at(-1).content, { mode: 0o600 });
  await start();
  browser = await chromium.launch({ headless: true }); context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', r => { if (new URL(r.request().url()).origin === origin) return r.continue(); denied.push(r.request().url()); return r.abort(); });
  await context.addInitScript(() => { if (location.protocol === 'http:') localStorage.setItem('realbud.first-run-done', '1'); });
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message)); await open();
  const historyCard = () => card().getByRole('article', { name: `${pack.skills[0].name} instruction history`, exact: true });
  const archiveRegion = () => card().getByRole('region', { name: 'Review instruction history archival', exact: true });
  const revertRegion = () => card().getByRole('region', { name: 'Review instruction revert', exact: true });
  async function showHistory() { const toggle = card().getByText('Instruction revision history and revert', { exact: true }); if (!(await historyCard().isVisible())) await toggle.click(); await historyCard().waitFor(); }
  async function refresh() { await card().getByRole('button', { name: 'Refresh setup checks', exact: true }).click(); await settled(); await showHistory(); }
  const summary = async () => (await request('/api/customer-packs/skill-proposals')).skillHistories.find(item => item.packId === pack.id && item.skillId === skillId);
  const override = () => journal().installs[pack.id].overrides[skillId];
  const confirmBody = p => ({ expectedInstalledDigest: p.installedDigest, expectedInstalledRevision: p.installedRevision, expectedActiveDigest: p.activeDigest, expectedActiveRevision: p.activeRevision, expectedHead: p.head, expectedPreviewDigest: p.previewDigest });
  const stage = async (id, content) => {
    const pending = join(profile, 'pending/skills'); mkdirSync(pending, { recursive: true, mode: 0o700 });
    writeFileSync(join(pending, id + '.json'), JSON.stringify({ id, subsystem: 'skills', action: 'edit', summary: 'Fictional reviewed retention improvement', origin: 'background_review', created_at: new Date().toISOString(), payload: { action: 'edit', name: `realbud-office-core-${skillId}`, content, replace_all: false } }), { mode: 0o600 });
    return (await request('/api/customer-packs/skill-proposals')).proposals.find(item => item.id === id);
  };
  const proposalBody = p => ({ id: p.id, pendingDigest: p.pendingDigest, currentDigest: p.currentDigest, decision: 'approve' });
  const first = (await request('/api/recipes')).recipes.find(item => item.id === pack.recipes[0].id);
  await request('/api/recipes', 'POST', { draft: { ...first, schedule: { time: '23:59', weekdays: [(new Date().getDay() + 1) % 7] }, expectedRevision: first.revision } }, 201);
  let approved = (await request('/api/recipes')).recipes.find(item => item.id === first.id);
  await request(`/api/recipes/${first.id}`, 'PATCH', { expectedRevision: approved.revision, planApproved: true, status: 'active' });
  const planBytes = readFileSync(join(data, 'recipes.json')), bookBytes = readFileSync(join(data, 'desk.json')), activeBytes = readFileSync(native);
  const unchanged = () => { assert.deepEqual(readFileSync(native), activeBytes); assert.deepEqual(readFileSync(join(data, 'recipes.json')), planBytes); assert.deepEqual(readFileSync(join(data, 'desk.json')), bookBytes); };
  const newText = baseline + '\nFictional approved revision after retained history.\n';
  const pending = await stage('1234abcd', newText);
  assert.ok(pending); await request('/api/customer-packs/skill-proposals/review', 'POST', proposalBody(pending), 409); unchanged();
  const defaultReview = await request('/api/customer-packs/skill-proposals');
  assert.ok(defaultReview.revisions.every(item => !Object.hasOwn(item, 'content')));
  assert.equal((await summary()).hotRevisions, 100);
  checks.push('Legacy 100-revision fixture is readable; proposal 101 is held without changing active instructions, approved scheduled plan or saved work; default history has no full instruction text.');
  await refresh(); await historyCard().getByRole('button', { name: 'Review instruction archival', exact: true }).click();
  await archiveRegion().waitFor(); assert.equal(await archiveRegion().getByRole('button', { name: 'Archive reviewed instruction history', exact: true }).isEnabled(), false);
  const archival = await request(route + '/archive-preview', 'POST', {}), archiveBody = confirmBody(archival);
  assert.equal(archival.archive.length, 98); assert.equal(archival.keep.length, 2); unchanged();
  await archiveRegion().scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'instruction-archive-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await archiveRegion().scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await page.screenshot({ path: join(output, 'instruction-archive-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  lockedDirectory = join(data, 'customer-skill-history', pack.id); mkdirSync(lockedDirectory, { recursive: true, mode: 0o700 }); chmodSync(lockedDirectory, 0o500);
  await archiveRegion().getByRole('checkbox').check(); await archiveRegion().getByRole('button', { name: 'Archive reviewed instruction history', exact: true }).click(); await settled();
  assert.ok((await summary()).pendingArchive); assert.equal(override().versions.length, 100); unchanged();
  chmodSync(lockedDirectory, 0o700); lockedDirectory = undefined;
  await stop(); await start(); await open(); await showHistory();
  await historyCard().getByRole('button', { name: 'Resume instruction archival', exact: true }).waitFor();
  let lostBody;
  await page.route('**' + route + '/resume-archive', async intercepted => { lostBody = intercepted.request().postDataJSON(); const response = await intercepted.fetch(); assert.equal(response.status(), 200); await intercepted.abort('failed'); }, { times: 1 });
  await historyCard().getByRole('button', { name: 'Resume instruction archival', exact: true }).click(); await settled();
  assert.ok(lostBody); assert.equal((await summary()).pendingArchive, null); assert.equal(override().versions.length, 2); assert.equal(override().archiveHead.revisions, 98); assert.equal(journal().version, 2); unchanged();
  assert.equal(await historyCard().getByRole('button', { name: 'Resume instruction archival', exact: true }).count(), 0);
  const firstHead = override().archiveHead.digest;
  await request(route + '/resume-archive', 'POST', lostBody); assert.equal(override().archiveHead.digest, firstHead); unchanged();
  assert.equal(readdirSync(join(data, 'customer-skill-history', pack.id)).filter(name => name.endsWith('.json')).length, 1);
  checks.push('Rendered archival requires explicit review; real EACCES preserves the full hot history and saved intent. Cold restart plus lost-response recovery commits one 98-revision archive and keeps active bytes, plan approval/schedule and saved work unchanged.');
  await refresh(); await card().getByText('Review active revision 100 and proposed text', { exact: true }).click();
  await card().getByRole('button', { name: 'Apply reviewed instructions and pause plans', exact: true }).click(); await settled();
  assert.equal(override().activeRevision, 101); assert.equal(override().archiveHead.digest, firstHead); assert.equal(readFileSync(native, 'utf8'), newText);
  const afterNew = readFileSync(journalPath); await request(route + '/archive', 'POST', archiveBody, null); assert.deepEqual(readFileSync(journalPath), afterNew);
  approved = (await request('/api/recipes')).recipes.find(item => item.id === first.id); assert.equal(approved.status, 'shadow'); assert.equal(approved.approvedRevision, null); assert.equal(approved.schedule, null);
  await showHistory(); await historyCard().getByRole('button', { name: 'Browse saved revisions', exact: true }).click(); await settled();
  let pages = 1;
  while (!(await historyCard().getByRole('button', { name: 'Review revert to revision 1', exact: true }).count())) { assert.ok(pages < 8); await historyCard().getByRole('button', { name: 'Show older revisions', exact: true }).click(); await settled(); pages++; }
  assert.ok(pages > 1); await historyCard().getByRole('button', { name: 'Review revert to revision 1', exact: true }).click(); await revertRegion().waitFor();
  assert.equal(await revertRegion().getByRole('button', { name: 'Confirm reviewed revert and pause plans', exact: true }).isEnabled(), false);
  assert.ok((await revertRegion().innerText()).includes(baseline.trim()));
  await revertRegion().scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'archived-instruction-revert-desktop.png') });
  const firstPage = await request(route + '/history', 'POST', {});
  let lastPage = firstPage;
  while (lastPage.nextCursor) lastPage = await request(route + '/history', 'POST', { installationRevision: lastPage.installationRevision, head: lastPage.head, sourceDigest: lastPage.sourceDigest, cursor: lastPage.nextCursor });
  const target = lastPage.revisions.find(item => item.revision === 1);
  const selected = { installationRevision: lastPage.installationRevision, head: lastPage.head, sourceDigest: lastPage.sourceDigest, revision: target.revision, digest: target.digest };
  const stale = await request(route + '/revert-preview', 'POST', selected); assert.equal(stale.proposed, baseline);
  const nextProposal = await stage('2345bcde', newText + '\nSecond fictional reviewed change.\n'); await request('/api/customer-packs/skill-proposals/review', 'POST', proposalBody(nextProposal));
  const beforeStale = readFileSync(journalPath); await request(route + '/revert', 'POST', { ...stale.selection, expectedReviewDigest: stale.reviewDigest }, 409); assert.deepEqual(readFileSync(journalPath), beforeStale);
  await revertRegion().getByRole('checkbox').check(); await revertRegion().getByRole('button', { name: 'Confirm reviewed revert and pause plans', exact: true }).click(); await settled();
  assert.equal(await revertRegion().count(), 0); assert.equal(override().activeRevision, 102);
  await showHistory(); await historyCard().getByRole('button', { name: 'Browse saved revisions', exact: true }).click(); await settled();
  for (let i = 0; i < 8 && !(await historyCard().getByRole('button', { name: 'Review revert to revision 1', exact: true }).count()); i++) { await historyCard().getByRole('button', { name: 'Show older revisions', exact: true }).click(); await settled(); }
  await historyCard().getByRole('button', { name: 'Review revert to revision 1', exact: true }).click(); await revertRegion().getByRole('checkbox').check();
  await revertRegion().getByRole('button', { name: 'Confirm reviewed revert and pause plans', exact: true }).click(); await settled();
  assert.equal(override().activeRevision, 103); assert.equal(readFileSync(native, 'utf8'), baseline); assert.equal(override().archiveHead.digest, firstHead); assert.equal(override().versions.length, 5);
  approved = (await request('/api/recipes')).recipes.find(item => item.id === first.id); assert.equal(approved.approvedRevision, null); assert.equal(approved.schedule, null);
  checks.push('Real native proposal 101 preserves the archive head. Paged UI opens full archived baseline; stale confirmation after revision 102 is rejected and refreshed. Fresh confirmation appends revision 103 with plans and schedules held.');
  await stop(); await start({ holdWrite: true });
  const secondPreview = await request(route + '/archive-preview', 'POST', {}), secondBody = confirmBody(secondPreview);
  assert.equal(secondPreview.archive.length, 3);
  const crashRequest = request(route + '/archive', 'POST', secondBody, null).catch(error => ({ error: String(error) }));
  for (let i = 0; i < 100 && !logs.includes('REALBUD_QA_SKILL_PARTIAL_WRITE_HELD'); i++) await wait(100);
  assert.ok(logs.includes('REALBUD_QA_SKILL_PARTIAL_WRITE_HELD'), logs.slice(-3000));
  assert.ok(journal().installs[pack.id].skillArchiveIntent); assert.equal(override().versions.length, 5); assert.equal(override().archiveHead.digest, firstHead);
  await stop('SIGKILL'); await crashRequest;
  await start(); await open(); await showHistory(); await page.setViewportSize({ width: 390, height: 844 });
  await historyCard().getByRole('button', { name: 'Resume instruction archival', exact: true }).waitFor();
  await historyCard().scrollIntoViewIfNeeded(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await page.screenshot({ path: join(output, 'instruction-recovery-mobile.png') });
  await historyCard().getByRole('button', { name: 'Resume instruction archival', exact: true }).click(); await settled();
  assert.equal(override().versions.length, 2); assert.equal(override().activeRevision, 103); assert.equal(override().archiveHead.batches, 2); assert.equal(override().archiveHead.revisions, 101); assert.equal(readFileSync(native, 'utf8'), baseline);
  const files = readdirSync(join(data, 'customer-skill-history', pack.id)); assert.equal(files.filter(name => name.endsWith('.json')).length, 2); assert.ok(files.every(name => !name.endsWith('.tmp')));
  const observed = []; let cursorPage = await request(route + '/history', 'POST', {});
  for (;;) { assert.ok(cursorPage.revisions.length <= 20); assert.ok(cursorPage.revisions.every(item => !Object.hasOwn(item, 'content'))); observed.push(...cursorPage.revisions.map(item => item.revision)); if (!cursorPage.nextCursor) break; cursorPage = await request(route + '/history', 'POST', { installationRevision: cursorPage.installationRevision, head: cursorPage.head, sourceDigest: cursorPage.sourceDigest, cursor: cursorPage.nextCursor }); }
  assert.deepEqual(observed, Array.from({ length: 103 }, (_, i) => 103 - i));
  const finalHead = override().archiveHead.digest; await stop(); await start(); assert.equal((await summary()).head, finalHead); assert.equal(readFileSync(native, 'utf8'), baseline); assert.deepEqual(readFileSync(join(data, 'desk.json')), bookBytes);
  checks.push('Actual SIGKILL during a partial immutable archive write leaves hot history and old head intact. Cold mobile UI recovery creates one second batch, removes only its owned temporary file, and returns all 103 unique revisions across bounded pages after another restart.');
  assert.deepEqual(errors, []); assert.deepEqual(denied, []);
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ checkedAt: new Date().toISOString(), layer: resources ? 'actual packaged HTTP service and renderer on macOS' : 'actual source HTTP service and compiled renderer on macOS', fixture: '100 explicitly seeded fictional retained revisions, two actual staged proposals, one actual reviewed archived revert; no model or customer data', checks, browserErrors: errors, deniedExternalRequests: denied, final: { activeRevision: override().activeRevision, hotRevisions: override().versions.length, ...override().archiveHead }, limits: ['No Windows installation or device proof', 'No live Hermes model, provider account or customer acceptance'], cleanup: 'Owned browser/service closed and disposable workspace removed in finally' }, null, 2));
  console.log(JSON.stringify({ output, checks, errors, denied }, null, 2));
} catch (error) { writeFileSync(join(output, 'failure.log'), logs + '\n' + String(error)); throw error; }
finally { if (lockedDirectory && existsSync(lockedDirectory)) chmodSync(lockedDirectory, 0o700); await browser?.close(); await stop(); rmSync(temp, { recursive: true, force: true }); }
