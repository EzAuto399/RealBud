// Rendered, source-level QA for today's onboarding/setup changes.
//
// It boots the real application server from server/bootstrap.ts against a
// throwaway data directory and serves the real renderer through a Vite dev
// server that proxies /api to it, so no dist build is required and ~/.realbud is
// never touched. Fictional data only: no account, no model, no packaged app.
//
// Run:
//   PLAYWRIGHT_MODULE=… CHROME_EXECUTABLE=… node scripts/qa-onboarding-setup.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer as createViteServer } from 'vite';

import { serviceSmokeEnv } from './service-smoke-env.mjs';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(process.env.QA_OUTPUT ?? join(root, 'outputs/onboarding-setup-2026-09-23'));
assert.ok(!existsSync(output), 'Choose a fresh QA_OUTPUT directory; existing evidence is preserved.');
const temp = mkdtempSync(join(realpathSync(tmpdir()), 'rb-onboarding-setup-'));
const data = join(temp, 'data');
mkdirSync(data, { mode: 0o700 });
mkdirSync(output, { recursive: true });

// The zone this Node process resolves. The server child inherits no TZ from
// serviceSmokeEnv, so a fresh v3 book must record exactly this zone — a fallback
// or fixture zone shown as the book's own setting would be invented setup.
const hostZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const IANA = /^(?:UTC|[A-Za-z][A-Za-z_-]*(?:\/[A-Za-z0-9_+-]+)+)$/;

const FRESH_PERSON = 'Fictional Setup Person';
const SAVED_PERSON = 'Fictional Saved Person';
const FICTIONAL_AGENCY = 'Fictional Harbour Agency';
const FICTIONAL_ZONE = 'Australia/Brisbane';
const FICTIONAL_PACK = 'office-core';
const COMMANDS = [
  `node server/bootstrap.ts  (spawned; REALBUD_DATA_DIR=<temp>, REALBUD_MANAGED_SERVICE=0, REALBUD_TEST_LAB=1, OMB_STATIC_DIR=${join(root, 'dist')})`,
  'vite dev server (createServer from the repo vite.config.ts) serving src/ and proxying /api to the booted server',
  'node scripts/qa-onboarding-setup.mjs',
];
const LIMITS = [
  'Fictional data only: a throwaway workspace, a fictional onboarding profile and a fictional saved office contact. No customer book, no customer acceptance.',
  'Source-level run: real server from server/bootstrap.ts plus the real renderer through a Vite dev server. Not a packaged desktop app, not an installed app, not Windows.',
  'No real accounts, no source-account access, no portal action and no model or worker call. Bud is deliberately absent, so the card reads "Bud: needs setup on You" and no step past 2 can finish.',
  'Headless Chrome at 1400x1050 and 390x844 only. Screenshots are fictional examples, never customer evidence.',
  'Proves onboarding/setup wiring and copy in the rendered app; it proves nothing about live workflow readiness or a real run.',
  'Fresh-browser persistence is exercised here. Restored-book replay and changed-port service restarts are separate scenarios in qa-onboarding-restart.mjs.',
];

const wait = ms => new Promise(r => setTimeout(r, ms));
const freePort = async () => {
  const held = createHttpServer();
  held.listen(0, '127.0.0.1');
  await once(held, 'listening');
  const { port } = held.address();
  await new Promise(r => held.close(r));
  return port;
};

const checks = [];
const errors = [];
const defects = [];
const observations = {};
let child, childClosed, vite, browser, logs = '', failure = null;

/** Record a product defect instead of aborting, so one broken behaviour cannot
 *  hide the checks after it. The run still fails at the end. */
const expect = async (check, body, defect) => {
  try {
    await body();
    checks.push(check);
  } catch (cause) {
    if (!(cause instanceof assert.AssertionError)) throw cause;
    defects.push({ ...defect, expected: check, observed: cause.message });
  }
};

