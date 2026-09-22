import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { MEMORY_PROPOSAL_INPUT_BYTES, MEMORY_PROPOSAL_REVIEW_LOCATION, parseMemoryProposalInput, parseMemoryProposalResult, type MemoryProposalInput, type MemoryProposalResult } from '../shared/hermes-memory-proposal.ts';
import { startMemoryProposalBroker, type MemoryProposalBroker } from './hermes-memory-proposal-broker.ts';

const { capability } = vi.hoisted(() => ({ capability: vi.fn() }));
vi.mock('./managed-service.ts', () => ({ managedService: { assertCapability: capability } }));
const input = (): MemoryProposalInput => ({ requestId: 'fictional-request:1', payload: { target: 'memory', action: 'add', content: 'Use Australian English.' } });
const result = (): MemoryProposalResult => ({ version: 1, id: '000000ab', reviewLocation: MEMORY_PROPOSAL_REVIEW_LOCATION });
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

describe('memory proposal strict shared contract', () => {
  it('accepts all native operations and preserves exact valid whitespace and Unicode bytes', () => {
    for (const target of ['memory', 'user'] as const) for (const payload of [
      { target, action: 'add', content: '  Keep\tspacing.\n😀\r\n' },
      { target, action: 'replace', content: 'New preference.', old_text: '  Exact selector\n' },
      { target, action: 'remove', old_text: '  Exact selector\n' },
      { target, action: 'batch', operations: [{ action: 'add', content: 'One' }, { action: 'replace', content: 'Two', old_text: 'One' }, { action: 'remove', old_text: 'Two' }] },
    ]) {
      const value = { requestId: 'fixture._:-123', payload };
      expect(parseMemoryProposalInput(value)).toEqual(value);
    }
  });
  it.each(['', '_bad', '-bad', 'a'.repeat(65), 'a b', 'a/b', 'a\n', 'é'])('rejects invalid request IDs %j', requestId => {
    expect(parseMemoryProposalInput({ ...input(), requestId })).toBeNull();
  });
  it('rejects aliases, extra identity/approval fields, malformed operations and blank selectors', () => {
    const valid = input();
    for (const value of [
      { ...valid, summary: 'Do not expose this' }, { ...valid, identity: 'somebody' }, { ...valid, expectedDigest: 'a'.repeat(64) },
      { ...valid, payload: { ...valid.payload, path: '/private/preferences' } },
      { ...valid, payload: { target: 'user', action: 'delete', old_text: 'One' } },
      { ...valid, payload: { target: 'user', action: 'replace', oldText: 'One', content: 'Two' } },
      { ...valid, payload: { target: 'user', action: 'add', content: ' \t\r\n' } },
      { ...valid, payload: { target: 'user', action: 'remove', old_text: ' \t\r\n' } },
      { ...valid, payload: { target: 'user', action: 'batch', operations: [] } },
      { ...valid, payload: { target: 'user', action: 'batch', operations: Array.from({ length: 101 }, () => ({ action: 'add', content: 'One' })) } },
      { ...valid, payload: { target: 'user', action: 'batch', operations: [{ action: 'add', content: 'One', target: 'memory' }] } },
      { ...valid, payload: { target: 'user', action: 'batch', operations: [{ action: 'batch', operations: [] }] } },
    ]) expect(parseMemoryProposalInput(value)).toBeNull();
  });
  it.each(['\x00', '\x07', '\x0b', '\x0c', '\x1f', '\x7f', '\x80', '\x9f', '\u061c', '\u200e', '\u200f', '\u202a', '\u202e', '\u2066', '\u2069', '\ud800', '\udfff'])('rejects controls and lone surrogates %j in both text fields', unsafe => {
    for (const payload of [{ target: 'memory', action: 'add', content: `x${unsafe}y` }, { target: 'user', action: 'remove', old_text: `x${unsafe}y` }]) expect(parseMemoryProposalInput({ requestId: 'fixture', payload })).toBeNull();
  });
  it('bounds the complete serialized UTF8 input, including multibyte text and JSON escaping', () => {
    const fixed = Buffer.byteLength(JSON.stringify({ requestId: 'a', payload: { target: 'memory', action: 'add', content: '' } }));
    const boundary = { requestId: 'a', payload: { target: 'memory', action: 'add', content: 'x'.repeat(MEMORY_PROPOSAL_INPUT_BYTES - fixed) } };
    expect(parseMemoryProposalInput(boundary)).toEqual(boundary);
    expect(parseMemoryProposalInput({ ...boundary, payload: { ...boundary.payload, content: boundary.payload.content + 'x' } })).toBeNull();
    expect(parseMemoryProposalInput({ ...input(), payload: { target: 'memory', action: 'add', content: '😀'.repeat(17_000) } })).toBeNull();
    expect(parseMemoryProposalInput({ ...input(), payload: { target: 'memory', action: 'add', content: '"'.repeat(33_000) } })).toBeNull();
    expect(parseMemoryProposalInput({ ...input(), payload: { target: 'memory', action: 'add', content: 'x'.repeat(128 * 1024 + 1) } })).toBeNull();
  });
  it('admits only the exact fixed minimal result without contents or approval data', () => {
    expect(parseMemoryProposalResult(result())).toEqual(result());
    for (const bad of [{ ...result(), id: 'ABCDEF01' }, { ...result(), id: '000000ab\n' }, { ...result(), version: 2 }, { ...result(), reviewLocation: 'elsewhere' }, { ...result(), reviewDigest: 'a'.repeat(64) }, { ...result(), content: 'private' }]) expect(parseMemoryProposalResult(bad)).toBeNull();
  });
});

