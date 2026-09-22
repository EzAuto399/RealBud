import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkflowDatabase } from './workflow-database.ts';
import { createMailIngestionService } from './mail-ingestion.ts';
import { defaultAgencySettings } from './agency-setup.ts';
import type { MailTaskPage, MailTaskUpdateResult, MailWorkspaceMetadata, MailWorkItem, MailScanPage, MailThread } from '../shared/mail-ingestion.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud mail HTTP ')), data = join(scratch, 'data');
const key = Buffer.alloc(32, 29), workspaceId = randomUUID(), accountId = 'fictional-mail', now = Date.now();
const itemId = (index: number) => createHash('sha256').update(JSON.stringify([workspaceId, accountId, (index + 1).toString(16)])).digest('hex');
let child: ChildProcess | undefined, closed: Promise<unknown> | undefined, base = '', token = '', logs = '';
const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
  method, signal: AbortSignal.timeout(15_000), headers: { 'x-realbud-session': token, 'content-type': 'application/json', ...headers },
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
  const port = (listener.address() as { port: number }).port; await new Promise<void>(resolve => listener.close(() => resolve()));
  base = `http://127.0.0.1:${port}`;
  const { serviceSmokeEnv } = await import(new URL('../scripts/service-smoke-env.mjs', import.meta.url).href);
  child = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], { cwd: root,
    env: { ...serviceSmokeEnv({ executable: process.execPath, home: scratch, data, scratch, port }), REALBUD_DESK_KEY: key.toString('hex'), VITEST: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  closed = new Promise((resolve, reject) => { child!.once('close', resolve); child!.once('error', reject); });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', bytes => { logs = (logs + bytes).slice(-12_000); });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null || child.signalCode) throw new Error(`Fictional mail fixture stopped: ${logs}`);
    const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) }).then(async r => await r.json() as {pid?:number}).catch(() => null);
    if (health?.pid === child.pid) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!ready) throw new Error(`Fictional mail fixture did not start: ${logs}`);
  token = (await (await fetch(base + '/api/session')).json() as {token:string}).token;
}
beforeAll(async () => {
  mkdirSync(join(data, 'company-installation'), { recursive: true, mode: 0o700 });
  writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } } }), { mode: 0o600 });
  writeFileSync(join(data, 'company-installation/workspace.json'), JSON.stringify({ version: 1, id: workspaceId, workerMemberKey: null }), { mode: 0o600 });
  await start();
}, 30_000);
afterAll(async () => { await stop(); rmSync(scratch, { recursive: true, force: true }); });

