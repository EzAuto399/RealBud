Review only two corrected security/integrity boundaries in the supplied current source. No tools, edits, additional subagents, or broader architecture review. Return your final verdict now, at most three concrete findings and short limitations. A changes-required verdict must cite a reachable failure in these actual implementations.

1. Download stream now retains the last chunk before yielding it until same-pass stat and digest checks succeed. All yielded chunks own copied memory. HTTP uses pipeline and Content-Length and destroys an errored response.
2. Native-download cookie now uses a separate random per-boot HMAC key, binds exact ticket URL and expiry; it is checked only as a cookie for exact GET. It is never compared against SESSION_TOKEN. Master headers/query still grant normal master access. Ticket route also checks independent unpredictable single-use ticket, expiry, ready operation and digest. Duplicate same-name cookies deliberately fail closed; cookie Path is exact per ticket so normal parallel tickets do not collide. Do not recommend accepting ambiguous credentials.

Tests already passed for independent retained chunk buffers, byte corruption during small/large real HTTP download (client rejects body), concurrent stage, same-pass verification. Auth tests cover alternate ticket, method, route, tampering, duplicate, expiry, and proof replay through Bearer/header/query. New actual HTTP cookie boundary test is being run.

FILE server/session-auth.ts
// Per-boot API session + loopback Host/Origin checks.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const SESSION_TOKEN = randomBytes(24).toString("hex");

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

export function hostAllowed(hostHeader: string | undefined, listenPort: number): boolean {
  if (!hostHeader) return false;
  const raw = hostHeader.split(",")[0]?.trim() ?? "";
  const [hostname, port] = raw.startsWith("[")
    ? [raw.slice(0, raw.indexOf("]") + 1), raw.slice(raw.lastIndexOf(":") + 1)]
    : raw.includes(":")
      ? [raw.slice(0, raw.lastIndexOf(":")), raw.slice(raw.lastIndexOf(":") + 1)]
      : [raw, ""];
  if (!LOOPBACK_HOSTS.has(hostname.toLowerCase())) return false;
  if (!port) return true;
  return Number(port) === listenPort;
}

export function originAllowed(origin: string | undefined, listenPort: number): boolean {
  if (!origin || origin === "null") return true;
  try {
    const url = new URL(origin);
    if (!LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return false;
    if (!url.port) return url.protocol === "http:" || url.protocol === "https:";
    const port = Number(url.port);
    const configuredUiPort = Number(process.env.OMB_UI_PORT);
    const uiPortAllowed = Number.isInteger(configuredUiPort) && configuredUiPort > 0 && configuredUiPort <= 65_535
      ? port === configuredUiPort
      : false;
    return port === listenPort || port === 5199 || port === 5173 || uiPortAllowed;
  } catch {
    return false;
  }
}

const DOWNLOAD_PATH = /^\/api\/private-backup\/v2\/downloads\/[A-Za-z0-9_-]{32,128}$/;
const DOWNLOAD_COOKIE = 'realbud-backup-download=';
const DOWNLOAD_KEY = randomBytes(32), DOWNLOAD_LIFETIME = 5 * 60_000;
function downloadProof(path: string, expiresAt: number): string {
  return createHmac('sha256', DOWNLOAD_KEY).update(`backup-download-v1\n${path}\n${expiresAt}`).digest('hex');
}
/** Native downloads cannot attach the renderer's custom header. This separate
 * per-boot proof grants only the exact ticket GET until expiry. It is never an
 * app session token, including if copied into a header or query parameter. */
export function privateBackupDownloadSessionCookie(ticket: { url: string; expiresAt: number }): string {
  const remaining = ticket.expiresAt - Date.now();
  if (!DOWNLOAD_PATH.test(ticket.url) || !Number.isSafeInteger(ticket.expiresAt) || remaining <= 0 || remaining > DOWNLOAD_LIFETIME) throw new Error('Invalid backup download grant.');
  return `${DOWNLOAD_COOKIE}${ticket.expiresAt}.${downloadProof(ticket.url, ticket.expiresAt)}; HttpOnly; SameSite=Strict; Path=${ticket.url}; Max-Age=${Math.ceil(remaining / 1000)}`;
}
function downloadSessionOk(req: IncomingMessage): boolean {
  if ((req.method ?? 'GET') !== 'GET') return false;
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (!DOWNLOAD_PATH.test(url.pathname)) return false;
    const values = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(DOWNLOAD_COOKIE));
    // Ambiguous credentials fail closed; each ticket uses its own cookie path.
    if (values.length !== 1) return false;
    const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(values[0]!.slice(DOWNLOAD_COOKIE.length));
    if (!match) return false;
    const expiresAt = Number(match[1]), remaining = expiresAt - Date.now();
    return remaining > 0 && remaining <= DOWNLOAD_LIFETIME && tokensEqual(match[2]!, downloadProof(url.pathname, expiresAt));
  } catch { return false; }
}
function tokenFromRequest(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const header = req.headers["x-realbud-session"];
  if (typeof header === "string" && header.trim()) return header.trim();
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const q = url.searchParams.get("session");
    if (q) return q;
  } catch {
    /* ignore */
  }
  return null;
}

