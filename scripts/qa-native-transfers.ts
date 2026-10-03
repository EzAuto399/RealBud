// Real pinned browser engine, disposable profile, fictional HTTPS page only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkBrowserHost } from '../server/work-browser-host.ts';
import { HermesBrowserTransport } from '../server/hermes-browser-transport.ts';
import { browserDownloadTarget, saveBrowserDownload, addBrowserTaskUpload, grantedUploadPath } from '../server/browser-runtime.ts';
if (!process.env.PLAYWRIGHT_MODULE || !process.env.REALBUD_QA_OUTPUT) throw new Error('Provide Playwright and a new output directory.');
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const root = await realpath(await mkdtemp('/private/tmp/rb-transfer-'));
const output = resolve(process.env.REALBUD_QA_OUTPUT); await mkdir(output, { recursive: false });
const host = new WorkBrowserHost({ root: join(root, 'host'), bundleRoot: resolve('dist-browser/hermes-native') });
let transport: HermesBrowserTransport | undefined, error: unknown;
const checks: string[] = [], csv = 'Date,Amount,Reference\r\n01/10/2026,123.45,FICTIONAL-001\r\n';
try {
  const connection = await host.ensureOpen();
  const browser = await chromium.connectOverCDP(connection.endpoint), context = browser.contexts()[0];
  await context.route('https://fictional-bank.example/**', (route: any) => route.request().url().endsWith('/transactions.csv')
    ? route.fulfill({ status: 200, headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="fictional-transactions.csv"' }, body: csv })
    : route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Fictional transfer test</title><h1>Fictional bank export and REI preview</h1><a href="/transactions.csv" download>Export bank CSV</a><label>Upload bank CSV<input type="file" aria-label="Upload bank CSV"></label><p>No ledger or submit action exists on this test page.</p>' }));
  const page = context.pages()[0]; await page.goto('https://fictional-bank.example/');
  transport = new HermesBrowserTransport({ root: join(root, 'control'), bundle: connection.bundle, endpoint: connection.endpoint,
    exec: async (executable, args, options) => {
      try {
        const { stdout } = await promisify(execFile)(executable, args, { ...options, timeout: 45_000, maxBuffer: 1_000_000 });
        const result = JSON.parse(stdout);
        if (!result.success) throw new Error(JSON.stringify(result));
        return result.data;
      } catch (cause) {
        // This runner has only a disposable fictional page and no credentials.
        await writeFile(join(output, 'synthetic-engine-error.txt'), String(cause) + '\n' + String((cause as { stdout?: string }).stdout ?? ''));
        throw cause;
      }
    } });
  await transport.start();
  const tabs = await transport.step({ kind: 'tabs' });
  const tab = Number((tabs.tabs as any[]).find(tab => tab.url === 'https://fictional-bank.example/').tabId.slice(1));
  const observe = async () => {
    const result = await transport!.step({ kind: 'read', tab });
    await writeFile(join(output, 'snapshot.txt'), String(result.snapshot)); return String(result.snapshot);
  };
  const ref = (text: string, label: string) => {
    const line = text.split('\n').find(line => line.includes(`"${label}"`) && /ref=e\d+/.test(line));
    assert(line, `Missing observed control ${label}: ${text}`); return '@' + line.match(/ref=(e\d+)/)![1];
  };
  await page.locator('a').evaluate((a: HTMLAnchorElement, contents: string) => { a.href = URL.createObjectURL(new Blob([contents], { type: 'text/csv' })); a.download = 'fictional-transactions.csv'; }, csv);
  const workroom = join(root, 'task'), staged = await browserDownloadTarget(workroom);
  const download = await transport.step({ kind: 'download', tab, ref: ref(await observe(), 'Export bank CSV'), path: staged });
  assert.equal(await readFile(staged, 'utf8'), csv);
  const saved = await saveBrowserDownload(workroom, staged, download.suggested_filename ?? download.filename);
  assert.equal(saved.sha256, createHash('sha256').update(csv).digest('hex'));
  checks.push('Native engine exported exact fictional CSV bytes; task broker retained byte length and matching SHA-256.');
  const upload = await addBrowserTaskUpload(workroom, 'fictional-reviewed.csv', Buffer.from(csv));
  const path = await grantedUploadPath(workroom, upload);
  await transport.step({ kind: 'upload', tab, ref: ref(await observe(), 'Upload bank CSV'), path });
  assert.equal(await page.locator('input[type=file]').evaluate((input: HTMLInputElement) => input.files?.[0]?.name), 'fictional-reviewed.csv');
  assert.equal(await page.locator('input[type=file]').evaluate(async (input: HTMLInputElement) => input.files?.[0]?.text()), csv);
  checks.push('Native engine attached the exact broker-granted CSV; fictional page readback matched original contents. No form submission exists.');
  await transport.stop(); assert.equal(page.isClosed(), false);
  checks.push('Stopping detached the controller without closing the work browser.');
} catch (cause) { error = cause; }
finally {
  try { await transport?.stop(); } catch (cause) { error ??= cause; }
  try { await host.disconnect(); } catch (cause) { error ??= cause; }
  try { await rm(root, { recursive: true, force: true }); } catch (cause) { error ??= cause; }
}
const receipt = { at: new Date().toISOString(), layer: 'Native macOS engine and task-file broker with fictional HTTPS page', result: error ? 'failed' : 'passed', checks,
  limits: ['No live bank/REI account or real financial posting.', 'Transport and file-integrity proof; actual bank layout and REI preview reconciliation remain unqualified.', 'No Windows native proof.'], ...(error ? { error: String(error) } : {}) };
await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
console.log(JSON.stringify(receipt)); if (error) throw error;
