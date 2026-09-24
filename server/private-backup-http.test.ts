import { afterEach, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { handlePrivateBackupV2Http } from './private-backup-http.ts';
import type { createPrivateBackupCoordinator } from './private-backup-coordinator.ts';
import { sessionOk, SESSION_TOKEN } from './session-auth.ts';
const servers: Server[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } });
async function fixture(overrides: object, realSession = false) {
  const service = overrides as Awaited<ReturnType<typeof createPrivateBackupCoordinator>>;
  const server = createServer(async (req, res) => {
    // Mirrors the required order: a rejected session never reaches body/service.
    const accepted = realSession ? sessionOk(req, (server.address() as { port: number }).port).ok : req.headers['x-fixture-session'] === 'allowed';
    if (!accepted) { res.writeHead(401); res.end(); return; }
    await handlePrivateBackupV2Http(req, res, new URL(req.url!, 'http://localhost'), service);
  }); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(base + '/api/private-backup/v2' + path, { ...init, headers: { ...(realSession ? { 'x-realbud-session': SESSION_TOKEN } : { 'x-fixture-session': 'allowed' }), ...init.headers } });
  return { request, base };
}
it('caps raw bodies, rejects malformed UTF-8, and never exposes service exceptions', async () => {
  const startExport = vi.fn(async () => { throw new Error('SECRET /private/key Fictional customer data'); }), f = await fixture({ startExport });
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', payload = JSON.stringify({ id, passphrase: 'Fictional passphrase long enough' });
  expect((await fetch(f.base + '/api/private-backup/v2/exports', { method: 'POST', body: payload })).status).toBe(401); expect(startExport).not.toHaveBeenCalled();
  expect((await f.request('/exports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.from([0xff]) })).status).toBe(400);
  expect((await f.request(`/uploads/${id}/chunks?offset=0`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: Buffer.alloc(1024 * 1024 + 1) })).status).toBe(413);
  const response = await f.request('/exports', { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload });
  expect(response.status).toBe(503); expect(await response.text()).not.toMatch(/SECRET|private\/key|customer/); expect(response.headers.get('cache-control')).toBe('no-store');
});
it('streams a ticket response and drains the producer when the HTTP client disconnects', async () => {
  let returned = false; const f = await fixture({ async download(_token: string, sink: (ticket: object, chunks: AsyncIterable<Buffer>, signal: AbortSignal) => Promise<void>) {
    const ticket = { filename: 'RealBud.realbud-backup', archiveBytes: 16 * 1024 * 1024 };
    async function* chunks() { try { for (let i = 0; i < 16; i++) yield Buffer.alloc(1024 * 1024, 7); } finally { returned = true; } }
    await sink(ticket, chunks(), new AbortController().signal);
  } });
  const response = await f.request('/downloads/' + 'A'.repeat(32)); expect(response.status).toBe(200); expect(response.headers.get('content-disposition')).toContain('RealBud.realbud-backup');
  const reader = response.body!.getReader(); expect((await reader.read()).value!.byteLength).toBeGreaterThan(0); await reader.cancel();
  await vi.waitFor(() => expect(returned).toBe(true));
});
it('issues a ticket-only native cookie through the real HTTP session gate', async () => {
  const ticket = { url: '/api/private-backup/v2/downloads/' + 'A'.repeat(32), filename: 'RealBud.realbud-backup', archiveBytes: 3, archiveDigest: 'a'.repeat(64), expiresAt: Date.now() + 300_000 };
  const download = vi.fn(async (_token: string, sink: (ticket: object, chunks: AsyncIterable<Buffer>, signal: AbortSignal) => Promise<void>) => {
    async function* chunks() { yield Buffer.from('abc'); } await sink(ticket, chunks(), new AbortController().signal);
  });
  const f = await fixture({ downloadTicket: async () => ticket, download }, true);
  const response = await f.request('/operations/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/download-ticket', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedArchiveDigest: ticket.archiveDigest }) });
  expect(response.status).toBe(200); const cookie = response.headers.get('set-cookie')!.split(';')[0]!; expect(cookie).not.toContain(SESSION_TOKEN);
  const received = await fetch(f.base + ticket.url, { headers: { cookie } }); expect(received.status).toBe(200); expect(await received.text()).toBe('abc'); expect(download).toHaveBeenCalledTimes(1);
  expect((await fetch(f.base + ticket.url.replace(/A/g, 'B'), { headers: { cookie } })).status).toBe(401);
  expect((await fetch(f.base + '/api/private-backup/v2/operations', { headers: { cookie } })).status).toBe(401); expect(download).toHaveBeenCalledTimes(1);
});
