import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDirs } from '../../config.ts';
import type { ProviderDriver, ProviderInstance, SendTurnInput } from '../../contracts.ts';
import { recordEvents, type EventRecorder } from '../../testing/events.ts';
import { ServiceEntitlementError } from '../../service-entitlement.ts';
import { HermesAgentDriver } from './hermes.ts';
import { GrokAgentDriver } from './grok.ts';
import type { AcpConfig } from './core.ts';
import { MEMORY_PROPOSAL_REVIEW_LOCATION, type MemoryProposalInput, type MemoryProposalResult } from '../../../shared/hermes-memory-proposal.ts';

const { assertCapability } = vi.hoisted(() => ({ assertCapability: vi.fn() }));
vi.mock('../../managed-service.ts', () => ({ managedService: { assertCapability } }));

// Only the provider process is fictional. It discovers the actual MCP broker
// before acknowledging session/new and holds each prompt for controlled tests.
const peer = `#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import readline from 'node:readline';
let servers = [], discovery = [], count = 0, prompt = null, prePromptCall = null;
const out = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
function dump() {
  const path=process.env.MEMORY_PEER_DUMP, tmp=path+'.'+process.pid;
  writeFileSync(tmp, JSON.stringify({pid:process.pid,servers,discovery,prePromptCall,count,active:prompt!==null}));
  renameSync(tmp,path);
}
dump();
async function handle(msg) {
  if(msg.method==='initialize') return out(msg.id,{protocolVersion:1,authMethods:[{id:'cached_token'}]});
  if(msg.method==='authenticate'||msg.method==='session/set_mode') return out(msg.id,{});
  if(msg.method==='session/new'||msg.method==='session/load') {
    servers=msg.params.mcpServers;
    const memory=servers.find(x=>x.name==='memory-proposals');
    if(memory) for(const method of ['initialize','tools/list']) {
      const response=await fetch(memory.url,{method:'POST',headers:{'content-type':'application/json',...Object.fromEntries(memory.headers.map(x=>[x.name,x.value]))},body:JSON.stringify({jsonrpc:'2.0',id:'discovery-'+method,method,params:method==='initialize'?{protocolVersion:'2025-11-25'}:{}})});
      discovery.push({method,status:response.status,body:await response.json()});
    }
    if(memory) {
      const response=await fetch(memory.url,{method:'POST',headers:{'content-type':'application/json',...Object.fromEntries(memory.headers.map(x=>[x.name,x.value]))},body:JSON.stringify({jsonrpc:'2.0',id:'before-prompt',method:'tools/call',params:{name:'memory_propose',arguments:{requestId:'before-prompt',payload:{action:'add',target:'memory',content:'Fictional premature proposal.'}}}})});
      prePromptCall=await response.json();
    }
    dump(); return out(msg.id,{sessionId:'fictional-memory-session'});
  }
  if(msg.method==='session/prompt') { count++; prompt=msg.id; dump(); return; }
  if(msg.method==='session/cancel') { if(prompt!==null) { const id=prompt;prompt=null;out(id,{stopReason:'cancelled'});dump(); } return; }
}
setInterval(()=>{
  let control;try{control=JSON.parse(readFileSync(process.env.MEMORY_PEER_CONTROL,'utf8'));}catch{return;}
  if(prompt!==null&&control.finish>=count) {const id=prompt;prompt=null;out(id,{stopReason:'end_turn'});dump();}
},10).unref();
const rl=readline.createInterface({input:process.stdin,terminal:false});
rl.on('line',line=>{try{void handle(JSON.parse(line)).catch(()=>process.exit(2));}catch{process.exit(3);}});
rl.on('close',()=>process.exit(0));
`;

