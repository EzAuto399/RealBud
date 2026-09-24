import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OptionCardData } from './store.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const peer = join(root, 'server/testing/fake-acp-cli.ts');
const memoryTool = 'hermes_memory_write';
const description = 'Save to memory: add to memory';
const content = 'git status is the preferred check. Browser instructions mention a password field, ' +
  'but never store a password. Use https://fictional.example.invalid only as a reference.\n' +
  '私人 fictional memory text remains fully visible. '.repeat(16);
type CardMessage = { id: string; card?: OptionCardData };
type Bot = { id: string; threadId: string; busy: boolean; messages: CardMessage[]; autoApprove?: boolean; alwaysAllow?: string[] };
const memoryScript = (extra: Record<string, unknown> = {}) => ({
  permission: true, tool: 'execute', rawInput: { command: content, description },
  title: `${description}: ${content}`, ...extra,
});

// These are the actual bootstrap, registry, Hermes ACP adapter, event bus,
// durable cards and HTTP approval routes. Only the subprocess speaking ACP is
// fictional. The fixture never supplies provider credentials or intercepts HTTP.
describe.each(['product', 'legacy'] as const)('Hermes memory approval HTTP (%s)', mode => {
  let scratch = '', data = '', script = '', dump = '', base = '', token = '', logs = '';
  let child: ChildProcess | undefined, closed: Promise<unknown> | undefined;
  const botId = 'bud', threadId = 'memory-http-thread';
  const peerPids = new Set<number>();

  async function api(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + path, {
      method, signal: AbortSignal.timeout(8_000),
      headers: { 'x-realbud-session': token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  }
  async function bot(): Promise<Bot> {
    return (await api('/api/bots')).body.bots.find((row: Bot) => row.id === botId);
  }
  async function until<T>(read: () => Promise<T | false>, label: string): Promise<T> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      if (child && (child.exitCode !== null || child.signalCode)) throw new Error(`Service exited: ${logs}`);
      const result = await read();
      if (result !== false) return result;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out waiting for ${label}: ${logs}`);
  }
  async function settled() { await until(async () => !(await bot()).busy, 'worker completion'); }
  async function start(input: Record<string, unknown> = memoryScript(), auto = false) {
    await settled();
    writeFileSync(script, JSON.stringify(input), { mode: 0o600 });
    expect((await api(`/api/bots/${botId}`, 'PATCH', {
      modelSelection: { instanceId: auto ? 'hermes-auto' : 'hermes', model: 'default' },
    })).status).toBe(200);
    const previous = new Set((await bot()).messages.map(message => message.id));
    const sent = await api(`/api/bots/${botId}/messages`, 'POST', { text: 'Review the next fictional fixture note.' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    return previous;
  }
  async function waiting(previous: Set<string>) {
    return until(async () => {
      const current = await bot();
      const message = current.messages.find(row => !previous.has(row.id) && row.card?.requestId && !row.card.answered);
      return message?.card ? { message, card: message.card } : false;
    }, 'manual memory approval card');
  }
  function chosen() {
    const result = JSON.parse(readFileSync(dump, 'utf8'));
    if (Number.isSafeInteger(result.pid)) peerPids.add(result.pid);
    return result.selectedPermissionOption;
  }
  async function respond(route: 'bots' | 'threads', card: OptionCardData, extra: Record<string, unknown> = {}) {
    return api(`/api/${route}/${route === 'bots' ? botId : threadId}/respond`, 'POST', {
      requestId: card.requestId, behavior: 'allow', scope: 'session', ...extra,
    });
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode) return;
    child.kill('SIGTERM');
    const force = setTimeout(() => child?.kill('SIGKILL'), 4_000);
    try { await closed; } finally { clearTimeout(force); }
  }

  beforeAll(async () => {
    scratch = mkdtempSync(join(realpathSync(tmpdir()), `RealBud memory HTTP ${mode} `));
    data = join(scratch, 'data'); script = join(scratch, 'peer-script.json'); dump = join(scratch, 'peer-result.json');
    mkdirSync(data, { recursive: true, mode: 0o700 });
    writeFileSync(script, JSON.stringify(memoryScript()), { mode: 0o600 });
    writeFileSync(join(data, 'config.json'), JSON.stringify({ instances: Object.fromEntries(
      ['hermes', 'hermes-auto'].map(id => [id, {
        driver: 'hermesAgent', config: { cli: peer, fullAuto: id === 'hermes-auto' },
        environment: { FAKE_ACP_SCRIPT: script, FAKE_ACP_DUMP: dump },
      }]),
    ) }), { mode: 0o600 });
    // Explicit old permissions test read-time enforcement, not merely a new
    // rule creation ban. They must remain inert without silently deleting data.
    writeFileSync(join(data, 'rules.json'), JSON.stringify({ rules: [memoryTool, 'shell:git', 'terminal:git'].map((key, index) => ({
      id: `old-rule-${index}`, key, decision: 'allow', label: 'Fictional legacy rule', createdAt: 1,
    })) }), { mode: 0o600 });
    writeFileSync(join(data, 'bots.json'), JSON.stringify([{
      id: botId, threadId, name: 'Bud', title: '', description: '', notifications: false, color: 'green', unread: false,
      modelSelection: { instanceId: 'hermes', model: 'default' }, resumeCursors: {}, createdAt: 1,
      ...(mode === 'legacy' ? { autoApprove: true, alwaysAllow: [memoryTool, 'shell:git'] } : {}),
    }]), { mode: 0o600 });
    const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = (listener.address() as { port: number }).port;
    await new Promise<void>(resolve => listener.close(() => resolve())); base = `http://127.0.0.1:${port}`;
    const { serviceSmokeEnv } = await import(new URL('../scripts/service-smoke-env.mjs', import.meta.url).href);
    child = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], {
      cwd: root, env: {
        ...serviceSmokeEnv({ executable: process.execPath, home: scratch, data, scratch, port }),
        REALBUD_MANAGED_SERVICE: '0', REALBUD_SERVICE_ENTITLEMENT_REQUIRED: '0',
        ...(mode === 'legacy' ? { OMB_TEST_FLEET: '1' } : {}), VITEST: 'true',
      }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    closed = new Promise((resolve, reject) => { child!.once('close', resolve); child!.once('error', reject); });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', bytes => { logs = (logs + bytes).slice(-12_000); });
    await until(async () => {
      try { return (await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(300) })).json() as { pid?: number }).pid === child?.pid; }
      catch { return false; }
    }, 'isolated bootstrap');
    token = (await (await fetch(base + '/api/session')).json() as { token: string }).token;
  }, 20_000);
  afterAll(async () => {
    await stop();
    const exited = (pid: number) => {
      try { process.kill(pid, 0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    };
    for (let attempt = 0; attempt < 50 && ![...peerPids].every(exited); attempt++) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect([...peerPids].every(exited), 'Owned ACP peers must exit before their fixture is removed').toBe(true);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it.each(['bots', 'threads'] as const)('keeps complete memory prose manual and forces once through /%s/respond', async route => {
    const before = await start();
    const { card } = await waiting(before);
    expect(card).toMatchObject({ tool: memoryTool, approvalPolicy: 'once', memoryReview: { description, content, complete: true } });
    expect(card).not.toHaveProperty('allowKey');
    expect(card).not.toHaveProperty('fence');
    expect((await bot()).busy).toBe(true);
    expect((await api('/api/rules')).body.rules.some((rule: { key: string }) => rule.key === memoryTool)).toBe(true);
    if (mode === 'legacy') expect(await bot()).toMatchObject({ autoApprove: true, alwaysAllow: expect.arrayContaining([memoryTool]) });
    const result = await respond(route, card);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    await settled(); expect(chosen()).toBe('allow-once');
    expect((await respond(route, card)).status).toBe(409);
  });

  it('does not let driver fullAuto bypass native memory approval', async () => {
    const { card } = await waiting(await start(memoryScript(), true));
    expect(card.tool).toBe(memoryTool);
    expect((await respond('threads', card)).status).toBe(200);
    await settled(); expect(chosen()).toBe('allow-once');
  });

  it('rejects remembered memory permissions and portal rule expansion before releasing the live request', async () => {
    const originalRules = (await api('/api/rules')).body;
    for (const key of [memoryTool, `${memoryTool}:anything`, memoryTool.toUpperCase()]) {
      expect((await api('/api/rules', 'POST', { key, decision: 'allow' })).status).toBe(400);
    }
    if (mode === 'legacy') {
      expect((await api(`/api/bots/${botId}`, 'PATCH', { alwaysAllow: [memoryTool] })).status).toBe(400);
    }
    const { card } = await waiting(await start());
    for (const route of ['bots', 'threads'] as const) {
      expect((await respond(route, card, { rule: { surface: 'portal-read', origin: 'fictional.example.invalid' } })).status).toBe(400);
      expect((await bot()).messages.some(message => message.card && message.card.requestId === card.requestId && !message.card.answered)).toBe(true);
    }
    expect((await api('/api/rules')).body).toEqual(originalRules);
    expect((await respond('threads', card, { behavior: 'deny', scope: 'once' })).status).toBe(200);
    await settled(); expect(chosen()).toBe('reject');
  });

  it.each([
    { name: 'incomplete envelope', input: memoryScript({ title: 'Save to memory: missing the complete native payload' }) },
    ...[
      { description: 'Save to memory: replace in memory', command: 'old: selector\nnew: replacement' },
      { description: 'Save to memory: remove from user profile', command: 'partial selector' },
      { description: 'Save to memory: apply 1 op(s) to memory', command: '- replace: selector -> replacement' },
    ].map(rawInput => ({ name: rawInput.description, input: memoryScript({ rawInput, title: `${rawInput.description}: ${rawInput.command}` }) })),
  ])('cancels $name rather than approving an incomplete review or a shell grant', async ({ input }) => {
    // Replace/remove expose only a substring selector, not the full existing
    // entry that would change. No amount of inline approval may certify it.
    const before = await start(input, true);
    await settled();
    expect(chosen()).toBeNull();
    expect((await bot()).messages.filter(message => !before.has(message.id)).some(message => message.card?.requestId)).toBe(false);
  });

  it('retains the identified terminal session flow separately from memory', async () => {
    if (mode === 'legacy') expect((await api(`/api/bots/${botId}`, 'PATCH', { autoApprove: false, alwaysAllow: [] })).status).toBe(200);
    const { card } = await waiting(await start({ permission: true, tool: 'execute', rawInput: { name: 'terminal', command: 'echo fictional' }, title: 'echo fictional' }));
    expect(card.tool).toBe('terminal'); expect(card).not.toHaveProperty('approvalPolicy');
    expect((await respond('threads', card)).status).toBe(200);
    await settled(); expect(chosen()).toBe('allow_session');
  });
});