export function tokensEqual(got: string, want: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sessionOk(req: IncomingMessage, listenPort: number): { ok: true } | { ok: false; status: number; error: string } {
  if (!hostAllowed(typeof req.headers.host === "string" ? req.headers.host : undefined, listenPort)) {
    return { ok: false, status: 403, error: "refused host" };
  }
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : undefined;
  if (!originAllowed(origin, listenPort)) {
    return { ok: false, status: 403, error: "refused origin" };
  }
  const token = tokenFromRequest(req);
  if (token ? !tokensEqual(token, SESSION_TOKEN) : !downloadSessionOk(req)) {
    return { ok: false, status: 401, error: "session required" };
  }
  return { ok: true };
}

export function needsSession(path: string, method?: string): boolean {
  if (path === "/api/health" || path === "/api/session") return false;
  if (!path.startsWith("/api/")) return false;
  if (path.startsWith("/api/internal/")) return false;
  // Ask can create a provider sign-in or execute an approved app operation.
  // Protect every mutation of its bot/thread state, including queued work,
  // edits, steering and approval responses. Keep legacy read-only views intact.
  if (method && !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) &&
    /^\/api\/(?:bots|threads|instances)(?:\/|$)/.test(path)) return true;
  return (
    path === "/api/config" ||
    path.startsWith("/api/hermes") ||
    path.startsWith("/api/care") ||
    path.startsWith("/api/service-admin") ||
    path.startsWith("/api/service/") ||
    path.startsWith("/api/tts") ||
    path.startsWith("/api/company") ||
    path.startsWith("/api/connected-apps") ||
    path === "/api/browser" || path.startsWith("/api/browser/") ||
    path.startsWith("/api/desk") ||
    path.startsWith("/api/channels") ||
    path.startsWith("/api/rules") ||
    path.startsWith("/api/law-watch") ||
    path.startsWith("/api/workflow-packs") ||
    path.startsWith("/api/customer-packs") ||
    path.startsWith("/api/agency-setup") ||
    path.startsWith("/api/private-backup") ||
    path.startsWith("/api/mail-workspace") ||
    path.startsWith("/api/workspace-tabs") ||
    path.startsWith("/api/expected-bills") ||
    /^\/api\/bill-(?:register|evidence|occurrences|series|scan|proposals|review-drafts)(?:\/|$)/.test(path) ||
    path.startsWith("/api/recipes") ||
    path.startsWith("/api/job-runs") ||
    path.startsWith("/api/computer-history") ||
    path.startsWith("/api/worker-issues") ||
    path.startsWith("/api/loops") ||
    path.startsWith("/api/loop-runs") ||
    path.startsWith("/api/artifacts") ||
    path.startsWith("/api/portal") ||
    path.startsWith("/api/imports") ||
    path.startsWith("/api/events")
  );
}