type Descriptor = { name: string; type: string; url: string; headers: { name: string; value: string }[] };
type PeerState = { pid: number; servers: Descriptor[]; discovery: any[]; prePromptCall: any; count: number; active: boolean };
type Integration = NonNullable<SendTurnInput['integrations']>['memoryProposals'];
const proposal = (requestId: string): MemoryProposalInput => ({ requestId, payload: { action: 'add', target: 'memory', content: 'Fictional office prefers weekly summaries.' } });
const saved = (id = '1234abcd'): MemoryProposalResult => ({ version: 1, id, reviewLocation: MEMORY_PROPOSAL_REVIEW_LOCATION });

describe('Hermes typed memory proposal ACP capability', () => {
  let scratch: string, dump: string, control: string, script: string;
  let instance: ProviderInstance | undefined, recorder: EventRecorder | undefined;
  const pids = new Set<number>();
  const threadId = 'fictional-memory-proposals';

  beforeEach(() => {
    assertCapability.mockReset(); ensureDirs(); pids.clear();
    scratch = mkdtempSync(join(tmpdir(), 'realbud-memory-acp-'));
    dump = join(scratch, 'peer.json'); control = join(scratch, 'control.json'); script = join(scratch, 'peer.mjs');
    writeFileSync(script, peer, { mode: 0o700 }); writeFileSync(control, JSON.stringify({ finish: 0 }), { mode: 0o600 });
  });
  afterEach(async () => {
    try { state(); } catch { /* A failed spawn may have produced no fixture record. */ }
    recorder?.stop(); await instance?.dispose();
    await vi.waitFor(() => {
      for (const pid of pids) {
        let alive = true; try { process.kill(pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
        expect(alive, 'Owned fictional ACP process must exit before deleting its files').toBe(false);
      }
    });
    rmSync(scratch, { recursive: true, force: true }); instance = undefined; recorder = undefined;
  });
  async function create(driver: ProviderDriver<AcpConfig> = HermesAgentDriver) {
    instance = await driver.create({ instanceId: 'fictional-memory-worker', displayName: 'Fictional memory worker', enabled: true,
      config: { cli: script, fullAuto: false, workspace: scratch },
      environment: { MEMORY_PEER_DUMP: dump, MEMORY_PEER_CONTROL: control, NODE_V8_COVERAGE: '' } });
    recorder = recordEvents(instance.adapter);
  }
  function state(): PeerState {
    const value = JSON.parse(readFileSync(dump, 'utf8')) as PeerState; pids.add(value.pid); return value;
  }
  async function start(integration?: Integration, expectedCount = 1) {
    const turn = await instance!.adapter.sendTurn({ threadId, text: 'Prepare the fictional memory proposal.',
      ...(integration ? { integrations: { memoryProposals: integration } } : {}) });
    await vi.waitFor(() => { expect(state().count).toBe(expectedCount); expect(state().active).toBe(true); });
    return turn;
  }
  async function finish(turnId: string) {
    writeFileSync(control, JSON.stringify({ finish: state().count }));
    await recorder!.until(event => event.type === 'turn.completed' && event.turnId === turnId);
  }
  function descriptor() { const result = state().servers.find(server => server.name === 'memory-proposals'); expect(result).toBeDefined(); return result!; }
  async function call(server: Descriptor, input: MemoryProposalInput, rpcId: string) {
    const response = await fetch(server.url, { method: 'POST', signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json', ...Object.fromEntries(server.headers.map(header => [header.name, header.value])) },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name: 'memory_propose', arguments: input } }) });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  }
  function expectSaved(response: Awaited<ReturnType<typeof call>>, id: string) {
    expect(response.status).toBe(200); expect(response.body.result.isError).not.toBe(true);
    expect(JSON.parse(response.body.result.content[0].text)).toEqual(saved(id));
  }
  async function expectRevoked(server: Descriptor) {
    const response = await call(server, proposal('revoked'), 'rpc-revoked').catch(() => null);
    if (response) expect(response.status === 403 || response.body?.result?.isError === true).toBe(true);
  }

  it('discovers only a private descriptor before prompting, then dispatches typed proposals', async () => {
    const propose = vi.fn().mockResolvedValue(saved()); await create();
    const turn = await start({ scope: 'host-only-profile-scope', propose });
    const observed = state(), server = descriptor();
    expect(observed.discovery.map(item => item.status)).toEqual([200, 200]);
    expect(observed.discovery[1].body.result.isError).not.toBe(true);
    expect(observed.discovery[1].body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['memory_propose']);
    expect(observed.prePromptCall.result.isError).toBe(true); expect(propose).not.toHaveBeenCalled();
    expect(JSON.stringify(observed.servers)).not.toContain('host-only-profile-scope');
    expect(JSON.stringify(observed.servers)).not.toContain('propose(');
    expect(server).toMatchObject({ name: 'memory-proposals', type: 'http', url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/) });
    expectSaved(await call(server, proposal('first-proposal'), 'first-rpc'), '1234abcd');
    expect(propose).toHaveBeenCalledExactlyOnceWith(proposal('first-proposal'), expect.any(AbortSignal));
    expect(assertCapability).toHaveBeenCalledWith('reasoning');
    await finish(turn.turnId);
  });

  it('reuses a warm session but calls the current turn integration, and denies idle cached calls', async () => {
    const first = vi.fn().mockResolvedValue(saved('1111aaaa')), second = vi.fn().mockResolvedValue(saved('2222bbbb')); await create();
    const one = await start({ scope: 'same-profile', propose: first }); const original = state(), server = descriptor();
    expectSaved(await call(server, proposal('first'), 'rpc-first'), '1111aaaa'); await finish(one.turnId);
    const idle = await call(server, proposal('first'), 'rpc-first');
    expect(idle.body.result.isError).toBe(true); expect(first).toHaveBeenCalledTimes(1);
    const two = await start({ scope: 'same-profile', propose: second }, 2);
    expect(state().pid).toBe(original.pid); expect(descriptor()).toEqual(server);
    expectSaved(await call(server, proposal('second'), 'rpc-second'), '2222bbbb');
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
    expect(recorder!.events.filter(event => event.type === 'session.started')).toHaveLength(1);
    await finish(two.turnId);
  });

  it('replaces the warm runtime and revokes the old token when host scope changes', async () => {
    await create(); const first = await start({ scope: 'profile-one', propose: async () => saved() });
    const oldState = state(), oldBroker = descriptor(); await finish(first.turnId);
    writeFileSync(control, JSON.stringify({ finish: 0 }));
    const next = await start({ scope: 'profile-two', propose: async () => saved('2222bbbb') });
    expect(state().pid).not.toBe(oldState.pid); expect(descriptor().url).not.toBe(oldBroker.url);
    await expectRevoked(oldBroker);
    expectSaved(await call(descriptor(), proposal('new'), 'rpc-new'), '2222bbbb'); await finish(next.turnId);
  });

  it('aborts an in-flight proposal on interruption and permits the next same-scope turn', async () => {
    let observedSignal: AbortSignal | undefined;
    const hanging = vi.fn((_input: MemoryProposalInput, signal: AbortSignal) => new Promise<MemoryProposalResult>((_resolve, reject) => {
      observedSignal = signal; signal.addEventListener('abort', () => reject(new Error('Fictional interrupted proposal')), { once: true });
    }));
    await create(); await start({ scope: 'same-profile', propose: hanging }); const server = descriptor();
    const pending = call(server, proposal('interrupted'), 'rpc-interrupted');
    await vi.waitFor(() => expect(hanging).toHaveBeenCalledTimes(1));
    await instance!.adapter.interruptTurn(threadId);
    expect(observedSignal?.aborted).toBe(true); expect((await pending).body.result.isError).toBe(true);
    expect((await call(server, proposal('interrupted'), 'rpc-interrupted')).body.result.isError).toBe(true);
    const replacement = vi.fn().mockResolvedValue(saved('3333cccc'));
    const next = await start({ scope: 'same-profile', propose: replacement }, 2);
    expectSaved(await call(descriptor(), proposal('later'), 'rpc-later'), '3333cccc'); await finish(next.turnId);
  });

  it('aborts pending proposals when a provider finishes its turn', async () => {
    let observedSignal: AbortSignal | undefined;
    const hanging = vi.fn((_input: MemoryProposalInput, signal: AbortSignal) => new Promise<MemoryProposalResult>((_resolve, reject) => {
      observedSignal = signal; signal.addEventListener('abort', () => reject(new Error('Fictional ended turn')), { once: true });
    }));
    await create(); const turn = await start({ scope: 'profile', propose: hanging });
    const pending = call(descriptor(), proposal('finishing'), 'rpc-finishing');
    await vi.waitFor(() => expect(hanging).toHaveBeenCalledTimes(1)); await finish(turn.turnId);
    expect(observedSignal?.aborted).toBe(true); expect((await pending).body.result.isError).toBe(true);
  });

  it('does not release a late old callback result during a new warm turn', async () => {
    let resolveOld!: (value: MemoryProposalResult) => void;
    const oldCallback = vi.fn(() => new Promise<MemoryProposalResult>(resolve => { resolveOld = resolve; }));
    await create(); const first = await start({ scope: 'same-profile', propose: oldCallback }); const server = descriptor();
    const oldCall = call(server, proposal('old-slow'), 'rpc-old-slow');
    await vi.waitFor(() => expect(oldCallback).toHaveBeenCalledTimes(1)); await finish(first.turnId);
    const currentCallback = vi.fn().mockResolvedValue(saved('4444dddd'));
    const current = await start({ scope: 'same-profile', propose: currentCallback }, 2);
    resolveOld(saved('1111aaaa'));
    expect((await oldCall).body.result.isError).toBe(true);
    expectSaved(await call(server, proposal('new-current'), 'rpc-new-current'), '4444dddd');
    expect(currentCallback).toHaveBeenCalledTimes(1); await finish(current.turnId);
  });

  it('holds calls if the current scope drifts or reasoning entitlement expires', async () => {
    const propose = vi.fn().mockResolvedValue(saved()); const integration = { scope: 'profile', propose };
    await create(); const turn = await start(integration), server = descriptor();
    integration.scope = 'changed';
    expect((await call(server, proposal('changed'), 'rpc-changed')).body.result.isError).toBe(true);
    integration.scope = 'profile';
    assertCapability.mockImplementation(() => { throw new ServiceEntitlementError('Fictional service expired.', 402); });
    expect((await call(server, proposal('expired'), 'rpc-expired')).body.result.isError).toBe(true);
    expect(propose).not.toHaveBeenCalled(); assertCapability.mockReset(); await finish(turn.turnId);
  });

  it('does not mount a tool without an integration', async () => {
    await create(); const turn = await start(); expect(state().servers).toEqual([]); await finish(turn.turnId);
  });

  it('revokes a previous warm capability when the next turn has no integration', async () => {
    await create(); const first = await start({ scope: 'profile', propose: async () => saved() });
    const previous = descriptor(), previousPid = state().pid; await finish(first.turnId);
    writeFileSync(control, JSON.stringify({ finish: 0 }));
    const next = await start(); expect(state().servers).toEqual([]); expect(state().pid).not.toBe(previousPid);
    await expectRevoked(previous); await finish(next.turnId);
  });

  it('never mounts the Hermes proposal capability on another ACP driver', async () => {
    const propose = vi.fn().mockResolvedValue(saved()); await create(GrokAgentDriver);
    const turn = await start({ scope: 'profile', propose }); expect(state().servers).toEqual([]);
    expect(propose).not.toHaveBeenCalled(); await finish(turn.turnId);
  });

  it('closes the proposal broker when its runtime is disposed', async () => {
    await create(); const turn = await start({ scope: 'profile', propose: async () => saved() });
    const server = descriptor(); await finish(turn.turnId); await instance!.dispose();
    await expectRevoked(server);
  });
});
