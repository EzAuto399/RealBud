import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  MEMORY_PROPOSAL_REVIEW_LOCATION,
  parseMemoryProposalInput,
  parseMemoryProposalResult,
  type MemoryProposalInput,
  type MemoryProposalResult,
} from '../shared/hermes-memory-proposal.ts';
import { managedService } from './managed-service.ts';

const PROTOCOL_VERSION = '2024-11-05';
const TOOL_NAME = 'memory_propose';
const PATH = '/mcp';
const BODY_LIMIT = 70 * 1024;
const BODY_TIMEOUT_MS = 10_000;
const CALLBACK_TIMEOUT_MS = 35_000;
const MAX_CACHE_ENTRIES = 256;
const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVE = 4;
const MAX_RPC_ID_LENGTH = 100;
const MAX_METHOD_LENGTH = 128;
const CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/;
const UNPAIRED_SURROGATE = /[\ud800-\udfff]/u;

const HTTP_ERROR = {
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  notFound: 'not found',
  methodNotAllowed: 'method not allowed',
  tooLarge: 'payload too large',
  timeout: 'request timeout',
  invalidEncoding: 'invalid encoding',
  invalidJson: 'invalid json',
  invalidRequest: 'invalid request',
} as const;

const RPC_ERROR = {
  invalidRequest: 'invalid request',
  methodNotFound: 'method not found',
  invalidParams: 'invalid params',
  inactive: 'inactive',
  unavailable: 'unavailable',
  busy: 'busy',
  conflict: 'conflict',
  uncertain: 'uncertain',
  cancelled: 'cancelled',
  timeout: 'timeout',
} as const;

const RPC_CODE = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  uncertain: -32000,
  inactive: -32001,
  unavailable: -32002,
  busy: -32003,
  cancelled: -32004,
  timeout: -32005,
  conflict: -32006,
} as const;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
} as const;

const TEXT_LIMITS = {
  content: { type: 'string', minLength: 1 },
  old_text: { type: 'string', minLength: 1 },
} as const;

const TARGET = { type: 'string', enum: ['memory', 'user'] } as const;

const ADD_OP = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'content'],
  properties: { action: { type: 'string', const: 'add' }, content: TEXT_LIMITS.content },
} as const;

const REPLACE_OP = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'content', 'old_text'],
  properties: {
    action: { type: 'string', const: 'replace' },
    content: TEXT_LIMITS.content,
    old_text: TEXT_LIMITS.old_text,
  },
} as const;

const REMOVE_OP = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'old_text'],
  properties: { action: { type: 'string', const: 'remove' }, old_text: TEXT_LIMITS.old_text },
} as const;

const ADD_PAYLOAD = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'action', 'content'],
  properties: { target: TARGET, action: { type: 'string', const: 'add' }, content: TEXT_LIMITS.content },
} as const;

const REPLACE_PAYLOAD = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'action', 'content', 'old_text'],
  properties: {
    target: TARGET,
    action: { type: 'string', const: 'replace' },
    content: TEXT_LIMITS.content,
    old_text: TEXT_LIMITS.old_text,
  },
} as const;

const REMOVE_PAYLOAD = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'action', 'old_text'],
  properties: { target: TARGET, action: { type: 'string', const: 'remove' }, old_text: TEXT_LIMITS.old_text },
} as const;

const BATCH_PAYLOAD = {
  type: 'object',
  additionalProperties: false,
  required: ['target', 'action', 'operations'],
  properties: {
    target: TARGET,
    action: { type: 'string', const: 'batch' },
    operations: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: { oneOf: [ADD_OP, REPLACE_OP, REMOVE_OP] },
    },
  },
} as const;

const TOOL_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['requestId', 'payload'],
  properties: {
    requestId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' },
    payload: { oneOf: [ADD_PAYLOAD, REPLACE_PAYLOAD, REMOVE_PAYLOAD, BATCH_PAYLOAD] },
  },
} as const;

const TOOL_TITLE = 'Memory proposal only';
const TOOL_DESCRIPTION =
  `Proposal only. This tool does not change memory. Human review is in ${MEMORY_PROPOSAL_REVIEW_LOCATION}. After an uncertain response, retry SAME requestId + payload.`;

export type MemoryProposalBrokerDescriptor = {
  type: 'http';
  name: 'memory-proposals';
  url: string;
  headers: [{ name: 'authorization'; value: string }];
};

export type MemoryProposalBroker = {
  descriptor: MemoryProposalBrokerDescriptor;
  cancelPending(): void;
  close(): void;
};