describe('memory proposal authenticated loopback broker', () => {
  let broker: MemoryProposalBroker, active: boolean, nextId: number;
  let propose: ReturnType<typeof vi.fn<(input: MemoryProposalInput, signal: AbortSignal) => Promise<MemoryProposalResult>>>;
  const headers = () => Object.fromEntries(broker.descriptor.headers.map(item => [item.name, item.value]));
  const invoke = async (method: string, params: unknown = {}, id: string | number = ++nextId, extraHeaders: Record<string, string> = {}) => {
    const response = await fetch(broker.descriptor.url, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json', ...extraHeaders }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(5000) });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  const call = (id?: string | number, value: unknown = input()) => invoke('tools/call', { name: 'memory_propose', arguments: value }, id);
  beforeEach(async () => {
    active = true; nextId = 0; capability.mockReset(); propose = vi.fn().mockResolvedValue(result());
    broker = await startMemoryProposalBroker({ isActive: () => active, propose: (value, signal) => propose(value, signal) });
  });
  afterEach(() => { broker?.close(); });

  it('reports staff closure as terminal without exposing diagnostics or creating a replacement capability', async () => {
    propose.mockRejectedValue(Object.assign(new Error('/fictional/private diagnostics'), { code: 'proposal-closed' }));
    const reply = (await call('closed-transport')).body.result;
    expect(reply.isError).toBe(true);
    expect(reply.content[0].text).toMatch(/closed by a person/);
    expect(reply.content[0].text).toMatch(/Do not retry/);
    expect(JSON.stringify(reply)).not.toMatch(/fictional\/private|could not be confirmed/);
    expect((await call('closed-transport')).body.result).toEqual(reply);
    expect(propose).toHaveBeenCalledTimes(1);
    const tools = (await invoke('tools/list')).body.result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(['memory_propose']);
  });

  it('does not trust a late closed result after the proposal capability is revoked', async () => {
    const pending = deferred<MemoryProposalResult>(); propose.mockReturnValue(pending.promise);
    const request = call('revoked-closure'); await vi.waitFor(() => expect(propose).toHaveBeenCalledTimes(1));
    active = false; pending.reject(Object.assign(new Error(), { code: 'proposal-closed' }));
    const result = (await request).body.result;
    expect(result.isError).toBe(true); expect(result.content[0].text).not.toContain('closed by a person');
  });

  it('permits idle discovery but exposes exactly a proposal tool with strict native schemas and no approval tool', async () => {
    active = false; expect(broker.descriptor.name).toBe('memory-proposals'); expect(new URL(broker.descriptor.url).hostname).toBe('127.0.0.1');
    const initialize = await invoke('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'fixture', version: '1' } });
    expect(initialize.body.result.capabilities).toEqual({ tools: {} });
    const discovery = await invoke('tools/list'); const tools = discovery.body.result.tools;
    expect(tools.map((tool: { name: string }) => tool.name)).toEqual(['memory_propose']);
    expect(tools[0].title).toBeTruthy(); expect(tools[0].description).toMatch(/requestId/); expect(tools[0].description).toMatch(/human review/i);
    expect(tools[0].inputSchema.additionalProperties).toBe(false); expect(tools[0].inputSchema.required).toEqual(expect.arrayContaining(['requestId', 'payload']));
    expect(JSON.stringify(tools)).not.toContain('expectedDigest');
    expect((await invoke('ping')).body.result).toEqual({}); expect(propose).not.toHaveBeenCalled(); expect(capability).not.toHaveBeenCalled();
    expect((await call()).body.result.isError).toBe(true); expect(propose).not.toHaveBeenCalled();
  });
  it('rejects foreign hosts, any browser Origin, and missing or wrong tokens before dispatch', async () => {
    // node:http preserves the exact Host override; fetch normalizes it from the URL.
    for (const extra of [{ host: 'attacker.invalid' }, { origin: 'https://attacker.invalid' }, { origin: '' }, { authorization: '' }, { authorization: 'Bearer wrong' }]) {
      const status = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(broker.descriptor.url, { method: 'POST', headers: { ...headers(), ...extra } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
        request.on('error', reject); request.end(JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method: 'tools/call', params: { name: 'memory_propose', arguments: input() } }));
      });
      expect(status).toBe(403);
    }
    expect(propose).not.toHaveBeenCalled();
  });
  it('rejects unsupported tools, routes, bad IDs and malformed JSON-RPC without acting', async () => {
    for (const name of ['memory_approve', 'memory', 'memory_apply', 'memory_close', 'interrupted-close']) expect((await invoke('tools/call', { name, arguments: input() })).body.result.isError).toBe(true);
    for (const method of ['resources/read', 'sampling/createMessage']) expect((await invoke(method)).body.result.isError).toBe(true);
    for (const id of [null, {}, [], 1.5, '', 'x'.repeat(101), 'x\n']) {
      const response = await fetch(broker.descriptor.url, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'memory_propose', arguments: input() } }) });
      expect(response.status).toBe(400);
    }
    expect((await fetch(broker.descriptor.url + '?bad=1', { method: 'POST', headers: headers(), body: '{}' })).status).toBe(405);
    expect((await fetch(broker.descriptor.url, { headers: headers() })).status).toBe(405);
    expect((await fetch(broker.descriptor.url, { method: 'POST', headers: headers(), body: '{' })).status).toBe(400);
    expect(propose).not.toHaveBeenCalled();
  });
  it('never dispatches tools/call notifications and accepts only the initialized notification', async () => {
    const notify = (method: string) => fetch(broker.descriptor.url, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', method, params: { name: 'memory_propose', arguments: input() } }) });
    expect((await notify('tools/call')).status).toBe(400);
    const initialized = await fetch(broker.descriptor.url, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
    expect(initialized.status).toBe(202); expect(propose).not.toHaveBeenCalled();
  });
  it('validates input before dispatch and returns only the exact minimal native result', async () => {
    expect((await call(undefined, { ...input(), approve: true })).body.result.isError).toBe(true);
    const response = await call();
    expect(propose).toHaveBeenCalledOnce(); expect(propose.mock.calls[0][0]).toEqual(input()); expect(propose.mock.calls[0][1]).toBeInstanceOf(AbortSignal);
    expect(response.body.result.structuredContent).toEqual(result()); expect(JSON.parse(response.body.result.content[0].text)).toEqual(result());
    expect(JSON.stringify(response.body)).not.toContain(input().payload.action); expect(capability).toHaveBeenCalledWith('reasoning');
  });
  it('accepts standard MCP metadata without forwarding it and rejects unsupported discovery parameters', async () => {
    const response = await invoke('tools/call', { name: 'memory_propose', arguments: input(), _meta: { progressToken: 'fixture-progress' } });
    expect(response.body.result.structuredContent).toEqual(result()); expect(propose.mock.calls[0][0]).toEqual(input());
    for (const method of ['initialize', 'tools/list', 'ping']) expect((await invoke(method, { path: '/private/ignored' })).body.result.isError).toBe(true);
    expect(propose).toHaveBeenCalledOnce();
  });
  it('denies initial reasoning entitlement failure without calling the host or revealing its error', async () => {
    capability.mockImplementation(() => { throw new Error('ak_private /private/workspace'); });
    const response = await call(); expect(response.body.result.isError).toBe(true); expect(JSON.stringify(response.body)).not.toMatch(/ak_private|private\/workspace/); expect(propose).not.toHaveBeenCalled();
  });
  it('deduplicates concurrent identical RPC delivery and rejects mismatched reuse, including typed IDs', async () => {
    const pending = deferred<MemoryProposalResult>(); propose.mockReturnValueOnce(pending.promise);
    const first = call(42), duplicate = call(42); await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce());
    const changed = await call(42, { ...input(), requestId: 'different' }); expect(changed.body.result.isError).toBe(true);
    pending.resolve(result()); expect((await first).body).toEqual((await duplicate).body); expect(propose).toHaveBeenCalledOnce();
    await call('42'); expect(propose).toHaveBeenCalledTimes(2);
  });
  it('rechecks idle and reasoning entitlement before returning cached success', async () => {
    expect((await call(42)).body.result.isError).not.toBe(true); active = false;
    expect((await call(42)).body.result.isError).toBe(true); active = true;
    capability.mockImplementation(() => { throw new Error('/private/customer ak_example secret'); });
    const denied = await call(42); expect(denied.body.result.isError).toBe(true); expect(JSON.stringify(denied.body)).not.toContain('private');
    expect(propose).toHaveBeenCalledOnce();
  });
  it('checks current activity and entitlement again after the host callback resolves', async () => {
    propose.mockImplementationOnce(async () => { active = false; return result(); });
    expect((await call()).body.result.isError).toBe(true);
    active = true; propose.mockImplementationOnce(async () => { capability.mockImplementation(() => { throw new Error('private entitlement detail'); }); return result(); });
    const denied = await call(); expect(denied.body.result.isError).toBe(true); expect(JSON.stringify(denied.body)).not.toContain('private entitlement detail');
  });
  it('keeps unknown failures fixed and lets only a new RPC id reach persistent idempotency again', async () => {
    propose.mockRejectedValueOnce(new Error('ak_secret fictional@example.invalid /private/preferences'));
    const first = await call(42), replay = await call(42); expect(first.body.result.isError).toBe(true); expect(replay.body).toEqual(first.body); expect(propose).toHaveBeenCalledOnce();
    expect(JSON.stringify(first.body)).not.toMatch(/ak_secret|example.invalid|private\/preferences/);
    expect((await call(43)).body.result.structuredContent).toEqual(result()); expect(propose).toHaveBeenCalledTimes(2);
    expect(propose.mock.calls[1][0]).toEqual(propose.mock.calls[0][0]);
  });
  it('rejects extra private data in a malformed host result without echoing it', async () => {
    propose.mockResolvedValueOnce({ ...result(), content: 'private memory', reviewDigest: 'a'.repeat(64) } as MemoryProposalResult);
    const response = await call(); expect(response.body.result.isError).toBe(true); expect(JSON.stringify(response.body)).not.toContain('private memory'); expect(JSON.stringify(response.body)).not.toContain('a'.repeat(64));
  });
  it('cancelPending aborts promptly, holds old RPC replay, and permits warm discovery/new request IDs', async () => {
    const pending = deferred<MemoryProposalResult>(); propose.mockReturnValueOnce(pending.promise);
    const first = call(42); await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce()); broker.cancelPending();
    expect(propose.mock.calls[0][1].aborted).toBe(true); const interrupted = await first; expect(interrupted.body.result.isError).toBe(true);
    expect((await invoke('tools/list')).body.result.tools).toHaveLength(1);
    expect((await call(42)).body.result.isError).toBe(true); expect(propose).toHaveBeenCalledOnce();
    pending.resolve(result()); await Promise.resolve();
    expect((await call(42)).body.result.isError).toBe(true); expect(propose).toHaveBeenCalledOnce();
    expect((await call(43)).body.result.structuredContent).toEqual(result()); expect(propose).toHaveBeenCalledTimes(2);
  });
  it('does not dispatch a request whose body was still arriving when its turn was canceled', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'memory_propose', arguments: input() } });
    let finish!: () => void;
    const response = new Promise<{ status: number; body: any }>((resolve, reject) => {
      const request = httpRequest(broker.descriptor.url, { method: 'POST', headers: { ...headers(), 'content-type': 'application/json' } }, incoming => {
        let text = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { text += chunk; });
        incoming.on('end', () => resolve({ status: incoming.statusCode!, body: JSON.parse(text) }));
      });
      request.on('error', reject); request.write(body.slice(0, 1)); finish = () => request.end(body.slice(1));
    });
    // A separate round trip proves that the streaming request reached the server.
    await invoke('ping'); broker.cancelPending(); finish();
    expect((await response).body.result.isError).toBe(true); expect(propose).not.toHaveBeenCalled();
  });
  it('close revokes the endpoint and aborts outstanding callbacks', async () => {
    const pending = deferred<MemoryProposalResult>(); propose.mockReturnValueOnce(pending.promise);
    const first = call(42).catch(() => null); await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce()); broker.close();
    expect(propose.mock.calls[0][1].aborted).toBe(true); await first;
    await expect(call(43)).rejects.toThrow(); pending.resolve(result());
  });
  it('aborts disconnected requests and never turns their late result into a cached success', async () => {
    const pending = deferred<MemoryProposalResult>(); propose.mockReturnValueOnce(pending.promise);
    const controller = new AbortController();
    const request = fetch(broker.descriptor.url, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'memory_propose', arguments: input() } }), signal: controller.signal }).catch(() => null);
    await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce()); controller.abort(); await request;
    await vi.waitFor(() => expect(propose.mock.calls[0][1].aborted).toBe(true));
    pending.resolve(result());
    expect((await call(42)).body.result.isError).toBe(true); expect(propose).toHaveBeenCalledOnce();
  });
  it('bounds body bytes and rejects malformed UTF8 before touching native work', async () => {
    expect((await fetch(broker.descriptor.url, { method: 'POST', headers: headers(), body: 'x'.repeat(80 * 1024) })).status).toBe(413);
    const bad = Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":1,"method":"'), Buffer.from([0xff]), Buffer.from('"}')]);
    expect((await fetch(broker.descriptor.url, { method: 'POST', headers: headers(), body: bad })).status).toBe(400);
    expect(propose).not.toHaveBeenCalled();
  });
  it('fingerprints exact raw request bytes so BOM changes cannot reuse a transport ID', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'memory_propose', arguments: input() } });
    const first = await fetch(broker.descriptor.url, { method: 'POST', headers: headers(), body: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body)]) });
    expect((await first.json() as any).result.structuredContent).toEqual(result());
    expect((await call(42)).body.result.isError).toBe(true); expect(propose).toHaveBeenCalledOnce();
  });
  it('returns an uncertain response at the native deadline even if the callback ignores abort', async () => {
    const pending = deferred<MemoryProposalResult>(); propose.mockReturnValueOnce(pending.promise);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const response = fetch(broker.descriptor.url, { method: 'POST', headers: headers(), body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'memory_propose', arguments: input() } }) });
      await vi.waitFor(() => expect(propose).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(35_000);
      expect((await (await response).json() as any).result.isError).toBe(true); expect(propose.mock.calls[0][1].aborted).toBe(true);
      pending.resolve(result()); await Promise.resolve();
    } finally { pending.resolve(result()); vi.useRealTimers(); }
    expect((await call(42)).body.result.isError).toBe(true); expect(propose).toHaveBeenCalledOnce();
  });
  it('retains the active callback limit when canceled native work ignores its signal', async () => {
    const pending = Array.from({ length: 4 }, () => deferred<MemoryProposalResult>());
    pending.forEach(item => propose.mockReturnValueOnce(item.promise));
    const calls = pending.map((_, index) => call(index)); await vi.waitFor(() => expect(propose).toHaveBeenCalledTimes(4));
    broker.cancelPending(); await Promise.all(calls);
    expect((await call(20)).body.result.isError).toBe(true); expect(propose).toHaveBeenCalledTimes(4);
    for (const item of pending) item.resolve(result()); await vi.waitFor(async () => { const response = await call(21 + nextId++); expect(response.body.result.isError).not.toBe(true); });
    expect(propose).toHaveBeenCalledTimes(5);
  });
  it('bounds retained RPC history without evicting an older successful request into a second dispatch', async () => {
    for (let id = 0; id < 256; id++) expect((await call(id)).body.result.isError).not.toBe(true);
    expect((await call(256)).body.result.isError).toBe(true); expect(propose).toHaveBeenCalledTimes(256);
    expect((await call(0)).body.result.structuredContent).toEqual(result()); expect(propose).toHaveBeenCalledTimes(256);
  });
});
