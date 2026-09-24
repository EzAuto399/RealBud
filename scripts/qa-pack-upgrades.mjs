// Actual service + rendered UI; disposable pack versions and filesystem failure.
// This is a local macOS source/compiled rehearsal, not live customer acceptance.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { serviceSmokeEnv } from './service-smoke-env.mjs';
if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE.');
if (process.platform === 'win32' || process.getuid?.() === 0) throw new Error('This filesystem fault fixture needs a non-root POSIX account.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'rb-pack-upgrades-')), data = join(temp, 'data');
mkdirSync(data, { mode: 0o700 });
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/pack-history-2026-09-22/gui-source'));
mkdirSync(output, { recursive: true });
const executable = process.env.REALBUD_QA_EXECUTABLE || process.execPath;
const resources = process.env.REALBUD_QA_RESOURCES;
if (!!resources !== !!process.env.REALBUD_QA_EXECUTABLE) throw new Error('Specify both compiled resources and executable.');
const entry = resources ? join(resources, 'server/bootstrap.js') : join(root, 'server/bootstrap.ts');
let child, childClosed, browser, context, page, origin, token, lockedDirectory, failure, logs = '', lostBody;
const checks = [], errors = [], denied = [];
const wait = ms => new Promise(r => setTimeout(r, ms));
async function stop() {
  if (!child || child.exitCode !== null || child.signalCode) return;
  child.kill('SIGTERM'); const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
  try { await childClosed; } finally { clearTimeout(timer); }
}
async function request(path, method = 'GET', body, expected = 200) {
  const r = await fetch(origin + path, { method, signal: AbortSignal.timeout(30000), headers: { 'content-type': 'application/json', 'x-realbud-session': token }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await r.json(); if (expected !== null) assert.equal(r.status, expected, `${path}: ${JSON.stringify(value)}`);
  return expected === null ? { status: r.status, body: value } : value;
}
async function start({ holdArchiveWrite = false } = {}) {
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(r => reserve.close(r)); origin = `http://127.0.0.1:${port}`;
  child = spawn(executable, [...(holdArchiveWrite ? ['--import', join(temp, 'hold-archive.mjs')] : []), entry], { cwd: resources || root,
    env: { ...serviceSmokeEnv({ executable, home: temp, data, scratch: temp, port }), REALBUD_MANAGED_SERVICE: '0', REALBUD_TEST_LAB: '1', REALBUD_HERMES_CLI: join(temp, 'worker.mjs'), OMB_STATIC_DIR: resources ? join(resources, 'ui') : join(root, 'dist') }, stdio: ['ignore', 'pipe', 'pipe'] });
  childClosed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { logs = (logs + b).slice(-100000); });
  let ready = false;
  for (let n = 0; n < 150; n++) { if (child.exitCode !== null || child.signalCode) break;
    try { if ((await (await fetch(origin + '/api/health', { signal: AbortSignal.timeout(500) })).json()).pid === child.pid) { ready = true; break; } } catch {} await wait(100); }
  assert.ok(ready, 'Fixture service did not become ready'); token = (await (await fetch(origin + '/api/session')).json()).token;
}
const installation = async () => (await request('/api/customer-packs')).installations.find(p => p.id === 'office-core');
const recipes = async () => (await request('/api/recipes')).recipes;
const card = () => page.getByRole('region', { name: 'Customer workflow pack setup', exact: true });
const change = () => page.getByRole('region', { name: 'Review pack version change', exact: true });
async function open() { await page.goto(origin + '/#/schedule'); await card().waitFor(); }
async function preview(pack) {
  await card().getByLabel('Preview a pack file', { exact: true }).setInputFiles({ name: 'fictional-pack.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(pack)) });
  await change().waitFor();
}
async function confirm(action) {
  await change().getByRole('checkbox').check(); await change().getByRole('button', { name: `Apply reviewed ${action}`, exact: true }).click();
}
async function settled() { await page.waitForFunction(() => document.querySelector('[aria-label="Customer workflow pack setup"]')?.getAttribute('aria-busy') === 'false'); }
try {
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } } }), { mode: 0o600 });
  writeFileSync(join(temp, 'worker.mjs'), `#!${process.execPath}\nconsole.log('Hermes Agent v0.21.3 (2026.9.14)');\n`, { mode: 0o700 });
  writeFileSync(join(temp, 'hold-archive.mjs'), `import { createRequire, syncBuiltinESMExports } from 'node:module';
const fs = createRequire(import.meta.url)('node:fs/promises');
const originalOpen = fs.open;
fs.open = async function(path, ...args) {
  const handle = await originalOpen.call(this, path, ...args);
  if (String(path).includes('customer-pack-history/') && String(path).endsWith('.tmp')) {
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async function(value, ...options) {
      const bytes = Buffer.from(value);
      await write(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))), ...options);
      process.stdout.write('REALBUD_QA_ARCHIVE_PARTIAL_WRITE_HELD\\n');
      await new Promise(() => {});
    };
  }
  return handle;
};
syncBuiltinESMExports();
`, { mode: 0o600 });
  await start();
  assert.equal((await fetch(origin + '/api/customer-packs')).status, 401);
  assert.equal((await fetch(origin + '/api/customer-packs/upgrade', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.route('**/*', route => { if (new URL(route.request().url()).origin === origin) return route.continue(); denied.push(route.request().url()); return route.abort(); });
  await context.addInitScript(() => localStorage.setItem('realbud.first-run-done', '1'));
  page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', e => errors.push(e.message)); await open();
  await card().getByRole('button', { name: 'Preview real estate office core pack', exact: true }).click();
  await card().getByRole('button', { name: 'Import reviewed pack', exact: true }).click(); await settled();
  assert.equal((await installation()).localReady, true);
  const pack = await request('/api/customer-packs/office-core/export'), original = structuredClone(pack), first = (await recipes()).find(r => r.id === pack.recipes[0].id);
  const baselineNative = readFileSync(join(data, 'hermes/profiles/property/skills', `realbud-office-core-${pack.skills[0].id}`, 'SKILL.md'), 'utf8');
  await request('/api/recipes', 'POST', { draft: { ...first, title: 'Fictional staff plan title', schedule: { time: '09:00', weekdays: [1] }, expectedRevision: first.revision } }, 201);
  let customized = (await recipes()).find(r => r.id === first.id);
  await request(`/api/recipes/${first.id}`, 'PATCH', { expectedRevision: customized.revision, planApproved: true, status: 'active' });
  customized = (await recipes()).find(r => r.id === first.id); assert.ok(customized.schedule); assert.equal(customized.approvedRevision, customized.revision);
  const book = readFileSync(join(data, 'desk.json'));
  pack.revision = 2; pack.recipes[0].description = 'Fictional publisher revision two: review source completeness.';
  const extra = { ...structuredClone(pack.recipes.at(-1)), id: 'wf-office-core-extra', title: 'Fictional optional review' };
  pack.recipes.push(extra); pack.workflows[0].recipeIds.push(extra.id);
  await preview(pack); assert.equal(await change().getByRole('button', { name: 'Apply reviewed upgrade', exact: true }).isEnabled(), false);
  assert.equal((await installation()).revision, 1);
  await change().getByText('Review exact instruction file changes', { exact: true }).click(); await change().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(output, 'upgrade-preview-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await change().scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await page.screenshot({ path: join(output, 'upgrade-preview-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.route('**/api/customer-packs/upgrade', async route => { lostBody = route.request().postDataJSON(); const result = await route.fetch(); assert.equal(result.status(), 200); await route.abort('failed'); }, { times: 1 });
  await confirm('upgrade'); await settled();
  const upgraded = await installation(); assert.equal(upgraded.revision, 2); assert.equal(upgraded.installationRevision, 2); assert.equal(upgraded.pendingChange, undefined);
  let current = (await recipes()).find(r => r.id === first.id);
  assert.equal(current.title, 'Fictional staff plan title'); assert.equal(current.description, pack.recipes[0].description); assert.equal(current.status, 'shadow'); assert.equal(current.approvedRevision, null); assert.equal(current.schedule, null);
  await request('/api/customer-packs/upgrade', 'POST', lostBody); assert.equal((await installation()).installationRevision, 2);
  assert.deepEqual(readFileSync(join(data, 'desk.json')), book);
  checks.push('Rendered upload preview is read-only and requires confirmation; real upgrade merges publisher change with staff title, adds optional plan, pauses approvals/schedules, and reconciles lost response without another generation.');
  await page.reload(); await card().waitFor();
  const conflict = structuredClone(pack); conflict.revision = 3; conflict.recipes[0].title = 'Conflicting publisher title';
  await preview(conflict); await change().getByRole('alert').waitFor(); assert.equal(await change().getByRole('button', { name: 'Apply reviewed upgrade', exact: true }).isEnabled(), false);
  assert.equal((await installation()).revision, 2); await change().getByRole('button', { name: 'Cancel version change', exact: true }).click();
  checks.push('A competing edit to the same plan field produces a visible conflict and cannot be applied.');
  const next = structuredClone(pack); next.revision = 3; next.skills[0].instructions += '\nFictional additional source coverage instruction.\n';
  const nativeSkill = join(data, 'hermes/profiles/property/skills', `realbud-office-core-${next.skills[0].id}`, 'SKILL.md');
  const nativeBefore = readFileSync(nativeSkill, 'utf8'); lockedDirectory = dirname(nativeSkill); chmodSync(lockedDirectory, 0o500);
  await preview(next);
  const failureResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/customer-packs/upgrade' && response.request().method() === 'POST');
  await confirm('upgrade'); const rejectedWrite = await failureResponse; assert.ok(rejectedWrite.status() >= 400); assert.match((await rejectedWrite.json()).error, /EACCES|permission denied/i); await settled();
  assert.equal((await installation()).pendingChange?.targetRevision, 3); assert.equal(readFileSync(nativeSkill, 'utf8'), nativeBefore);
  assert.ok((await recipes()).every(r => r.status === 'shadow' && r.approvedRevision === null && r.schedule === null));
  chmodSync(lockedDirectory, 0o700); lockedDirectory = undefined;
  await stop(); await start(); await open();
  await card().getByRole('button', { name: 'Resume reviewed pack change', exact: true }).click(); await settled();
  assert.equal((await installation()).revision, 3); assert.equal((await installation()).installationRevision, 3); assert.ok(readFileSync(nativeSkill, 'utf8').includes('revision 3.')); assert.equal(readFileSync(join(data, 'vault/workflow-support', next.skills[0].id, 'SKILL.md'), 'utf8'), next.skills[0].instructions);
  checks.push('A real protected-directory write failure leaves durable intent and paused plans; after cold service restart, Resume completes the exact saved change.');
  await card().getByText('Previous configurations and rollback', { exact: true }).click();
  await card().getByRole('button', { name: 'Preview rollback to configuration 1', exact: true }).click(); await change().waitFor();
  await confirm('rollback'); await settled();
  const rolled = await installation(); assert.equal(rolled.revision, 1); assert.equal(rolled.installationRevision, 4); assert.ok(rolled.retiredRecipes.includes(extra.id));
  current = (await recipes()).find(r => r.id === first.id); assert.equal(current.title, 'Fictional staff plan title'); assert.equal(current.description, original.recipes[0].description); assert.equal(current.approvedRevision, null); assert.equal(current.schedule, null);
  assert.equal(readFileSync(nativeSkill, 'utf8'), baselineNative); assert.equal(readFileSync(join(data, 'vault/workflow-support', original.skills[0].id, 'SKILL.md'), 'utf8'), original.skills[0].instructions);
  const retired = (await recipes()).find(r => r.id === extra.id); assert.ok(retired);
  await request(`/api/recipes/${extra.id}`, 'PATCH', { expectedRevision: retired.revision, planApproved: true, status: 'active' }, 409);
  await request('/api/recipes', 'POST', { draft: { ...retired, status: 'active', expectedRevision: retired.revision } }, 409);
  await request('/api/recipes', 'POST', { draft: { ...retired, id: ` ${retired.id} `, status: 'active', expectedRevision: retired.revision } }, 409);
  const deniedRun = await request(`/api/recipes/${extra.id}/prepare`, 'POST', { expectedRevision: retired.revision, requestId: crypto.randomUUID() }, 409); assert.match(deniedRun.error, /retired/i);
  assert.deepEqual(await request('/api/customer-packs/office-core/history-export', 'POST', { installationRevision: 1 }), original);
  assert.deepEqual(readFileSync(join(data, 'desk.json')), book);
  await card().scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'rollback-complete-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await card().scrollIntoViewIfNeeded(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await page.screenshot({ path: join(output, 'rollback-complete-mobile.png') });
  checks.push('Reviewed rollback restores prior instructions and staff configuration as a new generation; optional plan history stays saved and reactivation and execution are both refused; prior published definition exports exactly.');
  // Exercise archival through the same actual service and rendered controls.
  const upgradeTo = async revision => {
    const target = structuredClone(original); target.revision = revision;
    target.recipes[0].evidence = `Fictional evidence revision ${revision}.`;
    const inspected = await request('/api/customer-packs/upgrade/preview', 'POST', { pack: target });
    assert.equal(inspected.canApply, true, inspected.conflicts.join(' '));
    await request('/api/customer-packs/upgrade', 'POST', { pack: target, expectedInstalledDigest: inspected.installedDigest,
      expectedInstalledRevision: inspected.installedRevision, expectedDigest: inspected.digest, expectedPreviewDigest: inspected.previewDigest });
  };
  for (let revision = 2; revision <= 6; revision++) await upgradeTo(revision);
  assert.equal((await installation()).history.length, 8);
  const blockedTarget = structuredClone(original); blockedTarget.revision = 7;
  assert.equal((await request('/api/customer-packs/upgrade/preview', 'POST', { pack: blockedTarget })).canApply, false);
  const selected = (await recipes()).find(r => r.id === first.id);
  await request('/api/recipes', 'POST', { draft: { ...selected, schedule: { time: '23:59', weekdays: [(new Date().getDay() + 1) % 7] }, expectedRevision: selected.revision } }, 201);
  await request(`/api/recipes/${first.id}`, 'PATCH', { expectedRevision: (await recipes()).find(r => r.id === first.id).revision, planApproved: true, status: 'active' });
  const recipesBeforeArchive = readFileSync(join(data, 'recipes.json'));
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.reload(); await card().waitFor();
  await card().getByText('Previous configurations and rollback', { exact: true }).click();
  await card().getByRole('button', { name: 'Review history archival', exact: true }).click();
  const archiveReview = () => page.getByRole('region', { name: 'Review pack history archival', exact: true });
  await archiveReview().waitFor(); assert.equal(await archiveReview().getByRole('button', { name: 'Archive reviewed history', exact: true }).isEnabled(), false);
  assert.equal((await installation()).history.length, 8);
  await archiveReview().scrollIntoViewIfNeeded(); await page.screenshot({ path: join(output, 'archive-preview-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 }); await archiveReview().scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await page.screenshot({ path: join(output, 'archive-preview-mobile.png') });
  await page.setViewportSize({ width: 1440, height: 1000 });
  mkdirSync(join(data, 'customer-pack-history'), { mode: 0o700 });
  lockedDirectory = join(data, 'customer-pack-history/office-core'); mkdirSync(lockedDirectory, { mode: 0o500 });
  const rejectedArchive = page.waitForResponse(response => new URL(response.url()).pathname === '/api/customer-packs/office-core/archive');
  await archiveReview().getByRole('checkbox').check(); await archiveReview().getByRole('button', { name: 'Archive reviewed history', exact: true }).click();
  const archiveFailure = await rejectedArchive; assert.ok(archiveFailure.status() >= 400); assert.match((await archiveFailure.json()).error, /EACCES|permission denied/i); await settled();
  const pendingArchive = await installation(); assert.ok(pendingArchive.pendingArchive); assert.equal(pendingArchive.history.length, 8);
  assert.deepEqual(readFileSync(join(data, 'recipes.json')), recipesBeforeArchive);
  chmodSync(lockedDirectory, 0o700); lockedDirectory = undefined;
  await stop(); await start(); await open();
  let lostArchive;
  await page.route('**/api/customer-packs/office-core/resume-archive', async route => {
    lostArchive = route.request().postDataJSON(); const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('failed');
  }, { times: 1 });
  await card().getByRole('button', { name: 'Resume reviewed history archival', exact: true }).click(); await settled();
  const archived = await installation(); assert.equal(archived.pendingArchive, undefined); assert.equal(archived.history.length, 2);
  assert.equal(archived.archivedHistory.configurations, 6); assert.equal(archived.archivedHistory.batches, 1); assert.equal(archived.installationRevision, 9);
  await request('/api/customer-packs/office-core/resume-archive', 'POST', lostArchive);
  assert.deepEqual(readFileSync(join(data, 'recipes.json')), recipesBeforeArchive); assert.deepEqual(readFileSync(join(data, 'desk.json')), book);
  checks.push('At eight retained configurations the UI previews six for archival and keeps two recent; a real EACCES write failure preserves every configuration and all approval/schedule bytes. Cold restart and lost-response resume commit one archive without another generation.');
  await upgradeTo(7); assert.equal((await installation()).installationRevision, 10);
  const journalAfterUpgrade = readFileSync(join(data, 'customer-packs.json'));
  await request('/api/customer-packs/office-core/archive', 'POST', lostArchive);
  assert.deepEqual(readFileSync(join(data, 'customer-packs.json')), journalAfterUpgrade);
  await page.reload(); await card().waitFor(); await card().getByText('Previous configurations and rollback', { exact: true }).click();
  await card().getByRole('button', { name: 'Browse archived configurations', exact: true }).click(); await settled();
  await card().getByRole('button', { name: 'Preview rollback to configuration 1', exact: true }).click(); await change().waitFor();
  await confirm('rollback'); await settled();
  assert.equal((await installation()).installationRevision, 11); assert.equal((await installation()).revision, 1);
  assert.equal((await installation()).archivedHistory.configurations, 6);
  assert.deepEqual(await request('/api/customer-packs/office-core/history-export', 'POST', { installationRevision: 1 }), original);
  const retiredAgain = (await recipes()).find(r => r.id === extra.id); assert.ok(retiredAgain);
  await request(`/api/recipes/${extra.id}/prepare`, 'POST', { expectedRevision: retiredAgain.revision, requestId: crypto.randomUUID() }, 409);
  checks.push('A new update succeeds after archival; retrying the original archive after that update makes no changes. The rendered archived configuration rolls back through normal review and retired-plan ownership remains enforced.');
  // Kill the actual service after a real half-write, without letting its finally block run.
  await stop(); await start({ holdArchiveWrite: true }); await open();
  await card().getByText('Previous configurations and rollback', { exact: true }).click();
  await card().getByRole('button', { name: 'Review history archival', exact: true }).click(); await archiveReview().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await archiveReview().getByRole('checkbox').check(); await archiveReview().getByRole('button', { name: 'Archive reviewed history', exact: true }).click();
  for (let count = 0; count < 200 && !logs.includes('REALBUD_QA_ARCHIVE_PARTIAL_WRITE_HELD'); count++) await wait(50);
  assert.ok(logs.includes('REALBUD_QA_ARCHIVE_PARTIAL_WRITE_HELD'), 'The actual archive writer did not reach the controlled half-write');
  child.kill('SIGKILL'); await childClosed;
  const interruptedJournal = JSON.parse(readFileSync(join(data, 'customer-packs.json'), 'utf8')).installs['office-core'];
  assert.ok(interruptedJournal.archiveIntent); assert.equal(interruptedJournal.history.length, 4);
  const archiveDirectory = join(data, 'customer-pack-history/office-core');
  const pendingNames = readdirSync(archiveDirectory).filter(name => name.startsWith(`${interruptedJournal.archiveIntent.digest}.json.`) && name.endsWith('.tmp'));
  assert.equal(pendingNames.length, 1); const pendingPath = join(archiveDirectory, pendingNames[0]);
  const partialBytes = readFileSync(pendingPath); assert.ok(partialBytes.length > 100); assert.throws(() => JSON.parse(partialBytes.toString()));
  // Close the dead service page before selecting a new port. Its in-flight UI
  // reconciliation must not be mistaken for an outbound request from the new page.
  await page.close(); await start(); page = await context.newPage(); page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message)); await open();
  await card().getByRole('button', { name: 'Resume reviewed history archival', exact: true }).click(); await settled();
  assert.equal(existsSync(pendingPath), false); assert.equal((await installation()).pendingArchive, undefined);
  assert.equal((await installation()).archivedHistory.batches, 2); assert.equal((await installation()).archivedHistory.configurations, 8);
  await card().getByText('Previous configurations and rollback', { exact: true }).click();
  await card().getByRole('button', { name: 'Browse archived configurations', exact: true }).click(); await settled();
  await card().getByRole('button', { name: 'Show older archive', exact: true }).click(); await settled();
  assert.equal(await card().getByRole('button', { name: 'Preview rollback to configuration 1', exact: true }).count(), 1);
  await card().getByRole('button', { name: 'Preview rollback to configuration 1', exact: true }).scrollIntoViewIfNeeded();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: join(output, 'archived-history-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  await card().getByRole('button', { name: 'Preview rollback to configuration 1', exact: true }).scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await page.screenshot({ path: join(output, 'archived-history-mobile.png') });
  assert.deepEqual(readFileSync(join(data, 'desk.json')), book);
  checks.push('Actual service SIGKILL after a partial archive write leaves durable intent and original history; mobile cold-resume repairs that staging file and removes it. A second archive retains the first batch; bounded older-page browsing still reaches configuration one. Desktop and mobile archival screens remain usable.');
  assert.deepEqual(errors, []); assert.deepEqual(denied, []); checks.push('Desktop and390px screens render without horizontal overflow, browser errors or off-origin requests; private business book bytes remain unchanged.');
} catch (error) { failure = error; }
finally {
  if (lockedDirectory) chmodSync(lockedDirectory, 0o700);
  await browser?.close(); await stop();
  if (failure) writeFileSync(join(output, 'failure.log'), logs, { mode: 0o600 });
  rmSync(temp, { recursive: true, force: true });
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({ at: new Date().toISOString(), passed: !failure, layer: resources ? 'Compiled local service and built renderer' : 'Source local service and built renderer',
    limits: 'Disposable fictional pack and POSIX file-permission failure; no live worker/provider or native Windows proof', checks, errors, denied, cleaned: !existsSync(temp), ...(failure ? { error: failure.message } : {}) }, null, 2));
}
if (failure) throw failure;
console.log(JSON.stringify({ output, checks, cleaned: true }, null, 2));
