import { createHash, timingSafeEqual, X509Certificate } from 'node:crypto';
import https from 'node:https';
import { isIP } from 'node:net';
import tls from 'node:tls';
const MAX_BYTES = 32 * 1024;
// A bounded list of reviewed work contains both summaries and responses.
// Keep request admission small; responses have a separate finite ceiling.
const MAX_RESPONSE_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MEMBER_HEADER = 'x-realbud-member-session';
const EXECUTION_HEADER = 'x-realbud-execution-grant';
const ALLOWED = new Map([
    ['/api/company/status', new Set(['GET'])],
    ['/api/company/join', new Set(['POST'])],
    ['/api/company/sign-in', new Set(['POST'])],
    ['/api/company/recover-member', new Set(['POST'])],
    ['/api/company/me', new Set(['GET'])],
    ...['begin', 'confirm', 'revoke', 'list'].map(action => [`/api/company/execution-grants/${action}`, new Set(['POST'])]),
    ...['admit', 'check', 'renew', 'settle'].map(action => [`/api/company/execution/${action}`, new Set(['POST'])]),
    ['/api/company/portal-bindings/begin', new Set(['POST'])],
    ['/api/company/portal-bindings/accept', new Set(['POST'])],
    ['/api/company/portal-bindings/confirm', new Set(['POST'])],
    ['/api/company/portal-bindings/revoke', new Set(['POST'])],
    ['/api/company/portal-bindings/list', new Set(['POST'])],
    ['/api/company/logout', new Set(['POST'])],
    ['/api/company/invitations', new Set(['POST'])],
    ['/api/company/invitations/revoke', new Set(['POST'])],
    ['/api/company/members/revoke', new Set(['POST'])],
    ['/api/company/membership/management', new Set(['POST'])],
    ['/api/company/membership/leave', new Set(['POST'])],
    ['/api/company/membership/departure-status', new Set(['POST'])],
    ['/api/company/ownership/offer', new Set(['POST'])],
    ['/api/company/ownership/accept', new Set(['POST'])],
    ['/api/company/ownership/cancel', new Set(['POST'])],
    ['/api/company/credentials', new Set(['POST'])],
    ['/api/company/workflow-template', new Set(['GET', 'PUT'])],
    ['/api/company/work-members', new Set(['GET'])],
    ['/api/company/work', new Set(['GET', 'POST'])],
    ['/api/company/work/list', new Set(['POST'])],
    ['/api/company/work/respond', new Set(['POST'])],
    ['/api/company/work/close', new Set(['POST'])],
    ['/api/company/work/accept', new Set(['POST'])],
    ['/api/company/work/reassign', new Set(['POST'])],
    ['/api/company/work/history', new Set(['POST'])],
    ['/api/company/scopes', new Set(['GET', 'POST'])],
    ['/api/company/departments/list', new Set(['POST'])],
    ['/api/company/departments', new Set(['POST'])],
    ['/api/company/departments/access', new Set(['POST', 'PUT'])],
    ['/api/company/departments/cases', new Set(['POST'])],
    ['/api/company/departments/cases/recover', new Set(['POST'])],
    ['/api/company/departments/cases/create', new Set(['POST'])],
    ['/api/company/departments/cases/assign', new Set(['POST'])],
    ['/api/company/departments/cases/close', new Set(['POST'])],
    ['/api/company/departments/assignees', new Set(['POST'])],
    ['/api/company/departments/lifecycle', new Set(['POST'])],
    ['/api/company/knowledge/read', new Set(['POST'])],
    ['/api/company/knowledge/history', new Set(['POST'])],
    ['/api/company/knowledge', new Set(['PUT'])],
    ['/api/company/grants', new Set(['PUT'])],
    ['/api/company/cases', new Set(['POST'])],
    ['/api/company/cases/claim', new Set(['POST'])],
    ['/api/company/cases/renew', new Set(['POST'])],
    ['/api/company/cases/settle', new Set(['POST'])],
]);
const RESPONSE_HEADERS = {
    'cache-control': 'no-store',
    pragma: 'no-cache',
    'x-content-type-options': 'nosniff',
    'content-type': 'application/json; charset=utf-8',
    connection: 'close',
};
export function companyCertificateFingerprint(pem) {
    return sha256Der(new X509Certificate(pem).raw);
}
function sha256Der(der) {
    return createHash('sha256').update(der).digest('hex');
}
function fingerprintsEqual(left, right) {
    const a = Buffer.from(left, 'hex');
    const b = Buffer.from(right, 'hex');
    return a.length === 32 && a.length === b.length && timingSafeEqual(a, b);
}
function isValidHostname(host) {
    if (host.length === 0 || host.length > 253)
        return false;
    if (isIP(host) !== 0)
        return true;
    return host.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label));
}
function isCanonicalPath(path) {
    if (path.length < 2 || path.length > 128)
        return false;
    if (!path.startsWith('/') || path.endsWith('/'))
        return false;
    if (path.includes('?') || path.includes('#') || path.includes('\\') || path.includes('//'))
        return false;
    if (path.includes('%') || path.includes('..') || path.includes('./') || path.includes('\0'))
        return false;
    return path === path.trim() && path === encodeURI(path);
}
function sendJson(res, status, body) {
    if (res.headersSent || res.writableEnded)
        return;
    let payload;
    try {
        payload = JSON.stringify(body) ?? 'null';
    }
    catch {
        status = 500;
        payload = '{"error":"internal error"}';
    }
    if (Buffer.byteLength(payload) > MAX_RESPONSE_BYTES) {
        status = 500;
        payload = '{"error":"internal error"}';
    }
    res.writeHead(status, { ...RESPONSE_HEADERS, 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
}
function isBrowserAttempt(headers) {
    if (headers.origin != null && headers.origin !== '')
        return true;
    const mode = String(headers['sec-fetch-mode'] ?? '').toLowerCase();
    if (mode === 'cors' || mode === 'navigate' || mode === 'websocket')
        return true;
    if (String(headers['sec-fetch-site'] ?? '').toLowerCase() === 'cross-site')
        return true;
    if (headers['access-control-request-method'] != null)
        return true;
    return String(headers.upgrade ?? '').toLowerCase() === 'websocket';
}
function companyAuthorityHeaders(headers) {
    const value = headers[MEMBER_HEADER];
    const execution = headers[EXECUTION_HEADER];
    const result = {};
    if (typeof value === 'string' && value.length > 0 && value.length <= 4096 && !/[\0\r\n]/.test(value))
        result[MEMBER_HEADER] = value;
    if (typeof execution === 'string' && /^[a-f0-9]{64}$/.test(execution))
        result[EXECUTION_HEADER] = execution;
    return result;
}
function parseRequestPath(url) {
    if (url == null || url.length === 0)
        return null;
    if (url.includes('?') || url.includes('#') || url.includes('\\') || url.includes('\0'))
        return null;
    return isCanonicalPath(url) ? url : null;
}
function closeServer(server) {
    return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
        if (typeof server.closeAllConnections === 'function')
            server.closeAllConnections();
    });
}
function readLimitedBody(req) {
    const declared = req.headers['content-length'];
    if (typeof declared === 'string') {
        const n = Number(declared);
        if (!Number.isFinite(n) || n < 0 || n > MAX_BYTES) {
            req.resume();
            return Promise.resolve('too-large');
        }
    }
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        let settled = false;
        const done = (value) => {
            if (settled)
                return;
            settled = true;
            resolve(value);
        };
        req.on('data', (chunk) => {
            total += chunk.length;
            if (total > MAX_BYTES) {
                req.pause();
                req.resume();
                done('too-large');
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => done(Buffer.concat(chunks)));
        req.on('error', (err) => {
            if (!settled) {
                settled = true;
                reject(err);
            }
        });
    });
}
async function serve(req, res, handle) {
    req.setTimeout(DEFAULT_TIMEOUT_MS, () => {
        sendJson(res, 408, { error: 'invalid request' });
        req.destroy();
    });
    try {
        if (isBrowserAttempt(req.headers)) {
            sendJson(res, 403, { error: 'forbidden' });
            return;
        }
        const method = req.method ?? '';
        const path = parseRequestPath(req.url);
        if (path == null) {
            sendJson(res, 404, { error: 'not found' });
            return;
        }
        const allowedMethods = ALLOWED.get(path);
        if (allowedMethods == null) {
            sendJson(res, 404, { error: 'not found' });
            return;
        }
        if (!allowedMethods.has(method)) {
            sendJson(res, 405, { error: 'method not allowed' });
            return;
        }
        const raw = await readLimitedBody(req);
        if (raw === 'too-large') {
            sendJson(res, 413, { error: 'payload too large' });
            return;
        }
        let body;
        if (method === 'GET' || method === 'HEAD') {
            if (raw.length > 0) {
                sendJson(res, 400, { error: 'invalid request' });
                return;
            }
        }
        else if (raw.length > 0) {
            const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
            if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
                sendJson(res, 400, { error: 'invalid request' });
                return;
            }
            try {
                body = JSON.parse(raw.toString('utf8'));
            }
            catch {
                sendJson(res, 400, { error: 'invalid request' });
                return;
            }
        }
        const result = await handle(path, method, { headers: companyAuthorityHeaders(req.headers) }, body);
        const status = Number.isInteger(result.status) && result.status >= 100 && result.status <= 599 ? result.status : 500;
        sendJson(res, status, result.body);
    }
    catch {
        sendJson(res, 500, { error: 'internal error' });
    }
}
export async function startCompanyTransport(options) {
    const { host, port, key, cert, handle } = options;
    if (typeof host !== 'string' || host.length === 0)
        throw new Error('invalid company origin');
    if (!Number.isInteger(port) || port < 0 || port > 65535)
        throw new Error('invalid company origin');
    if (typeof key !== 'string' || key.length === 0 || typeof cert !== 'string' || cert.length === 0) {
        throw new Error('invalid company certificate');
    }
    const server = https.createServer({ key, cert, minVersion: 'TLSv1.2', requestCert: false, handshakeTimeout: DEFAULT_TIMEOUT_MS }, (req, res) => {
        void serve(req, res, handle);
    });
    server.requestTimeout = DEFAULT_TIMEOUT_MS;
    server.headersTimeout = 5_000;
    server.timeout = DEFAULT_TIMEOUT_MS;
    server.keepAliveTimeout = 0;
    server.maxConnections = 64;
    server.maxHeadersCount = 32;
    await new Promise((resolve, reject) => {
        const onError = (err) => reject(err);
        server.once('error', onError);
        server.listen(port, host, () => {
            server.off('error', onError);
            resolve();
        });
    });
    const address = server.address();
    if (address == null || typeof address === 'string') {
        await closeServer(server);
        throw new Error('company transport failed to bind');
    }
    let closed = false;
    return {
        port: address.port,
        close: async () => {
            if (closed)
                return;
            closed = true;
            await closeServer(server);
        },
    };
}
function parseCompanyOrigin(origin) {
    let url;
    try {
        url = new URL(origin);
    }
    catch {
        throw new Error('invalid company origin');
    }
    if (url.protocol !== 'https:')
        throw new Error('invalid company origin');
    if (url.username !== '' || url.password !== '')
        throw new Error('invalid company origin');
    if (url.pathname !== '/' && url.pathname !== '')
        throw new Error('invalid company origin');
    if (url.search !== '' || url.hash !== '')
        throw new Error('invalid company origin');
    if (origin.includes('@') || origin.includes('?') || origin.includes('#'))
        throw new Error('invalid company origin');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    if (!isValidHostname(hostname))
        throw new Error('invalid company origin');
    const port = url.port === '' ? 443 : Number(url.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('invalid company origin');
    return { hostname, port };
}
function failedRequest() {
    return new Error('company host request failed');
}
export async function requestCompanyHost(options) {
    const { origin, certificatePem, path, method, memberToken, executionToken, body, signal } = options;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000)
        throw new Error('company host timeout');
    if (!/^[A-Z]+$/.test(method) || method.length > 16)
        throw new Error('invalid company path');
    if (!isCanonicalPath(path) || !ALLOWED.get(path)?.has(method))
        throw new Error('invalid company path');
    if (executionToken !== undefined && (!/^\/api\/company\/execution\/(admit|check|renew|settle)$/.test(path) || !/^[a-f0-9]{64}$/.test(executionToken) || memberToken))
        throw new Error('invalid execution credential');
    const { hostname, port } = parseCompanyOrigin(origin);
    let expectedFp;
    try {
        expectedFp = companyCertificateFingerprint(certificatePem);
    }
    catch {
        throw new Error('invalid company certificate');
    }
    let payload;
    if (body !== undefined) {
        if (method === 'GET' || method === 'HEAD')
            throw new Error('invalid company path');
        try {
            payload = JSON.stringify(body);
        }
        catch {
            throw new Error('invalid company path');
        }
        if (payload == null || Buffer.byteLength(payload) > MAX_BYTES)
            throw new Error('payload too large');
    }
    const checkServerIdentity = (host, peer) => {
        const identityError = tls.checkServerIdentity(host, peer);
        if (identityError)
            return identityError;
        if (peer.raw == null)
            return failedRequest();
        if (!fingerprintsEqual(sha256Der(peer.raw), expectedFp))
            return failedRequest();
        return undefined;
    };
    return await new Promise((resolve, reject) => {
        let settled = false;
        let deadline;
        const req = https.request({
            hostname,
            port,
            path,
            method,
            servername: isIP(hostname) === 0 ? hostname : undefined,
            ca: certificatePem,
            // Pairing trusts this exact host certificate, including existing
            // non-CA leaves. Electron's TLS stack otherwise rejects those leaves
            // even though stock Node accepts them. Keep chain validation enabled;
            // hostname and exact DER pin checks still gate every request below.
            allowPartialTrustChain: true,
            minVersion: 'TLSv1.2',
            rejectUnauthorized: true,
            agent: false,
            timeout: timeoutMs,
            headers: {
                accept: 'application/json',
                'cache-control': 'no-store',
                ...(payload != null
                    ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
                    : { 'content-length': 0 }),
            },
            checkServerIdentity,
        });
        const cleanup = () => {
            clearTimeout(deadline);
            signal?.removeEventListener('abort', onAbort);
            req.setTimeout(0);
            req.removeListener('timeout', onTimeout);
        };
        const fail = (err) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            req.destroy();
            reject(err);
        };
        const succeed = (value) => {
            if (settled)
                return;
            settled = true;
            cleanup();
            resolve(value);
        };
        const onAbort = () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            fail(err);
        };
        const onTimeout = () => fail(new Error('company host timeout'));
        deadline = setTimeout(onTimeout, timeoutMs);
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted)
            onAbort();
        req.setTimeout(timeoutMs, onTimeout);
        req.on('timeout', onTimeout);
        req.on('error', () => fail(failedRequest()));
        req.on('response', (res) => {
            if (res.statusCode != null && res.statusCode >= 300 && res.statusCode < 400) {
                succeed({ status: res.statusCode, body: null });
                res.destroy();
                return;
            }
            const chunks = [];
            let total = 0;
            res.on('data', (chunk) => {
                total += chunk.length;
                if (total > MAX_RESPONSE_BYTES) {
                    res.destroy();
                    fail(new Error('payload too large'));
                    return;
                }
                chunks.push(chunk);
            });
            res.on('end', () => {
                if (settled)
                    return;
                const raw = Buffer.concat(chunks);
                if (raw.length === 0) {
                    succeed({ status: res.statusCode ?? 0, body: null });
                    return;
                }
                try {
                    succeed({ status: res.statusCode ?? 0, body: JSON.parse(raw.toString('utf8')) });
                }
                catch {
                    fail(failedRequest());
                }
            });
            res.on('error', () => fail(failedRequest()));
        });
        req.on('socket', (socket) => {
            socket.once('secureConnect', () => {
                try {
                    const peer = socket.getPeerCertificate(true);
                    if (peer?.raw == null || !fingerprintsEqual(sha256Der(peer.raw), expectedFp)) {
                        fail(failedRequest());
                        return;
                    }
                    const x509 = socket.getPeerX509Certificate();
                    if (!x509 || !fingerprintsEqual(sha256Der(x509.raw), expectedFp)) {
                        fail(failedRequest());
                        return;
                    }
                    if (memberToken != null && memberToken.length > 0) {
                        if (memberToken.length > 4096 || memberToken.includes('\r') || memberToken.includes('\n')) {
                            fail(failedRequest());
                            return;
                        }
                        req.setHeader(MEMBER_HEADER, memberToken);
                    }
                    if (executionToken)
                        req.setHeader(EXECUTION_HEADER, executionToken);
                    req.end(payload);
                }
                catch {
                    fail(failedRequest());
                }
            });
        });
    });
}
