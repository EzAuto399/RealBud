import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { needsSession, sessionOk } from './session-auth.ts';
import { buildSupportBundle, SUPPORT_BUNDLE_MAX_BYTES, SUPPORT_LOG_TAIL_BYTES, supportBundleRequest } from './support-bundle.ts';

// Obviously synthetic, key-shaped values the redactor recognises.
const KEY = 'sk-ant-fictional0000000000000000000000';
const BEARER = 'fictionalBearerToken0000000000';
const PASSWORD = 'fictional-password-000';

let directory = '';
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'realbud-support-')); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
const log = () => join(directory, 'realbud.log');
const line = (detail: string) => `${JSON.stringify({ at: '2026-09-23T00:00:00.000Z', event: 'routine', detail })}\n`;

describe('support file contents', () => {
  it('states what it holds and masks key-shaped values in both logs', async () => {
    writeFileSync(log(), line(`provider said ${KEY}`) + line(`login password=${PASSWORD}`));
    const desktopLog = [
      `[2026-09-23T00:00:01.000Z] fork /synthetic/server/bootstrap.js port=8799 key=wrapped`,
      `[2026-09-23T00:00:02.000Z] [err] Authorization: Bearer ${BEARER}`,
      `[2026-09-23T00:00:03.000Z] [err] dump -----BEGIN PRIVATE KEY-----`,
      'MIIfictionalPrivateKeyBody000000000000000000000000000000000000000',
      '-----END PRIVATE KEY-----',
      `[2026-09-23T00:00:04.000Z] exited code=1`,
    ].join('\n');

    const report = await buildSupportBundle({ logPath: log(), desktopLog, uptimeSeconds: 3_725, now: new Date('2026-09-23T01:00:00.000Z') });

    expect(report).toMatch(/^RealBud support file\nCreated: 2026-09-23T01:00:00.000Z\nRealBud version: /);
    expect(report).toContain(`System: ${process.platform} ${process.arch}`);
    expect(report).toContain('Office service running for: 1 h 2 min');
    expect(report).toContain('Documents, mail, saved credentials and business records are never read for this file.');
    expect(report).toContain('== Office service log (realbud.log) ==');
    expect(report).toContain('== Desktop app log (server.log) ==');
    for (const secret of [KEY, BEARER, PASSWORD, 'MIIfictionalPrivateKeyBody']) expect(report).not.toContain(secret);
    expect(report).toContain('«redacted');
    expect(report).toContain('«redacted private key, 2 lines»');
    expect(report).toContain('port=8799 key=wrapped');
    expect(report).toContain('exited code=1');
  });

  it('drops a partial first line so a cut key cannot slip past the patterns', async () => {
    const tail = 'QQQQfictionalKeyTail0123456789\n';
    const newest = line('newest entry');
    const filler = 'x'.repeat(SUPPORT_LOG_TAIL_BYTES - tail.length - newest.length - 1) + '\n';
    // The 200 KB tail starts exactly where the second half of the key begins.
    writeFileSync(log(), `${line('older')}{"detail":"sk-ant-fictional${tail}${filler}${newest}`);

    const report = await buildSupportBundle({ logPath: log() });

    expect(report).not.toContain('QQQQfictionalKeyTail');
    expect(report).toContain('newest entry');
  });

  it('cuts an over-long line without leaving half a key behind', async () => {
    writeFileSync(log(), line(`${'a '.repeat(1_990)}sk-ant-fictional${'X'.repeat(200)}`));
    const report = await buildSupportBundle({ logPath: log() });
    expect(report).toContain('[line cut]');
    expect(report).not.toContain('sk-ant-fictional');
    expect(report).not.toContain('XXXX');
  });

  it('adds the rotated log when the current one is short', async () => {
    writeFileSync(`${log()}.1`, line('from the previous log'));
    writeFileSync(log(), line('from the current log'));
    const report = await buildSupportBundle({ logPath: log() });
    expect(report.indexOf('from the previous log')).toBeGreaterThan(0);
    expect(report.indexOf('from the previous log')).toBeLessThan(report.indexOf('from the current log'));
  });

  it.skipIf(process.platform === 'win32')('refuses a log that is a link to another file', async () => {
    const vault = join(directory, 'vault.json');
    writeFileSync(vault, '{"entry":"fictional vault contents"}');
    symlinkSync(vault, log());
    const report = await buildSupportBundle({ logPath: log() });
    expect(report).not.toContain('fictional vault contents');
    expect(report).toContain('The office log was left out');
  });

  it('says when no office log exists instead of inventing one', async () => {
    expect(await buildSupportBundle({ logPath: log() })).toContain('No office log has been written yet.');
    expect(await buildSupportBundle({ logPath: null })).toContain('This run keeps no office log.');
  });

  it('stays within 512 KB and keeps the newest lines when masks lengthen the logs', async () => {
    // Short secrets grow when masked, so the raw 200 KB tails alone would not bound the file.
    const noisy = (label: string) => Array.from({ length: 20_000 }, (_, index) => `${label} ${index} password=abcdefgh token=ijklmnop`).join('\n');
    writeFileSync(log(), `${noisy('office')}\noffice newest\n`);
    const report = await buildSupportBundle({ logPath: log(), desktopLog: `${noisy('desktop')}\ndesktop newest` });

    expect(Buffer.byteLength(report, 'utf8')).toBeLessThanOrEqual(SUPPORT_BUNDLE_MAX_BYTES);
    expect(report).toContain('office newest');
    expect(report).toContain('desktop newest');
    expect(report).toMatch(/\[\d+ older lines were left out to keep this file small\.\]/);
    expect(report).not.toContain('abcdefgh');
    expect(report).not.toContain('ijklmnop');
  });

  it('accepts only the desktop log tail as a request body', () => {
    expect(supportBundleRequest({})).toEqual({});
    expect(supportBundleRequest({ desktopLog: 'line' })).toEqual({ desktopLog: 'line' });
    for (const body of [null, [], 'text', { desktopLog: 1 }, { desktopLog: 'line', path: '/synthetic/other' }]) {
      expect(() => supportBundleRequest(body)).toThrow('Check the support file request.');
    }
  });
});

