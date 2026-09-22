import type { IncomingMessage } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { needsSession, sessionOk, SESSION_TOKEN, privateBackupDownloadSessionCookie } from "./session-auth.ts";

describe("Ask mutation session boundary", () => {
  it.each([
    ["POST", "/api/bots/bud/messages"],
    ["PUT", "/api/bots/bud/queued-message"],
    ["DELETE", "/api/bots/bud/queued-message"],
    ["POST", "/api/bots/bud/steer"],
    ["POST", "/api/bots/bud/interrupt"],
    ["POST", "/api/bots/bud/respond"],
    ["POST", "/api/threads/thread-1/respond"],
    ["POST", "/api/bots/bud/messages/message-1/edit"],
    ["POST", "/api/bots/bud/active-branch"],
    ["POST", "/api/bots/bud/tasks"],
    ["PATCH", "/api/bots/bud/tasks/task-1"],
    ["PATCH", "/api/bots/bud"],
    ["POST", "/api/bots"],
    ["POST", "/api/instances/hermes/setup"],
    ["POST", "/api/hermes/update"],
    ["POST", "/api/connected-apps/managed/setup"],
    ["GET", "/api/workspace-tabs"],
    ['GET', '/api/agency-setup'],
    ['PUT', '/api/agency-setup'],
    ['GET', '/api/mail-workspace'],
    ['GET', '/api/mail-workspace/items'],
    ['GET', '/api/mail-workspace/scans'],
    ['GET', '/api/mail-workspace/items/item'],
    ['GET', '/api/mail-workspace/items/item/source'],
    ['PATCH', '/api/mail-workspace/items/item'],
    ['POST', '/api/mail-workspace/scan'],
    ['POST', '/api/mail-workspace/review'],
    ["PUT", "/api/workspace-tabs"],
    ["POST", "/api/workspace-tabs/reset"],
    ["GET", "/api/customer-packs"],
    ["POST", "/api/customer-packs/install"],
    ["POST", "/api/customer-packs/skill-proposals/review"],
    ["POST", "/api/customer-packs/skill-proposals/revert"],
    ["POST", "/api/hermes/update/restore"],
    ["POST", "/api/hermes/install"],
    ["POST", "/api/hermes/repair"],
    ["POST", "/api/hermes/model"],
    ["POST", "/api/hermes/oauth/start"],
    ["GET", "/api/browser"],
    ["POST", "/api/browser/connect"],
    ["POST", "/api/browser/select"],
    ["POST", "/api/browser/stop"],
    ["POST", "/api/browser/disconnect"],
  ])("requires the session before %s %s can change work or authority", (method, path) => {
    expect(needsSession(path, method)).toBe(true);
    const req = { url: path, method, headers: { host: "127.0.0.1:8799" } } as unknown as IncomingMessage;
    expect(sessionOk(req, 8799)).toEqual({ ok: false, status: 401, error: "session required" });
    req.headers["x-realbud-session"] = SESSION_TOKEN;
    expect(sessionOk(req, 8799)).toEqual({ ok: true });
  });

  it("rejects the wrong session or origin even with otherwise valid Ask input", () => {
    const req = { url: "/api/bots/bud/messages", method: "POST", headers: {
      host: "127.0.0.1:8799", "x-realbud-session": "wrong-session",
    } } as unknown as IncomingMessage;
    expect(sessionOk(req, 8799)).toMatchObject({ ok: false, status: 401 });
    req.headers["x-realbud-session"] = SESSION_TOKEN;
    req.headers.origin = "https://untrusted.example";
    expect(sessionOk(req, 8799)).toMatchObject({ ok: false, status: 403 });
  });

  it("preserves existing read-only task views, public health, and internal token routes", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      for (const path of ["/api/bots", "/api/bots/bud", "/api/bots/bud/tasks", "/api/threads/thread-1"]) {
        expect(needsSession(path, method)).toBe(false);
      }
    }
    expect(needsSession("/api/bots")).toBe(false);
    expect(needsSession("/api/health", "GET")).toBe(false);
    expect(needsSession("/api/session", "GET")).toBe(false);
    expect(needsSession("/api/internal/ask-bot", "POST")).toBe(false);
    expect(needsSession("/api/bots-lookalike", "POST")).toBe(false);
  });

  it("keeps connection settings and observations protected independently of method", () => {
    for (const path of ["/api/config", "/api/connected-apps/status", "/api/connected-apps/mode", "/api/connected-apps/gmail-readonly/setup"]) {
      expect(needsSession(path)).toBe(true);
      expect(needsSession(path, "GET")).toBe(true);
      expect(needsSession(path, "POST")).toBe(true);
    }
  });
});


