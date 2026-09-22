// A per-runtime proposal capability. Saved memory changes remain in human review.
import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { managedService } from "./managed-service.js";
import { parseMemoryProposalInput, parseMemoryProposalResult } from "../shared/hermes-memory-proposal.js";
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const properties = (value, required = Object.keys(value)) => ({ type: 'object', properties: value, required, additionalProperties: false });
const textSchema = { type: 'string', minLength: 1, maxLength: 131072, description: 'Exact nonblank text. Preserve spacing; do not include credentials, control characters or bidirectional formatting.' };
const operationSchemas = [
    properties({ action: { const: 'add' }, content: textSchema }),
    properties({ action: { const: 'replace' }, content: textSchema, old_text: textSchema }),
    properties({ action: { const: 'remove' }, old_text: textSchema }),
];
const targetSchema = { type: 'string', enum: ['memory', 'user'] };
export const MEMORY_PROPOSAL_TOOL = {
    name: 'memory_propose', title: 'Propose a memory change for human review',
    description: 'Propose preferences for exact human review in You → Bud → Bud’s memory. This tool only saves a pending proposal; it does not change saved memory, approve work or grant permissions. After an uncertain response, retry the same requestId and identical payload with a new transport request ID so RealBud can check the saved proposal. Never create a new requestId just to retry. A closed proposal is terminal: do not retry it or create a replacement unless the user asks for a new proposal.',
    inputSchema: properties({
        requestId: { type: 'string', minLength: 1, maxLength: 64, pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$', description: 'Stable idempotency key for this exact proposal; reuse unchanged after an uncertain response.' },
        payload: { oneOf: [...operationSchemas.map(schema => properties({ target: targetSchema, ...schema.properties })), properties({ target: targetSchema, action: { const: 'batch' }, operations: { type: 'array', minItems: 1, maxItems: 100, items: { oneOf: operationSchemas } } })] },
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};
const error = (message) => ({ content: [{ type: 'text', text: message }], isError: true });
const messages = {
    inactive: 'This memory proposal request is no longer active. Check saved reviews before continuing.',
    unavailable: 'Memory proposals are unavailable for this request. Check Bud setup and service access.',
    invalid: 'This memory proposal request is not supported. Use the exact proposal schema.',
    changed: 'This transport request changed. Use a new transport request ID without changing an uncertain proposal’s requestId or payload.',
    uncertain: 'The proposal result could not be confirmed. Check saved reviews or retry the same requestId and identical payload with a new transport request ID. No memory approval was created.',
    full: 'This memory proposal session is busy or full. Wait for pending work or start a new conversation before continuing.',
    closed: 'This interrupted proposal was closed by a person. Do not retry it or create a replacement automatically. A new proposal requires a new user request and normal human review.',
};
export async function startMemoryProposalBroker(options) {
    const token = randomBytes(32).toString('hex');
    const expectedAuthorization = Buffer.from(`Bearer ${token}`);
    const assertCapability = options.assertCapability ?? (() => managedService.assertCapability('reasoning'));
    const entries = new Map(), nativeControllers = new Set();
    let closed = false, generation = 0, authority = '', cachedBytes = 0;
    const authorized = () => {
        try {
            if (closed || !options.isActive())
                return error(messages.inactive);
            assertCapability();
            return null;
        }
        catch {
            return error(messages.unavailable);
        }
    };
    const cancelPending = () => { generation++; for (const controller of nativeControllers)
        controller.abort(); };
    const server = createServer((req, res) => {
        void (async () => {
            const receivedGeneration = generation;
            const headerCount = (name) => req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length;
            const authorization = Buffer.from(req.headers.authorization ?? '');
            if (closed || req.socket.remoteAddress !== '127.0.0.1' || Object.hasOwn(req.headers, 'origin') || req.headers.host !== authority ||
                headerCount('host') !== 1 || headerCount('authorization') !== 1 || authorization.length !== expectedAuthorization.length || !timingSafeEqual(authorization, expectedAuthorization)) {
                res.writeHead(403).end();
                return;
            }
            if (req.method !== 'POST' || req.url !== '/mcp') {
                res.writeHead(405).end();
                return;
            }
            const chunks = [];
            let bytes = 0;
            const bodyTimer = setTimeout(() => req.destroy(), 10_000);
            bodyTimer.unref();
            try {
                for await (const chunk of req) {
                    bytes += chunk.length;
                    if (bytes > 70 * 1024) {
                        res.writeHead(413).end();
                        return;
                    }
                    chunks.push(Buffer.from(chunk));
                }
            }
            finally {
                clearTimeout(bodyTimer);
            }
            const body = Buffer.concat(chunks);
            let msg;
            try {
                const decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
                if (!object(decoded))
                    throw new Error();
                msg = decoded;
            }
            catch {
                res.writeHead(400).end();
                return;
            }
            if (msg.jsonrpc !== '2.0' || typeof msg.method !== 'string' || msg.method.length > 128 || Object.keys(msg).some(key => !['jsonrpc', 'id', 'method', 'params'].includes(key))) {
                res.writeHead(400).end();
                return;
            }
            if (!Object.hasOwn(msg, 'id')) {
                if (msg.method === 'notifications/initialized' && (msg.params === undefined || object(msg.params) && Object.keys(msg.params).length === 0))
                    res.writeHead(202).end();
                else
                    res.writeHead(400).end();
                return;
            }
            const id = msg.id;
            if (!(typeof id === 'number' && Number.isSafeInteger(id)) && !(typeof id === 'string' && id.length > 0 && id.length <= 100 && !/[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(id) && !/[\ud800-\udfff]/u.test(id))) {
                res.writeHead(400).end();
                return;
            }
            const reply = (result) => { if (!res.destroyed && !res.writableEnded)
                res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify({ jsonrpc: '2.0', id, result })); };
            // The SDK discovers tools during session/new, before the current prompt is active.
            if (['initialize', 'tools/list', 'ping'].includes(msg.method) && msg.params !== undefined && (!object(msg.params) ||
                Object.keys(msg.params).some(key => !(msg.method === 'initialize' ? ['protocolVersion', 'capabilities', 'clientInfo', '_meta'] : ['_meta']).includes(key)) ||
                msg.params._meta !== undefined && !object(msg.params._meta))) {
                reply(error(messages.invalid));
                return;
            }
            if (msg.method === 'initialize') {
                reply({ protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'RealBud memory proposals', version: '1.0.0' } });
                return;
            }
            if (msg.method === 'tools/list') {
                reply({ tools: [MEMORY_PROPOSAL_TOOL] });
                return;
            }
            if (msg.method === 'ping') {
                reply({});
                return;
            }
            if (msg.method !== 'tools/call') {
                reply(error(messages.invalid));
                return;
            }
            const denied = authorized();
            if (denied) {
                reply(denied);
                return;
            }
            if (receivedGeneration !== generation) {
                reply(error(messages.inactive));
                return;
            }
            if (!object(msg.params) || Object.keys(msg.params).some(key => !['name', 'arguments', '_meta'].includes(key)) ||
                msg.params.name !== MEMORY_PROPOSAL_TOOL.name || msg.params._meta !== undefined && !object(msg.params._meta)) {
                reply(error(messages.invalid));
                return;
            }
            const input = parseMemoryProposalInput(msg.params.arguments);
            if (!input) {
                reply(error(messages.invalid));
                return;
            }
            const key = `${typeof id}:${id}`, fingerprint = createHash('sha256').update(body).digest('hex');
            let entry = entries.get(key);
            if (entry && entry.fingerprint !== fingerprint) {
                reply(error(messages.changed));
                return;
            }
            if (!entry) {
                if (entries.size >= 256 || cachedBytes + key.length + 1024 > 2 * 1024 * 1024 || nativeControllers.size >= 4) {
                    reply(error(messages.full));
                    return;
                }
                const controller = new AbortController();
                nativeControllers.add(controller);
                entry = { fingerprint, controller, generation, finished: false, response: Promise.resolve(error(messages.uncertain)) };
                entries.set(key, entry);
                cachedBytes += key.length + 1024;
                const owned = entry;
                const deadline = setTimeout(() => controller.abort(), 35_000);
                deadline.unref();
                // The native promise retains its concurrency slot even if it ignores abort.
                const native = Promise.resolve().then(async () => {
                    if (controller.signal.aborted || owned.generation !== generation || authorized())
                        throw new Error();
                    return options.propose(input, controller.signal);
                });
                const settled = native.then(value => {
                    if (controller.signal.aborted || owned.generation !== generation || authorized())
                        return error(messages.uncertain);
                    const result = parseMemoryProposalResult(value);
                    return result ? { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result } : error(messages.uncertain);
                }, cause => {
                    if (controller.signal.aborted || owned.generation !== generation || authorized())
                        return error(messages.uncertain);
                    return error(object(cause) && cause.code === 'proposal-closed' ? messages.closed : messages.uncertain);
                }).finally(() => { nativeControllers.delete(controller); clearTimeout(deadline); });
                let onAbort;
                const aborted = new Promise(resolve => { onAbort = () => resolve(error(messages.uncertain)); controller.signal.addEventListener('abort', onAbort, { once: true }); if (controller.signal.aborted)
                    onAbort(); });
                entry.response = Promise.race([settled, aborted]).finally(() => { owned.finished = true; controller.signal.removeEventListener('abort', onAbort); });
            }
            const pending = entry;
            const disconnect = () => { if (!res.writableEnded && !pending.finished)
                pending.controller.abort(); };
            res.once('close', disconnect);
            try {
                const result = await pending.response;
                // Cache replay is a capability use too; a completed result never bypasses a stopped turn.
                reply(authorized() ?? (receivedGeneration !== generation ? error(messages.inactive) : result));
            }
            finally {
                res.off('close', disconnect);
            }
        })().catch(() => { if (!res.destroyed && !res.writableEnded) {
            if (!res.headersSent)
                res.writeHead(400);
            res.end();
        } });
    });
    server.requestTimeout = 10_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 1000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === 'string') {
        server.close();
        throw new Error('Memory proposal service could not start.');
    }
    authority = `127.0.0.1:${address.port}`;
    return {
        descriptor: { type: 'http', name: 'memory-proposals', url: `http://${authority}/mcp`, headers: [{ name: 'authorization', value: `Bearer ${token}` }] },
        cancelPending,
        close() { if (closed)
            return; closed = true; cancelPending(); server.close(); server.closeAllConnections(); entries.clear(); },
    };
}