const writeReceipt = () => {
  writeFileSync(join(output, 'receipt.json'), JSON.stringify({
    at: new Date().toISOString(),
    layer: 'source',
    passed: failure === null && errors.length === 0 && defects.length === 0,
    exercised: [
      'src/components/desk/GoLiveCard.tsx', 'src/lib/setup-sequence.ts', 'src/lib/go-live.ts', 'src/lib/first-run.ts',
      'src/components/Onboarding.tsx', 'src/components/you/OfficeCard.tsx', 'src/components/RoutinesPage.tsx',
      'src/components/schedule/WorkflowPacksCard.tsx', 'src/components/schedule/AgencyWorkflowSetup.tsx',
    ],
    serverPid: child?.pid ?? null,
    commands: COMMANDS,
    checks,
    productDefects: defects,
    rendererPageErrors: errors,
    observations,
    ...(failure ? { failure } : {}),
    limits: LIMITS,
  }, null, 2));
};

try {
  const port = await freePort();
  const uiPort = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const uiBase = `http://127.0.0.1:${uiPort}`;
  observations.serverOrigin = base;
  observations.rendererOrigin = uiBase;
  observations.hostTimezone = hostZone;

  // The server only accepts a loopback Origin on its own port, 5199, 5173 or the
  // configured OMB_UI_PORT. This run's Vite port is ephemeral, so declare it.
  process.env.OMB_UI_PORT = String(uiPort);

  child = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], {
    cwd: root,
    env: {
      ...serviceSmokeEnv({ executable: process.execPath, home: temp, data, scratch: temp, port }),
      REALBUD_MANAGED_SERVICE: '0',
      REALBUD_TEST_LAB: '1',
      OMB_UI_PORT: String(uiPort),
      OMB_STATIC_DIR: process.env.OMB_STATIC_DIR ?? join(root, 'dist'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  childClosed = new Promise((res, rej) => { child.once('close', res); child.once('error', rej); });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { logs = (logs + b).slice(-30_000); });

  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null || child.signalCode) break;
    try {
      const health = await (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) })).json();
      if (health.pid === child.pid) { ready = true; break; }
    } catch { /* still starting */ }
    await wait(100);
  }
  assert.ok(ready, `server did not become ready:\n${logs}`);

  const token = (await (await fetch(`${base}/api/session`)).json()).token;
  const request = async (path, method = 'GET', body, expected = 200) => {
    const res = await fetch(base + path, {
      method,
      signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json', 'x-realbud-session': token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await res.json();
    assert.equal(res.status, expected, `${method} ${path}: ${JSON.stringify(value)}`);
    return value;
  };

  vite = await createViteServer({
    root,
    configFile: join(root, 'vite.config.ts'),
    logLevel: 'warn',
    server: {
      host: '127.0.0.1', port: uiPort, strictPort: true,
      proxy: { '/api': { target: base, changeOrigin: true, ws: true } },
    },
  });
  await vite.listen();

  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}),
  });
  // Only this run's renderer origin may load; nothing reaches the network.
  const onlyLocal = context => context.route('**/*', route =>
    new URL(route.request().url()).origin === uiBase ? route.continue() : route.abort());
  const watch = page => { page.on('pageerror', error => errors.push(`${page.url()} :: ${error.message}`)); return page; };

  const openSetupCard = async page => {
    // The morning overview starts collapsed and the setup card lives under it
    // (DeskPage.tsx: `mode === "batch" || !briefExpanded ? null : <GoLiveCard …>`).
    const morning = page.getByRole('region', { name: 'This morning', exact: true });
    await morning.waitFor();
    const show = morning.getByRole('button', { name: 'Show addresses', exact: true });
    if (await show.count()) await show.click();
    const card = page.getByRole('region', { name: 'Workspace setup', exact: true });
    await card.waitFor();
    const collapsed = card.getByRole('button', { name: /^Workspace setup · / });
    if (await collapsed.count()) await collapsed.click();
    return card;
  };

  // ── 1. Desk workspace setup is one ordered path of three steps ──────────────
  const context = await browser.newContext({ viewport: { width: 1400, height: 1050 } });
  await onlyLocal(context);
  await context.addInitScript(() => localStorage.setItem('realbud.first-run-done', '1'));
  const desk = watch(await context.newPage());
  desk.setDefaultTimeout(30_000);
  await desk.goto(`${uiBase}/#/desk`);
  // Completion belongs to the saved workspace, not the legacy origin flag.
  await desk.getByRole('heading', { name: 'Make the desk yours', exact: true }).waitFor();
  assert.equal((await request('/api/onboarding')).stage, 'profile');
  await desk.getByLabel('Your name', { exact: true }).fill(FRESH_PERSON);
  await desk.getByRole('button', { name: 'Continue', exact: true }).click();
  await desk.getByRole('heading', { name: 'You stay in charge', exact: true }).waitFor();
  assert.equal((await request('/api/onboarding')).stage, 'office-rules');
  await desk.reload();
  await desk.getByRole('heading', { name: 'You stay in charge', exact: true }).waitFor();
  assert.equal((await request('/api/config')).profile.name, FRESH_PERSON);
  await desk.screenshot({ path: join(output, 'onboarding-rules.png') });
  await desk.getByRole('button', { name: 'Open the sample desk first', exact: true }).click();
  await desk.getByRole('heading', { name: 'You stay in charge', exact: true }).waitFor({ state: 'hidden' });
  assert.equal((await request('/api/onboarding')).stage, 'complete');
  assert.equal((await request('/api/desk')).book.office.pmUser, FRESH_PERSON);
  checks.push('Fresh workspace ignores the legacy browser flag; profile submission saves office-rules, reload resumes rules with the saved profile, and explicit sample-desk completion saves complete with the office contact');
  let card = await openSetupCard(desk);
  await card.getByText('Step 1 of 3: Your agency', { exact: true }).waitFor();
  let cardText = (await card.innerText()).replace(/\s+/g, ' ').trim();
  observations.freshSetupCard = cardText;
  // Exactly one current step, and nothing the host has not answered may read as done.
  assert.equal(cardText.match(/Step \d of 3:/g)?.length, 1, cardText);
  assert.match(cardText, /Still to save on this one form: an agency name, a timezone, a workflow pack\./);
  assert.match(cardText, /(?:Later|Not checked yet) · 2\. Connect your accounts/);
  assert.match(cardText, /(?:Later|Not checked yet) · 3\. Approve and schedule/);
  // Bud is a status line, not a step: this harness installs no worker.
  assert.match(cardText, /Bud: needs setup on You/);
  assert.doesNotMatch(cardText, /Set up Bud/);
  assert.doesNotMatch(cardText, /Done:/);
  assert.doesNotMatch(cardText, /On with a next run recorded/);
  assert.doesNotMatch(cardText, /Reviewed with current checks passed/);
  await card.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await desk.screenshot({ path: join(output, 'desk-workspace-setup.png') });
  checks.push('Fresh workspace Desk shows "Workspace setup" as "Step 1 of 3: Your agency", exactly one current step, steps 2 and 3 unresolved, Bud as a status line rather than a step, and nothing marked Done');

  // ── 1b. The agency name alone does not finish step 1 ────────────────────────
  const namedAgency = await request('/api/desk/agency', 'PATCH', { name: FICTIONAL_AGENCY });
  assert.equal(namedAgency.book.agency.name, FICTIONAL_AGENCY);
  await desk.reload();
  card = await openSetupCard(desk);
  await card.getByText('Step 1 of 3: Your agency', { exact: true }).waitFor();
  cardText = (await card.innerText()).replace(/\s+/g, ' ').trim();
  observations.namedOnYouSetupCard = cardText;
  // The name saved on You counts, so only the timezone and pack are still asked for.
  assert.match(cardText, /Still to save on this one form: a timezone, a workflow pack\./);
  assert.doesNotMatch(cardText, /an agency name/);
  assert.doesNotMatch(cardText, /Done:/);
  checks.push(`Naming the agency on You through PATCH /api/desk/agency (${FICTIONAL_AGENCY}) is accepted as the agency name — step 1 stops asking for it — but step 1 stays current until the timezone and pack are saved too`);

  const openSetup = card.getByRole('button', { name: 'Open Agency workflow setup', exact: true });
  await openSetup.waitFor();
  await openSetup.click();
  await desk.getByRole('heading', { name: 'Schedule', exact: true }).waitFor();
  observations.hashAfterOpenSetup = await desk.evaluate(() => location.hash);
  const packs = desk.locator('#schedule-packs');
  await packs.waitFor();
  assert.equal(await packs.count(), 1);
  checks.push('Open Agency workflow setup opens the Schedule door with #schedule-packs present in the document');

  // The two surfaces must number the same steps, so Schedule's tabs read 1 to 3
  // with property references and the workflow review both inside step 3.
  const setupSteps = packs.getByRole('navigation', { name: 'Agency setup steps', exact: true });
  await setupSteps.waitFor();
  const stepLabels = (await setupSteps.innerText()).replace(/\s+/g, ' ').trim();
  observations.agencySetupStepLabels = stepLabels;
  assert.equal(stepLabels, '1. Agency details 2. Connect your accounts 3. Property references 3. Review workflows');
  checks.push('Schedule → Agency workflow setup numbers its tabs 1, 2, 3 and 3, matching the three-step Desk setup path');

  const packsBox = async () => packs.evaluate(el => {
    const rect = el.getBoundingClientRect();
    return {
      top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: Math.round(rect.height),
      viewport: window.innerHeight, hash: location.hash, focused: document.activeElement?.id ?? null,
    };
  });
  let box = await packsBox();
  for (let i = 0; i < 60 && !(box.top >= -2 && box.top <= box.viewport - 1); i++) {
    await wait(100);
    box = await packsBox();
  }
  observations.schedulePacksBox = box;
  assert.ok(box.height > 0, `#schedule-packs has no box: ${JSON.stringify(box)}`);
  await desk.screenshot({ path: join(output, 'schedule-packs.png') });
  await expect(
    'Open Agency workflow setup scrolls #schedule-packs into the viewport',
    () => assert.ok(box.top >= -2 && box.top <= box.viewport - 1, `#schedule-packs was not scrolled into view: ${JSON.stringify(box)}`),
    {
      id: 'agency-workflow-setup-deep-link-not-scrolled',
      where: [
        'src/components/desk/GoLiveCard.tsx (openWorkflowSetup)',
        'src/App.tsx:111-115 (door hash mirror)',
        'src/lib/app-route.ts:38-44 (doorHashToWrite keeps deep links only for the You door)',
        'src/components/RoutinesPage.tsx:380-392 (section scroll reads location.hash after jobsLoading clears)',
      ],
      detail: 'The button writes location.hash="schedule-packs" and dispatches showRoutines, but Schedule is a lazy chunk so its own getElementById scroll finds nothing, and the door mirror replaces the hash with "#/schedule" before RoutinesPage mounts. Schedule therefore opens scrolled to the top with the agency workflow setup section far below the fold.',
      evidence: 'screenshot schedule-packs.png',
    },
  );

  // Back to Desk for the rest of the path.
  await desk.goto(`${uiBase}/#/desk`);
  card = await openSetupCard(desk);
  await card.getByText('Step 1 of 3: Your agency', { exact: true }).waitFor();

  // ── 1c. Saving name, timezone and pack on one form advances to step 2 ───────
  const before = await request('/api/agency-setup');
  const saved = await request('/api/agency-setup', 'PUT', {
    expectedRevision: before.state.revision,
    settings: { ...before.state.settings, agencyName: FICTIONAL_AGENCY, timeZone: FICTIONAL_ZONE, workflowPackId: FICTIONAL_PACK },
  });
  assert.equal(saved.state.settings.timeZone, FICTIONAL_ZONE);
  assert.equal(saved.state.settings.workflowPackId, FICTIONAL_PACK);
  await desk.reload();
  card = await openSetupCard(desk);
  await card.getByText('Step 2 of 3: Connect your accounts', { exact: true }).waitFor();
  cardText = (await card.innerText()).replace(/\s+/g, ' ').trim();
  observations.savedAgencySetupCard = cardText;
  assert.equal(cardText.match(/Step \d of 3:/g)?.length, 1, cardText);
  assert.match(cardText, /Done: 1\. Your agency/);
  // No account is connected in this harness, so Gmail may never read as done.
  assert.doesNotMatch(cardText, /Done:.*2\. Connect your accounts/);
  // A fresh computer must link its RealBud account before account connections
  // can become step 2's current action. This harness never starts that link.
  assert.equal((await request('/api/office-link')).state, 'unlinked');
  const accountLink = card.getByRole('button', { name: 'Link with your RealBud account', exact: true });
  await accountLink.waitFor();
  assert.equal(await accountLink.count(), 1);
  assert.equal(await card.getByRole('button', { name: 'Open Connections', exact: true }).count(), 0);
  await card.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await desk.screenshot({ path: join(output, 'desk-workspace-setup-named.png') });
  checks.push(`Saving the agency name, timezone (${FICTIONAL_ZONE}) and workflow pack (${FICTIONAL_PACK}) in one PUT /api/agency-setup collapses step 1 into Done and advances the single current step to "Step 2 of 3: Connect your accounts", whose single action requires linking the RealBud account and which stays not done while unlinked`);

  // ── 1d. Step 2 opens its account-link gate; Connections remains navigable ──
  await accountLink.click();
  const accountOffice = desk.locator('#you-office');
  await accountOffice.waitFor();
  const websiteAccount = accountOffice.getByRole('region', { name: 'Website account', exact: true });
  await websiteAccount.getByRole('button', { name: 'Link with your RealBud account', exact: true }).waitFor();
  observations.hashAfterOpenAccountLink = await desk.evaluate(() => location.hash);
  assert.equal((await request('/api/office-link')).state, 'unlinked');
  await websiteAccount.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await desk.screenshot({ path: join(output, 'you-account-link.png') });
  checks.push('Step 2 opens the Website account controls in You → Office without starting a link or marking the computer linked');

  await desk.getByRole('navigation', { name: 'Jump to a settings group', exact: true }).getByRole('button', { name: 'Apps', exact: true }).click();
  const connectedApps = desk.locator('#you-connected-apps');
  await connectedApps.waitFor();
  // The hashchange handler reveals the disclosure on the next animation frame.
  await desk.locator('#you-connected-apps[open]').waitFor();
  observations.hashAfterOpenConnections = await desk.evaluate(() => location.hash);
  assert.equal(await connectedApps.count(), 1);
  assert.ok(await connectedApps.isVisible(), 'the Connections section on You is not visible');
  assert.ok(await connectedApps.evaluate(el => el.open), 'the Connected apps section is not expanded');
  await connectedApps.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await desk.screenshot({ path: join(output, 'you-connected-apps.png') });
  checks.push('You → Apps opens the #you-connected-apps Connections section, expanded and visible, without connecting an account');

  // ── 2. Narrow layout keeps the setup card inside 390px ──────────────────────
  const narrow = watch(await context.newPage());
  narrow.setDefaultTimeout(30_000);
  await narrow.setViewportSize({ width: 390, height: 844 });
  await narrow.goto(`${uiBase}/#/desk`);
  const narrowCard = await openSetupCard(narrow);
  await narrowCard.getByText(/^Step \d of 3: /).waitFor();
  await narrowCard.evaluate(el => el.scrollIntoView({ block: 'center' }));
  const narrowWidths = await narrow.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  observations.narrowWidths = narrowWidths;
  assert.ok(narrowWidths.scrollWidth <= narrowWidths.innerWidth + 1, `horizontal overflow at 390px: ${JSON.stringify(narrowWidths)}`);
  await narrow.screenshot({ path: join(output, 'desk-390.png') });
  await narrow.close();
  checks.push('The Desk workspace setup card renders at 390x844 with no horizontal page scroll');

  // ── 3. This office reports the zone the book actually recorded ─────────────
  const bookBefore = await request('/api/desk');
  observations.bookTimezone = bookBefore.book?.agency?.timezone ?? null;
  assert.equal(bookBefore.book.agency.timezone, hostZone);
  assert.match(bookBefore.book.agency.timezone, IANA);
  const you = watch(await context.newPage());
  you.setDefaultTimeout(30_000);
  await you.goto(`${uiBase}/#/you`);
  const office = you.locator('#you-office');
  await office.waitFor();
  if (!(await office.evaluate(el => el.open))) await office.locator('summary').first().click();
  const zoneLine = office.getByText(/^Book timezone:/);
  await zoneLine.waitFor();
  const zoneText = (await zoneLine.innerText()).replace(/\s+/g, ' ').trim();
  observations.officeZoneLine = zoneText;
  assert.equal(zoneText, `Book timezone: ${hostZone}`);
  assert.doesNotMatch(zoneText, /not recorded yet/);
  await zoneLine.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await you.screenshot({ path: join(output, 'you-office-timezone.png') });
  await you.close();
  checks.push(`You → This office shows the zone the fresh v3 book recorded (${hostZone}), matching the server process, with no "not recorded yet" fallback`);

  // ── 4. Completed setup persists in a fresh browser, preserving the contact ─
  const named = await request('/api/desk/agency', 'PATCH', { office: { pmUser: SAVED_PERSON } });
  assert.equal(named.book.office.pmUser, SAVED_PERSON);
  const freshContext = await browser.newContext({ viewport: { width: 1400, height: 1050 } });
  await onlyLocal(freshContext);
  const fresh = watch(await freshContext.newPage());
  fresh.setDefaultTimeout(30_000);
  await fresh.goto(`${uiBase}/#/desk`);
  await fresh.getByRole('region', { name: 'This morning', exact: true }).waitFor();
  assert.equal(await fresh.getByRole('heading', { name: 'Make the desk yours', exact: true }).count(), 0);
  assert.equal(await fresh.getByRole('heading', { name: 'You stay in charge', exact: true }).count(), 0);
  assert.equal(await fresh.evaluate(() => localStorage.getItem('realbud.first-run-done')), null);
  assert.equal((await request('/api/onboarding')).stage, 'complete');
  assert.equal((await request('/api/config')).profile.name, FRESH_PERSON);
  const bookAfter = await request('/api/desk');
  observations.officeAfterFreshBrowser = bookAfter.book.office.pmUser;
  assert.equal(bookAfter.book.office.pmUser, SAVED_PERSON);
  assert.notEqual(bookAfter.book.office.pmUser, FRESH_PERSON);
  await fresh.screenshot({ path: join(output, 'completed-setup-fresh-browser.png') });
  await freshContext.close();
  checks.push(`A fresh browser without the legacy flag enters the completed workspace directly, preserves the saved profile and leaves the saved office contact (${SAVED_PERSON}) untouched`);

  await desk.close();
  await context.close();
  assert.deepEqual(errors, [], `renderer page errors: ${JSON.stringify(errors)}`);
  checks.push('No renderer pageerror during onboarding, Desk, Schedule, You or fresh-browser re-entry');
  writeReceipt();
  console.log(JSON.stringify({ output, checks, defects, observations }, null, 2));
} catch (cause) {
  failure = cause instanceof Error ? cause.message : String(cause);
  try {
    const page = browser?.contexts().flatMap(c => c.pages()).at(-1);
    if (page) await page.screenshot({ path: join(output, 'failure.png') });
  } catch { /* the page may already be gone */ }
  writeFileSync(join(output, 'failure.log'), `${failure}\n\n--- server log ---\n${logs}`);
  writeReceipt();
  console.error(JSON.stringify({ output, failure, checks, errors, observations }, null, 2));
  throw cause;
} finally {
  await browser?.close();
  await vite?.close();
  if (child?.exitCode === null && !child.signalCode) {
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 4000);
    try { await childClosed; } finally { clearTimeout(force); }
  }
  rmSync(temp, { recursive: true, force: true });
}

// Every check ran; a recorded product defect still fails the run.
if (defects.length) {
  process.exitCode = 1;
  console.error(`${defects.length} product defect(s) observed — see ${join(output, 'receipt.json')}`);
}
