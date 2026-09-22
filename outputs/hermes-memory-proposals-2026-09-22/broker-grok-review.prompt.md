Perform a bounded independent security/correctness review of the three supplied files implementing RealBud's memory proposal-only loopback MCP broker. Do not use tools, edit files, spawn agents, run tests, or output hidden reasoning. Return structured JSON {approved:boolean,findings:[{severity:'high'|'medium'|'low',file:string,issue:string,fix:string}],limits:string[]}.
Required boundary: only pending memory proposals, no approval/apply tool; exact input schema, control/lone-surrogate rejection,64KiB serialized input; native host owns persistent idempotency and credential/threat checks; output only version/id/fixedlocation. HTTP127.0.0.1 exact Host/noOrigin/private bearer, bounded body/RPC/cache/concurrency. Discovery may precede active prompt; calls/cached replies require current active+reasoning. Cancellation must fence unfinished requests including bodies still arriving and late callback success; repeated same RPC ID+raw body shares one native call, changed body rejected; new RPC ID with same native requestId/payload may reach host again. Unknown responses may never invent success. A non-cooperative callback remains counted until actual settlement; close revokes. Test helpers must not weaken production behavior. Identify concrete reachable issues, not stylistic preferences or imagined requirements. Scope excludes native helper/service/ACP implementation (separate reviewed layers).

FILE shared/hermes-memory-proposal.ts
/** Proposals are pending human reviews, never authority to change saved memory. */
export type MemoryProposalOperation =
  | { action: 'add'; content: string }
  | { action: 'replace'; content: string; old_text: string }
  | { action: 'remove'; old_text: string };
export type MemoryProposalPayload = ({ target: 'memory' | 'user' } & MemoryProposalOperation)
  | { target: 'memory' | 'user'; action: 'batch'; operations: MemoryProposalOperation[] };
export interface MemoryProposalInput { requestId: string; payload: MemoryProposalPayload }
export const MEMORY_PROPOSAL_REVIEW_LOCATION = 'You → Bud → Bud’s memory' as const;
export interface MemoryProposalResult { version: 1; id: string; reviewLocation: typeof MEMORY_PROPOSAL_REVIEW_LOCATION }
export const MEMORY_PROPOSAL_INPUT_BYTES = 64 * 1024;
const textBytes = 128 * 1024;
const encoder = new TextEncoder();
const controls = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
// With Unicode mode, valid surrogate pairs are a single code point outside this range.
const unpairedSurrogate = /[\ud800-\udfff]/u;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const fields = (value: Record<string, unknown>, names: string[]) => Reflect.ownKeys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && encoder.encode(value).byteLength <= textBytes && !controls.test(value) && !unpairedSurrogate.test(value);
}
function operation(value: unknown, withTarget: boolean): MemoryProposalOperation | null {
  if (!object(value)) return null;
  const extra = withTarget ? ['target'] : [];
  if (value.action === 'add' && fields(value, [...extra, 'action', 'content']) && text(value.content)) return { action: 'add', content: value.content };
  if (value.action === 'replace' && fields(value, [...extra, 'action', 'content', 'old_text']) && text(value.content) && text(value.old_text)) return { action: 'replace', content: value.content, old_text: value.old_text };
  if (value.action === 'remove' && fields(value, [...extra, 'action', 'old_text']) && text(value.old_text)) return { action: 'remove', old_text: value.old_text };
  return null;
}
export function parseMemoryProposalInput(value: unknown): MemoryProposalInput | null {
  if (!object(value) || !fields(value, ['requestId', 'payload']) || typeof value.requestId !== 'string' || value.requestId !== value.requestId.trim() || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value.requestId) || !object(value.payload)) return null;
  const raw = value.payload, target = raw.target;
  if (target !== 'memory' && target !== 'user') return null;
  let payload: MemoryProposalPayload;
  if (raw.action === 'batch') {
    if (!fields(raw, ['target', 'action', 'operations']) || !Array.isArray(raw.operations) || raw.operations.length < 1 || raw.operations.length > 100) return null;
    const operations: MemoryProposalOperation[] = [];
    for (const item of raw.operations) { const parsed = operation(item, false); if (!parsed) return null; operations.push(parsed); }
    payload = { target, action: 'batch', operations };
  } else {
    const parsed = operation(raw, true); if (!parsed) return null;
    payload = { target, ...parsed };
  }
  const parsed = { requestId: value.requestId, payload };
  return encoder.encode(JSON.stringify(parsed)).byteLength <= MEMORY_PROPOSAL_INPUT_BYTES ? parsed : null;
}
export function parseMemoryProposalResult(value: unknown): MemoryProposalResult | null {
  if (!object(value) || !fields(value, ['version', 'id', 'reviewLocation']) || value.version !== 1 || typeof value.id !== 'string' || value.id.length !== 8 || !/^[a-f0-9]{8}$/.test(value.id) || value.reviewLocation !== MEMORY_PROPOSAL_REVIEW_LOCATION) return null;
  return { version: 1, id: value.id, reviewLocation: MEMORY_PROPOSAL_REVIEW_LOCATION };
}


