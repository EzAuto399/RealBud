import { readFileSync } from 'node:fs';
import https from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  companyCertificateFingerprint,
  requestCompanyHost,
  startCompanyTransport,
} from './host-transport.ts';

import { createHostCertificate } from './host-certificate.ts';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const cert = readFileSync(path.join(fixtures, 'localhost-cert.pem'), 'utf8');
const key = readFileSync(path.join(fixtures, 'localhost-key.pem'), 'utf8');

let WRONG_CA: string;
beforeAll(async () => { WRONG_CA = (await createHostCertificate('localhost')).cert; });

type Handle = Parameters<typeof startCompanyTransport>[0]['handle'];

async function withTransport(handle: Handle, run: (port: number) => Promise<void>): Promise<void> {
  const transport = await startCompanyTransport({ host: '127.0.0.1', port: 0, key, cert, handle });
  try {
    await run(transport.port);
  } finally {
    await transport.close();
  }
}

function hostCall(
  port: number,
  pathName: string,
  method: string,
  extra: Partial<Parameters<typeof requestCompanyHost>[0]> = {},
) {
  return requestCompanyHost({
    origin: `https://localhost:${port}`,
    certificatePem: cert,
    path: pathName,
    method,
    ...extra,
  });
}

function rawHttps(
  port: number,
  reqPath: string,
  method: string,
  headers: IncomingHttpHeaders = {},
  body?: string,
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'localhost',
        port,
        path: reqPath,
        method,
        ca: cert,
        minVersion: 'TLSv1.2',
        rejectUnauthorized: true,
        agent: false,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('company host transport', () => {
  it('carries reviewed work over the same pinned member channel without admitting new methods', async () => {
    const handle: Handle = async (pathName, method, request) => ({ status: 200, body: { pathName, method, member: request.headers['x-realbud-member-session'] } });
    await withTransport(handle, async port => {
      for (const [name, method] of [['work-members', 'GET'], ['work', 'GET'], ['work', 'POST'], ['work/respond', 'POST'], ['work/close', 'POST']]) {
        const response = await hostCall(port, `/api/company/${name}`, method, { memberToken: 'synthetic-member-token', ...(method === 'POST' ? { body: {} } : {}) });
        expect(response).toMatchObject({ status: 200, body: { member: 'synthetic-member-token' } });
      }
      await expect(hostCall(port, '/api/company/work', 'DELETE')).rejects.toThrow();
    });
  });

  it('bounds large collaboration responses independently from request limits', async () => {
    let size = 40 * 1024;
    await withTransport(async () => ({ status: 200, body: { summary: 'x'.repeat(size) } }), async port => {
      expect((await hostCall(port, '/api/company/work', 'GET')).body).toEqual({ summary: 'x'.repeat(size) });
      size = 513 * 1024;
      expect((await hostCall(port, '/api/company/work', 'GET')).status).toBe(500);
    });
  });
  it('exports a stable SHA-256 DER fingerprint', () => {
    const fp = companyCertificateFingerprint(cert);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(companyCertificateFingerprint(cert)).toBe(fp);
    expect(companyCertificateFingerprint(WRONG_CA)).not.toBe(fp);
  });

  it('matching pin success forwards JSON and omits CORS wildcards', async () => {
    const handle = vi.fn(async (pathName, method, _req, body) => ({
      status: method === 'GET' ? 200 : 201,
      body: { pathName, method, body },
    }));
    await withTransport(handle, async (port) => {
      const status = await hostCall(port, '/api/company/status', 'GET');
      expect(status).toEqual({ status: 200, body: { pathName: '/api/company/status', method: 'GET', body: undefined } });
      const joined = await hostCall(port, '/api/company/join', 'POST', { body: { handle: 'ada' } });
      expect(joined).toEqual({
        status: 201,
        body: { pathName: '/api/company/join', method: 'POST', body: { handle: 'ada' } },
      });
      const raw = await rawHttps(port, '/api/company/status', 'GET');
      expect(raw.headers['access-control-allow-origin']).toBeUndefined();
      expect(raw.headers['cache-control']).toBe('no-store');
    });
    expect(handle).toHaveBeenCalledTimes(3);
  });

  it('wrong CA/pin never calls handle and does not send the member token', async () => {
    const handle = vi.fn(async () => ({ status: 200, body: { leaked: true } }));
    await withTransport(handle, async (port) => {
      await expect(
        requestCompanyHost({
          origin: `https://localhost:${port}`,
          certificatePem: WRONG_CA,
          path: '/api/company/me',
          method: 'GET',
          memberToken: 'member-secret',
        }),
      ).rejects.toThrow();
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('hostname mismatch never calls handle', async () => {
    const handle = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    await withTransport(handle, async (port) => {
      await expect(
        requestCompanyHost({
          origin: `https://127.0.0.1:${port}`,
          certificatePem: cert,
          path: '/api/company/status',
          method: 'GET',
          memberToken: 'member-secret',
        }),
      ).rejects.toThrow();
    });
    expect(handle).not.toHaveBeenCalled();
  });

  it('never follows redirects and does not hit the Location target', async () => {
    const handle = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    await withTransport(handle, async (companyPort) => {
      const redirector = https.createServer({ key, cert, minVersion: 'TLSv1.2' }, (_req, res) => {
        res.writeHead(302, { Location: `https://localhost:${companyPort}/status` });
        res.end();
      });
      const redirectPort = await new Promise<number>((resolve, reject) => {
        redirector.once('error', reject);
        redirector.listen(0, '127.0.0.1', () => {
          const addr = redirector.address();
          if (addr && typeof addr !== 'string') resolve(addr.port);
          else reject(new Error('no port'));
        });
      });
      try {
        const result = await requestCompanyHost({
          origin: `https://localhost:${redirectPort}`,
          certificatePem: cert,
          path: '/api/company/status',
          method: 'GET',
          memberToken: 'member-secret',
        });
        expect(result.status).toBe(302);
        expect(result.body).toBeNull();
        expect(handle).not.toHaveBeenCalled();
      } finally {
        await new Promise<void>((resolve, reject) => {
          redirector.close((err) => (err ? reject(err) : resolve()));
        });
      }
    });
  });

  it('forwards only x-realbud-member-session and rejects browser origin', async () => {
    const handle = vi.fn<Handle>(async () => ({ status: 200, body: { me: true } }));
    await withTransport(handle, async (port) => {
      const allowed = await rawHttps(port, '/api/company/me', 'GET', {
        'x-realbud-member-session': 'member-secret',
        cookie: 'sid=leak',
        authorization: 'Bearer leak',
        'x-realbud-admin': 'yes',
        'x-realbud-service-admin': 'yes',
        'x-local-session': 'yes',
      });
      expect(allowed.status).toBe(200);
      expect(handle).toHaveBeenCalledTimes(1);
      expect(handle.mock.calls[0][2].headers).toEqual({ 'x-realbud-member-session': 'member-secret' });
      const browser = await rawHttps(port, '/api/company/me', 'GET', {
        origin: 'https://evil.example',
        'x-realbud-member-session': 'member-secret',
      });
      expect(browser.status).toBe(403);
      expect(handle).toHaveBeenCalledTimes(1);
    });
  });

  it.each([
    ['GET', '/create'],
    ['POST', '/setup'],
    ['POST', '/recover-owner'],
    ['GET', '/admin'],
    ['GET', '/settings'],
    ['GET', '/api'],
    ['GET', '/session'],
    ['GET', '/Ask'],
    ['GET', '/Desk'],
    ['GET', '/status/'],
    ['GET', '//status'],
    ['GET', '/status?x=1'],
    ['POST', '/cases/claim/../claim'],
  ])('%s %s is forbidden', async (method, reqPath) => {
    const handle = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    await withTransport(handle, async (port) => {
      if (reqPath.includes('?') || reqPath.endsWith('/') || reqPath.includes('..') || reqPath.includes('//')) {
        await expect(hostCall(port, reqPath, method)).rejects.toThrow();
      }
      const raw = await rawHttps(port, reqPath, method, { 'content-type': 'application/json' }, '{}');
      expect(raw.status).toBeGreaterThanOrEqual(400);
      expect(handle).not.toHaveBeenCalled();
    });
  });

  it('rejects malformed and oversized JSON without calling handle', async () => {
    const handle = vi.fn(async () => ({ status: 200, body: { ok: true } }));
    await withTransport(handle, async (port) => {
      const malformed = await rawHttps(
        port,
        '/api/company/join',
        'POST',
        { 'content-type': 'application/json' },
        '{not-json',
      );
      expect(malformed.status).toBe(400);
      const oversized = `{"blob":"${'x'.repeat(33 * 1024)}"}`;
      const large = await rawHttps(
        port,
        '/api/company/join',
        'POST',
        { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(oversized)) },
        oversized,
      );
      expect(large.status).toBe(413);
      await expect(hostCall(port, '/api/company/join', 'POST', { body: { blob: 'x'.repeat(33 * 1024) } })).rejects.toThrow();
      expect(handle).not.toHaveBeenCalled();
    });
  });

  it('keeps local state and every department outbox route off the LAN before member authentication', async () => {
    // This handler would accept the member if reached. A pinned TLS client and
    // member credential still cannot turn a local journal into an office API.
    const handle = vi.fn<Handle>(async () => ({ status: 200, body: { acceptedMember: true } }));
    await withTransport(handle, async port => {
      for (const name of ['local-state', 'department-outbox', 'department-outbox/ack', 'department-outbox/archive', 'department-outbox/archive/export']) {
        for (const method of ['GET', 'POST', 'DELETE']) {
          const pathName = `/api/company/${name}`;
          await expect(hostCall(port, pathName, method, { memberToken: 'synthetic-valid-member', ...(method === 'GET' ? {} : { body: {} }) })).rejects.toThrow();
          const response = await rawHttps(port, pathName, method, { 'x-realbud-member-session': 'synthetic-valid-member', 'content-type': 'application/json' }, method === 'GET' ? undefined : '{}');
          expect(response.status).toBeGreaterThanOrEqual(400);
        }
      }
      expect(handle).not.toHaveBeenCalled();
    });
  });

  it('honors cancellation before completion', async () => {
    const handle = vi.fn(async () => new Promise<{ status: number; body: unknown }>(() => {}));
    await withTransport(handle, async (port) => {
      const ac = new AbortController();
      const pending = hostCall(port, '/api/company/status', 'GET', { signal: ac.signal, timeoutMs: 8000 });
      ac.abort();
      await expect(pending).rejects.toThrow();
    });
  });

  it('ends a request at its deadline when the host handler never replies', async () => {
    const handle: Handle = async () => new Promise(() => {});
    await withTransport(handle, async (port) => {
      const started = Date.now();
      await expect(hostCall(port, '/api/company/status', 'GET', { timeoutMs: 100 })).rejects.toThrow('timeout');
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });

  it('rejects http, userinfo, query, and path-bearing origins', async () => {
    await expect(
      requestCompanyHost({ origin: 'http://localhost:1', certificatePem: cert, path: '/api/company/status', method: 'GET' }),
    ).rejects.toThrow();
    await expect(
      requestCompanyHost({
        origin: 'https://u:p@localhost:1',
        certificatePem: cert,
        path: '/api/company/status',
        method: 'GET',
      }),
    ).rejects.toThrow();
    await expect(
      requestCompanyHost({
        origin: 'https://localhost:1/status',
        certificatePem: cert,
        path: '/api/company/status',
        method: 'GET',
      }),
    ).rejects.toThrow();
    await expect(
      requestCompanyHost({
        origin: 'https://localhost:1?x=1',
        certificatePem: cert,
        path: '/api/company/status',
        method: 'GET',
      }),
    ).rejects.toThrow();
  });

});