export type MemoryProposalBrokerOptions = {
  isActive(): boolean;
  propose(input: MemoryProposalInput, signal: AbortSignal): Promise<MemoryProposalResult>;
  assertCapability?: () => void;
};

type RpcId = string | number;

type CallOutcome =
  | { kind: 'success'; result: MemoryProposalResult }
  | { kind: 'error'; code: number; message: string };

type CacheEntry = {
  fingerprint: string;
  generation: number;
  bytes: number;
  state: { kind: 'pending'; outcome: Promise<CallOutcome> } | { kind: 'done'; outcome: CallOutcome };
};

type WaitResult =
  | CallOutcome
  | { kind: 'timeout' }
  | { kind: 'cancelled' }
  | { kind: 'disconnect' };

function defaultAssertCapability(): void {
  managedService.assertCapability('reasoning');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function fields(value: Record<string, unknown>, names: string[]): boolean {
  return Reflect.ownKeys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

function rpcIdKey(id: RpcId): string {
  return typeof id === 'number' ? `n:${id}` : `s:${id}`;
}

function fingerprint(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

function parseRpcId(value: unknown): RpcId | undefined | 'bad' {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isInteger(value) && Number.isSafeInteger(value)) return value;
  if (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_RPC_ID_LENGTH &&
    !CONTROLS.test(value) &&
    !UNPAIRED_SURROGATE.test(value)
  ) {
    return value;
  }
  return 'bad';
}

function headerString(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function decodeUtf8(body: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

function publicResult(result: MemoryProposalResult): MemoryProposalResult {
  return { version: 1, id: result.id, reviewLocation: MEMORY_PROPOSAL_REVIEW_LOCATION };
}

function toolSuccessPayload(result: MemoryProposalResult): {
  content: [{ type: 'text'; text: string }];
  structuredContent: MemoryProposalResult;
} {
  const payload = publicResult(result);
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function writeHttpError(
  req: IncomingMessage,
  res: ServerResponse,
  status: number,
  message: string,
): void {
  if (!res.headersSent && !res.writableEnded) {
    const body = JSON.stringify({ error: message });
    res.writeHead(status, {
      ...JSON_HEADERS,
      'content-length': Buffer.byteLength(body),
      connection: 'close',
    });
    try {
      res.end(body);
    } catch {
      /* never hang */
    }
  }
  req.destroy();
}

function writeJson(res: ServerResponse, status: number, value: unknown, close = false): void {
  if (res.headersSent || res.writableEnded) return;
  const body = JSON.stringify(value);
  const headers: Record<string, string | number> = {
    ...JSON_HEADERS,
    'content-length': Buffer.byteLength(body),
  };
  if (close) headers.connection = 'close';
  res.writeHead(status, headers);
  try {
    res.end(body);
  } catch {
    /* never hang */
  }
}

function writeRpcResult(res: ServerResponse, id: RpcId, result: unknown): void {
  writeJson(res, 200, { jsonrpc: '2.0', id, result });
}

function writeRpcError(res: ServerResponse, id: RpcId, code: number, message: string): void {
  writeJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
}

function gateCode(kind: 'inactive' | 'unavailable'): { code: number; message: string } {
  return kind === 'inactive'
    ? { code: RPC_CODE.inactive, message: RPC_ERROR.inactive }
    : { code: RPC_CODE.unavailable, message: RPC_ERROR.unavailable };
}

function parseToolParams(params: unknown): MemoryProposalInput | null {
  if (!isObject(params) || !fields(params, ['name', 'arguments']) || params.name !== TOOL_NAME) return null;
  return parseMemoryProposalInput(params.arguments);
}

function discoveryParamsOk(method: string, params: unknown): boolean {
  if (params === undefined) return true;
  if (!isObject(params)) return false;
  if (method === 'ping' || method === 'tools/list') return fields(params, []);
  return true;
}

function readBody(req: IncomingMessage): Promise<{ ok: Buffer } | { error: 'timeout' | 'too_large' | 'disconnected' }> {
  return new Promise(resolve => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: { ok: Buffer } | { error: 'timeout' | 'too_large' | 'disconnected' }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onError);
      resolve(value);
    };
    const timer = setTimeout(() => {
      req.destroy();
      finish({ error: 'timeout' });
    }, BODY_TIMEOUT_MS);
    const onData = (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > BODY_LIMIT) {
        req.destroy();
        finish({ error: 'too_large' });
        return;
      }
      chunks.push(buf);
    };
    const onEnd = () => finish({ ok: Buffer.concat(chunks, size) });
    const onError = () => finish({ error: 'disconnected' });
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onError);
    if (req.destroyed || req.readableEnded) {
      if (req.readableEnded) onEnd();
      else onError();
    }
  });
}

