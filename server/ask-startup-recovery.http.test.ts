// Real HTTP server and ACP adapter; only external access/worker responses are
// fictional and delayed. This covers setup before an adapter session exists.
import { readSessionToken } from "./testing/local-session.ts";
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer, type ServerResponse } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER = dirname(fileURLToPath(import.meta.url));
const PORT = 18800 + Math.floor(Math.random() * 10_000), BASE = `http://127.0.0.1:${PORT}`;

describe.skipIf(process.platform === 'win32')('Ask startup cancellation and stream reconnect (real server, fake ACP)', () => {
  let child: ChildProcess | undefined, home = '', workerInbox = '', session = '', stderr = '', threadId = '';
  let holdAccess = false, holdMcp = false, holdNextStop = false;
  const access: ServerResponse[] = [], mcp: ServerResponse[] = [], stops: ServerResponse[] = [];
  const workers: string[] = [], seenWorkers = new Set<string>();
  const prompts: string[] = [];
  const deniedApprovals: string[] = [];
  const accessBody = () => ({ configured: true, checkedAt: new Date().toISOString(), services: { gmail: { connected: true, status: 'ACTIVE', accounts: [{ id: 'fictional-account', status: 'ACTIVE' }], accountSelectionRequired: false } }, tools: { available: true, names: ['GMAIL_LIST_THREADS'] } });
  const reply = (res: ServerResponse, value: unknown) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(value)); };
  const fixture = createServer((req, res) => {
    if (req.url?.startsWith('/denied/')) { deniedApprovals.push(req.url.slice('/denied/'.length)); reply(res, {}); return; }
    if (req.url === '/access') { if (holdAccess) access.push(res); else reply(res, accessBody()); return; }
    if (req.url === '/mcp-setup') { if (holdMcp) mcp.push(res); else reply(res, { mcp: { url: `${origin}/mcp` } }); return; }
    if (req.url === '/stop') { if (holdNextStop) { holdNextStop = false; stops.push(res); } else reply(res, {}); return; }
    reply(res, {});
  });
  let origin = '';
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', 'x-realbud-session': session }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as any };
  };
  const bud = async () => (await api('GET', '/api/bots')).body.bots.find((b: { id: string }) => b.id === 'bud');
  // Fixture coordination uses only Bud's existing writable workroom. The fake
  // worker must obey the production loopback allowlist, just like real Hermes.
  const collectWorkerPrompts = () => {
    if (!workerInbox) return;
    for (const name of readdirSync(workerInbox).filter(name => name.endsWith('.json')).sort()) {
      if (seenWorkers.has(name)) continue;
      const request = JSON.parse(readFileSync(join(workerInbox, name), 'utf8')) as { text: string };
      seenWorkers.add(name); prompts.push(request.text); workers.push(join(workerInbox, `${name}.release`));
    }
  };
  const waitFor = async (check: () => boolean | Promise<boolean>) => {
    const until = Date.now() + 12_000;
    for (;;) {
      collectWorkerPrompts();
      if (await check()) return;
      if (Date.now() >= until) throw new Error(`Fixture timed out: ${stderr.slice(-1800)}`);
      await new Promise(r => setTimeout(r, 25));
    }
  };
  const finishWorkers = () => {
    collectWorkerPrompts();
    for (const path of workers.splice(0)) writeFileSync(path, '', { mode: 0o600 });
  };
  const settle = async () => { finishWorkers(); await waitFor(async () => !(await bud()).busy); };
  const recipeApproval = async (requestId: string) => {
    child!.send({ fixture: 'recipe-approval', threadId, requestId });
    await waitFor(async () => (await bud()).messages.some((message: any) => message.card?.requestId === requestId));
    expect((await bud()).messages.find((message: any) => message.card?.requestId === requestId).card.title).toBe('Approval needed');
    expect(deniedApprovals).not.toContain(requestId);
    child!.send({ fixture: 'resolve-recipe-approval', threadId, requestId });
    await waitFor(async () => (await bud()).messages.find((message: any) => message.card?.requestId === requestId)?.card.answered === 'deny');
  };
  const hello = async () => {
    const controller = new AbortController();
    const response = await fetch(`${BASE}/api/events?session=${encodeURIComponent(session)}`, { signal: controller.signal });
    const reader = response.body!.getReader(); let text = '';
    try {
      while (!text.includes('\n\n')) { const value = await reader.read(); if (value.done) throw new Error('SSE ended'); text += new TextDecoder().decode(value.value); }
      return JSON.parse(text.slice(6, text.indexOf('\n\n')));
    } finally { controller.abort(); await reader.cancel().catch(() => {}); }
  };
  beforeAll(async () => {
    await new Promise<void>(r => fixture.listen(0, '127.0.0.1', r));
    origin = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
    home = mkdtempSync(join(tmpdir(), 'realbud-ask-startup-'));
    mkdirSync(join(home, '.realbud'), { mode: 0o700 });
    workerInbox = join(home, '.realbud/vault/bud-work/startup-fixture');
    mkdirSync(workerInbox, { recursive: true, mode: 0o700 });
    const cli = join(home, 'fictional-acp.mjs'), preload = join(home, 'fixture.mjs');
    writeFileSync(cli, `#!${process.execPath}
import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
if(process.argv.includes('--version')) { console.log('fictional-acp 1'); process.exit(0); }
const out = v => process.stdout.write(JSON.stringify(v)+'\\n');
const reply = (id,result) => out({jsonrpc:'2.0',id,result});
const pending = new Set(); let input='';
process.stdin.on('data', chunk => { input+=chunk; let at; while((at=input.indexOf('\\n'))>=0) { const line=input.slice(0,at); input=input.slice(at+1); if(line.trim()) void run(JSON.parse(line)); }});
async function run(msg) {
 if(msg.method==='initialize') return reply(msg.id,{protocolVersion:1,authMethods:[{id:'fictional-auth'}]});
 if(msg.method==='session/new') return reply(msg.id,{sessionId:'fictional-session'});
 if(msg.method==='session/cancel') { for(const id of pending) reply(id,{stopReason:'cancelled'}); pending.clear(); return; }
 if(msg.method!=='session/prompt') return reply(msg.id,{});
 pending.add(msg.id);
 out({jsonrpc:'2.0',method:'session/update',params:{sessionId:'fictional-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Fictional streamed answer'}}}});
 const request=join(${JSON.stringify(workerInbox)}, randomUUID()+'.json');
 writeFileSync(request+'.tmp',JSON.stringify({text:msg.params.prompt[0].text}),{mode:0o600});
 renameSync(request+'.tmp',request);
 while(pending.has(msg.id) && !existsSync(request+'.release')) await new Promise(resolve=>setTimeout(resolve,20));
 if(pending.delete(msg.id)) reply(msg.id,{stopReason:'end_turn'});
}
`);
    chmodSync(cli, 0o755);
    writeFileSync(preload, `import { ConnectedAppAccessCache } from ${JSON.stringify(new URL('./connected-app-access.ts', import.meta.url).href)};
import { EventBus } from ${JSON.stringify(new URL('./harness/bus.ts', import.meta.url).href)};
import { HermesAgentDriver } from ${JSON.stringify(new URL('./drivers/acp/hermes.ts', import.meta.url).href)};
const create=HermesAgentDriver.create;
HermesAgentDriver.create=async input => { const instance=await create(input), interrupt=instance.adapter.interruptTurn, respond=instance.adapter.respondToRequest;
 instance.adapter.interruptTurn=async threadId => { await interrupt(threadId); await fetch(${JSON.stringify(origin + '/stop')}); };
 instance.adapter.respondToRequest=async (threadId,requestId,decision) => { if(decision.behavior==='deny') await fetch(${JSON.stringify(origin + '/denied/')}+encodeURIComponent(requestId)); return respond(threadId,requestId,decision); };
 return instance;
};
// Publish the same turn-ID-less permission events as RealBud's recipe channel.
// This tests the actual server subscriber and persisted approval card without a
// browser, a customer account or a live recipe action.
let runtimeBus;
const subscribe=EventBus.prototype.subscribe;
EventBus.prototype.subscribe=function(listener) { runtimeBus=this; return subscribe.call(this,listener); };
process.on('message',message => {
 if(!message?.fixture || !runtimeBus) return;
 const base={eventId:'fictional-'+message.requestId,provider:'hermesAgent',providerInstanceId:'hermes',threadId:message.threadId,requestId:message.requestId,createdAt:new Date().toISOString()};
 if(message.fixture==='recipe-approval') runtimeBus.publish({...base,type:'request.opened',requestType:'permission',tool:'fictional_recipe_action',params:{},summary:'Fictional recipe approval',approvalPolicy:'once',fence:{surface:'portal-submit',origin:'https://fictional.example',ruleOffer:null}});
 if(message.fixture==='resolve-recipe-approval') runtimeBus.publish({...base,type:'request.resolved',behavior:'deny',source:'user'});
});
// Simulate an adapter delivering a late old completion after a replacement
// has synchronously registered. The actual server subscriber must fence it.
const publish=EventBus.prototype.publish, previousTurns=new Map();
EventBus.prototype.publish=function(event) {
  const previous=previousTurns.get(event.threadId);
  if(event.type==='turn.started') previousTurns.set(event.threadId,event);
  publish.call(this,event);
  if(event.type==='turn.started' && previous) {
    publish.call(this,{...previous,type:'content.delta',streamKind:'assistant_text',delta:'OBSOLETE ANSWER'});
    publish.call(this,{...previous,type:'turn.completed',ok:true,stopReason:'end_turn',cost:null});
  }
};
const original=globalThis.fetch;
ConnectedAppAccessCache.prototype.refresh=async function() { const response=await original(${JSON.stringify(origin + '/access')}); if(!response.ok) throw new Error('Fictional late access failure'); return response.json(); };
globalThis.fetch=(url,init) => { const text=String(url); if(text==='https://backend.composio.dev/api/v3.1/tool_router/session') return original(${JSON.stringify(origin + '/mcp-setup')},init); if(new URL(text).hostname==='127.0.0.1') return original(url,init); throw new Error('Fixture refuses external network'); };
`);
    writeFileSync(join(home, '.realbud/config.json'), JSON.stringify({ composio: { key: 'ak_fictional_fixture_only', userId: 'fictional-user' }, instances: { hermes: { driver: 'hermesAgent', config: { cli } } } }));
    child = spawn(process.execPath, ['--import', preload, join(SERVER, 'index.ts')], { cwd: join(SERVER, '..'), env: { PATH: process.env.PATH, VITEST: 'true', HOME: home, USERPROFILE: home, OMB_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stderr!.on('data', c => { stderr += c; });
    await waitFor(async () => { try { return (await fetch(BASE + '/api/health')).ok; } catch { return false; } });
    session = await readSessionToken(join(home, '.realbud'));
    threadId = (await bud()).threadId;
  }, 20_000);
  afterAll(async () => {
    for (const res of access.splice(0)) reply(res, accessBody());
    for (const res of mcp.splice(0)) reply(res, { mcp: { url: `${origin}/mcp` } });
    for (const res of stops.splice(0)) reply(res, {});
    finishWorkers();
    if (child && child.exitCode === null) await new Promise<void>(r => { child!.once('close', () => r()); child!.kill(); setTimeout(() => { child?.kill('SIGKILL'); r(); }, 4000).unref(); });
    fixture.closeAllConnections(); await new Promise<void>(r => fixture.close(() => r()));
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('Stop followed by a replacement never dispatches old pending access or clears the new busy turn', async () => {
    holdAccess = true; const before = prompts.length;
    expect((await api('POST', '/api/bots/bud/messages', { text: 'Fictional old stopped request' })).status).toBe(202);
    await waitFor(() => access.length === 1);
    expect((await api('POST', '/api/bots/bud/messages', { text: 'Fictional concurrent duplicate' })).status).toBe(409);
    expect(access).toHaveLength(1); // Busy admission prevents duplicate Ask discovery.
    expect((await api('POST', '/api/bots/bud/interrupt', {})).status).toBe(200);
    holdAccess = false;
    expect((await api('POST', '/api/bots/bud/messages', { text: 'Fictional replacement request' })).status).toBe(202);
    await waitFor(() => prompts.length === before + 1);
    reply(access.shift()!, accessBody());
    await new Promise(r => setTimeout(r, 150));
    expect(prompts).toHaveLength(before + 1);
    expect(prompts.at(-1)?.split('[Latest user request:]').at(-1)).toMatch(/Fictional replacement request$/);
    expect((await bud()).busy).toBe(true);
    await settle();
  });

  it('steer fences an old access rejection while preserving the replacement', async () => {
    holdAccess = true; const before = prompts.length;
    await api('POST', '/api/bots/bud/messages', { text: 'Fictional rejected old startup' });
    await waitFor(() => access.length === 1);
    holdAccess = false;
    expect((await api('POST', '/api/bots/bud/steer', { text: 'Fictional steered replacement' })).status).toBe(202);
    await waitFor(() => prompts.length === before + 1);
    const rejected = access.shift()!; rejected.statusCode = 503; reply(rejected, {});
    await new Promise(r => setTimeout(r, 150));
    expect((await bud()).busy).toBe(true);
    expect(prompts).toHaveLength(before + 1);
    expect((await bud()).messages.at(-1)?.text).not.toContain('could not answer');
    await settle();
  });

  it('Stop during awaited MCP setup prevents dispatch even with no replacement', async () => {
    holdMcp = true; const before = prompts.length;
    await api('POST', '/api/bots/bud/messages', { text: 'Fictional stop during tool setup' });
    await waitFor(() => mcp.length === 1);
    expect((await api('POST', '/api/bots/bud/interrupt', {})).status).toBe(200);
    // The old setup is still pending; a recipe has independent authority.
    await recipeApproval('fictional-recipe-after-setup-stop');
    holdMcp = false; reply(mcp.shift()!, { mcp: { url: `${origin}/mcp` } });
    await new Promise(r => setTimeout(r, 150));
    expect(prompts).toHaveLength(before);
    expect((await bud()).busy).toBe(false);
    await recipeApproval('fictional-recipe-after-setup-cleanup');
  });

  it('Stop while idle does not hide a subsequent recipe approval', async () => {
    expect((await bud()).busy).toBe(false);
    expect((await api('POST', '/api/bots/bud/interrupt', {})).status).toBe(200);
    await recipeApproval('fictional-recipe-after-idle-stop');
  });

  it('duplicate Stop reports the stopped turn once when no replacement starts', async () => {
    const before = prompts.length;
    const stoppedCount = async () => (await bud()).messages.filter((message: any) => message.text === 'Stopped. Bud will not continue this turn.').length;
    const messagesBefore = await stoppedCount();
    await api('POST', '/api/bots/bud/messages', { text: 'Fictional duplicate Stop without replacement' });
    await waitFor(() => prompts.length === before + 1);
    holdNextStop = true;
    const slowStop = api('POST', '/api/bots/bud/interrupt', {});
    await waitFor(() => stops.length === 1);
    expect((await api('POST', '/api/bots/bud/interrupt', {})).status).toBe(200);
    reply(stops.shift()!, {});
    expect((await slowStop).status).toBe(200);
    expect(await stoppedCount()).toBe(messagesBefore + 1);
    finishWorkers();
  });

  it('a slow duplicate Stop cannot settle a replacement started after the other Stop finished', async () => {
    const before = prompts.length;
    await api('POST', '/api/bots/bud/messages', { text: 'Fictional turn before duplicate stop' });
    await waitFor(() => prompts.length === before + 1);
    holdNextStop = true;
    const slowStop = api('POST', '/api/bots/bud/interrupt', {});
    await waitFor(() => stops.length === 1);
    expect((await api('POST', '/api/bots/bud/interrupt', {})).status).toBe(200);
    finishWorkers();
    await api('POST', '/api/bots/bud/messages', { text: 'Fictional newest replacement' });
    await waitFor(() => prompts.length === before + 2);
    reply(stops.shift()!, {});
    expect((await slowStop).status).toBe(200);
    expect((await bud()).busy).toBe(true);
    await settle();
  });

  it('reconnect restores active streamed text and removes it when the durable answer finishes', async () => {
    const before = prompts.length;
    await api('POST', '/api/bots/bud/messages', { text: 'Fictional reconnect test' });
    await waitFor(() => prompts.length === before + 1);
    expect((await api('POST', `/api/bots/bud/tasks/${threadId}`, {})).status).toBe(409);
    expect((await hello()).streams).toEqual([expect.objectContaining({ threadId, text: 'Fictional streamed answer', reasoning: '' })]);
    await settle();
    expect((await hello()).streams).toEqual([]);
    expect((await bud()).messages.at(-1)?.text).toBe('Fictional streamed answer');
  });

  it('keeps the explicit usage refresh behind the session gate and returns the current link state', async () => {
    const refused = await fetch(BASE + '/api/office-link/usage/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(refused.status).toBe(401);
    expect(await api('POST', '/api/office-link/usage/refresh', {})).toMatchObject({ status: 200, body: { usage: { state: 'not-linked' } } });
  });
});
