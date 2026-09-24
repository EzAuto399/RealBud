// A disposable local service proves that the complete HTTP boundary, including
// app-session authentication, guards graceful shutdown. No live providers.
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const directory = mkdtempSync(join(tmpdir(), 'realbud-stop-http-'));
const token = 'c'.repeat(64);
let child: ChildProcess;
let base = '';
let session = '';
let health: { pid: number; instanceId: string; controlId: string };
let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

beforeAll(async () => {
  const data = join(directory, 'data');
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
      REALBUD_SERVICE_CONTROL_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.resume(); child.stderr?.resume();
  exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  for (let attempt = 0; attempt < 150; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Disposable service exited before readiness.');
    const ready = await fetch(base + '/api/health').then(response => response.ok, () => false);
    if (ready) break;
    if (attempt === 149) throw new Error('Disposable service startup timed out.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  health = await (await fetch(base + '/api/health')).json() as typeof health;
  session = ((await (await fetch(base + '/api/session')).json()) as { token: string }).token;
}, 25_000);

afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  rmSync(directory, { recursive: true, force: true });
});

function stopRequest(options: { session?: string | null; capability?: string | null; origin?: string; body?: unknown; method?: string } = {}) {
  return fetch(base + '/api/service/stop', {
    method: options.method ?? 'POST', signal: AbortSignal.timeout(10_000),
    headers: {
      'content-type': 'application/json',
      ...(options.session === null ? {} : { 'x-realbud-session': options.session ?? session }),
      ...(options.capability === null ? {} : { 'x-realbud-service-control': options.capability ?? token }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    ...(options.method === 'GET' ? {} : { body: JSON.stringify(options.body === undefined ? { pid: health.pid, instanceId: health.instanceId, controlId: health.controlId } : options.body) }),
  });
}

describe('service shutdown through the real HTTP boundary', () => {
  it('reports a public process digest without publishing its shutdown capability', async () => {
    expect(health.pid).toBe(child.pid);
    expect(health.controlId).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(health)).not.toContain(token);
    expect((await stopRequest({ method: 'GET' })).status).toBe(404);
    expect((await fetch(base + '/api/health')).ok).toBe(true);
  });

  it('requires both the app session and the private process capability', async () => {
    for (const options of [{ session: null }, { session: 'fictional-wrong-app-session' }]) {
      expect((await stopRequest(options)).status).toBe(401);
    }
    for (const options of [{ capability: null }, { capability: 'd'.repeat(64) }, { capability: health.controlId }]) {
      expect((await stopRequest(options)).status).toBe(403);
    }
    expect((await fetch(base + '/api/health')).ok).toBe(true);
  });

  it('rejects browser requests and stale shutdown bodies without stopping', async () => {
    for (const origin of [base, 'https://fictional.example', 'null']) {
      expect((await stopRequest({ origin })).status).toBe(403);
    }
    for (const body of [null, [], {}, { ...health, pid: health.pid + 1 }, { ...health, instanceId: 'fictional-other-installation' }, { ...health, controlId: 'd'.repeat(64) }]) {
      expect((await stopRequest({ body })).status).toBe(403);
    }
    expect((await fetch(base + '/api/health')).ok).toBe(true);
  });

  it('returns an accepted receipt before orderly exit for the controlled process', async () => {
    const response = await stopRequest();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ stopping: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        exited,
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Controlled service did not finish graceful shutdown.')), 10_000); }),
      ]);
      expect(result).toEqual({ code: 0, signal: null });
    } finally { clearTimeout(timer); }
  }, 15_000);
});
