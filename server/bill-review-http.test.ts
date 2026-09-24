import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkflowDatabase } from './workflow-database.ts';
import { plantPrivateFile, privateDir, removeFixture } from './testing/private-fixture.ts';
import { proposalBackupFixture } from './testing/proposal-backup-fixture.ts';
import type { BillReviewDraft, BillReviewDraftPage, BillReviewDraftValue } from '../shared/bill-review-drafts.ts';
import type { BillProposalHistory } from '../shared/bill-proposals.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud review HTTP '));
const data = join(scratch, 'data'), workspaceId = randomUUID(), key = Buffer.alloc(32, 47);
// Windows admits each private object the service creates through one PowerShell
// launch, so a fresh boot there takes several seconds longer (qa-private-backup-boundaries).
const WINDOWS_BOOT = process.platform === 'win32', BOOT_BUDGET_MS = WINDOWS_BOOT ? 90_000 : 15_000;
let child: ChildProcess | undefined, closed: Promise<unknown> | undefined, base = '', token = '', logs = '';
let seeded: Awaited<ReturnType<typeof proposalBackupFixture>>;
let savedDraft: BillReviewDraft;
const id = randomUUID();
const value = (): BillReviewDraftValue => ({ workspaceId, state: 'editing', billId: null, billRevision: null,
  itemId: null, messageId: null, sourceDigest: null,
  fields: { propertyId: '', kind: 'Water', vendor: 'Fictional supplier', amount: '12.', invoiceDate: '2026-', dueDate: '', note: 'Keep this unfinished 私人 review' },
  billState: 'received', reason: 'Unfinished internal review', seriesId: '', arrivalDate: '', proposalRequest: null,
});
const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
  method, signal: AbortSignal.timeout(10_000), headers: { 'x-realbud-session': token, 'content-type': 'application/json', ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
async function stop() {
  if (child && child.exitCode === null && !child.signalCode) {
    child.kill('SIGTERM'); const force = setTimeout(() => child?.kill('SIGKILL'), 5_000);
    try { await closed; } finally { clearTimeout(force); }
  }
}
async function start() {
  const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve())); base = `http://127.0.0.1:${port}`;
  const { serviceSmokeEnv } = await import(new URL('../scripts/service-smoke-env.mjs', import.meta.url).href);
  child = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], { cwd: root,
    env: { ...serviceSmokeEnv({ executable: process.execPath, home: scratch, data, scratch, port }), REALBUD_DESK_KEY: key.toString('hex'), VITEST: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  closed = new Promise((resolve, reject) => { child!.once('close', resolve); child!.once('error', reject); });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', bytes => { logs = (logs + bytes).slice(-12_000); });
  let ready = false;
  for (const began = Date.now(); Date.now() - began < BOOT_BUDGET_MS;) {
    if (child.exitCode !== null || child.signalCode) throw new Error(`Fictional review service stopped: ${logs}`);
    const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }).then(async r => await r.json() as { pid?: number }).catch(() => null);
    if (health?.pid === child.pid) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`Fictional review service did not start: ${logs}`);
  token = (await (await fetch(base + '/api/session')).json() as { token: string }).token;
}
beforeAll(async () => {
  // The desktop app creates the data folder and these files with their own protected descriptors.
  privateDir(join(data, 'company-installation'));
  plantPrivateFile(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } } }));
  plantPrivateFile(join(data, 'company-installation/workspace.json'), JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null }));
  await start();
}, WINDOWS_BOOT ? 120_000 : 20_000);
afterAll(async () => { await stop(); await removeFixture(scratch); });

