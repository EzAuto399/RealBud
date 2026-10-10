// /api/health is what an update reads before it stops the office service
// (electron/update-service-handoff.mjs). A disposable service over the real
// bootstrap, ACP adapter, event bus and approval routes; only the ACP
// subprocess is fictional. No provider credentials, no network.
import { readSessionToken } from "./testing/local-session.ts";
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OptionCardData } from './store.ts';

const WINDOWS = process.platform === 'win32';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const peer = join(root, 'server/testing/fake-acp-cli.ts');
type Health = { busy: boolean; waitingApprovals: number };
type Bot = { id: string; busy: boolean; messages: Array<{ id: string; card?: OptionCardData }> };

describe('health reports what an update restart must wait for', () => {
  let scratch = '', data = '', base = '', token = '', logs = '';
  let child: ChildProcess | undefined, closed: Promise<unknown> | undefined;
  const botId = 'bud', threadId = 'health-gate-thread';

  async function api(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + path, {
      method, signal: AbortSignal.timeout(8_000),
      headers: { 'x-realbud-session': token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  }
  async function health(): Promise<Health & Record<string, unknown>> {
    // No session: the desktop reads health before it holds one.
    return await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(2_000) })).json() as Health & Record<string, unknown>;
  }
  async function bot(): Promise<Bot> {
    return (await api('/api/bots')).body.bots.find((row: Bot) => row.id === botId);
  }
  async function until<T>(read: () => Promise<T | false>, label: string, ms = 10_000): Promise<T> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (child && (child.exitCode !== null || child.signalCode)) throw new Error(`Service exited: ${logs}`);
      const result = await read();
      if (result !== false) return result;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out waiting for ${label}: ${logs}`);
  }

  beforeAll(async () => {
    scratch = mkdtempSync(join(realpathSync(tmpdir()), 'RealBud health gate '));
    data = join(scratch, 'data');
    const script = join(scratch, 'peer-script.json');
    mkdirSync(data, { recursive: true, mode: 0o700 });
    writeFileSync(script, JSON.stringify({ permission: true, tool: 'execute', rawInput: { name: 'terminal', command: 'echo fictional' }, title: 'echo fictional' }), { mode: 0o600 });
    writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: {
      hermes: { driver: 'hermesAgent', config: { cli: peer }, environment: { FAKE_ACP_SCRIPT: script } },
    } }), { mode: 0o600 });
    writeFileSync(join(data, 'bots.json'), JSON.stringify([{
      id: botId, threadId, name: 'Bud', title: '', description: '', notifications: false, color: 'green', unread: false,
      modelSelection: { instanceId: 'hermes', model: 'default' }, resumeCursors: {}, createdAt: 1,
    }]), { mode: 0o600 });
    const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>(resolve => listener.close(() => resolve())); base = `http://127.0.0.1:${port}`;
    const { serviceSmokeEnv } = await import(new URL('../scripts/service-smoke-env.mjs', import.meta.url).href);
    child = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], {
      cwd: root, env: {
        ...serviceSmokeEnv({ executable: process.execPath, home: scratch, data, scratch, port }),
        REALBUD_MANAGED_SERVICE: '0', REALBUD_SERVICE_ENTITLEMENT_REQUIRED: '0', VITEST: 'true',
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = new Promise((resolve, reject) => { child!.once('close', resolve); child!.once('error', reject); });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', bytes => { logs = (logs + bytes).slice(-12_000); });
    await until(async () => {
      try { return (await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) })).json() as { pid?: number }).pid === child?.pid; }
      catch { return false; }
    }, 'isolated bootstrap', WINDOWS ? 60_000 : 10_000);
    token = await readSessionToken(data);
  }, WINDOWS ? 90_000 : 20_000);

  afterAll(async () => {
    if (child && child.exitCode === null && !child.signalCode) {
      child.kill('SIGTERM');
      const force = setTimeout(() => child?.kill('SIGKILL'), 4_000);
      try { await closed; } finally { clearTimeout(force); }
    }
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it('counts a waiting approval card without its id, and drops it once answered', async () => {
    await until(async () => { const now = await health(); return !now.busy && now.waitingApprovals === 0 && now; }, 'an idle service');
    const before = new Set((await bot()).messages.map(message => message.id));
    const sent = await api(`/api/bots/${botId}/messages`, 'POST', { text: 'Run the fictional check.' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    const card = await until(async () => (await bot()).messages.find(row => !before.has(row.id) && row.card?.requestId && !row.card.answered)?.card ?? false, 'an approval card');

    const waiting = await health();
    expect(waiting.waitingApprovals).toBe(1);
    // The turn is parked on the card: it waits on the person, so it is counted there and not as busy.
    expect(waiting.busy).toBe(false);
    const shown = JSON.stringify(waiting);
    for (const detail of [card.requestId!, threadId, 'echo fictional']) expect(shown).not.toContain(detail);

    const answered = await api(`/api/threads/${threadId}/respond`, 'POST', { requestId: card.requestId, behavior: 'deny', scope: 'once' });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    const settled = await until(async () => { const now = await health(); return !now.busy && now.waitingApprovals === 0 && now; }, 'the answered card to clear');
    expect(settled).toMatchObject({ busy: false, waitingApprovals: 0 });
  }, 30_000);
});