it.each([
  ["GET", "/api/workflow-packs"], ["GET", "/api/workflow-packs/export"],
  ["POST", "/api/workflow-packs/import"], ["POST", "/api/workflow-packs/austin-phase-1/install"],
  ["POST", "/api/workflow-packs/austin-expected-bills/install"],
  ["GET", "/api/expected-bills"], ["POST", "/api/expected-bills"],
  ['GET', '/api/bill-register'],
  ['GET', `/api/bill-evidence/${'a'.repeat(64)}`],
  ['POST', '/api/bill-occurrences'], ['PUT', `/api/bill-occurrences/source-bill:${'a'.repeat(64)}`],
  ['POST', '/api/bill-series'], ['PUT', `/api/bill-series/bill-series:${'a'.repeat(36)}`],
  ['POST', '/api/bill-scan'],
  ['POST', '/api/bill-proposals'],
  ['GET', '/api/bill-proposals/00000000-0000-0000-0000-000000000001'],
  ['GET', '/api/bill-review-drafts'], ['POST', '/api/bill-review-drafts'],
  ['GET', '/api/bill-review-drafts/00000000-0000-0000-0000-000000000001'],
  ['PUT', '/api/bill-review-drafts/00000000-0000-0000-0000-000000000001'],
])("protects office pack and bill data: %s %s", (method, path) => {
  expect(needsSession(path, method)).toBe(true);
  const req = { url: path, method, headers: { host: "127.0.0.1:8799" } } as unknown as IncomingMessage;
  expect(sessionOk(req, 8799)).toMatchObject({ ok: false, status: 401 });
  req.headers["x-realbud-session"] = SESSION_TOKEN;
  expect(sessionOk(req, 8799)).toEqual({ ok: true });
});

it.each(['/api/bill-register', '/api/bill-evidence', '/api/bill-occurrences', '/api/bill-series', '/api/bill-scan', '/api/bill-proposals', '/api/bill-review-drafts','/api/website-requests','/api/office-link'])(
  'protects private bill route %s for every method and denies foreign origins', path => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) expect(needsSession(path, method)).toBe(true);
    const req = { url: path, method: 'GET', headers: { host: '127.0.0.1:8799', origin: 'https://untrusted.example', 'x-realbud-session': SESSION_TOKEN } } as unknown as IncomingMessage;
    expect(sessionOk(req, 8799)).toMatchObject({ ok: false, status: 403 });
    req.headers.origin = 'http://127.0.0.1:8799'; req.headers['x-realbud-session'] = 'stale-session';
    expect(sessionOk(req, 8799)).toMatchObject({ ok: false, status: 401 });
    expect(needsSession(`${path}-lookalike`, 'GET')).toBe(false);
  });

it('protects the browser link start, status and cancel under the office-link prefix', () => {
  for (const method of ['GET', 'POST', 'DELETE']) expect(needsSession('/api/office-link/browser-link', method)).toBe(true);
});


describe('native private backup download session', () => {
  it('accepts the scoped cookie only on download GET and rejects stale or duplicate cookies', () => {
    const path = '/api/private-backup/v2/downloads/' + 'A'.repeat(32);
    const request = (url: string, method: string, cookie: string) => ({ url, method, headers: { host: '127.0.0.1:8799', cookie } }) as IncomingMessage;
    const cookie = privateBackupDownloadSessionCookie({ url: path, expiresAt: Date.now() + 300_000 }).split(';')[0]!;
    expect(cookie).not.toContain(SESSION_TOKEN);
    expect(sessionOk(request(path, 'GET', cookie), 8799)).toEqual({ ok: true });
    for (const [url, method, value] of [[path, 'POST', cookie], [path.replace(/A/g, 'B'), 'GET', cookie], ['/api/config', 'GET', cookie], ['/api/private-backup/v2/operations', 'GET', cookie], [path, 'GET', cookie + '; ' + cookie], [path, 'GET', 'realbud-backup-download=stale'], [path, 'GET', `realbud-backup-download=${SESSION_TOKEN}`]]) expect(sessionOk(request(url!, method!, value!), 8799).ok).toBe(false);
  });
  it('rejects download proofs replayed as app credentials, tampered proofs, and expired grants', () => {
    const path = '/api/private-backup/v2/downloads/' + 'A'.repeat(32), now = Date.now();
    const header = privateBackupDownloadSessionCookie({ url: path, expiresAt: now + 300_000 }), cookie = header.split(';')[0]!, proof = cookie.slice(cookie.indexOf('=') + 1);
    expect(header).toContain(`Path=${path};`); expect(header).toContain('HttpOnly; SameSite=Strict');
    const request = (url: string, headers: Record<string, string | undefined>) => ({ method: 'GET', url, headers: { host: '127.0.0.1:8799', ...headers } }) as IncomingMessage;
    for (const url of ['/api/config', path]) {
      for (const headers of [{ authorization: `Bearer ${proof}` }, { 'x-realbud-session': proof }]) expect(sessionOk(request(url, headers), 8799).ok).toBe(false);
      expect(sessionOk(request(`${url}?session=${proof}`, {}), 8799).ok).toBe(false);
    }
    expect(sessionOk(request(path, { cookie: cookie.replace(/.$/, cookie.endsWith('a') ? 'b' : 'a') }), 8799).ok).toBe(false);
    expect(sessionOk(request(path, { cookie, origin: 'https://example.com' }), 8799).ok).toBe(false);
    try { vi.useFakeTimers(); vi.setSystemTime(now + 300_001); expect(sessionOk(request(path, { cookie }), 8799).ok).toBe(false); }
    finally { vi.useRealTimers(); }
  });
});