FILE server/private-backup-http.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { privateBackupDownloadSessionCookie } from './session-auth.ts';
import { createPrivateBackupV2Api } from './private-backup-v2-api.ts';
import type { createPrivateBackupCoordinator } from './private-backup-coordinator.ts';
import { PRIVATE_BACKUP_TRANSFER_API, PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES, PRIVATE_BACKUP_TRANSFER_ERRORS, parsePrivateBackupDownloadTicket } from '../shared/private-backup-transfers.ts';

type Coordinator = Awaited<ReturnType<typeof createPrivateBackupCoordinator>>;
const fail = (status: number): never => { throw Object.assign(new Error('The backup request could not be read.'), { status }); };
function body(req: IncomingMessage, maximum: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let bytes = 0, done = false;
    const timer = setTimeout(() => finish(Object.assign(new Error('Backup request timed out.'), { status: 408 })), 30_000); timer.unref();
    function finish(error?: unknown) {
      if (done) return; done = true; clearTimeout(timer);
      req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', aborted);
      if (error) { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; req.resume(); reject(error); }
      else { const result = Buffer.concat(chunks, bytes); for (const chunk of chunks) chunk.fill(0); resolve(result); }
    }
    function data(chunk: Buffer) { bytes += chunk.length; if (bytes > maximum) return finish(Object.assign(new Error('Backup request too large.'), { status: 413 })); chunks.push(Buffer.from(chunk)); }
    function end() { finish(); }
    function failed() { finish(Object.assign(new Error('Backup request interrupted.'), { status: 400 })); }
    function aborted() { failed(); }
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', aborted);
    if (req.aborted || req.destroyed) failed();
  });
}
/** The HTTP host MUST validate local session/Host/Origin before this handler.
 * No exception message is returned; it may contain a key, path or source data. */
export async function handlePrivateBackupV2Http(req: IncomingMessage, res: ServerResponse, url: URL, service: Coordinator): Promise<boolean> {
  if (url.pathname !== PRIVATE_BACKUP_TRANSFER_API && !url.pathname.startsWith(`${PRIVATE_BACKUP_TRANSFER_API}/`)) return false;
  res.setHeader('cache-control', 'no-store'); res.setHeader('x-content-type-options', 'nosniff');
  const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
  let raw: Buffer | undefined;
  try {
    const method = req.method ?? 'GET', chunk = method === 'PUT' && /\/uploads\/[^/]+\/chunks$/.test(url.pathname);
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') fail(400);
    if (!['GET', 'HEAD'].includes(method)) {
      if (chunk && req.headers['content-type']?.split(';')[0] !== 'application/octet-stream') fail(400);
      if (!chunk && req.headers['content-type']?.split(';')[0] !== 'application/json') fail(400);
      raw = await body(req, chunk ? PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES : 16 * 1024);
    }
    let parsed: unknown;
    if (raw && !chunk) { try { parsed = raw.length ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) : {}; } catch { fail(400); } }
    const api = createPrivateBackupV2Api({ service: () => service });
    const result = await api({ path: url.pathname, method, query: url.searchParams, body: parsed, bytes: chunk ? raw : undefined, chunkDigest: req.headers['x-realbud-chunk-sha256'] });
    if (!result) return false;
    if ('downloadTicket' in result) {
      await service.download(result.downloadTicket, async (ticket, chunks, signal) => {
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': ticket.archiveBytes,
          'content-disposition': `attachment; filename="${ticket.filename}"`, 'referrer-policy': 'no-referrer' });
        await pipeline(Readable.from(chunks), res, { signal });
      });
    } else {
      if (method === 'POST' && /\/operations\/[^/]+\/download-ticket$/.test(url.pathname) && result.status === 200) {
        const ticket = parsePrivateBackupDownloadTicket(result.body); if (!ticket) fail(503);
        res.setHeader('set-cookie', privateBackupDownloadSessionCookie(ticket));
      }
      json(result.status, result.body);
    }
  } catch (error) {
    if (res.headersSent || res.destroyed) { res.destroy(); return true; }
    const rawStatus = (error as { status?: number })?.status, status = [400, 404, 408, 409, 413, 500, 503, 507].includes(rawStatus ?? 0) ? rawStatus! : 503;
    const code = status === 413 || status === 507 ? 'insufficient-space' : status === 400 ? 'invalid-backup' : status === 409 ? 'workspace-busy' : 'storage-unavailable';
    json(status, { error: PRIVATE_BACKUP_TRANSFER_ERRORS[code], code });
  } finally { raw?.fill(0); }
  return true;
}