FILE server/hermes-memory-proposal-broker.ts
// A per-runtime proposal capability. Saved memory changes remain in human review.
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { managedService } from './managed-service.ts';
import { parseMemoryProposalInput, parseMemoryProposalResult, type MemoryProposalInput, type MemoryProposalResult } from '../shared/hermes-memory-proposal.ts';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const properties = (value: Record<string, unknown>, required = Object.keys(value)) => ({ type: 'object', properties: value, required, additionalProperties: false });
const textSchema = { type: 'string', minLength: 1, maxLength: 131072, description: 'Exact nonblank text. Preserve spacing; do not include credentials, control characters or bidirectional formatting.' };
const operationSchemas = [
  properties({ action: { const: 'add' }, content: textSchema }),
  properties({ action: { const: 'replace' }, content: textSchema, old_text: textSchema }),
  properties({ action: { const: 'remove' }, old_text: textSchema }),
];
const targetSchema = { type: 'string', enum: ['memory', 'user'] };
export const MEMORY_PROPOSAL_TOOL = {
  name: 'memory_propose', title: 'Propose a memory change for human review',
  description: 'Propose preferences for exact human review in You → Bud → Bud’s memory. This tool only saves a pending proposal; it does not change saved memory, approve work or grant permissions. After an uncertain response, retry the same requestId and identical payload with a new transport request ID so RealBud can check the saved proposal. Never create a new requestId just to retry.',
  inputSchema: properties({
    requestId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$', description: 'Stable idempotency key for this exact proposal; reuse unchanged after an uncertain response.' },
    payload: { oneOf: [...operationSchemas.map(schema => properties({ target: targetSchema, ...schema.properties })), properties({ target: targetSchema, action: { const: 'batch' }, operations: { type: 'array', minItems: 1, maxItems: 100, items: { oneOf: operationSchemas } } })] },
  }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
export interface MemoryProposalBroker {
  descriptor: { type: 'http'; name: 'memory-proposals'; url: string; headers: { name: string; value: string }[] };
  cancelPending(): void;
  close(): void;
}
type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean; structuredContent?: MemoryProposalResult };
const error = (message: string): ToolResult => ({ content: [{ type: 'text', text: message }], isError: true });
const messages = {
  inactive: 'This memory proposal request is no longer active. Check saved reviews before continuing.',
  unavailable: 'Memory proposals are unavailable for this request. Check Bud setup and service access.',
  invalid: 'This memory proposal request is not supported. Use the exact proposal schema.',
  changed: 'This transport request changed. Use a new transport request ID without changing an uncertain proposal’s requestId or payload.',
  uncertain: 'The proposal result could not be confirmed. Check saved reviews or retry the same requestId and identical payload with a new transport request ID. No memory approval was created.',
  full: 'This memory proposal session is busy or full. Wait for pending work or start a new conversation before continuing.',
};
type Entry = { fingerprint: string; response: Promise<ToolResult>; controller: AbortController; finished: boolean; generation: number };

export async function startMemoryProposalBroker(options: {
  isActive(): boolean;
  propose(input: MemoryProposalInput, signal: AbortSignal): Promise<MemoryProposalResult>;
  assertCapability?: () => void;
}): Promise<MemoryProposalBroker> {
  const token = randomBytes(32).toString('hex');
  const expectedAuthorization = Buffer.from(`Bearer ${token}`);
  const assertCapability = options.assertCapability ?? (() => managedService.assertCapability('reasoning'));
  const entries = new Map<string, Entry>(), nativeControllers = new Set<AbortController>();
  let closed = false, generation = 0, authority = '', cachedBytes = 0;
  const authorized = (): ToolResult | null => {
    try { if (closed || !options.isActive()) return error(messages.inactive); assertCapability(); return null; }
    catch { return error(messages.unavailable); }
  };
  const cancelPending = () => { generation++; for (const controller of nativeControllers) controller.abort(); };
  const server = createServer((req, res) => { void (async () => {
    const receivedGeneration = generation;
    const headerCount = (name: string) => req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length;
    const authorization = Buffer.from(req.headers.authorization ?? '');
    if (closed || req.socket.remoteAddress !== '127.0.0.1' || Object.hasOwn(req.headers, 'origin') || req.headers.host !== authority ||
      headerCount('host') !== 1 || headerCount('authorization') !== 1 || authorization.length !== expectedAuthorization.length || !timingSafeEqual(authorization, expectedAuthorization)) { res.writeHead(403).end(); return; }
    if (req.method !== 'POST' || req.url !== '/mcp') { res.writeHead(405).end(); return; }
    const chunks: Buffer[] = []; let bytes = 0;
    const bodyTimer = setTimeout(() => req.destroy(), 10_000); bodyTimer.unref();
    try {
      for await (const chunk of req) { bytes += chunk.length; if (bytes > 70 * 1024) { res.writeHead(413).end(); return; } chunks.push(Buffer.from(chunk)); }
    } finally { clearTimeout(bodyTimer); }
    const body = Buffer.concat(chunks); let msg: Record<string, unknown>;
    try { const decoded: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); if (!object(decoded)) throw new Error(); msg = decoded; }
    catch { res.writeHead(400).end(); return; }
    if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || msg.method.length > 128 || Object.keys(msg).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key))) { res.writeHead(400).end(); return; }
    if (!Object.hasOwn(msg, 'id')) {
      if (msg.method === 'notifications/initialized' && (msg.params === undefined || object(msg.params) && Object.keys(msg.params).length === 0)) res.writeHead(202).end();
      else res.writeHead(400).end(); return;
    }
    const id = msg.id;
    if (!(typeof id === 'number' && Number.isSafeInteger(id)) && !(typeof id === 'string' && id.length > 0 && id.length <= 100 && !/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(id) && !/[\ud800-\udfff]/u.test(id))) { res.writeHead(400).end(); return; }
    const reply = (result: unknown) => { if (!res.destroyed && !res.writableEnded) res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ jsonrpc: '2.0', id, result })); };
    // The SDK discovers tools during session/new, before the current prompt is active.
    if (['initialize', 'tools/list', 'ping'].includes(msg.method) && msg.params !== undefined && (!object(msg.params) ||
      Object.keys(msg.params).some(key => !(msg.method === 'initialize' ? ['protocolVersion', 'capabilities', 'clientInfo', '_meta'] : ['_meta']).includes(key)) ||
      msg.params._meta !== undefined && !object(msg.params._meta))) { reply(error(messages.invalid)); return; }
    if (msg.method === 'initialize') { reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'RealBud memory proposals', version: '1.0.0' } }); return; }
    if (msg.method === 'tools/list') { reply({ tools: [MEMORY_PROPOSAL_TOOL] }); return; }
    if (msg.method === 'ping') { reply({}); return; }
    if (msg.method !== 'tools/call') { reply(error(messages.invalid)); return; }
    const denied = authorized(); if (denied) { reply(denied); return; }
    if (receivedGeneration !== generation) { reply(error(messages.inactive)); return; }
    if (!object(msg.params) || Object.keys(msg.params).some(key => !['name', 'arguments', '_meta'].includes(key)) ||
      msg.params.name !== MEMORY_PROPOSAL_TOOL.name || msg.params._meta !== undefined && !object(msg.params._meta)) { reply(error(messages.invalid)); return; }
    const input = parseMemoryProposalInput(msg.params.arguments); if (!input) { reply(error(messages.invalid)); return; }
    const key = `${typeof id}:${id}`, fingerprint = createHash('sha256').update(body).digest('hex');
    let entry = entries.get(key);
    if (entry && entry.fingerprint !== fingerprint) { reply(error(messages.changed)); return; }
    if (!entry) {
      if (entries.size >= 256 || cachedBytes + key.length + 1024 > 2 * 1024 * 1024 || nativeControllers.size >= 4) { reply(error(messages.full)); return; }
      const controller = new AbortController(); nativeControllers.add(controller);
      entry = { fingerprint, controller, generation, finished: false, response: Promise.resolve(error(messages.uncertain)) };
      entries.set(key, entry); cachedBytes += key.length + 1024;
      const owned = entry;
      const deadline = setTimeout(() => controller.abort(), 35_000); deadline.unref();
      // The native promise retains its concurrency slot even if it ignores abort.
      const native = Promise.resolve().then(async () => {
        if (controller.signal.aborted || owned.generation !== generation || authorized()) throw new Error();
        return options.propose(input, controller.signal);
      });
      const settled = native.then(value => {
        if (controller.signal.aborted || owned.generation !== generation || authorized()) return error(messages.uncertain);
        const result = parseMemoryProposalResult(value);
        return result ? { content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result } : error(messages.uncertain);
      }, () => error(messages.uncertain)).finally(() => { nativeControllers.delete(controller); clearTimeout(deadline); });
      let onAbort!: () => void;
      const aborted = new Promise<ToolResult>(resolve => { onAbort = () => resolve(error(messages.uncertain)); controller.signal.addEventListener('abort', onAbort, { once: true }); if (controller.signal.aborted) onAbort(); });
      entry.response = Promise.race([settled, aborted]).finally(() => { owned.finished = true; controller.signal.removeEventListener('abort', onAbort); });
    }
    const pending = entry;
    const disconnect = () => { if (!res.writableEnded && !pending.finished) pending.controller.abort(); };
    res.once('close', disconnect);
    try {
      const result = await pending.response;
      // Cache replay is a capability use too; a completed result never bypasses a stopped turn.
      reply(authorized() ?? (receivedGeneration !== generation ? error(messages.inactive) : result));
    } finally { res.off('close', disconnect); }
  })().catch(() => { if (!res.destroyed && !res.writableEnded) { if (!res.headersSent) res.writeHead(400); res.end(); } }); });
  server.requestTimeout = 10_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new Error('Memory proposal service could not start.'); }
  authority = `127.0.0.1:${address.port}`;
  return {
    descriptor: { type: 'http', name: 'memory-proposals', url: `http://${authority}/mcp`, headers: [{ name: 'authorization', value: `Bearer ${token}` }] },
    cancelPending,
    close() { if (closed) return; closed = true; cancelPending(); server.close(); server.closeAllConnections(); entries.clear(); },
  };
}


FILE server/hermes-memory-proposal-broker.test.ts
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
    for (const name of ['memory_approve', 'memory', 'memory_apply']) expect((await invoke('tools/call', { name, arguments: input() })).body.result.isError).toBe(true);
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

