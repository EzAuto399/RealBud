Complete one bounded final review now. No tools or edits. Check only the fixes in the supplied diff: independent download buffers plus same-pass digest before HTTP completion; process-wide stage mutex held through full async runtime; once-only lease release; committed ready/reviewed close-failure error; persisted recovery error. Also review the narrowly scoped native-download session cookie in supplied full HTTP/auth source. Return JSON verdict approve/changes-required, findings (max4), limitations. Root has 102 passing focused checks including retaining 4+ download buffers, concurrent stage across two reviewed operations, once-only release, session-cookie route/method isolation, v1 bound restore and cold completion. Tests are evidence, not reason to overlook defects. Earlier broader review facts verified from source: runtime.discard denies active work before deletion; journal creation maps capturing/sealing/checking to interrupted; legacy receipt digest is exactly SHA256(JSON.stringify(backup)) and IDs are UUID strings; actual host beginRestore is idempotent and assertFresh temporarily ignores its own held flag. Do not repeat counterfactual findings about those facts.

diff --git a/outputs/private-backup-v2-2026-09-21/private-backup-coordinator.before-final-review.ts b/server/private-backup-coordinator.ts
index 2c45add8..1256b757 100644
--- a/outputs/private-backup-v2-2026-09-21/private-backup-coordinator.before-final-review.ts
+++ b/server/private-backup-coordinator.ts
@@ -45,7 +45,7 @@ export async function createPrivateBackupCoordinator(host: PrivateBackupCoordina
   const journal = await createBackupOperationStore({ directory: join(root, 'operations'), key, workspaceId: host.workspaceId, restoreDirectory: directory, now });
   const runtime = createBackupResourceRuntime({ journal, directory: root, key });
   const tasks = new Map<string, Promise<unknown>>(), tickets = new Map<string, { id: string; ticket: PrivateBackupDownloadTicket }>();
-  let closing = false, closedService = false;
+  let closing = false, closedService = false, restoring: string | null = null;
   const edit = (id: string, change: (record: BackupOperationRecord) => void) => journal.update(id, journal.get(id).revision, change);
   const operation = (id: string, kind?: 'export' | 'upload') => { const record = journal.get(id); if (kind && record.operation.kind !== kind) fail('This backup operation was not found.', 404); return record; };
   const check = (id: string) => { if (closing || closed.has(operation(id).operation.phase)) fail('This backup operation is closed.'); };
@@ -54,7 +54,7 @@ export async function createPrivateBackupCoordinator(host: PrivateBackupCoordina
     do { const page = journal.list({ after }); const held = page.items.find(r => r.restoreHeld && r.operation.phase !== 'completed'); if (held) return held; after = page.next ?? undefined; } while (after);
     return null;
   }
-  function writable() { if (heldOperation()) fail('Finish the held restore before starting another backup action.'); }
+  function writable() { if (restoring || heldOperation()) fail('Finish the held restore before starting another backup action.'); }
   async function publishStage(id: string) {
     return runtime.run(id, async work => {
       const record = operation(id), ref = record.references.prepared;
@@ -84,6 +84,7 @@ export async function createPrivateBackupCoordinator(host: PrivateBackupCoordina
   }
   function failed(id: string, error: unknown) {
     const record = operation(id); if (closed.has(record.operation.phase) || record.restoreHeld) return;
+    if (['ready', 'reviewed'].includes(record.operation.phase)) { edit(id, next => { next.operation.error = { code: 'recovery-required' }; next.operation.requiresPassphrase = false; }); return; }
     const status = (error as { status?: number })?.status;
     host.diagnostic?.({ phase: record.operation.phase, status: status ?? 503, locations: ((error as Error)?.stack ?? '').split('\n').slice(1).flatMap(line => { const match = /server\/([A-Za-z0-9_.-]+\.ts:\d+:\d+)/.exec(line); return match ? [match[1]!] : []; }).slice(0, 8) });
     const code: PrivateBackupTransferErrorCode = status === 413 || status === 507 ? 'insufficient-space' : status === 400 ? 'invalid-backup' : status === 409 ? 'workspace-busy' : 'storage-unavailable';
@@ -99,11 +100,12 @@ export async function createPrivateBackupCoordinator(host: PrivateBackupCoordina
     const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); work.own(() => handle.close());
     const original = await handle.stat();
     if (!original.isFile() || original.nlink !== 1 || original.size !== size) fail('Backup bytes need recovery.', 503);
-    async function* stream() {
+    async function* stream(expectedDigest?: string) {
+      const hash = expectedDigest ? createHash('sha256') : undefined;
       const buffer = Buffer.alloc(PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES); let offset = 0;
       try {
-        while (offset < size) { work.signal.throwIfAborted(); const read = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset); work.signal.throwIfAborted(); if (!read.bytesRead) fail('The backup file changed.', 503); offset += read.bytesRead; yield buffer.subarray(0, read.bytesRead); }
-        const final = await handle.stat(); if (final.size !== original.size || final.mtimeMs !== original.mtimeMs || final.ctimeMs !== original.ctimeMs) fail('The backup file changed.', 503);
+        while (offset < size) { work.signal.throwIfAborted(); const read = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset); work.signal.throwIfAborted(); if (!read.bytesRead) fail('The backup file changed.', 503); offset += read.bytesRead; const chunk = Buffer.from(buffer.subarray(0, read.bytesRead)); hash?.update(chunk); yield chunk; }
+        const final = await handle.stat(); if (final.size !== original.size || final.mtimeMs !== original.mtimeMs || final.ctimeMs !== original.ctimeMs || expectedDigest && hash!.digest('hex') !== expectedDigest) fail('The backup file changed.', 503);
       } finally { buffer.fill(0); }
     }
     return { handle, stream };
@@ -205,11 +207,11 @@ export async function createPrivateBackupCoordinator(host: PrivateBackupCoordina
         await runtime.run(id, async work => {
           const target = await allocation(id, work, 'capture', catalogStorageBudget(limits).totalBytes);
           const catalog = await PrivateBackupCatalog.create({ directory: target.directory, key, workspaceId: host.workspaceId, ...limits }); work.own(() => catalog.close());
-          const lease = await host.snapshotLease(); work.own(() => lease.release()); const createdAt = new Date(now()).toISOString();
+          const lease = await host.snapshotLease(); let released = false; const release = () => { if (!released) { released = true; lease.release(); } }; work.own(release); const createdAt = new Date(now()).toISOString();
           const captureOptions = { directory, key, workspaceId: host.workspaceId, catalog, assertLease: () => lease.assertCurrent(), signal: work.signal };
           const captured = await capturePrivateWorkspace(captureOptions); await verifyPrivateWorkspaceCapture(captureOptions, captured); lease.assertCurrent();
           const summary = catalog.seal(); edit(id, next => { next.references.capture = { directoryId: target.binding.allocation.id, catalogId: catalog.catalogId, workspaceId: host.workspaceId, digest: summary.digest, createdAt, databasePresent: captured.databasePresent }; next.operation.phase = 'sealing'; });
-          lease.release();
+          release();
           const archive = await allocation(id, work, 'archive', PRIVATE_BACKUP_TRANSFER_MAX_BYTES); await mkdir(archive.directory, { mode: 0o700 }); await windowsFilePrivacy(archive.directory, 'directory', true);
           const path = join(archive.directory, 'archive.realbud-backup'), file = await open(path, 'wx', 0o600); work.own(() => file.close()); await windowsFilePrivacy(path, 'file', true);
           let bytes = 0, receipt: BackupArchiveReceipt | undefined;
@@ -223,33 +225,40 @@ export async function createPrivateBackupCoordinator(host: PrivateBackupCoordina
       }); return operation(id).operation;
     },
     async stage(id: string, digest: string) {
-      const record = operation(id, 'upload'); if (record.operation.artifact?.archiveDigest !== digest || !privateBackupTransferDigest(digest)) fail('The reviewed backup changed.');
-      if (['staged', 'applying', 'completed'].includes(record.operation.phase)) return record.operation;
-      if (record.restoreHeld && record.references.prepared && ['staging', 'failed'].includes(record.operation.phase)) return publishStage(id);
-      if (record.operation.phase !== 'reviewed' || tasks.has(id) || record.restoreHeld || !record.references.preview) fail('Review this complete backup before restoring.');
-      host.assertFresh(); host.assertIdle(); await runtime.discard(id, ['prepared', 'build']);
-      return runtime.run(id, async work => {
-        const lease = await host.snapshotLease(); work.own(() => lease.release()); lease.assertCurrent(); host.assertFresh();
-        const reference = operation(id).references.preview!;
-        const source = await PrivateBackupCatalog.open({ directory: await work.access('preview'), key, catalogId: reference.catalogId, workspaceId: reference.workspaceId }); work.own(() => source.close());
-        const summary = source.validate(); if (!summary.sealed || summary.digest !== reference.digest) fail('The reviewed backup needs recovery.', 503);
-        let filesBytes = 0, protectedFiles = 0, recordBytes = 0;
-        for (const file of source.iterateFiles()) { filesBytes += file.data.length; if (file.encoding === 'json') protectedFiles++; }
-        for (const row of source.iterateRecords()) recordBytes += Buffer.byteLength(JSON.stringify(row.value));
-        const databaseBytes = capacity(256 * 1024 + summary.records * 16 * 1024 + 2 * recordBytes, PRIVATE_BACKUP_BUILD_MAX_BYTES);
-        const bytes = capacity(2 * filesBytes + 1024 * protectedFiles + (reference.databasePresent ? databaseBytes : 0), PRIVATE_BACKUP_PREPARED_LIMITS.bytes);
-        const preparedLimits = { bytes, sqliteBytes: capacity(256 * 1024 + 2 * bytes + 16 * 1024 * (summary.files + 1), PRIVATE_BACKUP_PREPARED_LIMITS.sqliteBytes) };
-        const preparedAllocation = await allocation(id, work, 'prepared', preparedStorageBudget(preparedLimits).totalBytes);
-        const build = reference.databasePresent ? await allocation(id, work, 'build', privateBackupBuildStorageBudget(databaseBytes).totalBytes) : undefined;
-        const prepared = await PrivateBackupPreparedStore.create({ directory: preparedAllocation.directory, key, workspaceId: reference.workspaceId, limits: preparedLimits }); work.own(() => prepared.close());
-        const result = await preparePrivateBackupRestore({ directory, key, source, prepared, databasePresent: reference.databasePresent, databaseBytes, buildDirectoryId: build?.binding.allocation.id, assertLease: () => lease.assertCurrent(), signal: work.signal });
-        await prepared.close(); work.signal.throwIfAborted(); lease.assertCurrent(); host.assertFresh(); host.assertIdle();
-        edit(id, next => { next.restoreHeld = true; next.operation.phase = 'staging'; next.operation.canCancel = false;
-          next.references.prepared = { directoryId: preparedAllocation.binding.allocation.id, storeId: prepared.storeId, workspaceId: reference.workspaceId, digest: result.digest }; });
-        host.beginRestore();
-        await stagePrivateRestoreV2({ directory, key, directoryId: preparedAllocation.binding.allocation.id, storeId: prepared.storeId, workspaceId: reference.workspaceId, expectedPreparedDigest: result.digest, receipt: operation(id).operation.preview!, assertFresh: host.assertFresh, assertIdle: host.assertIdle, epoch: host.epoch, operation: { operationId: id, previousWorkspaceId: host.workspaceId } });
-        return edit(id, next => { next.operation.phase = 'staged'; }).operation;
-      });
+      if (restoring) fail('Another restore is already being prepared.');
+      restoring = id;
+      try {
+        const record = operation(id, 'upload'); if (record.operation.artifact?.archiveDigest !== digest || !privateBackupTransferDigest(digest)) fail('The reviewed backup changed.');
+        if (['staged', 'applying', 'completed'].includes(record.operation.phase)) return record.operation;
+        if (record.restoreHeld && record.references.prepared && ['staging', 'failed'].includes(record.operation.phase)) return await publishStage(id);
+        if (record.operation.phase !== 'reviewed' || tasks.has(id) || record.restoreHeld || !record.references.preview) fail('Review this complete backup before restoring.');
+        const held = heldOperation(); if (held && held.operation.id !== id) fail('Finish the held restore before preparing another.');
+        host.assertFresh(); host.assertIdle(); await runtime.discard(id, ['prepared', 'build']);
+        return await runtime.run(id, async work => {
+          const current = operation(id, 'upload');
+          if (current.operation.phase !== 'reviewed' || current.restoreHeld || current.operation.artifact?.archiveDigest !== digest) fail('The reviewed restore changed.');
+          const lease = await host.snapshotLease(); work.own(() => lease.release()); lease.assertCurrent(); host.assertFresh();
+          const reference = operation(id).references.preview!;
+          const source = await PrivateBackupCatalog.open({ directory: await work.access('preview'), key, catalogId: reference.catalogId, workspaceId: reference.workspaceId }); work.own(() => source.close());
+          const summary = source.validate(); if (!summary.sealed || summary.digest !== reference.digest) fail('The reviewed backup needs recovery.', 503);
+          let filesBytes = 0, protectedFiles = 0, recordBytes = 0;
+          for (const file of source.iterateFiles()) { filesBytes += file.data.length; if (file.encoding === 'json') protectedFiles++; }
+          for (const row of source.iterateRecords()) recordBytes += Buffer.byteLength(JSON.stringify(row.value));
+          const databaseBytes = capacity(256 * 1024 + summary.records * 16 * 1024 + 2 * recordBytes, PRIVATE_BACKUP_BUILD_MAX_BYTES);
+          const bytes = capacity(2 * filesBytes + 1024 * protectedFiles + (reference.databasePresent ? databaseBytes : 0), PRIVATE_BACKUP_PREPARED_LIMITS.bytes);
+          const preparedLimits = { bytes, sqliteBytes: capacity(256 * 1024 + 2 * bytes + 16 * 1024 * (summary.files + 1), PRIVATE_BACKUP_PREPARED_LIMITS.sqliteBytes) };
+          const preparedAllocation = await allocation(id, work, 'prepared', preparedStorageBudget(preparedLimits).totalBytes);
+          const build = reference.databasePresent ? await allocation(id, work, 'build', privateBackupBuildStorageBudget(databaseBytes).totalBytes) : undefined;
+          const prepared = await PrivateBackupPreparedStore.create({ directory: preparedAllocation.directory, key, workspaceId: reference.workspaceId, limits: preparedLimits }); work.own(() => prepared.close());
+          const result = await preparePrivateBackupRestore({ directory, key, source, prepared, databasePresent: reference.databasePresent, databaseBytes, buildDirectoryId: build?.binding.allocation.id, assertLease: () => lease.assertCurrent(), signal: work.signal });
+          await prepared.close(); work.signal.throwIfAborted(); lease.assertCurrent(); host.assertFresh(); host.assertIdle();
+          edit(id, next => { next.restoreHeld = true; next.operation.phase = 'staging'; next.operation.canCancel = false;
+            next.references.prepared = { directoryId: preparedAllocation.binding.allocation.id, storeId: prepared.storeId, workspaceId: reference.workspaceId, digest: result.digest }; });
+          host.beginRestore();
+          await stagePrivateRestoreV2({ directory, key, directoryId: preparedAllocation.binding.allocation.id, storeId: prepared.storeId, workspaceId: reference.workspaceId, expectedPreparedDigest: result.digest, receipt: operation(id).operation.preview!, assertFresh: host.assertFresh, assertIdle: host.assertIdle, epoch: host.epoch, operation: { operationId: id, previousWorkspaceId: host.workspaceId } });
+          return edit(id, next => { next.operation.phase = 'staged'; }).operation;
+        });
+      } finally { restoring = null; }
     },
     async cancel(id: string) { for (const [token, saved] of tickets) if (saved.id === id) tickets.delete(token); return (await runtime.cancel(id)).operation; },
     async downloadTicket(id: string, digest: string): Promise<PrivateBackupDownloadTicket> {
@@ -267,7 +276,7 @@ export async function createPrivateBackupCoordinator(host: PrivateBackupCoordina
       await runtime.run(saved.id, async work => {
         const path = join(await work.access('archive'), 'archive.realbud-backup'), file = await input(work, path, saved.ticket.archiveBytes), hash = createHash('sha256');
         for await (const chunk of file.stream()) hash.update(chunk); if (hash.digest('hex') !== saved.ticket.archiveDigest) fail('The backup copy changed.', 503);
-        await sink(saved.ticket, file.stream(), work.signal);
+        await sink(saved.ticket, file.stream(saved.ticket.archiveDigest), work.signal);
       });
     },
     async settled(id: string) { await tasks.get(id); return operation(id).operation; },
@@ -276,7 +285,7 @@ export async function createPrivateBackupCoordinator(host: PrivateBackupCoordina
   };
   try {
     await runtime.recover(); const held = heldOperation();
-    if (held) { host.beginRestore(); if (held.operation.phase === 'staging') { try { await publishStage(held.operation.id); } catch { /* Retain the durable hold and surface recovery through operation status. */ } } }
+    if (held) { host.beginRestore(); if (held.operation.phase === 'staging') { try { await publishStage(held.operation.id); } catch { edit(held.operation.id, next => { next.operation.error = { code: 'recovery-required' }; }); } } }
   } catch (error) { await service.close(); throw error; }
   return service;
 }


### server/private-backup-http.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { privateBackupDownloadSessionCookie } from './session-auth.ts';
import { createPrivateBackupV2Api } from './private-backup-v2-api.ts';
import type { createPrivateBackupCoordinator } from './private-backup-coordinator.ts';
import { PRIVATE_BACKUP_TRANSFER_API, PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES, PRIVATE_BACKUP_TRANSFER_ERRORS } from '../shared/private-backup-transfers.ts';

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
      if (method === 'POST' && /\/operations\/[^/]+\/download-ticket$/.test(url.pathname) && result.status === 200) res.setHeader('set-cookie', privateBackupDownloadSessionCookie());
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


### server/session-auth.ts
// Per-boot API session + loopback Host/Origin checks.
import { randomBytes, timingSafeEqual } from "node:crypto";
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

/** Native downloads cannot attach the renderer's custom header. Grant a
 * short-lived HttpOnly cookie on the authenticated ticket response, accepted
 * solely by the exact backup-download GET route. It grants no other API access. */
export function privateBackupDownloadSessionCookie(): string {
  return `realbud-backup-download=${SESSION_TOKEN}; HttpOnly; SameSite=Strict; Path=/api/private-backup/v2/downloads/; Max-Age=300`;
}
function tokenFromRequest(req: IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const header = req.headers["x-realbud-session"];
  if (typeof header === "string" && header.trim()) return header.trim();
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if ((req.method ?? 'GET') === 'GET' && /^\/api\/private-backup\/v2\/downloads\/[A-Za-z0-9_-]{32,128}$/.test(url.pathname)) {
      const values = (req.headers.cookie ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith('realbud-backup-download='));
      if (values.length === 1) return values[0]!.slice('realbud-backup-download='.length);
    }
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
  if (!token || !tokensEqual(token, SESSION_TOKEN)) {
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

END OF COMPLETE REVIEW INPUT. Return final findings, never a progress statement.