COORDINATOR INPUT
  async function input(work: BackupResourceWork, path: string, size: number) {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); work.own(() => handle.close());
    const original = await handle.stat();
    if (!original.isFile() || original.nlink !== 1 || original.size !== size) fail('Backup bytes need recovery.', 503);
    async function* stream(expectedDigest?: string) {
      const hash = expectedDigest ? createHash('sha256') : undefined;
      const buffer = Buffer.alloc(PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES); let offset = 0, tail: Buffer | undefined;
      try {
        while (offset < size) {
          work.signal.throwIfAborted(); const read = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset); work.signal.throwIfAborted();
          if (!read.bytesRead) fail('The backup file changed.', 503);
          offset += read.bytesRead; const chunk = Buffer.from(buffer.subarray(0, read.bytesRead)); hash?.update(chunk);
          // Content-Length clients can accept completion before the generator
          // returns. Keep the final bytes until this exact pass is verified.
          if (offset === size) tail = chunk; else yield chunk;
        }
        const final = await handle.stat(); if (final.size !== original.size || final.mtimeMs !== original.mtimeMs || final.ctimeMs !== original.ctimeMs || expectedDigest && hash!.digest('hex') !== expectedDigest) fail('The backup file changed.', 503);
        work.signal.throwIfAborted(); if (tail) yield tail;
      } finally { buffer.fill(0); }
    }
    return { handle, stream };
  }

COORDINATOR DOWNLOAD
    async downloadTicket(id: string, digest: string): Promise<PrivateBackupDownloadTicket> {
      const record = operation(id, 'export'); if (tasks.has(id) || runtime.busy(id) || record.operation.phase !== 'ready' || record.operation.artifact?.archiveDigest !== digest) fail('Create or check the completed backup before downloading.');
      for (const [token, saved] of tickets) if (saved.ticket.expiresAt <= now()) tickets.delete(token);
      if (tickets.size >= 16) fail('Finish an existing backup download first.');
      const token = randomBytes(32).toString('base64url'), ticket = { ...record.operation.artifact, expiresAt: now() + 5 * 60_000, filename: `RealBud-private-work-${new Date(record.operation.createdAt).toISOString().slice(0, 10)}.realbud-backup`, url: `${PRIVATE_BACKUP_TRANSFER_API}/downloads/${token}` };
      tickets.set(token, { id, ticket }); return ticket;
    },
    /** Single-use, session-protected host streaming. Sink must finish/drain before
     * resolving. Never return a server file path to the browser. */
    async download(token: string, sink: (ticket: PrivateBackupDownloadTicket, chunks: AsyncIterable<Buffer>, signal: AbortSignal) => Promise<void>) {
      const saved = tickets.get(token); tickets.delete(token); if (!saved || saved.ticket.expiresAt <= now()) fail('This download link has expired.', 404);
      const record = operation(saved.id, 'export'); if (record.operation.phase !== 'ready' || record.operation.artifact?.archiveDigest !== saved.ticket.archiveDigest) fail('This backup is no longer available.', 404);
      await runtime.run(saved.id, async work => {
        const path = join(await work.access('archive'), 'archive.realbud-backup'), file = await input(work, path, saved.ticket.archiveBytes), hash = createHash('sha256');
        for await (const chunk of file.stream()) hash.update(chunk); if (hash.digest('hex') !== saved.ticket.archiveDigest) fail('The backup copy changed.', 503);
        await sink(saved.ticket, file.stream(saved.ticket.archiveDigest), work.signal);
      });
      // An earlier close failure stays visible until a new read and all of its
      // handle closes have actually succeeded after recovery.
      if (operation(saved.id).operation.error) edit(saved.id, next => { delete next.operation.error; });
    },
