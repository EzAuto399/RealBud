/** Actual Product Ask → ACP → private MCP → native pending → staff decision. */
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { chmod, copyFile, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareNativeMemoryFixture } from './testing/native-memory-fixture.ts';
import { MEMORY_REVIEW_API as reviews } from '../shared/hermes-memory-review.ts';
import type { MemoryProposalInput, MemoryProposalResult } from '../shared/hermes-memory-proposal.ts';

const runtime = process.env.REALBUD_TEST_HERMES_RUNTIME;
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const peer = join(root, 'server/testing/memory-proposal-acp-cli.mjs');
const payload: MemoryProposalInput = { requestId: 'conversation-preference-1', payload: { target: 'memory', action: 'replace', old_text: 'concise', content: 'Prefers detailed updates.' } };
describe.skipIf(!runtime || process.platform === 'win32')('Product Ask typed native memory proposals over actual HTTP', () => {
  let scratch = '', data = '', script = '', output = '', base = '', token = '', logs = '';
  let child: ChildProcess | undefined, closed: Promise<unknown> | undefined;
  let native: Awaited<ReturnType<typeof prepareNativeMemoryFixture>>;
  const ownedPeers = new Set<number>();
  let recordedId = '';
  async function api(path: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + path, { method, signal: AbortSignal.timeout(30_000), headers: { 'x-realbud-session': token, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() as any };
  }
  async function until<T>(read: () => Promise<T | false>, label: string): Promise<T> {
    const deadline = Date.now() + 35_000;
    while (Date.now() < deadline) {
      if (child && (child.exitCode !== null || child.signalCode)) throw new Error(`Fictional service exited during ${label}: ${logs}`);
      const value = await read(); if (value !== false) return value;
      await new Promise(done => setTimeout(done, 40));
    }
    throw new Error(`Timed out during ${label}: ${logs}`);
  }
  async function peerState() {
    try { const value = JSON.parse(await readFile(output, 'utf8')); ownedPeers.add(value.pid); return value; } catch { return null; }
  }
  async function ask(input: unknown = payload, tool = 'memory_propose') {
    const previous = (await peerState())?.calls.length ?? 0;
    await writeFile(script, JSON.stringify({ input, tool }), { mode: 0o600 });
    const sent = await api('/api/bots/bud/messages', 'POST', { text: 'Propose the next fictional conversational preference for review.' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    const peer = await until(async () => { const value = await peerState(); return value && value.calls.length > previous ? value : false; }, 'private proposal tool result');
    await until(async () => !(await api('/api/bots')).body.bots.find((bot: { id: string }) => bot.id === 'bud').busy, 'Ask completion');
    return peer.calls.at(-1).result;
  }
  beforeAll(async () => {
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'RealBud proposal HTTP '))); await chmod(scratch, 0o700);
    data = join(scratch, 'data'); script = join(scratch, 'input.json'); output = join(scratch, 'peer.json');
    native = await prepareNativeMemoryFixture(data, runtime!);
    const peerCli = join(scratch, 'fictional-hermes.mjs'); await copyFile(peer, peerCli); await chmod(peerCli, 0o700);
    await native.privateWrite(join(data, 'config.json'), JSON.stringify({ instances: { hermes: {
      driver: 'hermesAgent', config: { cli: peerCli, fullAuto: true }, environment: { FAKE_MEMORY_SCRIPT: script, FAKE_MEMORY_OUTPUT: output },
    } } }));
    await native.privateWrite(join(data, 'bots.json'), JSON.stringify([{ id: 'bud', threadId: 'proposal-http-chat', name: 'Bud', title: '', description: '', notifications: false,
      color: 'green', unread: false, modelSelection: { instanceId: 'hermes', model: 'default' }, resumeCursors: {}, createdAt: 1 }]));
    const listener = createServer(); listener.listen(0, '127.0.0.1'); await once(listener, 'listening');
    const port = (listener.address() as { port: number }).port; await new Promise<void>(done => listener.close(() => done())); base = `http://127.0.0.1:${port}`;
    const { serviceSmokeEnv } = await import(new URL('../scripts/service-smoke-env.mjs', import.meta.url).href);
    child = spawn(process.execPath, [join(root, 'server/bootstrap.ts')], { cwd: root, env: {
      ...serviceSmokeEnv({ executable: process.execPath, home: data, data, scratch, port }),
      REALBUD_MANAGED_SERVICE: '0', REALBUD_SERVICE_ENTITLEMENT_REQUIRED: '0', VITEST: 'true',
    }, stdio: ['ignore', 'pipe', 'pipe'] });
    closed = new Promise((done, fail) => { child!.once('close', done); child!.once('error', fail); });
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', bytes => { logs = (logs + bytes).slice(-12_000); });
    await until(async () => { try { return (await (await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) })).json() as { pid?: number }).pid === child?.pid; } catch { return false; } }, 'owned bootstrap');
    token = (await (await fetch(base + '/api/session')).json() as { token: string }).token;
  }, 45_000);
  afterAll(async () => {
    if (child && child.exitCode === null && !child.signalCode) {
      child.kill('SIGTERM'); const force = setTimeout(() => child?.kill('SIGKILL'), 5000); try { await closed; } finally { clearTimeout(force); }
    }
    const exited = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; } };
    for (let attempt = 0; attempt < 100 && ![...ownedPeers].every(exited); attempt++) await new Promise(done => setTimeout(done, 30));
    expect([...ownedPeers].every(exited), 'Every owned peer exits before deleting its scratch profile').toBe(true);
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  it('publishes a native pending replacement from Product Ask without applying memory or exposing approval authority', async () => {
    const before = await readFile(native.memoryFile, 'utf8'), response = await ask();
    const diagnosis = response.isError ? { response, list: await api(reviews), pending: await readdir(native.pendingDirectory) } : response;
    expect(response.isError, JSON.stringify(diagnosis)).not.toBe(true);
    const proposed = JSON.parse(response.content[0].text) as MemoryProposalResult; recordedId = proposed.id;
    expect(proposed).toEqual({ version: 1, id: expect.stringMatching(/^[a-f0-9]{8}$/), reviewLocation: 'You → Bud → Bud’s memory' });
    expect((await peerState()).discovery).toEqual([['memory_propose']]);
    expect(await readFile(native.memoryFile, 'utf8')).toBe(before);
    const staged = JSON.parse(await readFile(join(native.pendingDirectory, `${recordedId}.json`), 'utf8'));
    expect(staged).toMatchObject({ subsystem: 'memory', origin: 'foreground', payload: payload.payload });
    const list = await api(reviews); expect(list.status).toBe(200); expect(list.body.items).toContainEqual(expect.objectContaining({ id: recordedId, state: 'pending', origin: 'foreground' }));
    const preview = await api(`${reviews}/${recordedId}`); expect(preview.status).toBe(200);
    expect(preview.body.before).toBe(before); expect(preview.body.after).toBe('Prefers detailed updates.\n§\nUse Australian English.');
  }, 60_000);

  it('reuses the durable proposal identity on a new turn and cannot turn it into a tool approval', async () => {
    const reply = await ask(); expect(JSON.parse(reply.content[0].text).id).toBe(recordedId);
    expect((await readdir(native.pendingDirectory)).filter(name => name.endsWith('.json'))).toEqual([`${recordedId}.json`]);
    const blocked = await ask({ ...payload, decision: 'approve' }); expect(blocked.isError).toBe(true);
    const wrongTool = await ask({ id: recordedId }, 'memory_approve'); expect(wrongTool.isError).toBe(true);
    expect(await readFile(native.memoryFile, 'utf8')).toBe('Prefers concise updates.\n§\nUse Australian English.');
    expect((await api(`${reviews}/${recordedId}`, 'GET')).status).toBe(200);
  }, 60_000);

  it('applies only through the authenticated review decision and never recreates completed pending work on conversation retry', async () => {
    const preview = await api(`${reviews}/${recordedId}`);
    const decision = await api(`${reviews}/${recordedId}/decision`, 'POST', { expectedDigest: preview.body.reviewDigest, decision: 'approve' });
    expect(decision.status, JSON.stringify(decision.body)).toBe(200); expect(await readFile(native.memoryFile, 'utf8')).toBe(preview.body.after);
    expect(JSON.parse((await ask()).content[0].text).id).toBe(recordedId);
    expect((await readdir(native.pendingDirectory)).filter(name => name.endsWith('.json'))).toEqual([]);
    expect((await api(reviews)).body.items).toContainEqual(expect.objectContaining({ id: recordedId, state: 'applied' }));
    const changed = await ask({ ...payload, payload: { ...payload.payload, content: 'Another preference.' } }); expect(changed.isError).toBe(true);
    expect(await readFile(native.memoryFile, 'utf8')).toBe(preview.body.after);
  }, 60_000);
});
