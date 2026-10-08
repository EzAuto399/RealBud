// Real HTTP server and ACP adapter; the worker is a fictional ACP script that
// is deleted or replaced under the running service. Chat must keep the task and
// say where Bud is repaired, never echo the worker's path or raw process text.
import { readSessionToken } from './testing/local-session.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER = dirname(fileURLToPath(import.meta.url));
const PORT = 18800 + Math.floor(Math.random() * 10_000), BASE = `http://127.0.0.1:${PORT}`;

describe.skipIf(process.platform === 'win32')('worker deleted or replaced under a running service (real server, fictional worker)', () => {
  let child: ChildProcess | undefined, home = '', workerDir = '', cli = '', session = '', stderr = '';
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-realbud-session': session }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any };
  };
  const bud = async () => (await api('GET', '/api/bots')).body.bots.find((b: { id: string }) => b.id === 'bud');
  const waitFor = async (check: () => Promise<boolean>) => {
    const until = Date.now() + 15_000;
    while (!(await check())) {
      if (Date.now() >= until) throw new Error(`Fixture timed out: ${stderr.slice(-1800)}`);
      await new Promise(r => setTimeout(r, 25));
    }
  };
  const writeWorker = (source: string) => {
    mkdirSync(workerDir, { recursive: true, mode: 0o700 });
    writeFileSync(cli, `#!${process.execPath}\n${source}`);
    chmodSync(cli, 0o755);
  };
  /** Send one request and return what chat persisted after it. */
  const ask = async (text: string) => {
    expect((await api('POST', '/api/bots/bud/messages', { text })).status).toBe(202);
    await waitFor(async () => { const b = await bud(); return !b.busy && b.messages.some((m: any) => m.text === text); });
    const messages = (await bud()).messages as any[];
    const at = messages.findIndex(m => m.text === text);
    return { messages, after: messages.slice(at + 1) };
  };
  const visible = (m: any) => [m.text, m.tool?.name, m.card?.title, m.card?.detail].filter(Boolean).join(' ');
  const expectPathFreeRecovery = (after: any[]) => {
    const shown = after.map(visible).join('\n');
    expect(shown).toMatch(/Set up Bud/);
    expect(shown).not.toContain(home);
    expect(shown).not.toMatch(/fictional-worker|\/synthetic\/|ModuleNotFoundError|exited|spawn|PATH|`/);
  };

  beforeAll(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'realbud-worker-replacement-')));
    mkdirSync(join(home, '.realbud'), { mode: 0o700 });
    workerDir = join(home, 'fictional-worker');
    cli = join(workerDir, 'fictional-worker-acp.mjs');
    const preload = join(home, 'fixture.mjs');
    writeFileSync(preload, `const original=globalThis.fetch;
globalThis.fetch=(url,init) => { if(new URL(String(url)).hostname==='127.0.0.1') return original(url,init); throw new Error('Fixture refuses external network'); };
`);
    writeFileSync(join(home, '.realbud/config.json'), JSON.stringify({ instances: { hermes: { driver: 'hermesAgent', config: { cli } } } }));
    // The worker folder does not exist yet: the service boots, then Ask finds it gone.
    child = spawn(process.execPath, ['--import', preload, join(SERVER, 'index.ts')], { cwd: join(SERVER, '..'), env: { PATH: process.env.PATH, VITEST: 'true', HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr!.on('data', c => { stderr += c; });
    await waitFor(async () => { try { return (await fetch(BASE + '/api/health')).ok; } catch { return false; } });
    session = await readSessionToken(join(home, '.realbud'));
  }, 30_000);
  afterAll(async () => {
    if (child && child.exitCode === null) await new Promise<void>(r => { child!.once('close', () => r()); child!.kill(); setTimeout(() => { child?.kill('SIGKILL'); r(); }, 4000).unref(); });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('worker folder deleted: chat keeps the request and points at Set up Bud without the worker path', async () => {
    rmSync(workerDir, { recursive: true, force: true });
    const { after, messages } = await ask('Fictional request after the worker folder was deleted');
    expect(after.length).toBeGreaterThan(0);
    expectPathFreeRecovery(after);
    expect(messages.some(m => m.text === 'Fictional request after the worker folder was deleted')).toBe(true);
  });

  it('worker replaced by a broken copy: no raw process text or path reaches chat', async () => {
    writeWorker(`process.stderr.write(${JSON.stringify(`${cli}: ModuleNotFoundError at /synthetic/site-packages/fictional`)} + "\\n"); process.exit(3);`);
    const { after } = await ask('Fictional request after the worker was replaced');
    expect(after.length).toBeGreaterThan(0);
    expectPathFreeRecovery(after);
  });

  it('a repaired worker answers again and the earlier requests are still in the task', async () => {
    writeWorker(`const out = v => process.stdout.write(JSON.stringify(v)+'\\n'); let input='';
process.stdin.on('data', chunk => { input+=chunk; let at; while((at=input.indexOf('\\n'))>=0) { const line=input.slice(0,at); input=input.slice(at+1); if(line.trim()) run(JSON.parse(line)); }});
function run(msg) {
 if(msg.method==='initialize') return out({jsonrpc:'2.0',id:msg.id,result:{protocolVersion:1,authMethods:[]}});
 if(msg.method==='session/new') return out({jsonrpc:'2.0',id:msg.id,result:{sessionId:'fictional-session'}});
 if(msg.method!=='session/prompt') return out({jsonrpc:'2.0',id:msg.id,result:{}});
 out({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fictional-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Fictional repaired answer'}}}});
 out({jsonrpc:'2.0',id:msg.id,result:{stopReason:'end_turn'}});
}`);
    const { after, messages } = await ask('Fictional request after repair');
    expect(after.map(m => m.text)).toContain('Fictional repaired answer');
    for (const text of ['Fictional request after the worker folder was deleted', 'Fictional request after the worker was replaced']) {
      expect(messages.some(m => m.text === text)).toBe(true);
    }
  });
});