describe('support file authority', () => {
  it('requires the per-boot app session for every method', () => {
    expect(needsSession('/api/support/bundle', 'GET')).toBe(true);
    expect(needsSession('/api/support/bundle', 'POST')).toBe(true);
    const request = { headers: { host: '127.0.0.1:8799' }, url: '/api/support/bundle', method: 'GET' } as unknown as IncomingMessage;
    expect(sessionOk(request, 8799)).toEqual({ ok: false, status: 401, error: 'session required' });
  });
});

// The complete HTTP boundary, on a disposable service with no providers.
describe('support file through the real HTTP boundary', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
  const home = mkdtempSync(join(tmpdir(), 'realbud-support-http-'));
  let child: ChildProcess;
  let base = '';
  let session = '';

  beforeAll(async () => {
    const data = join(home, 'data');
    mkdirSync(data, { mode: 0o700 });
    writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: { fixture: { driver: 'not-a-real-driver' } } }));
    const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>(resolve => listener.close(() => resolve()));
    base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['--experimental-strip-types', 'server/index.ts'], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH || '', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
        HOME: data, USERPROFILE: data, REALBUD_DATA_DIR: data, REALBUD_HERMES_HOME: join(data, 'hermes'),
        HERMES_HOME: join(data, 'hermes'), OMB_PORT: String(port), VITEST: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.resume(); child.stderr?.resume();
    for (let attempt = 0; attempt < 150; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('Disposable service exited before readiness.');
      if (await fetch(`${base}/api/health`).then(response => response.ok, () => false)) break;
      if (attempt === 149) throw new Error('Disposable service startup timed out.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    session = ((await (await fetch(`${base}/api/session`)).json()) as { token: string }).token;
  }, 25_000);

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      try { await exited; } finally { clearTimeout(timer); }
    }
    rmSync(home, { recursive: true, force: true });
  });

  const bundle = (init: { session?: string | null; method?: string; body?: string; type?: string } = {}) =>
    fetch(`${base}/api/support/bundle`, {
      method: init.method ?? 'GET', signal: AbortSignal.timeout(10_000),
      headers: {
        ...(init.session === null ? {} : { 'x-realbud-session': init.session ?? session }),
        ...(init.body === undefined ? {} : { 'content-type': init.type ?? 'application/json' }),
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });

  it('refuses a request without the app session', async () => {
    for (const response of [await bundle({ session: null }), await bundle({ session: 'f'.repeat(48) }),
      await bundle({ session: null, method: 'POST', body: JSON.stringify({ desktopLog: KEY }) })]) {
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain('RealBud support file');
    }
  });

  it('returns a plain-text report to the app session', async () => {
    const response = await bundle();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const report = await response.text();
    expect(report).toMatch(/^RealBud support file\n/);
    expect(report).not.toContain('== Desktop app log');
  });

  it('masks the desktop log it is given and rejects any other body', async () => {
    const response = await bundle({ method: 'POST', body: JSON.stringify({ desktopLog: `[2026-09-23T00:00:00.000Z] [err] token ${KEY}\n[2026-09-23T00:00:01.000Z] exited code=1` }) });
    expect(response.status).toBe(200);
    const report = await response.text();
    expect(report).toContain('== Desktop app log (server.log) ==');
    expect(report).toContain('exited code=1');
    expect(report).not.toContain(KEY);
    expect((await bundle({ method: 'POST', body: JSON.stringify({ desktopLog: 'x', path: '/synthetic/other' }) })).status).toBe(400);
    expect((await bundle({ method: 'POST', body: 'desktopLog', type: 'text/plain' })).status).toBe(415);
  });
});
