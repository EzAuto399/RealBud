// Render the production components against the real agency/mail stores with
// explicitly fictional source and queue adapters. No account or model calls.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'vite';

if (!process.env.PLAYWRIGHT_MODULE) throw new Error('Set PLAYWRIGHT_MODULE.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'outputs/agency-mail-2026-09-21'); await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(realpathSync(tmpdir()), 'rb-agency-mail-ui-'));
process.env.REALBUD_DATA_DIR = temp;
const { createAgencySetupService } = await import('../server/agency-setup.ts');
const { createMailIngestionService } = await import('../server/mail-ingestion.ts');
let browser, server, verified = false, uncertainOnce = true, operation = null, sourceVersion = 1;
const checks = [], errors = [], reviewRequests = [];
const schedule = { revision: 1, enabled: false, timezone: 'Australia/Brisbane', localTime: '08:00', weekdays: [1, 2, 3, 4, 5], nextRunAt: null, available: true, detail: 'Fictional queue adapter for rendered UI verification.' };
const options = {
  directory: temp, workspaceId: 'fictional-agency-workspace', actorId: () => 'fictional-owner',
  checkGmail: async () => { verified = true; },
  observe: async () => ({
    gmail: { accounts: [{ id: 'fictional_mail', label: 'Fictional Acacia accounts', status: 'active' }], accountId: 'fictional_mail', state: verified ? 'verified' : 'unverified', checkedAt: verified ? Date.now() : null, bindingRevision: 'fictional-binding' },
    properties: { state: 'available', revision: 'fictional-properties-v1', items: [{ id: 'property-1', label: 'Fictional Oak Street' }] },
    billRegister: { state: 'available', count: 0 },
    workflows: Object.fromEntries(['bank-references', 'bills-calendar', 'morning-priorities'].map(id => [id, { state: 'available', bindingRevision: `fictional-${id}`, detail: 'Fictional available adapter for rendered UI checks; no live worker proof.' }])),
  }),
};
const agency = createAgencySetupService(options);
const mail = createMailIngestionService({ directory: temp, workspaceId: options.workspaceId, key: randomBytes(32), workroomDirectory: join(temp, 'workroom'),
  authorize: async () => { const result = await agency.assertWorkflowReady('morning-priorities'); return { accountId: result.settings.gmailAccountId, bindingRevision: createHash('sha256').update(result.evidenceDigest).digest('hex'), settings: result.settings, settingsRevision: result.revision }; },
  scan: async (authority, request) => ({ accountId: authority.accountId, windowStartAt: request.windowStartAt, windowEndAt: request.windowEndAt, pages: 1, paginationComplete: true, gaps: [], threads: [{ id: 'abc123', historyComplete: true, messages: [{ id: `abc12${sourceVersion}`, threadId: 'abc123', at: request.windowEndAt - 1000, direction: 'incoming', from: 'fictional-sender@example.invalid', to: 'fictional-office@example.invalid', subject: 'Fictional property inspection follow-up', body: `Fictional source version ${sourceVersion}. <img src="https://example.invalid/track" onerror="alert(1)"> Please review the inspection evidence.`, bodyTruncated: false, attachments: [] }] }] }),
});
const getSnapshot = async () => ({ ...await mail.get(), schedule, operation });
try {
  server = await createServer({ root, server: { port: 0, host: '127.0.0.1' }, plugins: [{ name: 'agency-mail-local-fixture',
    resolveId(id) { if (id === 'virtual:agency-mail-qa') return '\0agency-mail-qa'; },
    load(id) { if (id === '\0agency-mail-qa') return `import React from 'react'; import {createRoot} from 'react-dom/client'; import '/src/styles.css'; import {AgencyWorkflowSetup} from '/src/components/schedule/AgencyWorkflowSetup.tsx'; import {MailWorkPanel} from '/src/components/desk/MailWorkPanel.tsx'; createRoot(document.getElementById('root')).render(React.createElement('main',{style:{height:'100vh',overflowY:'auto',maxWidth:1100,margin:'0 auto',padding:16,display:'grid',gap:24}},React.createElement('p',null,'Fictional local fixture — no accounts or model calls'),React.createElement(AgencyWorkflowSetup),React.createElement(MailWorkPanel)));`; },
    configureServer(vite) {
    vite.middlewares.use(async (req, res, next) => {
      const path = req.url?.split('?')[0];
      if (path === '/__agency-mail-qa') {
        res.setHeader('content-type', 'text/html'); res.end(await vite.transformIndexHtml(path, '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/@id/virtual:agency-mail-qa"></script></body></html>')); return;
      }
      if (!path?.startsWith('/api/')) return next();
      const json = (status, body) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
      try {
        let input = ''; for await (const chunk of req) input += chunk; const body = input ? JSON.parse(input) : undefined;
        if (path === '/api/session') return json(200, { token: 'fictional-session' });
        if (path.startsWith('/api/agency-setup')) { const result = await agency.handle(path, req.method, body); return json(result.status, result.body); }
        if (path === '/api/mail-workspace') return json(200, await getSnapshot());
        if (path === '/api/mail-workspace/scan') return json(200, await mail.collect());
        if (path === '/api/mail-workspace/review') {
          reviewRequests.push(body); assert.equal(body.expectedRevision, schedule.revision); assert.match(body.requestId, /^[a-f0-9-]{36}$/);
          if (uncertainOnce) { uncertainOnce = false; return json(500, { error: 'Fictional uncertain transport receipt.' }); }
          operation = { state: 'running', kind: 'review', startedAt: Date.now(), detail: 'Fictional queued review; no model has been called.', requestId: body.requestId };
          return json(202, { run: { id: randomUUID(), requestId: body.requestId } });
        }
        if (path === '/api/mail-workspace/schedule') { await agency.assertWorkflowReady('morning-priorities'); schedule.enabled = body.enabled; schedule.revision++; return json(200, { schedule }); }
        const item = path.match(/^\/api\/mail-workspace\/items\/([a-f0-9]{64})(\/source)?$/);
        if (item) return json(200, item[2] ? await mail.source(item[1]) : await mail.update(item[1], body));
        return json(404, { error: 'No fixture API.' });
      } catch (cause) { return json(cause.status ?? 500, { error: cause.message }); }
    });
  } }] });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1400, height: 1050 } }); page.setDefaultTimeout(15_000); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/__agency-mail-qa`);
  const setup = page.getByRole('region', { name: 'Agency workflow setup', exact: true });
  await setup.getByLabel('Agency name', { exact: true }).fill('Fictional Acacia');
  await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SELECT');
  await setup.getByRole('combobox', { name: /^Office timezone/ }).selectOption('Australia/Brisbane');
  await setup.getByRole('combobox', { name: /^Workflow pack/ }).selectOption('office-core');
  await setup.getByRole('button', { name: 'Save and continue to Gmail', exact: true }).click();
  await setup.getByRole('combobox', { name: /^Private Gmail account/ }).selectOption('fictional_mail');
  await setup.getByRole('button', { name: 'Save selected account and scope', exact: true }).click();
  await setup.getByRole('button', { name: 'Check selected Gmail access', exact: true }).click();
  await setup.getByRole('button', { name: '3. Property references', exact: true }).click();
  await setup.getByRole('button', { name: 'Add property reference', exact: true }).click();
  await setup.getByRole('combobox', { name: /^Property/ }).selectOption('property-1');
  await setup.getByLabel('Agreed reference', { exact: true }).fill('REF100');
  await setup.getByLabel('Payer aliases — one per line', { exact: true }).fill('Fictional payer\nFictional occupant');
  await setup.getByRole('button', { name: 'Save and review workflows', exact: true }).click();
  await setup.getByLabel('Morning priorities and unanswered follow-ups', { exact: true }).check();
  await setup.getByRole('button', { name: 'Save workflow choices', exact: true }).click();
  await setup.getByRole('button', { name: 'Approve these workflow settings', exact: true }).click();
  await setup.getByText(/Setup reviewed and current run prerequisites checked/).waitFor();
  assert.equal((await agency.get()).workflows.find(w => w.id === 'morning-priorities').acceptance, 'not-verified');
  assert.equal(schedule.enabled, false); checks.push('Four-step setup persists actual agency settings and digest-bound review; acceptance unverified and schedule off');
  await setup.evaluate(element => element.scrollIntoView({block:'start'})); await page.screenshot({ path: join(output, 'agency-setup-desktop.png') });
  const panel = page.getByRole('region', { name: 'Mail priorities and follow-ups', exact: true });
  await panel.getByRole('button', { name: 'Collect reviewed Gmail scope', exact: true }).click();
  await panel.getByText('Fictional property inspection follow-up', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Review or edit this item', exact: true }).click();
  const editor = panel.getByRole('form', { name: 'Review saved mail item', exact: true });
  await editor.getByRole('combobox', { name: /^Priority/ }).selectOption('high');
  await editor.getByLabel('Responsible reviewer (local label)', { exact: true }).fill('Fictional manager');
  await editor.getByLabel('Your note', { exact: true }).fill('Preserve my review through a later scan.');
  await editor.getByRole('button', { name: 'Save reviewed item', exact: true }).click();
  await panel.getByText('Your note: Preserve my review through a later scan.', { exact: true }).waitFor();
  await panel.getByRole('button', { name: 'View source conversation', exact: true }).click();
  const source = panel.getByRole('complementary', { name: 'Saved source conversation', exact: true });
  await source.locator('summary').click();
  assert.equal(await source.locator('img').count(), 0); await source.getByText(/<img src=/).waitFor();
  await source.getByRole('button', { name: 'Close source conversation', exact: true }).click();
  await panel.getByRole('button', { name: 'Mark done', exact: true }).click();
  assert.equal((await mail.get()).items[0].status, 'done');
  sourceVersion++;
  await panel.getByRole('button', { name: 'Collect reviewed Gmail scope', exact: true }).click();
  await panel.getByText('New source evidence — review what changed before closing this item.', { exact: true }).waitFor();
  assert.equal((await mail.get()).items[0].note, 'Preserve my review through a later scan.');
  checks.push('Actual encrypted mail journal collects fixture evidence, preserves human edits, reopens changed evidence, and renders hostile source markup as text');
  await panel.getByRole('button', { name: 'Collect and prepare priorities with Bud', exact: true }).click();
  await panel.getByRole('button', { name: 'Reconcile and retry the same review request', exact: true }).waitFor();
  await panel.getByRole('button', { name: 'Reconcile and retry the same review request', exact: true }).click();
  await panel.getByText(/Priority review: running/).waitFor();
  assert.equal(reviewRequests.length, 2); assert.deepEqual(reviewRequests[0], reviewRequests[1]);
  assert.equal(await panel.getByRole('button', { name: 'Collect and prepare priorities with Bud', exact: true }).isDisabled(), true);
  operation.state = 'complete'; operation.detail = 'Fictional receipt completed; no model output or business acceptance was claimed.';
  await panel.getByRole('button', { name: 'Refresh saved mail work', exact: true }).click();
  await panel.getByRole('button', { name: 'Enable reviewed morning schedule', exact: true }).click();
  await panel.getByRole('button', { name: 'Turn off morning schedule', exact: true }).waitFor();
  assert.equal(schedule.enabled, true);
  await panel.getByRole('button', { name: 'Turn off morning schedule', exact: true }).click();
  await panel.getByRole('button', { name: 'Enable reviewed morning schedule', exact: true }).waitFor();
  assert.equal(schedule.enabled, false); checks.push('Uncertain review retry preserves request ID and revision, running review blocks duplicates, explicit schedule toggle reads back');
  await panel.evaluate(element => element.scrollIntoView({block:'start'})); await page.screenshot({ path: join(output, 'mail-work-desktop.png') });
  await page.reload(); await panel.getByText('Your note: Preserve my review through a later scan.', { exact: true }).waitFor();
  assert.equal((await createAgencySetupService(options).getConfiguration()).settings.agencyName, 'Fictional Acacia');
  await page.setViewportSize({ width: 390, height: 844 }); await panel.evaluate(element => element.scrollIntoView({block:'start'}));
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: join(output, 'mail-work-mobile.png') });
  await setup.getByRole('button', { name: '2. Private Gmail source', exact: true }).click(); await setup.scrollIntoViewIfNeeded();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: join(output, 'agency-source-mobile.png') });
  assert.deepEqual(errors, []); checks.push('Reload preserves saved agency and mail records; both 390px components have no overflow or browser errors');
  const saved = await readFile(join(temp, 'agency-setup.json'), 'utf8'); assert.ok(!saved.includes('fictional-session'));
  await writeFile(join(output, 'receipt.json'), JSON.stringify({ checkedAt: new Date().toISOString(), layer: 'rendered production React components and actual persisted agency/encrypted mail stores; fictional source and queue adapters; no live account, model or desktop package proof', checks, errors }, null, 2));
  console.log(JSON.stringify({ output, checks, errors }, null, 2));
} catch (cause) { console.error(JSON.stringify({ errors })); throw cause; }
finally { await browser?.close(); await server?.close(); await rm(temp, { recursive: true, force: true }); }