describe('durable bill review and historical proposal HTTP boundary', () => {
  it('protects every read and write without creating drafts on first use', async () => {
    for (const path of ['/api/bill-review-drafts', `/api/bill-review-drafts/${id}`, `/api/bill-proposals/${id}`]) {
      expect((await fetch(base + path)).status).toBe(401);
      expect((await request(path, 'GET', undefined, { 'x-realbud-session': 'stale' })).status).toBe(401);
      expect((await request(path, 'GET', undefined, { origin: 'https://untrusted.example' })).status).toBe(403);
    }
    const page = await (await request('/api/bill-review-drafts')).json() as BillReviewDraftPage;
    expect(page.workspaceId).toBe(workspaceId); expect(page.items).toEqual([]); expect(page.total).toBe(0);
    const absent = await request(`/api/bill-proposals/${id}`);
    expect(absent.headers.get('cache-control')).toBe('no-store');
    expect(await absent.json()).toMatchObject({ state: 'not-recorded', historical: true, run: null });
    const db = new WorkflowDatabase({ dir: data, key });
    try { expect(db.hasRecords()).toBe(false); } finally { db.close(); }
  });

  it('saves raw incomplete wording, rejects stale writes, and reopens after an actual restart', async () => {
    const created = await request('/api/bill-review-drafts', 'POST', { id, expectedRevision: null, value: value() });
    expect(created.status).toBe(200); savedDraft = (await created.json() as { draft: BillReviewDraft }).draft;
    expect(savedDraft.fields).toEqual(value().fields);
    const edit = { ...value(), state: 'saved', fields: { ...value().fields, note: 'Newer staff notes survive restart' } };
    const updated = await request(`/api/bill-review-drafts/${id}`, 'PUT', { expectedRevision: savedDraft.revision, value: edit });
    expect(updated.status).toBe(200);
    expect((await request(`/api/bill-review-drafts/${id}`, 'PUT', { expectedRevision: savedDraft.revision, value: value() })).status).toBe(409);
    savedDraft = (await updated.json() as { draft: BillReviewDraft }).draft;
    await stop(); await start();
    expect((await (await request(`/api/bill-review-drafts/${id}`)).json() as { draft: BillReviewDraft }).draft).toEqual(savedDraft);
    const page = await (await request('/api/bill-review-drafts?limit=1')).json() as BillReviewDraftPage;
    expect(page.items[0].id).toBe(id); expect(page.items[0]).not.toHaveProperty('fields'); expect(page.items[0]).not.toHaveProperty('reason');
  }, WINDOWS_BOOT ? 120_000 : 20_000);

  it('reads a durable intent with no run despite unconfigured managed provider authority', async () => {
    const db = new WorkflowDatabase({ dir: data, key });
    try { seeded = await proposalBackupFixture(db, data); } finally { db.close(); }
    const response = await request(`/api/bill-proposals/${seeded.request.requestId}`);
    expect(response.status).toBe(200);
    const history = await response.json() as BillProposalHistory;
    expect(history).toMatchObject({ state: 'intent-recorded', historical: true, run: null, proposal: null, sourceDigest: seeded.request.expectedSourceDigest });
    const recovered = await request('/api/bill-review-drafts', 'POST', { id: randomUUID(), expectedRevision: null,
      value: { ...value(), state: 'saved', itemId: seeded.request.itemId, messageId: seeded.request.messageId, sourceDigest: seeded.request.expectedSourceDigest, proposalRequest: seeded.request },
    });
    expect(recovered.status).toBe(200);
    const check = new WorkflowDatabase({ dir: data, key });
    try {
      expect(check.get('bill-proposal', seeded.id)).toEqual(seeded.record);
      expect(check.count('execution-job')).toBe(0);
    } finally { check.close(); }
    // Looking at a receipt must not invoke the unavailable managed service or
    // consume a worker slot. Domain tests additionally spy all forbidden seams.
    expect(history.state).toBe('intent-recorded');
  });

  it('rejects foreign workspace, duplicate queries, route confusion and unsupported methods', async () => {
    const before = await (await request(`/api/bill-review-drafts/${id}`)).json();
    const foreign = await request(`/api/bill-review-drafts/${id}`, 'PUT', { expectedRevision: savedDraft.revision, value: { ...value(), workspaceId: randomUUID() } });
    expect([400, 409]).toContain(foreign.status);
    for (const path of ['/api/bill-review-drafts?filter=active&filter=all', '/api/bill-review-drafts?limit=0', '/api/bill-review-drafts?accountId=other',
      `/api/bill-review-drafts/${id}?filter=all`, `/api/bill-proposals/${seeded.request.requestId}?limit=1`, '/api/bill-proposals/not-a-uuid']) {
      expect((await request(path)).status).toBe(400);
    }
    expect((await request(`/api/bill-proposals/${seeded.request.requestId}`, 'POST', {})).status).toBe(405);
    expect((await request(`/api/bill-review-drafts/${id}`, 'DELETE', {})).status).toBe(405);
    expect((await request('/api/bill-review-drafts', 'POST', {}, { 'content-type': 'text/plain' })).status).toBe(415);
    expect(await (await request(`/api/bill-review-drafts/${id}`)).json()).toEqual(before);
  });
});