describe('retained mail through actual bootstrap and protected HTTP', () => {
  it('keeps first-use reads nonmaterializing so an untouched workspace can still restore', async () => {
    const metadata = await (await request('/api/mail-workspace')).json();
    expect(metadata).toMatchObject({ version: 2, revision: 0, counts: { total: 0 }, latestScan: null });
    expect(metadata).not.toHaveProperty('items');
    expect((await (await request('/api/mail-workspace/items?limit=5')).json() as MailTaskPage).items).toEqual([]);
    expect((await (await request('/api/mail-workspace/scans')).json() as MailScanPage).items).toEqual([]);
    expect((await request(`/api/mail-workspace/items/${'f'.repeat(64)}`)).status).toBe(404);
    const db = new WorkflowDatabase({ dir: data, key });
    try { expect(db.hasRecords()).toBe(false); } finally { db.close(); }
  });

  it('opens retained groups, counts, history and an exact old source after a real restart', async () => {
    await stop();
    const db = new WorkflowDatabase({ dir: data, key });
    try {
      let scan = 0;
      const settings = { ...defaultAgencySettings(), gmailAccountId: accountId, agencyName: 'Fictional HTTP agency', timeZone: 'UTC' };
      const service = createMailIngestionService({ directory: data, database: () => db, workspaceId, key, workroomDirectory: join(data, 'vault'), now: () => now,
        authorize: async () => ({ accountId, bindingRevision: 'b'.repeat(64), settingsRevision: 1, settings }),
        scan: async (_authority, query) => ({ accountId, windowStartAt: query.windowStartAt, windowEndAt: query.windowEndAt, pages: 1, paginationComplete: true, gaps: [],
          threads: Array.from({ length: 15 }, (_, offset) => {
            const index = scan * 15 + offset, id = (index + 1).toString(16);
            return { id, historyComplete: true, messages: [{ id: (index + 1000).toString(16), threadId: id, at: now - index * 1000 - 1000, direction: 'incoming' as const,
              from: 'fictional@example.invalid', to: 'office@example.invalid', subject: `Fictional source ${String(index).padStart(3, '0')}`, body: `Fictional retained content ${index}`, bodyTruncated: false, attachments: [] }] };
          }) }),
      });
      for (; scan < 3; scan++) await service.collect();
      for (let index = 0; index < 40; index++) {
        const item = await service.getItem(itemId(index));
        const patch = index < 15 ? { status: 'done' } : index < 25 ? { disposition: 'waiting' } : index < 35 ? { disposition: 'reference' } : { status: 'snoozed', snoozedUntil: now + 60 * 60_000 };
        await service.update(item.id, { expectedRevision: item.revision, ...patch, note: `Retained staff note ${index}` });
      }
    } finally { db.close(); }
    await start();
    const metadata = await (await request('/api/mail-workspace')).json() as MailWorkspaceMetadata;
    expect(metadata.counts).toMatchObject({ total: 45, done: 15, waiting: 10, reference: 10, snoozed: 5, open: 5 });
    expect(metadata.nextSnoozeAt).toBe(now + 60 * 60_000); expect(metadata).not.toHaveProperty('items');
    const page = await (await request('/api/mail-workspace/items?group=done&limit=5')).json() as MailTaskPage;
    expect(page.total).toBe(15); expect(page.items).toHaveLength(5); expect(page.nextCursor).toBeTypeOf('string');
    const more = await (await request(`/api/mail-workspace/items?group=done&limit=5&cursor=${page.nextCursor}`)).json() as MailTaskPage;
    expect(new Set([...page.items, ...more.items].map(item => item.id)).size).toBe(10);
    const source = await (await request(`/api/mail-workspace/items/${itemId(0)}/source`)).json() as {thread: MailThread; accountId:string};
    expect(source.thread.messages[0].body).toBe('Fictional retained content 0');
    expect(source.accountId).toBe(accountId);
    const scans = await (await request('/api/mail-workspace/scans?limit=2')).json() as MailScanPage;
    expect(scans.total).toBe(3); expect(scans.items).toHaveLength(2); expect(scans.nextCursor).toBeTypeOf('string');
    expect((await (await request(`/api/mail-workspace/scans?limit=2&cursor=${scans.nextCursor}`)).json() as MailScanPage).items).toHaveLength(1);
  }, 30_000);

  it('searches all retained tasks and invalidates a continuation after a staff edit', async () => {
    const found = await (await request('/api/mail-workspace/items?group=all&q=source%20044&limit=1')).json() as MailTaskPage;
    expect(found.total).toBe(1); expect(found.items[0].id).toBe(itemId(44));
    const first = await (await request('/api/mail-workspace/items?group=all&limit=5')).json() as MailTaskPage;
    const exact = await (await request(`/api/mail-workspace/items/${itemId(0)}`)).json() as { item: MailWorkItem };
    const patch = { expectedRevision: exact.item.revision, note: 'A newer fictional staff decision' };
    const result = await request(`/api/mail-workspace/items/${itemId(0)}`, 'PATCH', patch);
    expect(result.status).toBe(200);
    expect((await result.json() as MailTaskUpdateResult).item.note).toBe(patch.note);
    expect((await request(`/api/mail-workspace/items/${itemId(0)}`, 'PATCH', patch)).status).toBe(409);
    expect((await request(`/api/mail-workspace/items?group=all&limit=5&cursor=${first.nextCursor}`)).status).toBe(409);
    expect((await (await request(`/api/mail-workspace/items/${itemId(0)}`)).json() as {item:MailWorkItem}).item.note).toBe(patch.note);
  });

  it('requires current session and origin on metadata, pages, history and exact source', async () => {
    for (const path of ['/api/mail-workspace', '/api/mail-workspace/items?limit=1', '/api/mail-workspace/scans', `/api/mail-workspace/items/${itemId(0)}`, `/api/mail-workspace/items/${itemId(0)}/source`]) {
      expect((await fetch(base + path)).status).toBe(401);
      expect((await request(path, 'GET', undefined, { 'x-realbud-session': 'stale' })).status).toBe(401);
      expect((await request(path, 'GET', undefined, { origin: 'https://untrusted.example' })).status).toBe(403);
    }
  });

  it('rejects duplicate, foreign-source and misplaced query fields without changing records', async () => {
    const before = await (await request('/api/mail-workspace')).json() as MailWorkspaceMetadata;
    for (const path of ['/api/mail-workspace?limit=1', '/api/mail-workspace/items?limit=2&limit=3', '/api/mail-workspace/items?group=wrong',
      '/api/mail-workspace/items?accountId=another-office', '/api/mail-workspace/scans?q=body', `/api/mail-workspace/items/${itemId(0)}?cursor=abc`, `/api/mail-workspace/items/${itemId(0)}/source?group=all`]) {
      expect((await request(path)).status).toBe(400);
    }
    expect((await request('/api/mail-workspace/scan?limit=1', 'POST', {})).status).toBe(400);
    expect((await request(`/api/mail-workspace/items/${itemId(0)}?limit=1`, 'PATCH', { expectedRevision: 1, note: 'Must not write' })).status).toBe(400);
    const after = await (await request('/api/mail-workspace')).json() as MailWorkspaceMetadata;
    expect(after.revision).toBe(before.revision); expect(after.counts).toEqual(before.counts);
  });
});