function waitForOutcome(
  outcome: Promise<CallOutcome>,
  req: IncomingMessage,
  work: AbortSignal,
): Promise<WaitResult> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: WaitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('aborted', onDisconnect);
      req.off('close', onDisconnect);
      work.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const timer = setTimeout(() => finish({ kind: 'timeout' }), CALLBACK_TIMEOUT_MS);
    const onDisconnect = () => finish({ kind: 'disconnect' });
    const onAbort = () => finish({ kind: 'cancelled' });
    req.on('aborted', onDisconnect);
    req.on('close', onDisconnect);
    work.addEventListener('abort', onAbort, { once: true });
    if (req.destroyed) onDisconnect();
    else if (work.aborted) onAbort();
    outcome.then(
      value => finish(value),
      () => finish({ kind: 'error', code: RPC_CODE.uncertain, message: RPC_ERROR.uncertain }),
    );
  });
}

export async function startMemoryProposalBroker(
  options: MemoryProposalBrokerOptions,
): Promise<MemoryProposalBroker> {
  const isActive = options.isActive;
  const propose = options.propose;
  const assertCapability = options.assertCapability ?? defaultAssertCapability;
  const token = randomBytes(32).toString('hex');
  const expectedAuth = Buffer.from(`Bearer ${token}`);
  let tokenBuf: Buffer | null = expectedAuth;
  let closed = false;
  let generation = 0;
  let activeCallbacks = 0;
  let retainedBytes = 0;
  const controllers = new Set<AbortController>();
  const cache = new Map<string, CacheEntry>();
  const terminalKeys: string[] = [];

  const allowToolsCall = (): 'ok' | 'inactive' | 'unavailable' => {
    try {
      if (!isActive()) return 'inactive';
      assertCapability();
      return 'ok';
    } catch {
      return 'unavailable';
    }
  };

  const authorize = (header: string | string[] | undefined): boolean => {
    if (closed || !tokenBuf) return false;
    const raw = headerString(header);
    const got = Buffer.from(raw ?? '');
    if (got.length !== tokenBuf.length) {
      timingSafeEqual(tokenBuf, tokenBuf);
      return false;
    }
    return timingSafeEqual(got, tokenBuf);
  };

  const evictTerminal = (): void => {
    while (
      (cache.size > MAX_CACHE_ENTRIES || retainedBytes > MAX_CACHE_BYTES) &&
      terminalKeys.length > 0
    ) {
      const key = terminalKeys.shift();
      if (!key) break;
      const entry = cache.get(key);
      if (!entry || entry.state.kind === 'pending') continue;
      retainedBytes -= entry.bytes;
      cache.delete(key);
    }
  };

  const rememberTerminal = (key: string): void => {
    terminalKeys.push(key);
    evictTerminal();
  };

  const entryBytes = (key: string, fp: string, outcome?: CallOutcome): number => {
    let n = key.length + fp.length + 48;
    if (outcome?.kind === 'success') n += Buffer.byteLength(JSON.stringify(publicResult(outcome.result)));
    return n;
  };

  const abortTracked = (): void => {
    for (const controller of controllers) {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }
    controllers.clear();
  };

  const cancelPending = (): void => {
    generation += 1;
    abortTracked();
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    tokenBuf = null;
    cancelPending();
    try {
      server.close();
    } catch {
      /* ignore */
    }
    try {
      server.closeIdleConnections?.();
    } catch {
      /* ignore */
    }
    try {
      server.closeAllConnections?.();
    } catch {
      /* ignore */
    }
  };

  const replyOutcome = (res: ServerResponse, id: RpcId, outcome: CallOutcome): void => {
    if (outcome.kind === 'success') {
      const gate = allowToolsCall();
      if (gate !== 'ok') {
        const err = gateCode(gate);
        writeRpcError(res, id, err.code, err.message);
        return;
      }
      writeRpcResult(res, id, toolSuccessPayload(outcome.result));
      return;
    }
    writeRpcError(res, id, outcome.code, outcome.message);
  };

  const finishCall = async (
    req: IncomingMessage,
    res: ServerResponse,
    id: RpcId,
    outcome: Promise<CallOutcome>,
    work: AbortSignal,
  ): Promise<void> => {
    const waited = await waitForOutcome(outcome, req, work);
    if (waited.kind === 'disconnect' || res.writableEnded || res.headersSent) return;
    if (waited.kind === 'timeout') {
      writeRpcError(res, id, RPC_CODE.timeout, RPC_ERROR.timeout);
      return;
    }
    if (waited.kind === 'cancelled') {
      writeRpcError(res, id, RPC_CODE.cancelled, RPC_ERROR.cancelled);
      return;
    }
    replyOutcome(res, id, waited);
  };

  const dispatch = (
    input: MemoryProposalInput,
    key: string,
    fp: string,
  ): { outcome: Promise<CallOutcome>; work: AbortController } => {
    const work = new AbortController();
    controllers.add(work);
    const entryGeneration = generation;
    let settle!: (outcome: CallOutcome) => void;
    const outcome = new Promise<CallOutcome>(resolve => {
      settle = resolved => resolve(resolved);
    });
    void outcome.catch(() => {});
    const entry: CacheEntry = {
      fingerprint: fp,
      generation: entryGeneration,
      bytes: entryBytes(key, fp),
      state: { kind: 'pending', outcome },
    };
    retainedBytes += entry.bytes;
    cache.set(key, entry);
    evictTerminal();
    activeCallbacks += 1;
    const kill = setTimeout(() => {
      try {
        work.abort();
      } catch {
        /* ignore */
      }
    }, CALLBACK_TIMEOUT_MS);
    const complete = (next: CallOutcome) => {
      if (entry.state.kind !== 'pending') return;
      retainedBytes -= entry.bytes;
      entry.state = { kind: 'done', outcome: next };
      entry.bytes = entryBytes(key, fp, next);
      retainedBytes += entry.bytes;
      rememberTerminal(key);
      settle(next);
    };
    void (async () => {
      try {
        let raw: unknown;
        try {
          raw = await propose(input, work.signal);
        } catch {
          complete({ kind: 'error', code: RPC_CODE.uncertain, message: RPC_ERROR.uncertain });
          return;
        }
        if (generation !== entryGeneration || work.signal.aborted) {
          complete({ kind: 'error', code: RPC_CODE.uncertain, message: RPC_ERROR.uncertain });
          return;
        }
        const parsed = parseMemoryProposalResult(raw);
        if (!parsed) {
          complete({ kind: 'error', code: RPC_CODE.uncertain, message: RPC_ERROR.uncertain });
          return;
        }
        complete({ kind: 'success', result: publicResult(parsed) });
      } catch {
        complete({ kind: 'error', code: RPC_CODE.uncertain, message: RPC_ERROR.uncertain });
      } finally {
        clearTimeout(kill);
        activeCallbacks -= 1;
        controllers.delete(work);
      }
    })();
    return { outcome, work };
  };

  const handleToolsCall = async (
    req: IncomingMessage,
    res: ServerResponse,
    id: RpcId,
    params: unknown,
    body: Buffer,
  ): Promise<void> => {
    const input = parseToolParams(params);
    if (!input) {
      writeRpcError(res, id, RPC_CODE.invalidParams, RPC_ERROR.invalidParams);
      return;
    }
    const key = rpcIdKey(id);
    const fp = fingerprint(body);
    const existing = cache.get(key);
    if (existing && existing.fingerprint !== fp) {
      writeRpcError(res, id, RPC_CODE.conflict, RPC_ERROR.conflict);
      return;
    }
    const gate = allowToolsCall();
    if (gate !== 'ok') {
      const err = gateCode(gate);
      writeRpcError(res, id, err.code, err.message);
      return;
    }
    if (existing) {
      if (existing.state.kind === 'done') {
        replyOutcome(res, existing.state.outcome.kind === 'success' ? res && id : id, existing.state.outcome);
        return;
      }
      if (existing.generation !== generation) {
        writeRpcError(res, id, RPC_CODE.uncertain, RPC_ERROR.uncertain);
        return;
      }
      await finishCall(req, res, id, existing.state.outcome, new AbortController().signal);
      return;
    }
    if (activeCallbacks >= MAX_ACTIVE) {
      writeRpcError(res, id, RPC_CODE.busy, RPC_ERROR.busy);
      return;
    }
    const started = dispatch(input, key, fp);
    await finishCall(req, res, id, started.outcome, started.work.signal);
  };

  const handleRpc = async (
    req: IncomingMessage,
    res: ServerResponse,
    body: Buffer,
    text: string,
  ): Promise<void> => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      writeHttpError(req, res, 400, HTTP_ERROR.invalidJson);
      return;
    }
    if (!isObject(parsed) || !Object.hasOwn(parsed, 'jsonrpc') || !Object.hasOwn(parsed, 'method')) {
      writeHttpError(req, res, 400, HTTP_ERROR.invalidRequest);
      return;
    }
    const keys = Reflect.ownKeys(parsed);
    const allowed = new Set(['jsonrpc', 'method', 'id', 'params']);
    if (keys.some(key => typeof key !== 'string' || !allowed.has(key))) {
      writeHttpError(req, res, 400, HTTP_ERROR.invalidRequest);
      return;
    }
    if (parsed.jsonrpc !== '2.0' || typeof parsed.method !== 'string') {
      writeHttpError(req, res, 400, HTTP_ERROR.invalidRequest);
      return;
    }
    const method = parsed.method;
    if (
      method.length === 0 ||
      method.length > MAX_METHOD_LENGTH ||
      CONTROLS.test(method) ||
      UNPAIRED_SURROGATE.test(method)
    ) {
      writeHttpError(req, res, 400, HTTP_ERROR.invalidRequest);
      return;
    }
    const id = parseRpcId(parsed.id);
    if (id === 'bad') {
      writeHttpError(req, res, 400, HTTP_ERROR.invalidRequest);
      return;
    }
    const params = Object.hasOwn(parsed, 'params') ? parsed.params : undefined;
    if (id === undefined) {
      if (method === 'notifications/initialized') {
        writeJson(res, 202, {});
        return;
      }
      writeHttpError(req, res, 400, HTTP_ERROR.invalidRequest);
      return;
    }
    if (!discoveryParamsOk(method, params)) {
      writeRpcError(res, id, RPC_CODE.invalidParams, RPC_ERROR.invalidParams);
      return;
    }
    if (method === 'initialize') {
      writeRpcResult(res, id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'memory-proposals', version: '1' },
      });
      return;
    }
    if (method === 'tools/list') {
      writeRpcResult(res, id, {
        tools: [
          {
            name: TOOL_NAME,
            title: TOOL_TITLE,
            description: TOOL_DESCRIPTION,
            inputSchema: TOOL_INPUT_SCHEMA,
          },
        ],
      });
      return;
    }
    if (method === 'ping') {
      writeRpcResult(res, id, {});
      return;
    }
    if (method === 'notifications/initialized') {
      writeRpcResult(res, id, {});
      return;
    }
    if (method === 'tools/call') {
      await handleToolsCall(req, res, id, params, body);
      return;
    }
    writeRpcError(res, id, RPC_CODE.methodNotFound, RPC_ERROR.methodNotFound);
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (closed) {
          writeHttpError(req, res, 401, HTTP_ERROR.unauthorized);
          return;
        }
        if (req.method !== 'POST') {
          writeHttpError(req, res, 405, HTTP_ERROR.methodNotAllowed);
          return;
        }
        const path = (req.url ?? '').split('?')[0];
        if (path !== PATH) {
          writeHttpError(req, res, 404, HTTP_ERROR.notFound);
          return;
        }
        const addr = server.address();
        const port = addr && typeof addr !== 'string' ? addr.port : 0;
        const host = headerString(req.headers.host);
        if (!port || host !== `127.0.0.1:${port}`) {
          writeHttpError(req, res, 403, HTTP_ERROR.forbidden);
          return;
        }
        if (req.headers.origin !== undefined) {
          writeHttpError(req, res, 403, HTTP_ERROR.forbidden);
          return;
        }
        if (!authorize(req.headers.authorization)) {
          writeHttpError(req, res, 401, HTTP_ERROR.unauthorized);
          return;
        }
        const body = await readBody(req);
        if ('error' in body) {
          if (body.error === 'disconnected') return;
          if (body.error === 'too_large') {
            writeHttpError(req, res, 413, HTTP_ERROR.tooLarge);
            return;
          }
          writeHttpError(req, res, 408, HTTP_ERROR.timeout);
          return;
        }
        const text = decodeUtf8(body.ok);
        if (text === null) {
          writeHttpError(req, res, 400, HTTP_ERROR.invalidEncoding);
          return;
        }
        await handleRpc(req, res, body.ok, text);
      } catch {
        if (!res.headersSent && !res.writableEnded) writeHttpError(req, res, 400, HTTP_ERROR.invalidRequest);
        else req.destroy();
      }
    })();
  });

  server.on('error', () => {});

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.off('error', onError);
      reject(err);
    };
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string' || addr.address !== '127.0.0.1' || addr.port <= 0) {
    close();
    throw new Error('failed to bind');
  }

  const descriptor: MemoryProposalBrokerDescriptor = {
    type: 'http',
    name: 'memory-proposals',
    url: `http://127.0.0.1:${addr.port}/mcp`,
    headers: [{ name: 'authorization', value: `Bearer ${token}` }],
  };

  return { descriptor, cancelPending, close };
}
