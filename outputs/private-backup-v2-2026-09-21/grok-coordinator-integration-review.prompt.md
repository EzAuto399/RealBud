Bounded independent code review. No tools, edits, or external actions. Review supplied current coordinator integration for concrete data-loss, concurrency, incomplete restore recovery, secret exposure, or capacity flaws. Root is integrating HTTP/UI and tests concurrently and owns all changes. Return compact JSON {verdict,findings:[{severity,file,trigger,consequence,fix}],limits}. Maximum 6 actionable findings. Do not invent absent features as implemented. Known unfinished: HTTP/UI not wired yet, v1 route must adapt before persistent journal initialization; native Windows unverified. Prioritize source defects that block integration. Inspect resource ownership and partial success carefully.

### server/private-backup-coordinator.ts
/** Installation-owned backup orchestration. HTTP callers supply IDs and bytes,
 * never keys, paths, allocation budgets, or restore authority. */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, statfs } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fsyncDir } from './atomic.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { createBackupOperationStore, type BackupOperationRecord, type BackupResourceRole } from './private-backup-operations.ts';
import { createBackupResourceRuntime, type BackupResourceWork } from './private-backup-resource-runtime.ts';
import { PrivateBackupCatalog, catalogStorageBudget, type CatalogLimits } from './private-backup-catalog.ts';
import { createBackupTransferStore, backupTransferStorageBudget, type BackupUploadStatus } from './private-backup-transfer.ts';
import { capturePrivateWorkspace, verifyPrivateWorkspaceCapture } from './private-backup-capture.ts';
import { decodeBackupCatalog, encodeBackupCatalog, type BackupArchiveReceipt } from './private-backup-archive.ts';
import { decodeLegacyBackupCatalog } from './private-backup-legacy.ts';
import { measurePrivateBackupRestore, transformPrivateBackupCatalog } from './private-backup-restore-catalog.ts';
import { PrivateBackupPreparedStore, preparedStorageBudget, PRIVATE_BACKUP_PREPARED_LIMITS } from './private-backup-prepared.ts';
import { preparePrivateBackupRestore, privateBackupBuildStorageBudget, PRIVATE_BACKUP_BUILD_MAX_BYTES } from './private-backup-prepare.ts';
import { stagePrivateRestoreV2 } from './private-backup-cold-restore.ts';
import { PRIVATE_BACKUP_TRANSFER_API, PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES, PRIVATE_BACKUP_TRANSFER_MAX_BYTES,
  privateBackupTransferDigest, privateBackupTransferId, type PrivateBackupTransferOperation, type PrivateBackupTransferPage,
  type PrivateBackupDownloadTicket, type PrivateBackupTransferErrorCode } from '../shared/private-backup-transfers.ts';

const MiB = 1024 ** 2, MARKER = 8192, MARGIN = 128 * MiB;
const closed = new Set(['cancelled', 'expired', 'completed']);
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
function fail(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }
function passphrase(value: string) { if (typeof value !== 'string' || value.length < 16 || value.length > 256) fail('Use a backup passphrase between 16 and 256 characters.', 400); }
function capacity(value: number, max: number) { if (!Number.isSafeInteger(value) || value > max) fail('The restored workspace exceeds this computer’s supported backup capacity.', 413); return Math.max(65_536, Math.ceil(value / 4096) * 4096); }
export interface PrivateBackupCoordinatorHost {
  directory: string; key: Buffer; workspaceId: string;
  snapshotLease(): Promise<{ assertCurrent(): void; release(): void }>;
  assertFresh(): void; assertIdle(): void; epoch(): string;
  /** Sticky host write barrier. Called only after complete preparation. */
  beginRestore(): void;
  now?: () => number;
  /** Host/test admission policy; never supplied by an HTTP request. */
  freeBytes?: () => Promise<number>;
  captureLimits?: CatalogLimits;
}
export async function createPrivateBackupCoordinator(host: PrivateBackupCoordinatorHost) {
  const directory = resolve(host.directory), root = join(directory, 'private-backup-v2'), key = Buffer.from(host.key), now = host.now ?? Date.now;
  const journal = await createBackupOperationStore({ directory: join(root, 'operations'), key, workspaceId: host.workspaceId, restoreDirectory: directory, now });
  const runtime = createBackupResourceRuntime({ journal, directory: root, key });
  const tasks = new Map<string, Promise<unknown>>(), tickets = new Map<string, { id: string; ticket: PrivateBackupDownloadTicket }>();
  let closing = false;
  const edit = (id: string, change: (record: BackupOperationRecord) => void) => journal.update(id, journal.get(id).revision, change);
  const operation = (id: string, kind?: 'export' | 'upload') => { const record = journal.get(id); if (kind && record.operation.kind !== kind) fail('This backup operation was not found.', 404); return record; };
  const check = (id: string) => { if (closing || closed.has(operation(id).operation.phase)) fail('This backup operation is closed.'); };
  async function free() { if (host.freeBytes) return host.freeBytes(); const stat = await statfs(directory); return stat.bavail * stat.bsize; }
  async function admit(bytes: number) {
    if (closing) fail('Backup storage is closing.');
    const available = await free();
    if (!Number.isFinite(available) || available < journal.usage().reservedBytes + bytes + MARGIN) fail('This computer needs more free space before the backup can continue.', 507);
  }
  async function allocation(id: string, work: BackupResourceWork, role: BackupResourceRole, bytes: number) {
    check(id); let record = operation(id);
    const existing = record.allocations?.find(a => a.role === role && a.state !== 'removed');
    if (existing) return work.claim(role, existing.bytes);
    const required = record.allocations!.reduce((sum, a) => sum + (a.state === 'removed' ? 0 : a.bytes), bytes + MARKER);
    if (required > record.reservedBytes) {
      await admit(required - record.reservedBytes); work.signal.throwIfAborted(); check(id);
      record = operation(id); if (record.restoreHeld) fail('Restore storage must stay reserved.');
      edit(id, next => { next.reservedBytes = Math.max(next.reservedBytes, required); });
    }
    return work.claim(role, bytes + MARKER);
  }
  function failed(id: string, error: unknown) {
    const record = operation(id); if (closed.has(record.operation.phase) || record.restoreHeld) return;
    const status = (error as { status?: number })?.status;
    const code: PrivateBackupTransferErrorCode = status === 413 || status === 507 ? 'insufficient-space' : status === 400 ? 'invalid-backup' : status === 409 ? 'workspace-busy' : 'storage-unavailable';
    edit(id, next => { next.operation.phase = 'failed'; next.operation.error = { code }; delete next.operation.preview;
      next.operation.requiresPassphrase = next.operation.kind === 'export' || next.operation.receivedBytes === next.operation.progress.totalBytes; });
  }
  function launch(id: string, task: () => Promise<unknown>) {
    if (closing || tasks.has(id)) fail('This backup operation is busy.');
    const pending = Promise.resolve().then(task).catch(error => { failed(id, error); }).finally(() => { tasks.delete(id); });
    tasks.set(id, pending); void pending.catch(() => {});
  }
  async function input(work: BackupResourceWork, path: string, size: number) {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); work.own(() => handle.close());
    const original = await handle.stat();
    if (!original.isFile() || original.nlink !== 1 || original.size !== size) fail('Backup bytes need recovery.', 503);
    async function* stream() {
      const buffer = Buffer.alloc(PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES); let offset = 0;
      try {
        while (offset < size) { work.signal.throwIfAborted(); const read = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset); work.signal.throwIfAborted(); if (!read.bytesRead) fail('The backup file changed.', 503); offset += read.bytesRead; yield buffer.subarray(0, read.bytesRead); }
        const final = await handle.stat(); if (final.size !== original.size || final.mtimeMs !== original.mtimeMs || final.ctimeMs !== original.ctimeMs) fail('The backup file changed.', 503);
      } finally { buffer.fill(0); }
    }
    return { handle, stream };
  }
  function reconcile(id: string, status: BackupUploadStatus) {
    const record = operation(id, 'upload'); if (closed.has(record.operation.phase) || record.restoreHeld) return record.operation;
    if (status.size !== record.operation.progress.totalBytes || status.offset < record.operation.receivedBytes!) fail('Backup upload records need recovery.', 503);
    if (status.state === 'cancelled' || status.state === 'staged') fail('Backup upload authority needs recovery.', 503);
    if (status.offset === record.operation.receivedBytes && status.prefixDigest === record.operation.prefixCommitment && (status.state !== 'uploaded' || record.operation.artifact)) return record.operation;
    return edit(id, next => {
      next.operation.receivedBytes = status.offset; next.operation.prefixCommitment = status.prefixDigest;
      next.operation.progress.completedBytes = status.offset;
      if (status.state === 'uploaded') { next.operation.artifact = { archiveBytes: status.size, archiveDigest: status.digest! }; next.operation.phase = 'uploaded'; next.operation.requiresPassphrase = true; delete next.operation.preview; delete next.operation.error; }
    }).operation;
  }
  async function transfer<T>(id: string, create: boolean, task: (store: Awaited<ReturnType<typeof createBackupTransferStore>>) => Promise<T>) {
    return runtime.run(id, async work => {
      const record = operation(id, 'upload');
      const path = create ? (await allocation(id, work, 'upload', backupTransferStorageBudget(record.operation.progress.totalBytes!).totalBytes)).directory : await work.access('upload');
      const store = await createBackupTransferStore({ directory: path, key, workspaceId: host.workspaceId, now }); work.own(() => store.close());
      return task(store);
    });
  }
  async function uploadStatus(id: string) {
    const record = operation(id); if (record.operation.kind !== 'upload' || tasks.has(id) || runtime.busy(id) || closed.has(record.operation.phase) || record.restoreHeld || !record.allocations?.some(a => a.role === 'upload' && a.state === 'allocated')) return record.operation;
    return transfer(id, false, async store => reconcile(id, await store.status(id)));
  }
  function freshRecord(id: string, kind: 'upload' | 'export', totalBytes: number | null): PrivateBackupTransferOperation {
    if (!privateBackupTransferId(id)) fail('Invalid backup operation.', 400); const at = now();
    return { version: 2, id, workspaceId: host.workspaceId, kind, phase: kind === 'export' ? 'capturing' : 'uploading', createdAt: at, updatedAt: at, expiresAt: null,
      progress: { completedBytes: 0, totalBytes }, canCancel: true, requiresPassphrase: false,
      ...(kind === 'upload' ? { receivedBytes: 0, prefixCommitment: sha('[]') } : {}) };
  }
  async function maybeCreate(id: string, kind: 'upload' | 'export', size: number | null, reservation: number) {
    try { const current = operation(id, kind); if (kind === 'upload' && current.operation.progress.totalBytes !== size) fail('This identifier belongs to another upload.'); return current; }
    catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
    await admit(reservation); return journal.create(freshRecord(id, kind, size), reservation, { trackResources: true });
  }
  async function previewWork(id: string, phrase: string, digest: string) {
    return runtime.run(id, async work => {
      const upload = await work.access('upload'), store = await createBackupTransferStore({ directory: upload, key, workspaceId: host.workspaceId, now }); work.own(() => store.close());
      const artifact = await store.artifact(id); if (artifact.digest !== digest) fail('The reviewed backup changed.');
      const file = await input(work, artifact.path, artifact.size), magic = Buffer.alloc(8); await file.handle.read(magic, 0, 8, 0);
      const v2 = magic.equals(Buffer.from('RBUDPV2\0')), limits = { maxEntries: Math.min(v2 ? 99_999 : 8000, Math.max(1, Math.floor(artifact.size / 64))), maxBytes: artifact.size };
      const decoded = await allocation(id, work, 'decoded', catalogStorageBudget(limits).totalBytes);
      const options = { directory: decoded.directory, key, passphrase: phrase, expectedArchiveDigest: digest, signal: work.signal,
        catalogMaxEntries: limits.maxEntries, catalogMaxBytes: limits.maxBytes, catalogMaxStorageBytes: catalogStorageBudget(limits).databaseBytes };
      const result = v2 ? await decodeBackupCatalog(file.stream(), options) : await decodeLegacyBackupCatalog(file.stream(), options);
      work.own(() => result.catalog.close()); work.signal.throwIfAborted();
      const at = now(), measured = measurePrivateBackupRestore({ source: result.catalog, at }), targetLimits = { maxEntries: Math.max(1, measured.entries), maxBytes: Math.max(1, measured.plainBytes) };
      const target = await allocation(id, work, 'preview', catalogStorageBudget(targetLimits).totalBytes);
      const catalog = await PrivateBackupCatalog.create({ directory: target.directory, key, workspaceId: result.metadata.workspaceId, ...targetLimits }); work.own(() => catalog.close());
      const summary = transformPrivateBackupCatalog({ source: result.catalog, destination: catalog, at }); work.signal.throwIfAborted();
      if (summary.plainBytes !== measured.plainBytes || summary.entries !== measured.entries) fail('Restore preparation changed.', 503);
      edit(id, next => { next.references.preview = { directoryId: target.binding.allocation.id, catalogId: catalog.catalogId, workspaceId: catalog.workspaceId, digest: summary.digest, createdAt: result.metadata.createdAt, databasePresent: result.metadata.databasePresent };
        next.operation.phase = 'reviewed'; next.operation.preview = result.receipt; next.operation.requiresPassphrase = false; delete next.operation.error; });
    });
  }
  const service = {
    async list(options: { limit: number; cursor?: string }): Promise<PrivateBackupTransferPage> {
      const after = options.cursor; if (after && !privateBackupTransferId(after)) fail('Invalid backup page.', 400);
      const page = journal.list({ limit: options.limit, after });
      return { version: 2, workspaceId: host.workspaceId, limits: { archiveBytes: PRIVATE_BACKUP_TRANSFER_MAX_BYTES, chunkBytes: PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES }, items: page.items.map(r => r.operation), total: page.total, nextCursor: page.next };
    },
    get: uploadStatus,
    async startUpload(id: string, totalBytes: number) {
      const record = await maybeCreate(id, 'upload', totalBytes, backupTransferStorageBudget(totalBytes).totalBytes + MARKER);
      if (closed.has(record.operation.phase) || record.restoreHeld || tasks.has(id)) return record.operation;
      return transfer(id, true, async store => reconcile(id, await store.start(id, totalBytes)));
    },
    async appendUpload(id: string, offset: number, bytes: Uint8Array, digest: string) {
      const record = operation(id, 'upload'); if (!['uploading', 'interrupted'].includes(record.operation.phase)) fail('This upload no longer accepts chunks.');
      if (record.operation.phase === 'interrupted') edit(id, next => { next.operation.phase = 'uploading'; delete next.operation.error; });
      return transfer(id, false, async store => reconcile(id, await store.append(id, offset, bytes, digest)));
    },
    async sealUpload(id: string, totalBytes: number, commitment: string) {
      const record = operation(id, 'upload'); if (record.operation.progress.totalBytes !== totalBytes || !['uploading', 'uploaded', 'interrupted'].includes(record.operation.phase)) fail('Check the saved upload before finishing.');
      return transfer(id, false, async store => reconcile(id, await store.seal(id, commitment)));
    },
    async preview(id: string, phrase: string, digest: string) {
      passphrase(phrase); const record = operation(id, 'upload');
      if (!privateBackupTransferDigest(digest) || record.operation.artifact?.archiveDigest !== digest) fail('The selected backup changed.');
      if (tasks.has(id) && record.operation.phase === 'checking' || record.operation.phase === 'reviewed') return record.operation;
      if (!['uploaded', 'interrupted', 'failed'].includes(record.operation.phase) || record.restoreHeld) fail('This backup cannot be checked again.');
      // Mark reversible work failed before discarding old provisional resources;
      // checking is entered only after their handles and cleanup have drained.
      if (record.operation.phase === 'uploaded') edit(id, next => { next.operation.phase = 'failed'; });
      await runtime.discard(id, ['decoded', 'preview', 'prepared', 'build']);
      edit(id, next => { next.operation.phase = 'checking'; next.operation.requiresPassphrase = false; delete next.operation.error; });
      launch(id, () => previewWork(id, phrase, digest)); return operation(id).operation;
    },
    async startExport(id: string, phrase: string) {
      passphrase(phrase); const limits = host.captureLimits ?? { maxEntries: 99_999, maxBytes: PRIVATE_BACKUP_TRANSFER_MAX_BYTES };
      const record = await maybeCreate(id, 'export', null, catalogStorageBudget(limits).totalBytes + MARKER);
      if (tasks.has(id) || record.operation.phase === 'ready' || closed.has(record.operation.phase)) return record.operation;
      if (!['capturing', 'failed', 'interrupted'].includes(record.operation.phase)) fail('Check the saved backup operation before retrying.');
      launch(id, async () => {
        if (record.operation.phase !== 'capturing') { await runtime.discard(id, ['capture', 'archive']); edit(id, next => { next.operation.phase = 'capturing'; next.operation.requiresPassphrase = false; delete next.operation.error; }); }
        await runtime.run(id, async work => {
          const target = await allocation(id, work, 'capture', catalogStorageBudget(limits).totalBytes);
          const catalog = await PrivateBackupCatalog.create({ directory: target.directory, key, workspaceId: host.workspaceId, ...limits }); work.own(() => catalog.close());
          const lease = await host.snapshotLease(); work.own(() => lease.release()); const createdAt = new Date(now()).toISOString();
          const captureOptions = { directory, key, workspaceId: host.workspaceId, catalog, assertLease: () => lease.assertCurrent(), signal: work.signal };
          const captured = await capturePrivateWorkspace(captureOptions); await verifyPrivateWorkspaceCapture(captureOptions, captured); lease.assertCurrent();
          const summary = catalog.seal(); edit(id, next => { next.references.capture = { directoryId: target.binding.allocation.id, catalogId: catalog.catalogId, workspaceId: host.workspaceId, digest: summary.digest, createdAt, databasePresent: captured.databasePresent }; next.operation.phase = 'sealing'; });
          lease.release();
          const archive = await allocation(id, work, 'archive', PRIVATE_BACKUP_TRANSFER_MAX_BYTES); await mkdir(archive.directory, { mode: 0o700 }); await windowsFilePrivacy(archive.directory, 'directory', true);
          const path = join(archive.directory, 'archive.realbud-backup'), file = await open(path, 'wx', 0o600); work.own(() => file.close()); await windowsFilePrivacy(path, 'file', true);
          let bytes = 0, receipt: BackupArchiveReceipt | undefined;
          for await (const chunk of encodeBackupCatalog(catalog, { passphrase: phrase, createdAt, databasePresent: captured.databasePresent, signal: work.signal, onComplete(value) { receipt = value; } })) {
            let offset = 0; while (offset < chunk.length) { work.signal.throwIfAborted(); const write = await file.write(chunk, offset, chunk.length - offset); if (!write.bytesWritten) fail('Backup storage is unavailable.', 503); offset += write.bytesWritten; bytes += write.bytesWritten; }
          }
          await file.sync(); fsyncDir(archive.directory); work.signal.throwIfAborted(); if (!receipt || receipt.transport.archiveBytes !== bytes) fail('The backup did not finish.', 503);
          const completed = receipt;
          edit(id, next => { next.operation.phase = 'ready'; next.operation.artifact = { archiveBytes: bytes, archiveDigest: completed.transport.archiveDigest }; next.operation.preview = completed.receipt; next.operation.progress = { completedBytes: bytes, totalBytes: bytes }; });
        });
      }); return operation(id).operation;
    },
    async stage(id: string, digest: string) {
      const record = operation(id, 'upload'); if (record.operation.artifact?.archiveDigest !== digest || !privateBackupTransferDigest(digest)) fail('The reviewed backup changed.');
      if (['staged', 'applying', 'completed'].includes(record.operation.phase)) return record.operation;
      if (record.operation.phase !== 'reviewed' || tasks.has(id) || record.restoreHeld || !record.references.preview) fail('Review this complete backup before restoring.');
      host.assertFresh(); host.assertIdle(); await runtime.discard(id, ['prepared', 'build']);
      return runtime.run(id, async work => {
        const lease = await host.snapshotLease(); work.own(() => lease.release()); lease.assertCurrent(); host.assertFresh();
        const reference = operation(id).references.preview!;
        const source = await PrivateBackupCatalog.open({ directory: await work.access('preview'), key, catalogId: reference.catalogId, workspaceId: reference.workspaceId }); work.own(() => source.close());
        const summary = source.validate(); if (!summary.sealed || summary.digest !== reference.digest) fail('The reviewed backup needs recovery.', 503);
        let filesBytes = 0, protectedFiles = 0, recordBytes = 0;
        for (const file of source.iterateFiles()) { filesBytes += file.data.length; if (file.encoding === 'json') protectedFiles++; }
        for (const row of source.iterateRecords()) recordBytes += Buffer.byteLength(JSON.stringify(row.value));
        const databaseBytes = capacity(256 * 1024 + summary.records * 16 * 1024 + 2 * recordBytes, PRIVATE_BACKUP_BUILD_MAX_BYTES);
        const bytes = capacity(2 * filesBytes + 1024 * protectedFiles + (reference.databasePresent ? databaseBytes : 0), PRIVATE_BACKUP_PREPARED_LIMITS.bytes);
        const preparedLimits = { bytes, sqliteBytes: capacity(256 * 1024 + 2 * bytes + 16 * 1024 * (summary.files + 1), PRIVATE_BACKUP_PREPARED_LIMITS.sqliteBytes) };
        const preparedAllocation = await allocation(id, work, 'prepared', preparedStorageBudget(preparedLimits).totalBytes);
        const build = reference.databasePresent ? await allocation(id, work, 'build', privateBackupBuildStorageBudget(databaseBytes).totalBytes) : undefined;
        const prepared = await PrivateBackupPreparedStore.create({ directory: preparedAllocation.directory, key, workspaceId: reference.workspaceId, limits: preparedLimits }); work.own(() => prepared.close());
        const result = await preparePrivateBackupRestore({ directory, key, source, prepared, databasePresent: reference.databasePresent, databaseBytes, buildDirectoryId: build?.binding.allocation.id, assertLease: () => lease.assertCurrent(), signal: work.signal });
        await prepared.close(); work.signal.throwIfAborted(); lease.assertCurrent(); host.assertFresh(); host.assertIdle();
        edit(id, next => { next.restoreHeld = true; next.operation.phase = 'staging'; next.operation.canCancel = false;
          next.references.prepared = { directoryId: preparedAllocation.binding.allocation.id, storeId: prepared.storeId, workspaceId: reference.workspaceId, digest: result.digest }; });
        host.beginRestore();
        await stagePrivateRestoreV2({ directory, key, directoryId: preparedAllocation.binding.allocation.id, storeId: prepared.storeId, workspaceId: reference.workspaceId, expectedPreparedDigest: result.digest, receipt: operation(id).operation.preview!, assertFresh: host.assertFresh, assertIdle: host.assertIdle, epoch: host.epoch, operation: { operationId: id, previousWorkspaceId: host.workspaceId } });
        return edit(id, next => { next.operation.phase = 'staged'; }).operation;
      });
    },
    async cancel(id: string) { for (const [token, saved] of tickets) if (saved.id === id) tickets.delete(token); return (await runtime.cancel(id)).operation; },
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
        await sink(saved.ticket, file.stream(), work.signal);
      });
    },
    async settled(id: string) { await tasks.get(id); return operation(id).operation; },
    async close() { closing = true; tickets.clear(); await runtime.close(); await Promise.allSettled(tasks.values()); journal.close(); key.fill(0); },
  };
  try { await runtime.recover(); } catch (error) { await service.close(); throw error; }
  return service;
}


### server/private-backup-resource-runtime.ts
/** Host-side lifetime of backup writers and their journal-owned files.
 * Every writer/reader of an allocation runs inside run() and registers its
 * handles before awaiting more work. No browser input supplies a path. */
import { createPrivateBackupResources, type BackupResourceBinding } from './private-backup-resources.ts';
import type { BackupOperationStore, BackupResourceRole } from './private-backup-operations.ts';

function fail(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }
const terminal = new Set(['cancelled', 'expired', 'completed']);
// A full/unwritable journal can prevent persisting a failed-close PID hold.
// Reconstructing a runtime in this same process must still preserve its files.
const failedClosesInThisProcess = new Set<string>();
interface ActiveWork { controller: AbortController; done: Promise<unknown> }
export interface BackupResourceWork {
  signal: AbortSignal;
  /** Register immediately after opening a handle; close must drain its writes. */
  own(close: () => void | Promise<void>): void;
  claim(role: BackupResourceRole, bytes: number): Promise<{ binding: BackupResourceBinding; directory: string; existing: boolean }>;
  path(role: BackupResourceRole): string;
  /** Authenticate the retained marker and known files before reopening a store. */
  access(role: BackupResourceRole): Promise<string>;
}
export function createBackupResourceRuntime(options: { journal: BackupOperationStore; directory: string; key: Buffer }) {
  const active = new Map<string, ActiveWork>(), cleanup = new Map<string, Promise<void>>(), undrained = new Set<string>();
  let closing = false;
  const journal = options.journal;
  const resources = createPrivateBackupResources({ directory: options.directory, key: options.key, assertCurrent(binding, action) {
    const current = journal.resourceBinding(binding.operationId, binding.allocation.id, action);
    if (JSON.stringify(current) !== JSON.stringify(binding)) fail('Backup resource ownership changed. Its files were preserved.');
    if (action === 'remove' && (active.has(binding.operationId) || undrained.has(binding.operationId) || failedClosesInThisProcess.has(binding.operationId))) fail('Backup work has not finished closing. Its storage remains reserved.');
  } });
  async function clean(id: string, roles?: readonly BackupResourceRole[]) {
    const work = active.get(id); work?.controller.abort();
    await work?.done.catch(() => {});
    if (undrained.has(id) || failedClosesInThisProcess.has(id)) fail('Backup work could not close. Restart to recover its retained storage.', 503);
    let record = roles ? journal.get(id) : journal.getCleanupRecord(id);
    if (!roles && !terminal.has(record.operation.phase)) fail('Close the backup operation before releasing its storage.');
    for (const allocation of record.allocations ?? []) {
      if (allocation.state === 'removed' || roles && !roles.includes(allocation.role)) continue;
      record = journal.beginResourceCleanup(id, record.revision, allocation.id);
      const binding = journal.resourceBinding(id, allocation.id, 'remove');
      await resources.remove(binding);
      // A failure or process exit before either journal update retains the
      // allocation and reservation. The next cleanup replays missing files.
      record = journal.finishResourceCleanup(id, record.revision, allocation.id);
    }
    if (!roles) journal.releaseCleanedReservation(id, record.revision);
  }
  function cleanOnce(id: string): Promise<void> {
    const existing = cleanup.get(id); if (existing) return existing;
    const promise = Promise.resolve().then(() => clean(id)).finally(() => { cleanup.delete(id); });
    cleanup.set(id, promise); return promise;
  }
  return {
    busy(id: string) { return active.has(id) || cleanup.has(id); },
    run<T>(id: string, task: (work: BackupResourceWork) => Promise<T>): Promise<T> {
      if (closing || active.has(id) || cleanup.has(id) || undrained.has(id) || failedClosesInThisProcess.has(id)) return Promise.reject(Object.assign(new Error('This backup operation is busy or needs recovery.'), { status: 409 }));
      const record = journal.get(id);
      if (terminal.has(record.operation.phase)) return Promise.reject(Object.assign(new Error('This backup operation is closed.'), { status: 409 }));
      if (!record.allocations) return Promise.reject(Object.assign(new Error('This older backup operation has no tracked resource ownership.'), { status: 409 }));
      if (record.cleanupHold) return Promise.reject(Object.assign(new Error('This backup operation requires process-exit recovery.'), { status: 409 }));
      const controller = new AbortController(), handles: (() => void | Promise<void>)[] = [], claims = new Set<Promise<unknown>>();
      let draining = false;
      const check = () => {
        controller.signal.throwIfAborted(); if (draining) fail('Backup handles are closing.');
        if (terminal.has(journal.get(id).operation.phase)) fail('This backup operation is closed.');
      };
      const context: BackupResourceWork = {
        signal: controller.signal,
        own(close) { if (draining || typeof close !== 'function') fail('Register backup handles before draining.'); handles.push(close); },
        claim(role, bytes) {
          const claim = (async () => {
            check(); let current = journal.get(id), allocation = current.allocations?.find(a => a.role === role && a.state !== 'removed');
            if (!allocation) { current = journal.allocate(id, current.revision, { role, bytes }); allocation = current.allocations!.find(a => a.role === role && a.state !== 'removed')!; }
            if (allocation.bytes !== bytes) fail('The backup allocation capacity changed.');
            const binding = journal.resourceBinding(id, allocation.id, 'claim'), claimed = await resources.claim(binding); check();
            return { binding, ...claimed };
          })();
          claims.add(claim); void claim.finally(() => { claims.delete(claim); }).catch(() => {}); return claim;
        },
        async access(role) {
          check(); const allocation = journal.get(id).allocations?.find(a => a.role === role && a.state === 'allocated');
          if (!allocation) fail('This backup resource was not found.', 404);
          const binding = journal.resourceBinding(id, allocation.id, 'read'), inspected = await resources.inspect(binding); check();
          if (!inspected.claimed || !inspected.dataPresent || inspected.exceedsAllocation) fail('Backup resource ownership or capacity needs recovery.', 503);
          return resources.path(binding);
        },
        path(role) {
          check(); const allocation = journal.get(id).allocations?.find(a => a.role === role && a.state === 'allocated');
          if (!allocation) fail('This backup resource was not found.', 404);
          return resources.path(journal.resourceBinding(id, allocation.id, 'read'));
        },
      };
      const done = Promise.resolve().then(async () => {
        check(); const result = await task(context);
        while (claims.size) await Promise.all([...claims]);
        controller.signal.throwIfAborted(); return result;
      }).catch(error => { controller.abort(); throw error; }).finally(async () => {
        draining = true; await Promise.allSettled([...claims]); let closeFailed = false;
        for (const close of handles.reverse()) {
          try { await close(); } catch { closeFailed = true; }
        }
        if (closeFailed) {
          undrained.add(id); failedClosesInThisProcess.add(id);
          journal.holdResourceCleanup(id, journal.get(id).revision);
          fail('Backup handles could not close. Its files and reservation were retained.', 503);
        }
      }).finally(() => { active.delete(id); });
      active.set(id, { controller, done }); return done;
    },
    /** Discard selected provisional resources after all work has closed. The
     * reservation remains charged and every removed allocation stays recorded. */
    async discard(id: string, roles: readonly BackupResourceRole[]) {
      if (closing || active.has(id) || cleanup.has(id)) fail('Finish current backup work before discarding scratch files.');
      const record = journal.get(id);
      const allowed = record.operation.phase === 'reviewed' ? ['prepared', 'build'] :
        ['failed', 'interrupted'].includes(record.operation.phase) ? (record.operation.kind === 'export' ? ['capture', 'archive'] : ['decoded', 'preview', 'prepared', 'build']) : [];
      if (record.restoreHeld || !roles.length || roles.some(role => !allowed.includes(role))) fail('These backup resources must be retained for recovery.');
      const promise = Promise.resolve().then(() => clean(id, roles)).finally(() => { cleanup.delete(id); });
      cleanup.set(id, promise); await promise;
    },
    /** Save cancellation before signalling writers; repeated requests join the
     * same drain/cleanup and never release a second reservation. */
    async cancel(id: string) {
      if (closing) fail('Backup storage is closing.');
      const record = journal.get(id);
      if (record.operation.phase !== 'cancelled') {
        if (!record.operation.canCancel || record.restoreHeld) fail('This restore must retain its files for recovery.');
        journal.update(id, record.revision, next => {
          next.operation.phase = 'cancelled'; next.operation.canCancel = false; next.operation.requiresPassphrase = false;
          delete next.operation.artifact; delete next.operation.preview; delete next.operation.error;
        });
      }
      active.get(id)?.controller.abort(); await cleanup.get(id); await cleanOnce(id); return journal.get(id);
    },
    /** Internal startup cleanup only. Resumable current-workspace uploads and
     * uncertain restores are retained; foreign non-held work is retired first. */
    async recover() {
      if (closing || active.size || cleanup.size) fail('Finish current backup work before recovery.');
      journal.retireForeign(); let after: string | undefined, cleaned = 0, held = 0;
      do {
        const page = journal.cleanupCandidates({ limit: 20, after });
        for (const record of page.items) {
          if (!terminal.has(record.operation.phase)) continue;
          if (!record.allocations) { held++; continue; }
          try { await cleanOnce(record.operation.id); cleaned++; }
          catch {
            // A per-operation ownership/file/close hold must not stop unrelated
            // cleanup. Recheck journal authority so structural/global failures
            // are not silently downgraded to an individual hold.
            journal.usage(); held++;
          }
        }
        after = page.next ?? undefined;
      } while (after);
      return { cleaned, held };
    },
    async close() {
      closing = true; for (const work of active.values()) work.controller.abort();
      await Promise.allSettled([...active.values()].map(work => work.done));
      await Promise.allSettled([...cleanup.values()]); await resources.close();
      if (undrained.size) fail('Backup handles need restart recovery. Their reservations were retained.', 503);
    },
  };
}


### server/private-backup-operations.ts
/** Durable control records for private backup v2. No business bodies, paths,
 * passphrases or keys belong in these records. Artifact bytes remain owned by
 * the coordinator; reservations must cover its enforced component limits. */
import { randomUUID } from 'node:crypto';
import { lstatSync, unlinkSync } from 'node:fs';
import { link, lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { decryptJson, encryptJson, isEncryptedEnvelope } from './desk-crypto.ts';
import { fsyncDir } from './atomic.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { readBackupColdCompletion } from './private-backup-completion.ts';
import { parsePrivateBackupTransferOperation, privateBackupTransferDigest, privateBackupTransferId, type PrivateBackupTransferOperation, type PrivateBackupTransferPhase } from '../shared/private-backup-transfers.ts';

export const PRIVATE_BACKUP_OPERATION_LIMITS = Object.freeze({ records: 1000, active: 4, journalBytes: 64 * 1024 ** 2, recordBytes: 64 * 1024, reservationBytes: 32 * 1024 ** 3 });
export interface BackupCatalogReference {
  directoryId: string; catalogId: string; workspaceId: string; digest: string; createdAt: string; databasePresent: boolean;
}
export interface BackupPreparedReference { directoryId: string; storeId: string; workspaceId: string; digest: string }
export type BackupResourceRole = 'capture' | 'decoded' | 'preview' | 'prepared' | 'archive' | 'build' | 'upload';
export const BACKUP_RESOURCE_ROLES: readonly BackupResourceRole[] = ['capture', 'decoded', 'preview', 'prepared', 'archive', 'build', 'upload'];
export interface BackupResourceAllocation {
  id: string; nonce: string; role: BackupResourceRole; bytes: number; state: 'allocated' | 'deleting' | 'removed';
}
/** Filesystem marker for a retained allocation. State is journal-only and must
 * never appear here. Prepared files stay at DATA/private-backup-v2/prepared/<allocation.id>. */
export interface BackupResourceMarker {
  version: 1; operationId: string; workspaceId: string;
  allocation: { id: string; nonce: string; role: BackupResourceRole; bytes: number };
}
export interface BackupOperationRecord {
  version: 1; revision: number; operation: PrivateBackupTransferOperation;
  reservedBytes: number;
  /** Sticky from staging onward, including a failed/uncertain stage. Only a
   * separately verified cold completion permits releasing its reservation. */
  restoreHeld: boolean;
  references: { capture?: BackupCatalogReference; preview?: BackupCatalogReference; prepared?: BackupPreparedReference };
  /** Absent on legacy records. allocate() creates the list; removed rows stay. */
  allocations?: BackupResourceAllocation[];
  /** A failed handle close requires confirmed process exit, not merely a new
   * runtime instance. PID reuse conservatively keeps the cleanup hold. */
  cleanupHold?: { pid: number };
}
export interface BackupOperationStoreOptions {
  directory: string; key: Buffer; workspaceId: string;
  /** Installation-owned business directory, used only to verify a cold restore
   * when its archive replaced the prior workspace identity. Never an HTTP path. */
  restoreDirectory?: string;
  limits?: { records?: number; active?: number; reservationBytes?: number };
  now?: () => number;
  /** Test-only process interruption seam; never populated from serialized input. */
  fault?: (point: 'initial-ready' | 'initial-linked' | 'completion-committed') => void;
  /** Test-only identity seam; never populated from serialized input. */
  randomId?: () => string;
}
const SCHEMA = {
  control: 'CREATE TABLE control (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL)',
  operations: 'CREATE TABLE operations (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL)',
};
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const integer = (v: unknown, minimum = 0): v is number => Number.isSafeInteger(v) && Number(v) >= minimum && Number(v) < Number.MAX_SAFE_INTEGER;
const closedPhases = new Set<PrivateBackupTransferPhase>(['cancelled', 'expired', 'completed']);
const restorePhases = new Set<PrivateBackupTransferPhase>(['staging', 'staged', 'applying']);
const interruptedPhases = new Set<PrivateBackupTransferPhase>(['capturing', 'sealing', 'checking']);
const RESOURCE_KIND: Record<'export' | 'upload', readonly BackupResourceRole[]> = { export: ['capture', 'archive'], upload: ['decoded', 'preview', 'prepared', 'build', 'upload'] };
const transitions: Record<PrivateBackupTransferPhase, readonly PrivateBackupTransferPhase[]> = {
  capturing: ['sealing', 'failed', 'interrupted', 'cancelled'], sealing: ['ready', 'failed', 'interrupted', 'cancelled'],
  ready: ['cancelled', 'expired'], uploading: ['uploaded', 'failed', 'interrupted', 'cancelled'],
  uploaded: ['checking', 'failed', 'interrupted', 'cancelled'], checking: ['reviewed', 'failed', 'interrupted', 'cancelled'],
  reviewed: ['staging', 'failed', 'cancelled'], staging: ['staged', 'failed'], staged: ['applying'],
  // Completion is admitted only by the encrypted cold-proof reconciliation
  // below, never by a generic progress update or a coordinator success flag.
  applying: ['failed'], completed: [], cancelled: [], expired: [],
  interrupted: ['capturing', 'sealing', 'uploading', 'uploaded', 'checking', 'cancelled'],
  failed: ['capturing', 'sealing', 'uploading', 'uploaded', 'checking', 'staging', 'staged', 'applying', 'cancelled'],
};
function fail(message = 'Backup operation records need recovery. Existing files were preserved.', status = 503): never { throw Object.assign(new Error(message), { status }); }
function reference(v: unknown, prepared: boolean): boolean {
  if (!object(v) || !exact(v, prepared ? ['directoryId', 'storeId', 'workspaceId', 'digest'] : ['directoryId', 'catalogId', 'workspaceId', 'digest', 'createdAt', 'databasePresent']) ||
      !privateBackupTransferId(v.directoryId) || !privateBackupTransferId(v.workspaceId) || !privateBackupTransferId(v[prepared ? 'storeId' : 'catalogId']) || !privateBackupTransferDigest(v.digest)) return false;
  return prepared || typeof v.createdAt === 'string' && Number.isFinite(Date.parse(v.createdAt)) && new Date(v.createdAt).toISOString() === v.createdAt && typeof v.databasePresent === 'boolean';
}
export function backupResourceMarker(operationId: string, workspaceId: string, allocation: BackupResourceAllocation): BackupResourceMarker {
  return { version: 1, operationId, workspaceId, allocation: { id: allocation.id, nonce: allocation.nonce, role: allocation.role, bytes: allocation.bytes } };
}
export function parseBackupResourceMarker(v: unknown): BackupResourceMarker | null {
  if (!object(v) || !exact(v, ['version', 'operationId', 'workspaceId', 'allocation']) || v.version !== 1 || !privateBackupTransferId(v.operationId) || !privateBackupTransferId(v.workspaceId) || !object(v.allocation) ||
      !exact(v.allocation, ['id', 'nonce', 'role', 'bytes']) || !privateBackupTransferId(v.allocation.id) || !privateBackupTransferId(v.allocation.nonce) ||
      !BACKUP_RESOURCE_ROLES.includes(v.allocation.role as BackupResourceRole) || !integer(v.allocation.bytes, 1) || v.allocation.bytes > PRIVATE_BACKUP_OPERATION_LIMITS.reservationBytes) return null;
  return { version: 1, operationId: v.operationId, workspaceId: v.workspaceId, allocation: { id: v.allocation.id, nonce: v.allocation.nonce, role: v.allocation.role as BackupResourceRole, bytes: v.allocation.bytes } };
}
function cleanupEligible(record: BackupOperationRecord, workspaceId: string) {
  if (record.restoreHeld && record.operation.phase !== 'completed') return false;
  if (record.cleanupHold) {
    try { process.kill(record.cleanupHold.pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false; }
  }
  return closedPhases.has(record.operation.phase) || record.operation.workspaceId === workspaceId && (record.operation.phase === 'failed' || record.operation.phase === 'interrupted');
}
/** Reversible stage scratch has no published prepared reference. Only its
 * builder/prepared allocations may be discarded while a review remains valid. */
function allocationCleanupEligible(record: BackupOperationRecord, workspaceId: string, allocation: BackupResourceAllocation) {
  return cleanupEligible(record, workspaceId) || record.operation.workspaceId === workspaceId &&
    record.operation.phase === 'reviewed' && !record.restoreHeld && !record.cleanupHold && !record.references.prepared &&
    (allocation.role === 'prepared' || allocation.role === 'build');
}
function parseAllocations(v: unknown, kind: 'export' | 'upload', reservedBytes: number, references: BackupOperationRecord['references']): BackupResourceAllocation[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 32) return fail();
  const parsed: BackupResourceAllocation[] = []; const ids = new Set<string>(); const nonces = new Set<string>(); const live = new Set<BackupResourceRole>(); let liveBytes = 0;
  for (const item of v) {
    if (!object(item) || !exact(item, ['id', 'nonce', 'role', 'bytes', 'state']) || !privateBackupTransferId(item.id) || !privateBackupTransferId(item.nonce) ||
        !BACKUP_RESOURCE_ROLES.includes(item.role as BackupResourceRole) || !(RESOURCE_KIND[kind] as readonly string[]).includes(item.role as string) || !integer(item.bytes, 1) ||
        item.bytes > PRIVATE_BACKUP_OPERATION_LIMITS.reservationBytes || item.state !== 'allocated' && item.state !== 'deleting' && item.state !== 'removed' ||
        item.id === item.nonce || ids.has(item.id) || nonces.has(item.nonce) || ids.has(item.nonce) || nonces.has(item.id)) return fail();
    ids.add(item.id); nonces.add(item.nonce);
    if (item.state !== 'removed') { if (live.has(item.role as BackupResourceRole)) return fail(); live.add(item.role as BackupResourceRole); liveBytes += item.bytes; }
    parsed.push({ id: item.id, nonce: item.nonce, role: item.role as BackupResourceRole, bytes: item.bytes, state: item.state });
  }
  if (!integer(liveBytes) || liveBytes > reservedBytes) return fail();
  for (const name of ['capture', 'preview', 'prepared'] as const) {
    const ref = references[name]; if (ref && !parsed.some(a => a.role === name && a.id === ref.directoryId)) return fail();
  }
  return parsed;
}
function validate(v: unknown, workspaceId: string): BackupOperationRecord {
  if (!object(v) || !exact(v, ['version', 'revision', 'operation', 'reservedBytes', 'restoreHeld', 'references'], ['allocations', 'cleanupHold']) || v.version !== 1 || !integer(v.revision, 1) || !integer(v.reservedBytes) ||
      v.reservedBytes > PRIVATE_BACKUP_OPERATION_LIMITS.reservationBytes || typeof v.restoreHeld !== 'boolean' || !object(v.references) || !exact(v.references, [], ['capture', 'preview', 'prepared'])) return fail();
  const op = parsePrivateBackupTransferOperation(v.operation); if (!op || op.workspaceId !== workspaceId) return fail();
  for (const [name, ref] of Object.entries(v.references)) if (!reference(ref, name === 'prepared')) return fail();
  if (op.kind === 'export' && (v.references.preview || v.references.prepared || v.restoreHeld) || op.kind === 'upload' && v.references.capture) return fail();
  if (op.phase === 'completed' && (op.kind !== 'upload' || !v.restoreHeld || !v.references.prepared)) return fail();
  if (restorePhases.has(op.phase) && !v.restoreHeld || v.restoreHeld && (op.canCancel || ['cancelled', 'expired'].includes(op.phase)) || v.restoreHeld && op.phase !== 'completed' && !v.reservedBytes) return fail();
  if (v.references.capture && (v.references.capture as BackupCatalogReference).workspaceId !== workspaceId) return fail();
  if (v.references.preview && op.preview && (v.references.preview as BackupCatalogReference).workspaceId !== op.preview.workspaceId) return fail();
  if (v.references.prepared && (!v.restoreHeld || !v.references.preview || (v.references.prepared as BackupPreparedReference).workspaceId !== (v.references.preview as BackupCatalogReference).workspaceId)) return fail();
  const parsedAllocations = parseAllocations(v.allocations, op.kind, v.reservedBytes, v.references as BackupOperationRecord['references']);
  if (v.cleanupHold !== undefined && (!object(v.cleanupHold) || !exact(v.cleanupHold, ['pid']) || !integer(v.cleanupHold.pid, 1))) return fail();
  if (Buffer.byteLength(JSON.stringify(v)) > PRIVATE_BACKUP_OPERATION_LIMITS.recordBytes) return fail();
  return { version: 1, revision: v.revision, operation: op, reservedBytes: v.reservedBytes, restoreHeld: v.restoreHeld, references: structuredClone(v.references), ...(parsedAllocations ? { allocations: parsedAllocations } : {}), ...(v.cleanupHold ? { cleanupHold: structuredClone(v.cleanupHold) } : {}) } as BackupOperationRecord;
}
async function privateDirectory(directory: string): Promise<void> {
  const root = parse(directory).root; let current = root;
  for (const part of directory.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try { const s = await lstat(current); if (!s.isDirectory() || s.isSymbolicLink()) fail(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const made = await mkdir(directory, { recursive: true, mode: 0o700 }), stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.())) fail();
  await windowsFilePrivacy(directory, 'directory', made !== undefined);
}

/** Publish a complete, private database with an exclusive hard link. The fixed
 * name is never an empty/truncated initialization marker. A killed publisher's
 * second link is recoverable only for its authenticated, empty initial store. */
async function initialize(path: string, directory: string, options: BackupOperationStoreOptions, nonce: string): Promise<boolean> {
  try { await lstat(path); return false; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let entries = 0;
  for await (const _entry of await opendir(directory)) if (++entries > 32) fail('Interrupted backup initialization files need recovery. Existing files were preserved.');
  const temporary = join(directory, `.operations-init-${nonce}.sqlite`), file = await open(temporary, 'wx', 0o600);
  let published = false;
  try {
    await windowsFilePrivacy(temporary, 'file', true);
    const db = new DatabaseSync(temporary);
    try {
      db.exec('PRAGMA page_size=4096; PRAGMA max_page_count=16; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;');
      db.exec(`${SCHEMA.control}; ${SCHEMA.operations}; PRAGMA user_version=1;`);
      db.prepare('INSERT INTO control VALUES(1,?)').run(JSON.stringify(encryptJson(options.key, { version: 1, workspaceId: options.workspaceId, owner: null, initialization: nonce })));
      db.exec('COMMIT');
    } finally { db.close(); }
    await file.sync(); options.fault?.('initial-ready');
    try { await link(temporary, path); published = true; fsyncDir(directory); options.fault?.('initial-linked'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    return published;
  } finally {
    await file.close(); await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }); fsyncDir(directory);
  }
}

export async function createBackupOperationStore(options: BackupOperationStoreOptions) {
  if (!Buffer.isBuffer(options.key) || options.key.length !== 32 || !privateBackupTransferId(options.workspaceId)) fail('A protected workspace is required.', 400);
  const limits = { ...PRIVATE_BACKUP_OPERATION_LIMITS, ...options.limits }, now = options.now ?? Date.now, newId = options.randomId ?? randomUUID;
  for (const name of ['records', 'active', 'reservationBytes'] as const) if (!integer(limits[name], 1) || limits[name] > PRIVATE_BACKUP_OPERATION_LIMITS[name]) fail('Invalid backup operation limits.', 400);
  const directory = resolve(options.directory), path = join(directory, 'operations.sqlite'); await privateDirectory(directory);
  const nonce = randomUUID(); await initialize(path, directory, options, nonce);
  const initial = await lstat(path);
  if (!initial.isFile() || initial.isSymbolicLink() || ![1, 2].includes(initial.nlink) || !initial.size || initial.size > limits.journalBytes || process.platform !== 'win32' && ((initial.mode & 0o077) || initial.uid !== process.getuid?.())) fail();
  await windowsFilePrivacy(path, 'file');
  const key = Buffer.from(options.key); let db: DatabaseSync;
  try { db = new DatabaseSync(path); } catch (error) { key.fill(0); throw error; }
  let closed = false;
  const encode = (value: unknown) => JSON.stringify(encryptJson(key, value));
  const decode = (value: unknown): unknown => {
    if (typeof value !== 'string' || Buffer.byteLength(value) > 2 * limits.recordBytes) return fail();
    try { const envelope: unknown = JSON.parse(value); if (!isEncryptedEnvelope(envelope)) return fail(); return decryptJson(key, envelope); } catch { return fail(); }
  };
  const tx = <T>(work: () => T): T => { if (closed) fail('Backup operation storage is closed.', 409); db.exec('BEGIN IMMEDIATE'); try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { try { db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back a full-disk transaction. */ } throw error; } };
  const control = (requireCurrent = true) => {
    const row = db.prepare('SELECT CASE WHEN length(payload)<=? THEN payload END AS payload FROM control WHERE id=1').get(2 * limits.recordBytes);
    const value = row && decode(row.payload);
    if (!object(value) || !exact(value, ['version', 'workspaceId', 'owner', 'initialization']) || value.version !== 1 || !privateBackupTransferId(value.workspaceId) || requireCurrent && value.workspaceId !== options.workspaceId ||
      !(value.initialization === null || privateBackupTransferId(value.initialization)) ||
      !(value.owner === null || object(value.owner) && exact(value.owner, ['pid', 'nonce']) && integer(value.owner.pid, 1) && privateBackupTransferId(value.owner.nonce))) return fail();
    return value as { version: 1; workspaceId: string; owner: { pid: number; nonce: string } | null; initialization: string | null };
  };
  const assertOwner = () => {
    if (closed) fail('Backup operation storage is closed.', 409);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.ino !== initial.ino || stat.dev !== initial.dev || stat.size > limits.journalBytes ||
        process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.())) fail();
    const owner = control().owner; if (owner?.pid !== process.pid || owner.nonce !== nonce) fail();
  };
  const rowRecord = (row: Record<string, unknown>): BackupOperationRecord => {
    const value = decode(row.payload);
    if (!object(value) || !object(value.operation) || !privateBackupTransferId(value.operation.workspaceId)) return fail();
    const record = validate(value, value.operation.workspaceId);
    if (record.operation.id !== row.id || record.revision !== row.revision) fail(); return record;
  };
  const rows = () => db.prepare('SELECT id,revision,CASE WHEN length(payload)<=? THEN payload END AS payload FROM operations ORDER BY id LIMIT ?').iterate(2 * limits.recordBytes, limits.records + 1);
  const read = (id: string) => {
    if (!privateBackupTransferId(id)) fail('Invalid backup operation.', 400);
    const row = db.prepare('SELECT id,revision,CASE WHEN length(payload)<=? THEN payload END AS payload FROM operations WHERE id=?').get(2 * limits.recordBytes, id);
    if (!row) fail('This backup operation was not found.', 404); return rowRecord(row);
  };
  const totals = () => {
    let records = 0, workspaceRecords = 0, active = 0, reservedBytes = 0; const resourceIds = new Set<string>();
    for (const row of rows()) { const r = rowRecord(row); records++; const current = r.operation.workspaceId === options.workspaceId; workspaceRecords += Number(current);
      for (const allocation of r.allocations ?? []) for (const id of [allocation.id, allocation.nonce]) { if (resourceIds.has(id)) fail(); resourceIds.add(id); }
      active += Number(current && !closedPhases.has(r.operation.phase)); reservedBytes += r.reservedBytes; }
    if (records > limits.records || !integer(reservedBytes) || reservedBytes > limits.reservationBytes) fail();
    return { records, workspaceRecords, active, reservedBytes };
  };
  const save = (record: BackupOperationRecord) => db.prepare('INSERT OR REPLACE INTO operations VALUES(?,?,?)').run(record.operation.id, record.revision, encode(record));
  const stamp = () => { const value = now(); if (!integer(value, 1)) fail('The backup clock is unavailable.'); return value; };
  const persist = (before: BackupOperationRecord, workspace: string, edit: (next: BackupOperationRecord) => void) => {
    const next = structuredClone(before);
    edit(next);
    next.revision = before.revision + 1;
    next.operation.updatedAt = Math.max(stamp(), before.operation.updatedAt);
    validate(next, workspace);
    save(next);
    return structuredClone(next);
  };
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-1024;');
    const schema = db.prepare("SELECT name,type,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 3").all();
    if (schema.length !== 2 || schema.some(row => row.type !== 'table' || !Object.hasOwn(SCHEMA, String(row.name)) || row.sql !== SCHEMA[row.name as keyof typeof SCHEMA]) || db.prepare('PRAGMA user_version').get()?.user_version !== 1) fail();
    const page = Number(db.prepare('PRAGMA page_size').get()?.page_size); if (!integer(page, 512) || page > 65_536) fail();
    db.exec(`PRAGMA max_page_count=${Math.floor(limits.journalBytes / page)};`);
    const prior = control(false);
    let completion: Awaited<ReturnType<typeof readBackupColdCompletion>> | undefined;
    if (options.restoreDirectory) {
      try { completion = await readBackupColdCompletion(options.restoreDirectory, key, options.workspaceId); }
      catch (error) { if (prior.workspaceId !== options.workspaceId) throw error; }
    } else if (prior.workspaceId !== options.workspaceId) fail();
    let consumeCompletion = false;
    tx(() => {
      const header = control(false);
      if (header.owner) {
        try { process.kill(header.owner.pid, 0); fail('Another running service owns backup operations.', 409); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      totals();
      if (lstatSync(path).nlink === 2) {
        if (!header.initialization || header.owner || totals().records !== 0) fail();
        const candidatePath = join(directory, `.operations-init-${header.initialization}.sqlite`);
        try {
          const candidate = lstatSync(candidatePath);
          if (!candidate.isFile() || candidate.isSymbolicLink() || candidate.nlink !== 2 || candidate.ino !== initial.ino || candidate.dev !== initial.dev) fail();
          unlinkSync(candidatePath); fsyncDir(directory);
        } catch (error) {
          // The publishing process may finish removing its own extra link
          // while this opener holds the SQL admission lock.
          const named = lstatSync(path);
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || named.nlink !== 1 || named.ino !== initial.ino || named.dev !== initial.dev || named.isSymbolicLink()) throw error;
        }
      }
      if (header.workspaceId !== options.workspaceId && (!completion || completion.proof.previousWorkspaceId !== header.workspaceId)) fail();
      const matchingCompletion = completion && (completion.proof.previousWorkspaceId === header.workspaceId || completion.proof.workspaceId === header.workspaceId) &&
        db.prepare('SELECT id FROM operations WHERE id=?').get(completion.proof.operationId);
      if (header.workspaceId !== options.workspaceId && !matchingCompletion) fail();
      if (completion && matchingCompletion) {
        completion.assertCurrent();
        const proof = completion.proof, restored = read(proof.operationId), prepared = restored.references.prepared;
        if (restored.operation.workspaceId !== proof.previousWorkspaceId || restored.operation.kind !== 'upload' || !restored.restoreHeld ||
            header.workspaceId !== proof.previousWorkspaceId && restored.operation.phase !== 'completed' ||
            !['staging', 'staged', 'applying', 'failed', 'completed'].includes(restored.operation.phase) || !prepared || prepared.directoryId !== proof.directoryId ||
            prepared.storeId !== proof.storeId || prepared.digest !== proof.preparedDigest || prepared.workspaceId !== proof.workspaceId ||
            restored.references.preview?.workspaceId !== proof.workspaceId || restored.operation.artifact?.archiveDigest !== proof.receipt.digest ||
            restored.operation.preview && JSON.stringify(restored.operation.preview) !== JSON.stringify(proof.receipt)) fail();
        // Verified cold publication may have outlived its process before a
        // journal phase update. Keep the original ownership and reservation:
        // completion does not prove that retained artifacts were cleaned up.
        if (restored.operation.phase !== 'completed') {
          restored.revision++; restored.operation.phase = 'completed'; restored.operation.canCancel = false;
          restored.operation.requiresPassphrase = false; restored.operation.preview = proof.receipt;
          restored.operation.updatedAt = Math.max(stamp(), restored.operation.updatedAt); delete restored.operation.error;
          save(validate(restored, proof.previousWorkspaceId));
        }
        consumeCompletion = true;
      }
      db.prepare('UPDATE control SET payload=? WHERE id=1').run(encode({ ...header, workspaceId: options.workspaceId, owner: { pid: process.pid, nonce }, initialization: null }));
      // We own the journal now. No previous live computation can still publish.
      // Ciphertext upload progress remains resumable; staging evidence stays held.
      for (const row of rows()) {
        const r = rowRecord(row); if (r.operation.workspaceId !== options.workspaceId || !interruptedPhases.has(r.operation.phase)) continue;
        r.revision++; r.operation.phase = 'interrupted'; r.operation.updatedAt = Math.max(stamp(), r.operation.updatedAt);
        r.operation.requiresPassphrase = r.operation.kind === 'export' || r.operation.receivedBytes === r.operation.progress.totalBytes;
        delete r.operation.preview; r.operation.error = { code: 'interrupted' }; save(validate(r, options.workspaceId));
      }
    });
    // Commit the durable journal first. A killed process leaves an exact proof
    // that the next opener recognizes as already ingested and then consumes.
    if (consumeCompletion) { options.fault?.('completion-committed'); completion!.consume(); }
  } catch (error) {
    try { tx(() => { const header = control(false); if (header.owner?.pid === process.pid && header.owner.nonce === nonce) db.prepare('UPDATE control SET payload=? WHERE id=1').run(encode({ ...header, owner: null })); }); } catch { /* Preserve unverifiable storage; never clear another owner. */ }
    db.close(); key.fill(0); throw error;
  }
  return {
    get(id: string) { assertOwner(); const record = read(id); if (record.operation.workspaceId !== options.workspaceId) fail('This backup operation was not found.', 404); return record; },
    usage() { assertOwner(); return { ...totals(), limits: { records: limits.records, active: limits.active, reservedBytes: limits.reservationBytes } }; },
    list(pageOptions: { limit?: number; after?: string } = {}) {
      assertOwner(); const limit = pageOptions.limit ?? 20;
      if (!integer(limit, 1) || limit > 20 || pageOptions.after !== undefined && !privateBackupTransferId(pageOptions.after)) fail('Invalid backup operation page.', 400);
      const result: BackupOperationRecord[] = []; let next: string | null = null;
      for (const row of rows()) {
        const record = rowRecord(row); if (record.operation.workspaceId !== options.workspaceId || record.operation.id <= (pageOptions.after ?? '')) continue;
        if (result.length === limit) { next = result.at(-1)!.operation.id; break; } result.push(record);
      }
      return { items: result, next, total: totals().workspaceRecords };
    },
    create(operation: PrivateBackupTransferOperation, reservedBytes: number, resourceOptions?: { trackResources: true }): BackupOperationRecord {
      return tx(() => {
        assertOwner();
        if (resourceOptions !== undefined && (!object(resourceOptions) || !exact(resourceOptions, ['trackResources']) || resourceOptions.trackResources !== true)) fail('Invalid backup resource tracking.', 400);
        const record = validate({ version: 1, revision: 1, operation, reservedBytes, restoreHeld: false, references: {}, ...(resourceOptions ? { allocations: [] } : {}) }, options.workspaceId);
        if (operation.phase !== (operation.kind === 'export' ? 'capturing' : 'uploading') || !reservedBytes) fail('Invalid new backup operation.', 400);
        const existing = db.prepare('SELECT id FROM operations WHERE id=?').get(operation.id);
        if (existing) { const before = read(operation.id); if (before.operation.workspaceId !== options.workspaceId || before.operation.kind !== operation.kind || operation.kind === 'upload' && before.operation.progress.totalBytes !== operation.progress.totalBytes || resourceOptions && !before.allocations) fail('This operation identifier belongs to a different request.', 409); return before; }
        const used = totals();
        if (used.records >= limits.records || used.active >= limits.active) fail('Saved backup operations have reached their limit. Review existing operations first.', 409);
        if (used.reservedBytes + reservedBytes > limits.reservationBytes) fail('Backup temporary storage is fully reserved. Finish or cancel an existing operation.', 507);
        save(record); return structuredClone(record);
      });
    },
    update(id: string, revision: number, change: (record: BackupOperationRecord) => void): BackupOperationRecord {
      return tx(() => {
        assertOwner(); const before = read(id); if (before.operation.workspaceId !== options.workspaceId) fail('This backup operation was not found.', 404);
        if (before.revision !== revision) fail('Backup progress changed. Check the saved operation before retrying.', 409);
        const next = structuredClone(before), result: unknown = change(next);
        if (result !== undefined) {
          // TypeScript accepts async functions where void is expected. An
          // asynchronous edit cannot own this synchronous transaction.
          if (result instanceof Promise) void result.catch(() => {});
          fail('Backup operation edits must finish synchronously.', 400);
        }
        next.revision = before.revision + 1;
        next.operation.updatedAt = Math.max(stamp(), before.operation.updatedAt);
        validate(next, options.workspaceId);
        if (next.operation.id !== id || next.operation.kind !== before.operation.kind || next.operation.createdAt !== before.operation.createdAt || before.restoreHeld && !next.restoreHeld || restorePhases.has(next.operation.phase) && !next.restoreHeld) fail();
        if (next.operation.phase !== before.operation.phase && !transitions[before.operation.phase].includes(next.operation.phase)) fail('This backup transition is unavailable.', 409);
        if (!before.restoreHeld && next.restoreHeld && !(before.operation.phase === 'reviewed' && next.operation.phase === 'staging')) fail('A restore must start from its reviewed backup.', 409);
        if (before.restoreHeld && ['capturing', 'sealing', 'uploading', 'uploaded', 'checking', 'reviewed', 'interrupted', 'cancelled', 'expired'].includes(next.operation.phase)) fail('Restore artifacts must be retained for recovery.', 409);
        if (before.operation.artifact && !['cancelled', 'expired'].includes(next.operation.phase) && JSON.stringify(before.operation.artifact) !== JSON.stringify(next.operation.artifact)) fail();
        if (before.restoreHeld) {
          for (const name of ['preview', 'prepared'] as const) {
            if (before.references[name] && JSON.stringify(before.references[name]) !== JSON.stringify(next.references[name])) fail('Restore artifacts must be retained for recovery.', 409);
          }
          if (next.operation.phase !== 'completed' && next.reservedBytes !== before.reservedBytes || next.reservedBytes > before.reservedBytes) fail('Restore storage must remain reserved until completion and cleanup.', 409);
        }
        if (JSON.stringify(next.allocations) !== JSON.stringify(before.allocations)) fail();
        if (JSON.stringify(next.cleanupHold) !== JSON.stringify(before.cleanupHold)) fail('Backup cleanup holds require process-exit recovery.', 409);
        if ((before.allocations || before.cleanupHold) && next.reservedBytes < before.reservedBytes) fail('Restore storage must remain reserved until completion and cleanup.', 409);
        if (before.operation.phase === 'completed' && next.reservedBytes !== before.reservedBytes) fail('Restore storage must remain reserved until completion and cleanup.', 409);
        if (next.allocations) {
          for (const name of ['capture', 'preview', 'prepared'] as const) {
            const ref = next.references[name]; if (!ref) continue;
            if (JSON.stringify(ref) !== JSON.stringify(before.references[name]) || restorePhases.has(next.operation.phase)) {
              if (!next.allocations.some(a => a.role === name && a.state === 'allocated' && a.id === ref.directoryId)) fail();
            }
          }
        }
        if (before.operation.kind === 'upload' && (next.operation.progress.totalBytes !== before.operation.progress.totalBytes || next.operation.receivedBytes! < before.operation.receivedBytes!)) fail();
        const used = totals(); if (used.reservedBytes - before.reservedBytes + next.reservedBytes > limits.reservationBytes) fail('Backup temporary storage is fully reserved.', 507);
        save(next); return structuredClone(next);
      });
    },
    /** Creates a retained allocation. Identifiers are generated here; callers
     * never supply paths, passphrases or business values. */
    allocate(id: string, revision: number, request: { role: BackupResourceRole; bytes: number }) {
      return tx(() => {
        assertOwner(); const before = read(id); if (before.operation.workspaceId !== options.workspaceId) fail('This backup operation was not found.', 404);
        if (before.revision !== revision) fail('Backup progress changed. Check the saved operation before retrying.', 409);
        if (closedPhases.has(before.operation.phase)) fail('This backup transition is unavailable.', 409);
        if (before.cleanupHold) fail('This backup operation requires process-exit recovery.', 409);
        if (!object(request) || !exact(request, ['role', 'bytes'])) fail('Invalid backup allocation.', 400);
        const role = request.role, bytes = request.bytes;
        if (!(RESOURCE_KIND[before.operation.kind] as readonly string[]).includes(role) || !integer(bytes, 1) || bytes > PRIVATE_BACKUP_OPERATION_LIMITS.reservationBytes) fail('Invalid backup operation.', 400);
        if (before.restoreHeld && (before.operation.phase !== 'staging' || before.references.prepared || role !== 'prepared' && role !== 'build')) fail('Restore artifacts must be retained for recovery.', 409);
        const existing = before.allocations ?? [];
        if (existing.length >= 32) fail('Saved backup operations have reached their limit. Review existing operations first.', 409);
        if (existing.some(a => a.state !== 'removed' && a.role === role)) fail('This backup transition is unavailable.', 409);
        const liveBytes = existing.reduce((sum, a) => a.state === 'removed' ? sum : sum + a.bytes, 0);
        if (!integer(liveBytes + bytes) || liveBytes + bytes > before.reservedBytes) fail('Backup temporary storage is fully reserved.', 507);
        const allocationId = newId(), allocationNonce = newId();
        if (!privateBackupTransferId(allocationId) || !privateBackupTransferId(allocationNonce)) fail('Invalid backup operation.', 400);
        if (allocationId === allocationNonce) fail('This operation identifier belongs to a different request.', 409);
        for (const row of rows()) {
          for (const a of rowRecord(row).allocations ?? []) {
            if (a.id === allocationId || a.nonce === allocationNonce || a.id === allocationNonce || a.nonce === allocationId) fail('This operation identifier belongs to a different request.', 409);
          }
        }
        return persist(before, options.workspaceId, next => {
          next.allocations = [...(next.allocations ?? []), { id: allocationId, nonce: allocationNonce, role, bytes, state: 'allocated' }];
        });
      });
    },
    /** Marks a retained allocation deleting. Does not imply writers are idle;
     * callers must abort, drain and close before removing files. Never releases
     * reservedBytes. */
    beginResourceCleanup(id: string, revision: number, allocationId: string) {
      return tx(() => {
        assertOwner(); const before = read(id);
        if (before.revision !== revision) fail('Backup progress changed. Check the saved operation before retrying.', 409);
        if (!privateBackupTransferId(allocationId)) fail('Invalid backup operation.', 400);
        const current = before.allocations?.find(a => a.id === allocationId); if (!current) fail('Invalid backup operation.', 400);
        if (!allocationCleanupEligible(before, options.workspaceId, current)) fail('This backup transition is unavailable.', 409);
        if (current.state !== 'allocated') return structuredClone(before);
        return persist(before, before.operation.workspaceId, next => { next.allocations!.find(a => a.id === allocationId)!.state = 'deleting'; });
      });
    },
    /** Caller invokes only after strict filesystem removal and fsync. Keeps
     * identity and bytes for audit; does not lower reservedBytes. */
    finishResourceCleanup(id: string, revision: number, allocationId: string) {
      return tx(() => {
        assertOwner(); const before = read(id);
        if (before.revision !== revision) fail('Backup progress changed. Check the saved operation before retrying.', 409);
        if (!privateBackupTransferId(allocationId)) fail('Invalid backup operation.', 400);
        const current = before.allocations?.find(a => a.id === allocationId); if (!current) fail('Invalid backup operation.', 400);
        if (!allocationCleanupEligible(before, options.workspaceId, current)) fail('This backup transition is unavailable.', 409);
        if (current.state === 'removed') return structuredClone(before);
        if (current.state !== 'deleting') fail('This backup transition is unavailable.', 409);
        return persist(before, before.operation.workspaceId, next => { next.allocations!.find(a => a.id === allocationId)!.state = 'removed'; });
      });
    },
    /** Sets reservedBytes to 0 after every retained allocation is removed, or
     * when nothing was ever allocated. Sole path that lowers reservation on
     * allocation-aware and completed records. */
    releaseCleanedReservation(id: string, revision: number) {
      return tx(() => {
        assertOwner(); const before = read(id);
        if (before.revision !== revision) fail('Backup progress changed. Check the saved operation before retrying.', 409);
        if (!closedPhases.has(before.operation.phase) || !cleanupEligible(before, options.workspaceId)) fail('This backup transition is unavailable.', 409);
        if (!before.allocations || before.allocations.some(a => a.state !== 'removed')) fail('Backup storage has no complete cleanup record. Its reservation was retained.', 409);
        if (!before.reservedBytes) return structuredClone(before);
        return persist(before, before.operation.workspaceId, next => { next.reservedBytes = 0; });
      });
    },
    /** Internal page of records whose files or reservations still need cleanup.
     * Includes foreign terminal work; public get/list still hide those. */
    cleanupCandidates(pageOptions: { limit?: number; after?: string } = {}) {
      assertOwner(); const limit = pageOptions.limit ?? 20;
      if (!integer(limit, 1) || limit > 20 || pageOptions.after !== undefined && !privateBackupTransferId(pageOptions.after)) fail('Invalid backup operation page.', 400);
      const result: BackupOperationRecord[] = []; let next: string | null = null, total = 0;
      for (const row of rows()) {
        const record = rowRecord(row);
        if (!cleanupEligible(record, options.workspaceId) || !record.reservedBytes && !(record.allocations ?? []).some(a => a.state !== 'removed')) continue;
        total++;
        if (record.operation.id <= (pageOptions.after ?? '')) continue;
        if (result.length === limit) { next = result.at(-1)!.operation.id; continue; }
        result.push(record);
      }
      return { items: result, next, total };
    },
    /** Internal only: permits retirement cleanup under the original owner.
     * Never use this read for a customer operation/status response. */
    getCleanupRecord(id: string) {
      assertOwner(); const record = read(id);
      if (!cleanupEligible(record, options.workspaceId)) fail('This backup must retain its files for recovery.', 409);
      return record;
    },
    /** Persisted before reporting a handle-close failure. Only confirmed exit
     * permits subsequent automatic cleanup; generic updates cannot clear it. */
    holdResourceCleanup(id: string, revision: number) {
      return tx(() => {
        assertOwner(); const before = read(id);
        if (before.operation.workspaceId !== options.workspaceId) fail('This backup operation was not found.', 404);
        if (before.revision !== revision) fail('Backup progress changed. Check the saved operation before retrying.', 409);
        if (before.cleanupHold) return before;
        return persist(before, before.operation.workspaceId, next => { next.cleanupHold = { pid: process.pid }; });
      });
    },
    /** The filesystem helper re-reads this binding at every awaited boundary.
     * Foreign ownership is admitted only for eligible internal cleanup. */
    resourceBinding(id: string, allocationId: string, action: 'read' | 'claim' | 'remove') {
      assertOwner(); const record = read(id);
      if (!['read', 'claim', 'remove'].includes(action) || !privateBackupTransferId(allocationId)) fail('Invalid backup allocation.', 400);
      const current = record.operation.workspaceId === options.workspaceId, allocation = record.allocations?.find(a => a.id === allocationId);
      if (!allocation || !current && !cleanupEligible(record, options.workspaceId)) fail('This backup resource was not found.', 404);
      if (action === 'claim' && (!current || record.cleanupHold || closedPhases.has(record.operation.phase) || allocation.state !== 'allocated' ||
        record.restoreHeld && (record.operation.phase !== 'staging' || record.references.prepared || allocation.role !== 'prepared' && allocation.role !== 'build'))) fail('This backup allocation no longer accepts files.', 409);
      if (action === 'remove' && (!allocationCleanupEligible(record, options.workspaceId, allocation) || allocation.state !== 'deleting')) fail('Save eligible cleanup intent before removing backup files.', 409);
      return { operationId: id, workspaceId: record.operation.workspaceId, allocation: structuredClone(allocation) };
    },
    /** Cancels foreign, unheld, nonterminal records after control.workspaceId
     * changes. Strips public artifact/preview; keeps owner, refs, allocations
     * and reservation so cleanup can finish. */
    retireForeign() {
      return tx(() => {
        assertOwner(); const targets: BackupOperationRecord[] = [];
        for (const row of rows()) {
          const before = rowRecord(row);
          if (before.operation.workspaceId === options.workspaceId || before.restoreHeld || closedPhases.has(before.operation.phase)) continue;
          targets.push(before);
        }
        for (const before of targets) persist(before, before.operation.workspaceId, next => {
          next.operation.phase = 'cancelled'; next.operation.canCancel = false; next.operation.requiresPassphrase = false;
          delete next.operation.artifact; delete next.operation.preview;
        });
        return targets.length;
      });
    },
    /** Only removes old terminal metadata whose artifact cleanup already
     * released all reservations. Never removes staged/restore-held evidence. */
    prune(beforeTime: number): number {
      return tx(() => {
        assertOwner(); if (!integer(beforeTime, 1)) fail('Invalid backup retention time.', 400);
        const ids: string[] = [];
        for (const row of rows()) {
          const r = rowRecord(row);
          if (r.cleanupHold && !cleanupEligible(r, options.workspaceId)) continue;
          if (r.reservedBytes || (r.allocations ?? []).some(a => a.state !== 'removed') || r.operation.updatedAt >= beforeTime) continue;
          if (r.operation.phase === 'completed' || !r.restoreHeld && ['cancelled', 'expired'].includes(r.operation.phase)) ids.push(r.operation.id);
        }
        for (const id of ids) db.prepare('DELETE FROM operations WHERE id=?').run(id); return ids.length;
      });
    },
    close() {
      if (closed) return;
      try { tx(() => { assertOwner(); const header = control(); db.prepare('UPDATE control SET payload=? WHERE id=1').run(encode({ ...header, owner: null })); }); }
      finally { closed = true; try { db.close(); } finally { key.fill(0); } }
    },
  };
}
export type BackupOperationStore = Awaited<ReturnType<typeof createBackupOperationStore>>;


### server/private-backup-prepared.ts
/** Exact, already-prepared destination bytes for a future cold restore.
 * This private database is created by RealBud, never supplied by an archive.
 * A completed read and full validate() are required before publishing files.
 * This store does not interpret business ciphertext or apply a restore. */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { lstat, mkdir, open, readdir } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { fsyncDir } from './atomic.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { isPrivateBackupPath } from './private-workspace-backup.ts';

export const PRIVATE_BACKUP_PREPARED_CHUNK_BYTES = 1024 * 1024;
export const PRIVATE_BACKUP_PREPARED_LIMITS = Object.freeze({
  bytes: 1024 ** 3, fileBytes: 8 * 1024 ** 2, entries: 100_001, sqliteBytes: 3 * 1024 ** 3,
});
export interface PreparedLimits { bytes: number; fileBytes: number; entries: number; sqliteBytes: number }
export interface PreparedEntry {
  sequence: number; path: string; beforeHash: string | null; intendedHash: string | null; bytes: number;
}
export interface PreparedSummary {
  storeId: string; workspaceId: string; entries: number; bytes: number; digest: string; sealed: boolean;
}
interface Header extends PreparedSummary { version: 1; limits: PreparedLimits }
interface Metadata extends PreparedEntry { version: 1; entryId: string; chunks: number }
interface EntryRow { sequence: number; entry_id: string; lookup: string; payload: Uint8Array }
interface OperationOptions { signal?: AbortSignal }
const FILE = 'prepared.sqlite';
const JOURNAL = `${FILE}-journal`;
const BOOTSTRAP_BYTES = 1024 * 1024;
const JOURNAL_HEADER_BYTES = 28;
const DATABASE = 'workflow-state.sqlite';
const CHUNK = PRIVATE_BACKUP_PREPARED_CHUNK_BYTES;
const OVERHEAD = 29; // version + nonce + GCM tag
const META_BYTES = 4096;
const PAGE_BYTES = 4096;
const TABLES = {
  prepared_header: 'CREATE TABLE prepared_header (id INTEGER PRIMARY KEY CHECK(id=1), payload BLOB NOT NULL) STRICT',
  prepared_entries: 'CREATE TABLE prepared_entries (sequence INTEGER PRIMARY KEY, entry_id TEXT NOT NULL UNIQUE, lookup TEXT NOT NULL UNIQUE, payload BLOB NOT NULL) STRICT',
  prepared_chunks: 'CREATE TABLE prepared_chunks (entry_id TEXT NOT NULL, ordinal INTEGER NOT NULL, payload BLOB NOT NULL, PRIMARY KEY(entry_id,ordinal)) STRICT',
};
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(v);
const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const nullableHash = (v: unknown): v is string | null => v === null || hex(v);
const integer = (v: unknown, min = 0): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= min;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function exact(v: unknown, keys: string[]): v is Record<string, unknown> {
  return object(v) && Object.keys(v).sort().join(',') === [...keys].sort().join(',');
}
function fail(message = 'The prepared backup needs recovery. Its original files were preserved.', status = 503): never {
  throw Object.assign(new Error(message), { status });
}
function unsupported(): never { fail('Prepared backup storage is on an unsupported filesystem.', 503); }
export function preparedStorageBudget(limits?: Partial<PreparedLimits>): { databaseBytes: number; rollbackBytes: number; totalBytes: number } {
  const value = { ...PRIVATE_BACKUP_PREPARED_LIMITS, ...limits };
  limitsCheck(value);
  const pages = Math.floor(value.sqliteBytes / PAGE_BYTES);
  const databaseBytes = pages * PAGE_BYTES;
  const rollbackBytes = pages * (PAGE_BYTES + 8) + 2 * PAGE_BYTES * (pages + 1) + BOOTSTRAP_BYTES;
  return { databaseBytes, rollbackBytes, totalBytes: databaseBytes + rollbackBytes };
}
/** DELETE journal header: sector-size at 20, page-size at 24. Magic may be unsynced zeros. */
export function preparedRollbackJournalBounds(header: Uint8Array): { pageBytes: number; sectorBytes: number } {
  if (header.byteLength < JOURNAL_HEADER_BYTES) unsupported();
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const sectorBytes = view.getUint32(20), pageBytes = view.getUint32(24);
  if (pageBytes !== PAGE_BYTES || !integer(sectorBytes, 512) || sectorBytes > PAGE_BYTES || (sectorBytes & (sectorBytes - 1)) !== 0) unsupported();
  return { pageBytes, sectorBytes };
}
async function admitRollbackJournal(directory: string): Promise<void> {
  const path = join(directory, JOURNAL);
  let stat;
  try { stat = lstatSync(path); } catch { unsupported(); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < JOURNAL_HEADER_BYTES) unsupported();
  await windowsFilePrivacy(path, 'file');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)), bytes = Buffer.alloc(JOURNAL_HEADER_BYTES);
  try {
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== stat.dev || actual.ino !== stat.ino || process.platform !== 'win32' && ((actual.mode & 0o077) !== 0 || actual.uid !== process.getuid?.())) unsupported();
    if (readSync(fd, bytes, 0, JOURNAL_HEADER_BYTES, 0) < JOURNAL_HEADER_BYTES) unsupported();
    preparedRollbackJournalBounds(bytes);
  } finally { bytes.fill(0); closeSync(fd); }
}

function validPath(path: unknown): path is string { return path === DATABASE || isPrivateBackupPath(path); }
function keyCheck(key: Buffer): void { if (!Buffer.isBuffer(key) || key.length !== 32) fail('A protected installation key is required.', 400); }
function limitsCheck(value: unknown): asserts value is PreparedLimits {
  if (!exact(value, ['bytes', 'fileBytes', 'entries', 'sqliteBytes']) ||
      !Object.entries(PRIVATE_BACKUP_PREPARED_LIMITS).every(([k, max]) => integer(value[k], k === 'sqliteBytes' ? 65_536 : 1) && Number(value[k]) <= max)) {
    fail('The prepared backup limits are invalid.', 400);
  }
}
function aborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw Object.assign(new Error('Preparing the private backup was cancelled.'), { name: 'AbortError', status: 409 });
}
async function next<T>(iterator: AsyncIterator<T>, signal: AbortSignal): Promise<IteratorResult<T>> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const cancel = () => { try { aborted(signal); } catch (error) { reject(error); } };
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve().then(() => { aborted(signal); return iterator.next(); }).then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', cancel));
  });
}
async function ancestors(directory: string): Promise<void> {
  const root = parse(directory).root;
  let current = root;
  for (const part of directory.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Prepared backup storage contains a linked or invalid folder.');
  }
}
async function privateDirectory(directory: string): Promise<void> {
  await ancestors(directory);
  const stat = await lstat(directory);
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail('Prepared backup storage permissions need recovery.');
  await windowsFilePrivacy(directory, 'directory');
}
async function ownedFiles(directory: string, budget = preparedStorageBudget()): Promise<void> {
  await privateDirectory(directory);
  const names = await readdir(directory);
  if (!names.includes(FILE) || names.some(name => name !== FILE && name !== `${FILE}-journal`)) fail();
  for (const name of names) {
    const path = join(directory, name), stat = await lstat(path);
    const maxBytes = name === FILE ? budget.databaseBytes : budget.rollbackBytes;
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes ||
        process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid())) fail();
    await windowsFilePrivacy(path, 'file');
  }
}
function configure(db: DatabaseSync, maxBytes: number): void {
  db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-2048; PRAGMA busy_timeout=0;');
  const page = db.prepare('PRAGMA page_size').get()?.page_size;
  if (page !== PAGE_BYTES || db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete' || db.prepare('PRAGMA temp_store').get()?.temp_store !== 2) fail();
  const max = Math.floor(maxBytes / PAGE_BYTES);
  if (db.prepare(`PRAGMA max_page_count=${max}`).get()?.max_page_count !== max) fail('Prepared backup storage has reached its capacity.', 413);
}
function schemaCheck(db: DatabaseSync): void {
  const rows = db.prepare("SELECT type,name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' LIMIT 4").all();
  if (db.prepare('PRAGMA user_version').get()?.user_version !== 1 || rows.length !== 3 ||
      rows.some(row => row.type !== 'table' || !Object.hasOwn(TABLES, String(row.name)) || row.sql !== TABLES[row.name as keyof typeof TABLES])) fail();
}

export class PrivateBackupPreparedStore {
  readonly directory: string;
  readonly storeId: string;
  readonly workspaceId: string;
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private closed = false;
  private closing = false;
  private operation: { done: Promise<unknown>; controller: AbortController } | undefined;
  private closingPromise: Promise<void> | undefined;

  private constructor(directory: string, key: Buffer, db: DatabaseSync, storeId: string, workspaceId: string) {
    this.directory = directory; this.key = Buffer.from(key); this.db = db;
    this.storeId = storeId; this.workspaceId = workspaceId;
  }
  static async create(options: { directory: string; key: Buffer; workspaceId: string; limits?: Partial<PreparedLimits> }): Promise<PrivateBackupPreparedStore> {
    keyCheck(options.key);
    if (!uuid(options.workspaceId)) fail('The prepared backup workspace is invalid.', 400);
    const limits = { ...PRIVATE_BACKUP_PREPARED_LIMITS, ...options.limits }; limitsCheck(limits);
    const directory = resolve(options.directory);
    await ancestors(dirname(directory));
    await mkdir(directory, { mode: 0o700 });
    await windowsFilePrivacy(directory, 'directory', true);
    const file = await open(join(directory, FILE), 'wx', 0o600); await file.close();
    await windowsFilePrivacy(join(directory, FILE), 'file', true);
    let db: DatabaseSync | undefined, store: PrivateBackupPreparedStore | undefined;
    try {
      db = new DatabaseSync(join(directory, FILE));
      db.exec(`PRAGMA page_size=${PAGE_BYTES}`); configure(db, limits.sqliteBytes);
      db.exec(`${TABLES.prepared_header}; ${TABLES.prepared_entries}; ${TABLES.prepared_chunks}; PRAGMA user_version=1;`);
      store = new PrivateBackupPreparedStore(directory, options.key, db, randomUUID(), options.workspaceId);
      store.saveHeader({ version: 1, storeId: store.storeId, workspaceId: store.workspaceId,
        entries: 0, bytes: 0, digest: store.emptyDigest(), sealed: false, limits }, true);
      fsyncDir(directory); fsyncDir(dirname(directory));
      return store;
    } catch (error) { if (store) await store.close(); else db?.close(); throw error; }
  }
  /** Only an internally generated store directory and trusted saved identity may be opened. */
  static async open(options: { directory: string; key: Buffer; storeId: string; workspaceId: string }): Promise<PrivateBackupPreparedStore> {
    keyCheck(options.key);
    if (!uuid(options.storeId) || !uuid(options.workspaceId)) fail();
    const directory = resolve(options.directory);
    await ownedFiles(directory);
    let db: DatabaseSync | undefined, store: PrivateBackupPreparedStore | undefined;
    try {
      db = new DatabaseSync(join(directory, FILE));
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0;');
      schemaCheck(db); configure(db, PRIVATE_BACKUP_PREPARED_LIMITS.sqliteBytes);
      store = new PrivateBackupPreparedStore(directory, options.key, db, options.storeId, options.workspaceId);
      const header = store.header(); configure(db, header.limits.sqliteBytes);
      return store;
    } catch (error) { if (store) await store.close(); else db?.close(); throw error; }
  }
  private ready(): void { if (this.closed || this.closing) fail('The prepared backup store is closed.', 409); }
  private idle(): void { this.ready(); if (this.operation) fail('The prepared backup store is busy.', 409); }
  private emptyDigest(): string { return hash(JSON.stringify(['realbud-prepared-v1', this.storeId, this.workspaceId])); }
  private aad(purpose: string, ...bindings: (string | number)[]): Buffer {
    return Buffer.from(JSON.stringify(['realbud-prepared-v1', this.storeId, this.workspaceId, purpose, ...bindings]));
  }
  private encrypt(plain: Buffer, aad: Buffer): Buffer {
    const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), body]);
  }
  private decrypt(payload: unknown, aad: Buffer, maxBytes: number): Buffer {
    try {
      if (!(payload instanceof Uint8Array) || payload.byteLength < OVERHEAD || payload.byteLength > maxBytes + OVERHEAD || payload[0] !== 1) fail();
      const bytes = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
      const cipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(1, 13));
      cipher.setAAD(aad); cipher.setAuthTag(bytes.subarray(13, OVERHEAD));
      return Buffer.concat([cipher.update(bytes.subarray(OVERHEAD)), cipher.final()]);
    } catch { return fail(); }
  }
  private decode(payload: unknown, aad: Buffer): unknown {
    const plain = this.decrypt(payload, aad, META_BYTES);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)); }
    catch { return fail(); } finally { plain.fill(0); }
  }
  private encryptedJson(value: unknown, aad: Buffer): Buffer {
    const plain = Buffer.from(JSON.stringify(value));
    try { if (plain.length > META_BYTES) fail(); return this.encrypt(plain, aad); }
    finally { plain.fill(0); }
  }
  private lookup(path: string): string {
    return createHmac('sha256', this.key).update(this.aad('path', path.toLowerCase())).digest('hex');
  }
  private header(): Header {
    if (this.closed) fail('The prepared backup store is closed.', 409);
    const rows = this.db.prepare('SELECT id,length(payload) AS size FROM prepared_header LIMIT 2').all();
    if (rows.length !== 1 || rows[0].id !== 1 || !integer(rows[0].size) || rows[0].size > META_BYTES + OVERHEAD) fail();
    const value = this.decode(this.db.prepare('SELECT payload FROM prepared_header WHERE id=1').get()?.payload, this.aad('header'));
    if (!exact(value, ['version', 'storeId', 'workspaceId', 'entries', 'bytes', 'digest', 'sealed', 'limits']) ||
        value.version !== 1 || value.storeId !== this.storeId || value.workspaceId !== this.workspaceId ||
        !integer(value.entries) || !integer(value.bytes) || !hex(value.digest) || typeof value.sealed !== 'boolean') fail();
    limitsCheck(value.limits);
    if (value.entries > value.limits.entries || value.bytes > value.limits.bytes) fail();
    return value as unknown as Header;
  }
  private saveHeader(header: Header, initial = false): void {
    const payload = this.encryptedJson(header, this.aad('header'));
    this.db.prepare(initial ? 'INSERT INTO prepared_header VALUES (1,?)' : 'UPDATE prepared_header SET payload=? WHERE id=1').run(payload);
  }
  private publicSummary(header: Header): PreparedSummary {
    const { version: _version, limits: _limits, ...summary } = header; return summary;
  }
  summary(): PreparedSummary { this.idle(); return this.publicSummary(this.header()); }
  private row(sequence: number): EntryRow | undefined {
    const bounds = this.db.prepare('SELECT length(payload) AS size FROM prepared_entries WHERE sequence=?').get(sequence);
    if (!bounds) return undefined;
    if (!integer(bounds.size) || bounds.size > META_BYTES + OVERHEAD) fail();
    return this.db.prepare('SELECT * FROM prepared_entries WHERE sequence=?').get(sequence) as unknown as EntryRow;
  }
  private metadata(row: EntryRow, header: Header): Metadata {
    if (!integer(row.sequence, 1) || row.sequence > header.entries || !uuid(row.entry_id) || !hex(row.lookup)) fail();
    const value = this.decode(row.payload, this.aad('entry', row.entry_id, row.sequence));
    if (!exact(value, ['version', 'entryId', 'sequence', 'path', 'beforeHash', 'intendedHash', 'bytes', 'chunks']) ||
        value.version !== 1 || value.entryId !== row.entry_id || value.sequence !== row.sequence || !validPath(value.path) ||
        !nullableHash(value.beforeHash) || !nullableHash(value.intendedHash) || !integer(value.bytes) || !integer(value.chunks) ||
        row.lookup !== this.lookup(value.path) || value.bytes > (value.path === DATABASE ? header.limits.bytes : header.limits.fileBytes) ||
        value.chunks !== Math.ceil(value.bytes / CHUNK) || value.intendedHash === null && (value.bytes !== 0 || value.chunks !== 0)) fail();
    return value as unknown as Metadata;
  }
  private manifest(previous: string, entry: Metadata): string { return hash(JSON.stringify([previous, entry])); }
  private publicEntry(entry: Metadata): PreparedEntry {
    const { version: _version, entryId: _entryId, chunks: _chunks, ...result } = entry; return result;
  }
  private run<T>(task: (signal: AbortSignal) => Promise<T>, external?: AbortSignal): Promise<T> {
    try { this.idle(); aborted(external); } catch (error) { return Promise.reject(error); }
    const controller = new AbortController(), cancel = () => controller.abort();
    external?.addEventListener('abort', cancel, { once: true });
    const done = Promise.resolve().then(() => task(controller.signal)).finally(() => {
      external?.removeEventListener('abort', cancel); this.operation = undefined;
    });
    this.operation = { controller, done }; return done;
  }
  private async transaction<T>(signal: AbortSignal, body: (header: Header) => Promise<T>): Promise<T> {
    aborted(signal);
    await ownedFiles(this.directory, preparedStorageBudget(this.header().limits));
    aborted(signal);
    let began = false;
    try {
      this.db.exec('BEGIN IMMEDIATE'); began = true;
      const header = this.header();
      this.saveHeader(header);
      await admitRollbackJournal(this.directory);
      const result = await body(header);
      aborted(signal); this.db.exec('COMMIT'); began = false;
      return result;
    } catch (error) {
      if (began) { try { this.db.exec('ROLLBACK'); } catch { /* SQLite may already have rolled back a full disk transaction. */ } }
      const code = (error as { code?: unknown; errcode?: unknown }).code;
      if (typeof code === 'string' && code.startsWith('ERR_SQLITE')) {
        if ((error as { errcode?: number }).errcode === 5) fail('The prepared backup store is busy.', 409);
        if ((error as { errcode?: number }).errcode === 13) fail('Prepared backup storage has reached its capacity.', 413);
        fail();
      }
      throw error;
    }
  }
  private admit(path: string, beforeHash: string | null, header: Header): void {
    if (!validPath(path) || !nullableHash(beforeHash)) fail('The prepared backup file identity is invalid.', 400);
    if (header.sealed) fail('The prepared backup is sealed. Prepare a new store to change its files.', 409);
    if (header.entries >= header.limits.entries) fail('The prepared backup reached its entry capacity.', 413);
    if (this.db.prepare('SELECT 1 FROM prepared_entries WHERE lookup=?').get(this.lookup(path))) fail('The prepared backup contains a duplicate file identity.', 409);
  }
  private commitEntry(entry: Metadata, header: Header): void {
    this.db.prepare('INSERT INTO prepared_entries VALUES (?,?,?,?)').run(entry.sequence, entry.entryId, this.lookup(entry.path), this.encryptedJson(entry, this.aad('entry', entry.entryId, entry.sequence)));
    header.entries++; header.bytes += entry.bytes; header.digest = this.manifest(header.digest, entry); this.saveHeader(header);
  }
  addFile(path: string, beforeHash: string | null, data: AsyncIterable<Uint8Array>, options: OperationOptions = {}): Promise<PreparedEntry> {
    return this.run(signal => this.transaction(signal, async header => {
      this.admit(path, beforeHash, header);
      if (!data || typeof data[Symbol.asyncIterator] !== 'function') fail('Prepared file bytes must be a stream.', 400);
      const iterator = data[Symbol.asyncIterator](), entry: Metadata = { version: 1, entryId: randomUUID(), sequence: header.entries + 1, path, beforeHash, intendedHash: '', bytes: 0, chunks: 0 };
      const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(CHUNK);
      const maxBytes = Math.min(header.limits.bytes - header.bytes, path === DATABASE ? header.limits.bytes : header.limits.fileBytes);
      let used = 0, finished = false, empty = 0;
      const save = () => {
        const chunk = buffer.subarray(0, used); digest.update(chunk);
        this.db.prepare('INSERT INTO prepared_chunks VALUES (?,?,?)').run(entry.entryId, entry.chunks, this.encrypt(chunk, this.aad('chunk', entry.entryId, entry.sequence, entry.chunks)));
        entry.chunks++; used = 0;
      };
      try {
        while (true) {
          const result = await next(iterator, signal); aborted(signal);
          if (result.done) { finished = true; break; }
          const value = result.value;
          if (!(value instanceof Uint8Array) || value.byteLength > CHUNK) fail('Prepared file bytes must use chunks up to 1 MiB.', 400);
          if (value.byteLength === 0) { if (++empty > 1024) fail('Prepared file stream made no progress.', 400); continue; }
          empty = 0;
          if (value.byteLength > maxBytes - entry.bytes) fail('The prepared backup reached its file or total byte capacity.', 413);
          entry.bytes += value.byteLength;
          for (let offset = 0; offset < value.byteLength;) {
            aborted(signal);
            const count = Math.min(CHUNK - used, value.byteLength - offset);
            buffer.set(value.subarray(offset, offset + count), used); used += count; offset += count;
            if (used === CHUNK) { save(); if (entry.chunks % 8 === 0) await yieldTurn(); }
          }
        }
        if (used) save();
        entry.intendedHash = digest.digest('hex'); this.commitEntry(entry, header);
        return this.publicEntry(entry);
      } finally {
        buffer.fill(0);
        // A stuck producer must not keep close()/rollback waiting indefinitely.
        if (!finished) { try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* Producer cleanup cannot make an incomplete entry visible. */ } }
      }
    }), options.signal);
  }
  addRemoval(path: string, beforeHash: string | null, options: OperationOptions = {}): Promise<PreparedEntry> {
    return this.run(signal => this.transaction(signal, async header => {
      this.admit(path, beforeHash, header);
      const entry: Metadata = { version: 1, entryId: randomUUID(), sequence: header.entries + 1, path, beforeHash, intendedHash: null, bytes: 0, chunks: 0 };
      this.commitEntry(entry, header); return this.publicEntry(entry);
    }), options.signal);
  }
  private sealed(): Header {
    const header = this.header(); if (!header.sealed) fail('The prepared backup has not been sealed.', 409); return header;
  }
  private *manifestEntries(header: Header): Iterable<Metadata> {
    let digest = this.emptyDigest(), bytes = 0;
    if (this.db.prepare('SELECT count(*) AS n FROM prepared_entries').get()?.n !== header.entries) fail();
    for (let sequence = 1; sequence <= header.entries; sequence++) {
      const row = this.row(sequence); if (!row) fail();
      const entry = this.metadata(row, header); bytes += entry.bytes; digest = this.manifest(digest, entry); yield entry;
    }
    if (bytes !== header.bytes || digest !== header.digest) fail();
  }
  /** Exhaust the iterator before trusting the complete ordered manifest. */
  *entries(): Iterable<PreparedEntry> {
    this.idle(); const header = this.sealed();
    for (const entry of this.manifestEntries(header)) { this.idle(); yield this.publicEntry(entry); }
  }
  private chunk(entry: Metadata, ordinal: number): Buffer {
    const bound = this.db.prepare('SELECT length(payload) AS size FROM prepared_chunks WHERE entry_id=? AND ordinal=?').get(entry.entryId, ordinal);
    const length = Math.min(CHUNK, entry.bytes - ordinal * CHUNK);
    if (bound?.size !== length + OVERHEAD) fail();
    const row = this.db.prepare('SELECT payload FROM prepared_chunks WHERE entry_id=? AND ordinal=?').get(entry.entryId, ordinal);
    const bytes = this.decrypt(row?.payload, this.aad('chunk', entry.entryId, entry.sequence, ordinal), CHUNK);
    if (bytes.length !== length) { bytes.fill(0); fail(); } return bytes;
  }
  private async checkContents(entry: Metadata, signal: AbortSignal): Promise<void> {
    if (this.db.prepare('SELECT count(*) AS n FROM prepared_chunks WHERE entry_id=?').get(entry.entryId)?.n !== entry.chunks) fail();
    if (entry.intendedHash === null) return;
    const digest = createHash('sha256');
    for (let ordinal = 0; ordinal < entry.chunks; ordinal++) {
      aborted(signal); const bytes = this.chunk(entry, ordinal);
      try { digest.update(bytes); } finally { bytes.fill(0); }
      if (ordinal % 8 === 7) await yieldTurn();
    }
    if (digest.digest('hex') !== entry.intendedHash) fail();
  }
  private async inspect(header: Header, signal: AbortSignal): Promise<PreparedSummary> {
    schemaCheck(this.db);
    let chunks = 0;
    for (const entry of this.manifestEntries(header)) {
      aborted(signal); await this.checkContents(entry, signal); chunks += entry.chunks;
      if (entry.sequence % 100 === 0) await yieldTurn();
    }
    if (this.db.prepare('SELECT count(*) AS n FROM prepared_chunks').get()?.n !== chunks) fail();
    return this.publicSummary(header);
  }
  seal(options: OperationOptions = {}): Promise<PreparedSummary> {
    return this.run(signal => this.transaction(signal, async header => {
      await this.inspect(header, signal);
      if (!header.sealed) { header.sealed = true; this.saveHeader(header); }
      return this.publicSummary(header);
    }), options.signal);
  }
  /** Reauthenticates every sealed entry, chunk, before hash and ordered manifest. */
  validate(options: OperationOptions = {}): Promise<PreparedSummary> {
    return this.run(signal => this.transaction(signal, async header => {
      if (!header.sealed) fail('The prepared backup has not been sealed.', 409);
      return this.inspect(header, signal);
    }), options.signal);
  }
  /** Each chunk is authenticated before yield. Exhaust to verify full hash/EOF.
   * Already yielded bytes must remain provisional until this iterator completes. */
  async *readFile(path: string, options: OperationOptions = {}): AsyncIterable<Buffer> {
    this.idle(); aborted(options.signal); const header = this.sealed();
    if (!validPath(path)) fail('The prepared backup file identity is invalid.', 400);
    const found = this.db.prepare('SELECT sequence FROM prepared_entries WHERE lookup=?').get(this.lookup(path));
    if (!found || !integer(found.sequence, 1)) fail('The prepared backup file was not found.', 404);
    const row = this.row(found.sequence); if (!row) fail();
    const entry = this.metadata(row, header);
    if (entry.path !== path || entry.intendedHash === null) fail('The prepared backup file was not found.', 404);
    const digest = createHash('sha256');
    for (let ordinal = 0; ordinal < entry.chunks; ordinal++) {
      this.idle(); aborted(options.signal);
      const bytes = this.chunk(entry, ordinal);
      try { digest.update(bytes); yield bytes; } finally { bytes.fill(0); }
    }
    this.idle(); aborted(options.signal);
    if (this.db.prepare('SELECT count(*) AS n FROM prepared_chunks WHERE entry_id=?').get(entry.entryId)?.n !== entry.chunks || digest.digest('hex') !== entry.intendedHash) fail();
  }
  close(): Promise<void> {
    if (this.closingPromise) return this.closingPromise;
    this.closing = true; this.operation?.controller.abort();
    this.closingPromise = (async () => {
      await this.operation?.done.catch(() => undefined);
      try { this.db.close(); } finally { this.key.fill(0); this.closed = true; }
    })(); return this.closingPromise;
  }
}


### server/private-backup-prepare.ts
/** Materialize final randomized ciphertext once, before the compact stage is
 * published. Later restart recovery reads identical prepared bytes. */
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, rmdir, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PrivateBackupCatalog } from './private-backup-catalog.ts';
import { PrivateBackupPreparedStore } from './private-backup-prepared.ts';
import { privateBackupTargetPaths } from './private-backup-capture.ts';
import { privateRestoreTargetHash } from './private-backup-cold-restore.ts';
import { encryptJson } from './desk-crypto.ts';
import { WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH } from './workflow-database.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { fsyncDir } from './atomic.ts';

export const PRIVATE_BACKUP_BUILD_MAX_BYTES = 1024 ** 3;
const PAGE_BYTES = 4096;
export function privateBackupBuildStorageBudget(databaseBytes = PRIVATE_BACKUP_BUILD_MAX_BYTES) {
  if (!Number.isSafeInteger(databaseBytes) || databaseBytes < 65_536 || databaseBytes > PRIVATE_BACKUP_BUILD_MAX_BYTES || databaseBytes % PAGE_BYTES) fail('Invalid restore preparation capacity.', 400);
  const rollbackBytes = databaseBytes / PAGE_BYTES * (PAGE_BYTES + 8) + 2 * 65_536;
  return { databaseBytes, rollbackBytes, totalBytes: databaseBytes + rollbackBytes };
}
function fail(message = 'The private restore could not be prepared. Existing business records were preserved.', status = 503): never { throw Object.assign(new Error(message), { status }); }
async function safeFolder(path: string) {
  const absolute = resolve(path), root = parse(absolute).root; let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try { const s = await lstat(current); if (!s.isDirectory() || s.isSymbolicLink()) fail(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const created = await mkdir(path, { recursive: true, mode: 0o700 }), stat = await lstat(path);
  if (process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.())) fail();
  await windowsFilePrivacy(path, 'directory', created !== undefined);
}
/** Clean only this invocation's exclusively created build directory after its
 * SQLite/file handles close. Unexpected entries remain available for recovery. */
async function removeBuild(directory: string, identity: { dev: number; ino: number }) {
  const sameDirectory = async () => {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== identity.dev || stat.ino !== identity.ino) fail('Restore preparation storage changed; its files need recovery.');
  };
  await sameDirectory();
  const names = await readdir(directory);
  if (names.some(name => !['workflow-state.sqlite', 'workflow-state.sqlite-journal'].includes(name))) fail('Restore preparation contains unexpected files; they were preserved for recovery.');
  const files = [];
  for (const name of names) {
    const path = join(directory, name), stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || process.platform !== 'win32' && ((stat.mode & 0o077) || stat.uid !== process.getuid?.())) fail('Restore preparation contains linked or unverified files; they were preserved.');
    await windowsFilePrivacy(path, 'file'); files.push({ path, stat });
  }
  for (const file of files) {
    await sameDirectory(); const current = await lstat(file.path);
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== file.stat.dev || current.ino !== file.stat.ino || current.size !== file.stat.size || current.mtimeMs !== file.stat.mtimeMs || current.ctimeMs !== file.stat.ctimeMs) fail('Restore preparation storage changed; its files need recovery.');
    await unlink(file.path);
  }
  await sameDirectory(); await rmdir(directory); fsyncDir(dirname(directory));
}
async function* chunks(bytes: Buffer) { try { for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) yield bytes.subarray(offset, offset + 1024 * 1024); } finally { bytes.fill(0); } }
export async function preparePrivateBackupRestore(options: {
  directory: string; key: Buffer; source: PrivateBackupCatalog; prepared: PrivateBackupPreparedStore;
  databasePresent: boolean; assertLease: () => void; signal?: AbortSignal;
  onProgress?: (value: { files: number; bytes: number }) => void | Promise<void>;
  /** Internal storage admission limit; never a browser-supplied path or quota. */
  databaseBytes?: number;
  /** Coordinator-owned allocation identity, recorded before directory creation. */
  buildDirectoryId?: string;
}) {
  if (!Buffer.isBuffer(options.key) || options.key.length !== 32) fail();
  if (options.buildDirectoryId !== undefined && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(options.buildDirectoryId)) fail('The restore preparation allocation is invalid.', 400);
  const databaseBytes = options.databaseBytes ?? PRIVATE_BACKUP_BUILD_MAX_BYTES;
  if (!Number.isSafeInteger(databaseBytes) || databaseBytes < 65_536 || databaseBytes > PRIVATE_BACKUP_BUILD_MAX_BYTES || databaseBytes % PAGE_BYTES) fail('The restore preparation capacity is invalid.', 400);
  const key = Buffer.from(options.key), directory = resolve(options.directory);
  const assert = () => {
    options.signal?.throwIfAborted(); const result: unknown = options.assertLease();
    if (result !== undefined) {
      if (result && typeof result === 'object' && 'then' in result) void Promise.resolve(result).catch(() => {});
      fail('The snapshot lease assertion must complete synchronously.', 500);
    }
  };
  let scratch: string | undefined, scratchIdentity: { dev: number; ino: number } | undefined;
  try {
    assert(); const source = options.source.summary(), target = options.prepared.summary();
    if (!source.sealed || target.sealed || target.entries || target.workspaceId !== source.workspaceId || !options.databasePresent && source.records) fail();
    options.source.validate();
    const remaining = new Set(await privateBackupTargetPaths(directory)); assert();
    let files = 0, bytes = 0;
    const added = async (size: number) => { files++; bytes += size; assert(); await options.onProgress?.({ files, bytes }); assert(); };
    for (const file of options.source.iterateFiles()) {
      assert();
      // JSON encoding is confined by catalog validation to Desk and the legacy
      // private-vault envelopes; all ordinary business bytes remain exact.
      const content = file.encoding === 'json' ? Buffer.from(JSON.stringify(encryptJson(key, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.data))))) : Buffer.from(file.data);
      const size = content.length, before = await privateRestoreTargetHash(join(directory, file.path)); assert();
      await options.prepared.addFile(file.path, before, chunks(content), { signal: options.signal }); assert();
      remaining.delete(file.path); await added(size);
    }
    if (options.databasePresent) {
      const parent = join(directory, 'private-backup-v2', 'build'); await safeFolder(parent); assert();
      const candidate = join(parent, options.buildDirectoryId ?? randomUUID());
      await mkdir(candidate, { mode: 0o700 }); // Never claim or clean an existing allocation.
      scratch = candidate; scratchIdentity = await lstat(scratch); await windowsFilePrivacy(scratch, 'directory', true);
      const database = join(scratch, 'workflow-state.sqlite');
      const created = await open(database, 'wx', 0o600); await created.close(); await windowsFilePrivacy(database, 'file', true); assert();
      const db = new DatabaseSync(database);
      try {
        db.exec(`PRAGMA trusted_schema=OFF; PRAGMA page_size=${PAGE_BYTES}; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE; PRAGMA cache_size=-2048; PRAGMA temp_store=MEMORY; PRAGMA cache_spill=OFF;`);
        if (db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'delete' || db.prepare('PRAGMA cache_spill').get()?.cache_spill !== 0 || db.prepare('PRAGMA page_size').get()?.page_size !== PAGE_BYTES || db.prepare(`PRAGMA max_page_count=${databaseBytes / PAGE_BYTES}`).get()?.max_page_count !== databaseBytes / PAGE_BYTES) fail('Restore preparation storage reached its capacity.', 413);
        db.exec('CREATE TABLE workflow_records (id TEXT PRIMARY KEY, kind TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL); PRAGMA user_version=1; BEGIN IMMEDIATE;');
        const insert = db.prepare('INSERT INTO workflow_records VALUES(?,?,?,?)');
        // The whole private build is provisional until closed and copied. Small
        // transactions bound non-spilling memory without publishing partial work.
        let batchBytes = 0, batchRows = 0;
        for (const row of options.source.iterateRecords()) {
          assert(); const payload = JSON.stringify(encryptJson(key, row.value));
          if (payload.length > WORKFLOW_MAX_ENCRYPTED_RECORD_LENGTH) fail('A restored workflow record exceeds its storage limit. No restore was staged.');
          insert.run(row.id, row.kind, row.revision, payload); batchBytes += Buffer.byteLength(payload); batchRows++;
          if (batchBytes >= 8 * 1024 * 1024 || batchRows >= 128) { db.exec('COMMIT; BEGIN IMMEDIATE;'); batchBytes = 0; batchRows = 0; }
        }
        db.exec('COMMIT');
      } catch (error) {
        // SQLITE_FULL may already have rolled back. Closing discards any
        // remaining transaction; no incomplete database enters the prepared store.
        if ((error as { errcode?: number }).errcode === 13) fail('Restore preparation storage reached its capacity. No restore was staged.', 413);
        throw error;
      } finally { db.close(); }
      const handle = await open(database, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat(); if (before.size > databaseBytes || !before.isFile() || before.nlink !== 1) fail();
        const baseline = await privateRestoreTargetHash(join(directory, 'workflow-state.sqlite')); assert();
        async function* stream() {
          const buffer = Buffer.alloc(1024 * 1024); let offset = 0;
          try {
            while (offset < before.size) {
              assert(); const result = await handle.read(buffer, 0, Math.min(buffer.length, before.size - offset), offset); assert();
              if (!result.bytesRead) fail(); offset += result.bytesRead; yield buffer.subarray(0, result.bytesRead);
            }
            const after = await handle.stat(); if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) fail();
          } finally { buffer.fill(0); }
        }
        await options.prepared.addFile('workflow-state.sqlite', baseline, stream(), { signal: options.signal }); assert();
        remaining.delete('workflow-state.sqlite'); await added(before.size);
      } finally { await handle.close(); }
    }
    for (const path of remaining) {
      assert(); const before = await privateRestoreTargetHash(join(directory, path)); assert(); if (before === null) fail();
      await options.prepared.addRemoval(path, before); assert();
    }
    const final = options.source.validate(); if (final.digest !== source.digest || final.entries !== source.entries) fail();
    assert(); const sealed = await options.prepared.seal({ signal: options.signal }); assert(); return sealed;
  } finally {
    key.fill(0);
    if (scratch && scratchIdentity) await removeBuild(scratch, scratchIdentity);
  }
}


### server/private-backup-transfer.ts
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { encryptJson, decryptJson, isEncryptedEnvelope } from './desk-crypto.ts';
import { windowsFilePrivacy } from './windows-file-privacy.ts';
import { fsyncDir } from './atomic.ts';

export const BACKUP_TRANSFER_CHUNK_BYTES = 1024 * 1024;
export const BACKUP_TRANSFER_MAX_BYTES = 1024 * 1024 * 1024;
export const BACKUP_TRANSFER_JOURNAL_BYTES = 64 * 1024 * 1024;
export function backupTransferStorageBudget(archiveBytes: number) {
  if (!Number.isSafeInteger(archiveBytes) || archiveBytes < 1 || archiveBytes > BACKUP_TRANSFER_MAX_BYTES) throw Object.assign(new Error('Invalid backup size.'), { status: 400 });
  const rollbackBytes = BACKUP_TRANSFER_JOURNAL_BYTES / 4096 * (4096 + 8) + 2 * 65_536;
  return { databaseBytes: BACKUP_TRANSFER_JOURNAL_BYTES, rollbackBytes, totalBytes: archiveBytes + BACKUP_TRANSFER_JOURNAL_BYTES + rollbackBytes };
}
export const BACKUP_TRANSFER_CANCEL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ACTIVE = 4;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
function fail(message: string, status = 409): never { throw Object.assign(new Error(message), { status }); }
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && Number(v) >= min;
interface Chunk { offset: number; size: number; digest: string }
export interface BackupUploadStatus {
  id: string; size: number; offset: number; state: 'uploading' | 'uploaded' | 'staged' | 'cancelled';
  createdAt: number; updatedAt: number; digest: string | null; manifestDigest: string | null;
  /** Commitment to the exact durably accepted prefix, for reselected files. */
  prefixDigest: string;
}
interface Upload extends Omit<BackupUploadStatus, 'prefixDigest'> { version: 1; workspaceId: string; pending: Chunk | null }
type FaultPoint = 'intent-saved' | 'data-written' | 'data-synced' | 'recovery-before-sync' | 'receipt-saved' | 'cancel-saved';
export interface BackupTransferOptions {
  /** An installation-owned directory, never a browser-provided path. */
  directory: string; key: Buffer; workspaceId: string;
  now?: () => number;
  /** Test-only interruption hook. No serialized value can configure it. */
  fault?: (point: FaultPoint, id: string) => void;
}

async function safeParents(path: string): Promise<void> {
  const absolute = resolve(path), root = parse(absolute).root; let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    try { const s = await lstat(current); if (!s.isDirectory() || s.isSymbolicLink()) fail('Backup transfer storage needs recovery.', 503); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
async function privateFolder(path: string): Promise<void> {
  await safeParents(path);
  const created = await mkdir(path, { recursive: true, mode: 0o700 }), s = await lstat(path);
  if (!s.isDirectory() || s.isSymbolicLink() || process.platform !== 'win32' && ((s.mode & 0o077) || s.uid !== process.getuid?.())) fail('Backup transfer storage is not private.', 503);
  await windowsFilePrivacy(path, 'directory', created !== undefined);
}
async function checkedFile(path: string, absent = false) {
  await safeParents(dirname(path));
  try {
    const s = await lstat(path);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || process.platform !== 'win32' && ((s.mode & 0o077) || s.uid !== process.getuid?.())) fail('Backup transfer file needs recovery.', 503);
    await windowsFilePrivacy(path, 'file'); return s;
  } catch (error) { if (absent && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function checkedHandle(path: string, flags: number) {
  const before = await checkedFile(path);
  const handle = await open(path, flags | (constants.O_NOFOLLOW ?? 0));
  try {
    const after = await handle.stat();
    if (!before || before.ino !== after.ino || before.dev !== after.dev || after.nlink !== 1) fail('Backup transfer changed while opening.', 503);
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
function validChunk(value: unknown): value is Chunk {
  return object(value) && Object.keys(value).length === 3 && integer(value.offset) && value.offset % BACKUP_TRANSFER_CHUNK_BYTES === 0 &&
    integer(value.size, 1) && value.size <= BACKUP_TRANSFER_CHUNK_BYTES && typeof value.digest === 'string' && HASH.test(value.digest);
}
function validUpload(value: unknown, workspaceId: string, id: string): value is Upload {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'createdAt,digest,id,manifestDigest,offset,pending,size,state,updatedAt,version,workspaceId' || value.version !== 1 || value.id !== id || value.workspaceId !== workspaceId ||
      !integer(value.size, 1) || value.size > BACKUP_TRANSFER_MAX_BYTES || !integer(value.offset) || value.offset > value.size ||
      !integer(value.createdAt, 1) || !integer(value.updatedAt, 1) || value.updatedAt < value.createdAt ||
      typeof value.state !== 'string' || !['uploading', 'uploaded', 'staged', 'cancelled'].includes(value.state)) return false;
  if (value.offset !== value.size && value.offset % BACKUP_TRANSFER_CHUNK_BYTES !== 0) return false;
  if (value.pending !== null && (!validChunk(value.pending) || value.pending.offset !== value.offset || value.pending.size !== Math.min(BACKUP_TRANSFER_CHUNK_BYTES, value.size - value.offset) || value.state !== 'uploading')) return false;
  const completed = value.state === 'uploaded' || value.state === 'staged';
  return completed ? value.offset === value.size && value.pending === null && typeof value.digest === 'string' && HASH.test(value.digest) && typeof value.manifestDigest === 'string' && HASH.test(value.manifestDigest)
    : value.digest === null && value.manifestDigest === null;
}
/** Fixed-size ciphertext transport only. Uploaded data remains untrusted until
 * the codec and complete business graph validate. A live process owns writes;
 * confirmed process exit, not a timeout, permits restart recovery. */
export async function createBackupTransferStore(options: BackupTransferOptions) {
  if (options.key.length !== 32 || !UUID.test(options.workspaceId)) fail('Invalid backup transfer installation.', 400);
  const directory = resolve(options.directory), now = options.now ?? Date.now;
  const nonce = randomUUID(), pid = process.pid;
  await privateFolder(directory);
  const journal = join(directory, 'transfers.sqlite');
  const existing = await checkedFile(journal, true);
  if (existing && existing.size > BACKUP_TRANSFER_JOURNAL_BYTES) fail('Backup transfer journal needs size recovery. Existing copies were preserved.', 503);
  if (!existing) { const file = await open(journal, 'wx', 0o600); try { await windowsFilePrivacy(journal, 'file', true); await file.sync(); } finally { await file.close(); } fsyncDir(directory); }
  const key = Buffer.from(options.key);
  let db: DatabaseSync;
  try { db = new DatabaseSync(journal); } catch (error) { key.fill(0); throw error; }
  let closed = false, closing = false, queued = 0, tail: Promise<unknown> = Promise.resolve();
  const transact = <T>(fn: () => T): T => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (error) { try { db.exec('ROLLBACK'); } catch { /* SQLITE_FULL may already have rolled back. */ } throw error; } };
  const encode = (value: unknown) => JSON.stringify(encryptJson(key, value));
  const decode = (payload: unknown): unknown => { try { const v = JSON.parse(String(payload)); if (!isEncryptedEnvelope(v)) throw new Error(); return decryptJson(key, v); } catch { return fail('Backup transfer journal needs recovery.', 503); } };
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1500; PRAGMA temp_store=MEMORY; PRAGMA cache_spill=OFF;');
    if (db.prepare('PRAGMA journal_mode=DELETE').get()?.journal_mode !== 'delete' || db.prepare('PRAGMA cache_spill').get()?.cache_spill !== 0) fail('Backup transfer storage policy needs recovery.', 503);
    const schema = db.prepare("SELECT type,name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").all();
    if (existing && schema.some(row => row.type !== 'table' || !['owner', 'operations', 'chunks'].includes(String(row.name)))) fail('Backup transfer schema needs recovery.', 503);
    if (existing && Number(db.prepare('PRAGMA user_version').get()?.user_version) !== 1) fail('Backup transfer version needs recovery.', 503);
    if (!existing) db.exec('CREATE TABLE owner (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL); CREATE TABLE operations (id TEXT PRIMARY KEY, payload TEXT NOT NULL); CREATE TABLE chunks (id TEXT NOT NULL, offset INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id,offset)); PRAGMA user_version=1;');
    const pageBytes = Number(db.prepare('PRAGMA page_size').get()?.page_size);
    if (pageBytes !== 4096) fail('Backup transfer page size needs recovery.', 503);
    if (db.prepare(`PRAGMA max_page_count=${BACKUP_TRANSFER_JOURNAL_BYTES / pageBytes}`).get()?.max_page_count !== BACKUP_TRANSFER_JOURNAL_BYTES / pageBytes) fail('Backup transfer storage reached its capacity.', 413);
    transact(() => {
      const previous = db.prepare('SELECT payload FROM owner WHERE id=1').get();
      if (previous) {
        const owner = decode(previous.payload);
        if (!object(owner) || Object.keys(owner).sort().join(',') !== 'nonce,pid,workspaceId' || owner.workspaceId !== options.workspaceId || !integer(owner.pid, 1) || typeof owner.nonce !== 'string' || !UUID.test(owner.nonce)) fail('Backup transfer ownership needs recovery.', 503);
        try { process.kill(owner.pid, 0); fail('Another running service owns these backup transfers.'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      db.prepare('INSERT OR REPLACE INTO owner VALUES(1,?)').run(encode({ pid, nonce, workspaceId: options.workspaceId }));
    });
  } catch (error) { db.close(); key.fill(0); throw error; }
  const assertOwner = () => {
    if (closed) fail('Backup transfers are closed.');
    const row = db.prepare('SELECT payload FROM owner WHERE id=1').get(), owner = row && decode(row.payload);
    if (!object(owner) || owner.pid !== pid || owner.nonce !== nonce || owner.workspaceId !== options.workspaceId) fail('Backup transfer ownership changed.', 503);
  };
  const run = <T>(work: () => Promise<T>): Promise<T> => {
    if (closing || closed || queued >= 8) return Promise.reject(Object.assign(new Error('Backup transfer is busy or closing. Check its saved status before retrying.'), { status: 409 }));
    queued++;
    const task = tail.then(async () => { assertOwner(); return work(); }).finally(() => { queued--; }); tail = task.catch(() => {}); return task;
  };
  const read = (id: string): Upload => {
    if (typeof id !== 'string' || !UUID.test(id)) fail('Invalid backup transfer.', 400);
    const row = db.prepare('SELECT payload FROM operations WHERE id=?').get(id);
    if (!row) fail('This backup transfer was not found.', 404);
    const value = decode(row.payload); if (!validUpload(value, options.workspaceId, id)) fail('Backup transfer receipt needs recovery.', 503); return value;
  };
  const save = (value: Upload) => {
    if (!validUpload(value, options.workspaceId, value.id)) fail('Backup transfer transition needs recovery.', 503);
    assertOwner(); db.prepare('INSERT OR REPLACE INTO operations VALUES(?,?)').run(value.id, encode(value));
  };
  const publicStatus = ({ version: _version, workspaceId: _workspace, pending: _pending, ...status }: Upload): BackupUploadStatus => {
    const manifest: [number, number, string][] = [];
    for (let offset = 0; offset < status.offset; offset += BACKUP_TRANSFER_CHUNK_BYTES) {
      const chunk = readChunk(status.id, offset);
      if (!chunk || chunk.size !== Math.min(BACKUP_TRANSFER_CHUNK_BYTES, status.size - offset)) fail('The saved upload prefix needs recovery.', 503);
      manifest.push([chunk.offset, chunk.size, chunk.digest]);
    }
    return { ...status, prefixDigest: hash(JSON.stringify(manifest)) };
  };
  const artifactPath = (id: string) => join(directory, `${id}.ciphertext`);
  const readChunk = (id: string, offset: number): Chunk | null => {
    const row = db.prepare('SELECT payload FROM chunks WHERE id=? AND offset=?').get(id, offset); if (!row) return null;
    const value = decode(row.payload);
    if (!object(value) || value.id !== id || !validChunk(value.chunk) || value.chunk.offset !== offset || Object.keys(value).length !== 2) fail('Backup chunk receipt needs recovery.', 503);
    return value.chunk;
  };
  const commitChunk = (upload: Upload, chunk: Chunk) => transact(() => {
    db.prepare('INSERT INTO chunks VALUES(?,?,?)').run(upload.id, chunk.offset, encode({ id: upload.id, chunk }));
    upload.offset += chunk.size; upload.pending = null; upload.updatedAt = Math.max(now(), upload.createdAt); save(upload);
  });
  async function reconcile(upload: Upload): Promise<Upload> {
    if (upload.state === 'cancelled') { if (await checkedFile(artifactPath(upload.id), true)) { await unlink(artifactPath(upload.id)); fsyncDir(directory); } return upload; }
    const stat = await checkedFile(artifactPath(upload.id), true);
    // Admission writes its receipt before exclusive file creation. A missing
    // zero-length upload can be recreated; partial/missing data cannot.
    if (!stat && upload.offset === 0 && !upload.pending && upload.state === 'uploading') {
      const handle = await open(artifactPath(upload.id), 'wx', 0o600); try { await windowsFilePrivacy(artifactPath(upload.id), 'file', true); await handle.sync(); } finally { await handle.close(); } fsyncDir(directory); return upload;
    }
    if (!stat) fail('Backup transfer data is missing. Keep the original backup and contact support.', 503);
    if (!upload.pending) { if (stat.size !== upload.offset) fail('Backup transfer data changed unexpectedly.', 503); return upload; }
    const pending = upload.pending;
    if (stat.size === upload.offset) { upload.pending = null; save(upload); return upload; }
    if (stat.size !== upload.offset + pending.size) fail('An interrupted backup chunk needs recovery. The original backup is unchanged.', 503);
    const handle = await checkedHandle(artifactPath(upload.id), constants.O_RDWR);
    try {
      const data = Buffer.alloc(pending.size); const result = await handle.read(data, 0, data.length, pending.offset);
      if (result.bytesRead !== data.length || hash(data) !== pending.digest) fail('An interrupted backup chunk failed its integrity check.', 503);
      // A previous full write may have died before fsync. Bytes visible in the
      // page cache are not a durable receipt until recovery syncs them too.
      options.fault?.('recovery-before-sync', upload.id); await handle.sync();
    }
    finally { await handle.close(); }
    commitChunk(upload, pending); return upload;
  }
  async function append(id: string, offset: number, data: Uint8Array, digest: string): Promise<BackupUploadStatus> {
    if (!(data instanceof Uint8Array) || !integer(offset) || !HASH.test(digest) || data.length < 1 || data.length > BACKUP_TRANSFER_CHUNK_BYTES || hash(data) !== digest) fail('The backup chunk is invalid.', 400);
    const upload = await reconcile(read(id));
    if (upload.state !== 'uploading') fail('This transfer no longer accepts upload chunks.');
    const chunk = { offset, size: data.length, digest }, prior = readChunk(id, offset);
    if (prior) { if (prior.size !== chunk.size || prior.digest !== chunk.digest) fail('This chunk differs from its saved receipt.'); return publicStatus(upload); }
    if (offset !== upload.offset || data.length !== Math.min(BACKUP_TRANSFER_CHUNK_BYTES, upload.size - upload.offset)) fail('Resume from the saved upload position with the original file.');
    upload.pending = chunk; save(upload); options.fault?.('intent-saved', id);
    const handle = await checkedHandle(artifactPath(id), constants.O_RDWR);
    try { let written = 0; while (written < data.length) { const part = await handle.write(data, written, data.length - written, offset + written); if (!part.bytesWritten) fail('Backup storage did not accept the chunk.', 503); written += part.bytesWritten; } options.fault?.('data-written', id); await handle.sync(); }
    finally { await handle.close(); }
    options.fault?.('data-synced', id); commitChunk(upload, chunk); options.fault?.('receipt-saved', id); return publicStatus(upload);
  }
  async function verifyArtifact(upload: Upload): Promise<void> {
    const handle = await checkedHandle(artifactPath(upload.id), constants.O_RDONLY), whole = createHash('sha256');
    try {
      const before = await handle.stat(), buffer = Buffer.alloc(BACKUP_TRANSFER_CHUNK_BYTES);
      for (let offset = 0; offset < upload.size;) {
        const part = await handle.read(buffer, 0, Math.min(buffer.length, upload.size - offset), offset);
        if (!part.bytesRead) fail('The completed backup is truncated.', 503);
        whole.update(buffer.subarray(0, part.bytesRead)); offset += part.bytesRead;
      }
      const after = await handle.stat();
      if (before.size !== upload.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || whole.digest('hex') !== upload.digest) fail('The completed backup bytes changed. Keep the original file and copy it again.', 503);
    } finally { await handle.close(); }
  }
  async function pruneCancelled(): Promise<number> {
    let removed = 0;
    // Only terminal transport receipts expire. Business history and staged or
    // otherwise active copies are never removed by this retention policy.
    for (const row of db.prepare('SELECT id FROM operations').iterate()) {
      const upload = read(String(row.id));
      if (upload.state !== 'cancelled' || now() - upload.updatedAt < BACKUP_TRANSFER_CANCEL_RETENTION_MS) continue;
      await reconcile(upload);
      transact(() => { db.prepare('DELETE FROM chunks WHERE id=?').run(upload.id); db.prepare('DELETE FROM operations WHERE id=?').run(upload.id); }); removed++;
    }
    return removed;
  }
  return {
    start(id: string, size: number) { return run(async () => {
      if (typeof id !== 'string' || !UUID.test(id) || !integer(size, 1) || size > BACKUP_TRANSFER_MAX_BYTES) fail('Choose a non-empty backup up to 1 GiB.', 400);
      if (db.prepare('SELECT id FROM operations WHERE id=?').get(id)) { const current = await reconcile(read(id)); if (current.size !== size || current.state === 'cancelled') fail('This upload identifier is already bound to another request.'); return publicStatus(current); }
      await pruneCancelled();
      let active = 0;
      for (const row of db.prepare('SELECT id FROM operations').iterate()) if (read(String(row.id)).state !== 'cancelled') active++;
      if (active >= MAX_ACTIVE) fail('Finish or remove an earlier backup transfer before starting another.');
      const at = now(), value: Upload = { version: 1, workspaceId: options.workspaceId, id, size, offset: 0, state: 'uploading', createdAt: at, updatedAt: at, digest: null, manifestDigest: null, pending: null };
      save(value); await reconcile(value); return publicStatus(value);
    }); },
    status(id: string) { return run(async () => publicStatus(await reconcile(read(id)))); },
    append(id: string, offset: number, data: Uint8Array, digest: string) {
      // Own the bounded bytes before entering the queue; callers cannot mutate
      // an admitted buffer while a previous operation is completing.
      if (!(data instanceof Uint8Array) || data.length > BACKUP_TRANSFER_CHUNK_BYTES) return Promise.reject(Object.assign(new Error('The backup chunk is too large.'), { status: 413 }));
      if (queued >= 8 || closing || closed) return Promise.reject(Object.assign(new Error('Check the saved transfer status before retrying.'), { status: 409 }));
      const owned = Buffer.from(data); return run(() => append(id, offset, owned, digest));
    },
    seal(id: string, manifestDigest: string) { return run(async () => {
      if (!HASH.test(manifestDigest)) fail('Check the complete upload before finishing.', 400);
      const upload = await reconcile(read(id));
      if (upload.state === 'uploaded' || upload.state === 'staged') { if (upload.manifestDigest !== manifestDigest) fail('The completed upload does not match this file.'); await verifyArtifact(upload); return publicStatus(upload); }
      if (upload.state !== 'uploading' || upload.offset !== upload.size) fail('The upload has not finished.');
      const manifest: [number, number, string][] = [], whole = createHash('sha256');
      const handle = await checkedHandle(artifactPath(id), constants.O_RDONLY);
      try {
        for (let offset = 0; offset < upload.size; offset += BACKUP_TRANSFER_CHUNK_BYTES) {
          const chunk = readChunk(id, offset), size = Math.min(BACKUP_TRANSFER_CHUNK_BYTES, upload.size - offset);
          if (!chunk || chunk.size !== size) fail('The complete upload is missing a chunk receipt.', 503);
          const data = Buffer.alloc(size), read = await handle.read(data, 0, size, offset);
          if (read.bytesRead !== size || hash(data) !== chunk.digest) fail('The uploaded backup failed its chunk check.', 503);
          whole.update(data); manifest.push([offset, size, chunk.digest]);
        }
        if ((await handle.stat()).size !== upload.size || hash(JSON.stringify(manifest)) !== manifestDigest) fail('The complete uploaded backup differs from the selected file.');
      } finally { await handle.close(); }
      upload.state = 'uploaded'; upload.digest = whole.digest('hex'); upload.manifestDigest = manifestDigest; upload.updatedAt = Math.max(now(), upload.createdAt); save(upload); return publicStatus(upload);
    }); },
    /** Internal only: the host must never return this server-generated path. */
    artifact(id: string) { return run(async () => { const upload = await reconcile(read(id)); if (!['uploaded', 'staged'].includes(upload.state)) fail('The backup upload is not complete.'); await verifyArtifact(upload); return { path: artifactPath(id), size: upload.size, digest: upload.digest! }; }); },
    markStaged(id: string, digest: string) { return run(async () => { const upload = await reconcile(read(id)); if (!['uploaded', 'staged'].includes(upload.state) || upload.digest !== digest) fail('The reviewed backup changed.'); await verifyArtifact(upload); upload.state = 'staged'; upload.updatedAt = Math.max(now(), upload.createdAt); save(upload); return publicStatus(upload); }); },
    cancel(id: string) { return run(async () => { const upload = read(id); if (upload.state === 'staged') fail('This backup is staged for restore and must be retained for restart recovery.'); upload.state = 'cancelled'; upload.pending = null; upload.digest = null; upload.manifestDigest = null; upload.updatedAt = Math.max(now(), upload.createdAt); save(upload); options.fault?.('cancel-saved', id); await reconcile(upload); return publicStatus(upload); }); },
    pruneCancelled() { return run(pruneCancelled); },
    async close() {
      closing = true; await tail; if (closed) return;
      try { assertOwner(); transact(() => { db.prepare('DELETE FROM owner WHERE id=1').run(); }); }
      finally { closed = true; db.close(); key.fill(0); }
    },
  };
}


### server/private-backup-v2-api.ts
import {
  PRIVATE_BACKUP_TRANSFER_API,
  PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES,
  PRIVATE_BACKUP_TRANSFER_ERRORS,
  PRIVATE_BACKUP_TRANSFER_MAX_BYTES,
  PRIVATE_BACKUP_TRANSFER_MAX_ITEMS,
  parsePrivateBackupDownloadTicket,
  parsePrivateBackupTransferOperation,
  parsePrivateBackupTransferPage,
  privateBackupTransferDigest,
  privateBackupTransferId,
  type PrivateBackupDownloadTicket,
  type PrivateBackupTransferOperation,
  type PrivateBackupTransferPage,
} from '../shared/private-backup-transfers.ts';

const FIELDS = 'Use the supported private-backup fields.';
const CONFIRM = 'Confirm staging this reviewed backup.';
const INVALID = PRIVATE_BACKUP_TRANSFER_ERRORS['storage-unavailable'];
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;
const CURSOR = /^[A-Za-z0-9_-]{1,512}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;

export interface BackupV2ApiService {
  list(input: { limit: number; cursor?: string }): Promise<PrivateBackupTransferPage>;
  get(id: string): Promise<PrivateBackupTransferOperation>;
  startExport(id: string, passphrase: string): Promise<PrivateBackupTransferOperation>;
  startUpload(id: string, totalBytes: number): Promise<PrivateBackupTransferOperation>;
  appendUpload(id: string, offset: number, bytes: Uint8Array, sha256: string): Promise<PrivateBackupTransferOperation>;
  sealUpload(id: string, totalBytes: number, chunkCommitment: string): Promise<PrivateBackupTransferOperation>;
  preview(id: string, passphrase: string, expectedArchiveDigest: string): Promise<PrivateBackupTransferOperation>;
  stage(id: string, expectedArchiveDigest: string): Promise<PrivateBackupTransferOperation>;
  cancel(id: string): Promise<PrivateBackupTransferOperation>;
  downloadTicket(id: string, expectedArchiveDigest: string): Promise<PrivateBackupDownloadTicket>;
}

type V2Request = {
  path: string;
  method: string;
  query?: URLSearchParams;
  body?: unknown;
  bytes?: Uint8Array;
  chunkDigest?: unknown;
};

type V2Result = { status: number; body: unknown } | { status: 200; downloadTicket: string };

type Route =
  | { name: 'operations' }
  | { name: 'exports' }
  | { name: 'uploads' }
  | { name: 'operation'; id: string }
  | { name: 'download-ticket'; id: string }
  | { name: 'cancel'; id: string }
  | { name: 'chunks'; id: string }
  | { name: 'seal'; id: string }
  | { name: 'preview'; id: string }
  | { name: 'stage'; id: string }
  | { name: 'download'; token: string };

const fail = (message: string, status = 400): never => {
  throw Object.assign(new Error(message), { status });
};

function unknown(): { status: number; body: unknown } {
  return { status: 404, body: { error: 'Unknown private-backup action.' } };
}

function fields(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail(FIELDS);
  const value = body as Record<string, unknown>;
  if (Object.keys(value).length !== allowed.length || allowed.some((key) => !Object.hasOwn(value, key))) fail(FIELDS);
  return value;
}

function emptyBody(body: unknown): void {
  if (body === undefined) return;
  fields(body, []);
}

function readQuery(query: URLSearchParams | undefined, allowed: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (query === undefined) return out;
  if (!(query instanceof URLSearchParams)) fail(FIELDS);
  for (const name of new Set(query.keys())) {
    if (!allowed.includes(name)) fail(FIELDS);
    const all = query.getAll(name);
    if (all.length !== 1) fail(FIELDS);
    out.set(name, all[0]!);
  }
  return out;
}

function noQuery(query: URLSearchParams | undefined): void {
  if (readQuery(query, []).size) fail(FIELDS);
}

function decimal(value: string, min: number, max: number): number {
  if (!DECIMAL.test(value)) fail(FIELDS);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max) fail(FIELDS);
  return n;
}

function needId(value: unknown): string {
  if (!privateBackupTransferId(value)) fail(FIELDS);
  return value;
}

function needDigest(value: unknown): string {
  if (!privateBackupTransferDigest(value)) fail(FIELDS);
  return value;
}

function needPassphrase(value: unknown): string {
  if (typeof value !== 'string' || value.length < 16 || value.length > 256) fail(FIELDS);
  return value;
}

function needTotalBytes(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > PRIVATE_BACKUP_TRANSFER_MAX_BYTES) fail(FIELDS);
  return value as number;
}

function needOffset(value: string | undefined): number {
  if (value === undefined || !DECIMAL.test(value)) fail(FIELDS);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0 || n % PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES !== 0) fail(FIELDS);
  return n;
}

function needBytes(bytes: Uint8Array | undefined): Uint8Array {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES) {
    fail(FIELDS);
  }
  return bytes;
}

function needOp(raw: unknown, expect: { id: string; kind?: 'export' | 'upload' }): PrivateBackupTransferOperation {
  const operation = parsePrivateBackupTransferOperation(raw);
  if (!operation || operation.id !== expect.id || (expect.kind !== undefined && operation.kind !== expect.kind)) {
    fail(INVALID, 500);
  }
  return operation;
}

function needPage(raw: unknown): PrivateBackupTransferPage {
  const page = parsePrivateBackupTransferPage(raw);
  if (!page) fail(INVALID, 500);
  return page;
}

function needTicket(raw: unknown): PrivateBackupDownloadTicket {
  const ticket = parsePrivateBackupDownloadTicket(raw);
  if (!ticket) fail(INVALID, 500);
  return ticket;
}

function wrapped(status: number, operation: PrivateBackupTransferOperation): { status: number; body: unknown } {
  return { status, body: { operation } };
}

function route(rest: string): Route | null {
  const parts = rest.split('/');
  if (parts.length === 1 && parts[0] === 'operations') return { name: 'operations' };
  if (parts.length === 1 && parts[0] === 'exports') return { name: 'exports' };
  if (parts.length === 1 && parts[0] === 'uploads') return { name: 'uploads' };
  if (parts.length === 2 && parts[0] === 'operations' && privateBackupTransferId(parts[1])) {
    return { name: 'operation', id: parts[1] };
  }
  if (parts.length === 2 && parts[0] === 'downloads' && TOKEN.test(parts[1]!)) {
    return { name: 'download', token: parts[1]! };
  }
  if (parts.length === 3 && privateBackupTransferId(parts[1])) {
    const id = parts[1]!;
    if (parts[0] === 'operations' && parts[2] === 'download-ticket') return { name: 'download-ticket', id };
    if (parts[0] === 'operations' && parts[2] === 'cancel') return { name: 'cancel', id };
    if (parts[0] === 'uploads' && parts[2] === 'chunks') return { name: 'chunks', id };
    if (parts[0] === 'uploads' && parts[2] === 'seal') return { name: 'seal', id };
    if (parts[0] === 'uploads' && parts[2] === 'preview') return { name: 'preview', id };
    if (parts[0] === 'uploads' && parts[2] === 'stage') return { name: 'stage', id };
  }
  return null;
}

/** Session protection is supplied by the HTTP host and must apply before this
 * function. Request path and query cannot choose disk directories, keys, or
 * workspaces. Caller limits raw request reads before allocating body. Download
 * token consumption and streaming are host/coordinator-owned. */
export function createPrivateBackupV2Api(host: { service: () => BackupV2ApiService }) {
  return async (request: V2Request): Promise<V2Result | null> => {
    const { path, method, query, body, bytes, chunkDigest } = request;
    if (path !== PRIVATE_BACKUP_TRANSFER_API && !path.startsWith(`${PRIVATE_BACKUP_TRANSFER_API}/`)) return null;

    const matched = route(path === PRIVATE_BACKUP_TRANSFER_API ? '' : path.slice(PRIVATE_BACKUP_TRANSFER_API.length + 1));
    if (!matched) return unknown();

    if (matched.name === 'operations' && method === 'GET') {
      const found = readQuery(query, ['limit', 'cursor']);
      const limit = found.has('limit')
        ? decimal(found.get('limit')!, 1, PRIVATE_BACKUP_TRANSFER_MAX_ITEMS)
        : PRIVATE_BACKUP_TRANSFER_MAX_ITEMS;
      const cursor = found.get('cursor');
      if (cursor !== undefined && !CURSOR.test(cursor)) fail(FIELDS);
      return { status: 200, body: needPage(await host.service().list(cursor === undefined ? { limit } : { limit, cursor })) };
    }

    if (matched.name === 'exports' && method === 'POST') {
      noQuery(query);
      const found = fields(body, ['id', 'passphrase']);
      const id = needId(found.id);
      return wrapped(202, needOp(await host.service().startExport(id, needPassphrase(found.passphrase)), { id, kind: 'export' }));
    }

    if (matched.name === 'uploads' && method === 'POST') {
      noQuery(query);
      const found = fields(body, ['id', 'totalBytes']);
      const id = needId(found.id);
      return wrapped(201, needOp(await host.service().startUpload(id, needTotalBytes(found.totalBytes)), { id, kind: 'upload' }));
    }

    if (matched.name === 'operation' && method === 'GET') {
      noQuery(query);
      return wrapped(200, needOp(await host.service().get(matched.id), { id: matched.id }));
    }

    if (matched.name === 'download-ticket' && method === 'POST') {
      noQuery(query);
      const found = fields(body, ['expectedArchiveDigest']);
      return { status: 200, body: needTicket(await host.service().downloadTicket(matched.id, needDigest(found.expectedArchiveDigest))) };
    }

    if (matched.name === 'cancel' && method === 'POST') {
      noQuery(query);
      emptyBody(body);
      return wrapped(200, needOp(await host.service().cancel(matched.id), { id: matched.id }));
    }

    if (matched.name === 'chunks' && method === 'PUT') {
      const offset = needOffset(readQuery(query, ['offset']).get('offset'));
      if (body !== undefined) fail(FIELDS);
      const chunk = needBytes(bytes);
      return wrapped(
        200,
        needOp(await host.service().appendUpload(matched.id, offset, chunk, needDigest(chunkDigest)), {
          id: matched.id,
          kind: 'upload',
        }),
      );
    }

    if (matched.name === 'seal' && method === 'POST') {
      noQuery(query);
      const found = fields(body, ['totalBytes', 'chunkCommitment']);
      return wrapped(
        200,
        needOp(await host.service().sealUpload(matched.id, needTotalBytes(found.totalBytes), needDigest(found.chunkCommitment)), {
          id: matched.id,
          kind: 'upload',
        }),
      );
    }

    if (matched.name === 'preview' && method === 'POST') {
      noQuery(query);
      const found = fields(body, ['passphrase', 'expectedArchiveDigest']);
      return wrapped(
        202,
        needOp(await host.service().preview(matched.id, needPassphrase(found.passphrase), needDigest(found.expectedArchiveDigest)), {
          id: matched.id,
          kind: 'upload',
        }),
      );
    }

    if (matched.name === 'stage' && method === 'POST') {
      noQuery(query);
      if (!body || typeof body !== 'object' || Array.isArray(body)) fail(FIELDS);
      const found = body as Record<string, unknown>;
      if (Object.keys(found).some((key) => key !== 'expectedArchiveDigest' && key !== 'confirm')) fail(FIELDS);
      if (found.confirm !== true) fail(CONFIRM);
      return wrapped(202, needOp(await host.service().stage(matched.id, needDigest(found.expectedArchiveDigest)), {
        id: matched.id,
        kind: 'upload',
      }));
    }

    if (matched.name === 'download' && method === 'GET') {
      noQuery(query);
      return { status: 200, downloadTicket: matched.token };
    }

    return unknown();
  };
}


### shared/private-backup-transfers.ts
import { parsePrivateBackupReceipt, type PrivateBackupReceipt } from './private-workspace-backup.ts';

/** Public transport projections only. Never include scratch paths, keys,
 * passphrases, raw exceptions, or uploaded business values here. */
export const PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES = 1024 * 1024;
export const PRIVATE_BACKUP_TRANSFER_MAX_BYTES = 1024 * 1024 * 1024;
export const PRIVATE_BACKUP_TRANSFER_MAX_ITEMS = 20;
export const PRIVATE_BACKUP_TRANSFER_API = '/api/private-backup/v2';
export const PRIVATE_BACKUP_TRANSFER_PHASES = [
  'capturing', 'sealing', 'ready', 'uploading', 'uploaded', 'checking', 'reviewed',
  'staging', 'staged', 'applying', 'completed', 'interrupted', 'failed', 'cancelled', 'expired',
] as const;
export type PrivateBackupTransferPhase = typeof PRIVATE_BACKUP_TRANSFER_PHASES[number];
export const PRIVATE_BACKUP_TRANSFER_ERRORS = {
  interrupted: 'This backup operation was interrupted. Check its saved progress before continuing.',
  'invalid-backup': 'This file could not be verified as a complete supported backup. Keep the original file.',
  'incorrect-passphrase': 'The backup could not be opened with that passphrase. Check it and try again.',
  'storage-unavailable': 'Backup storage is unavailable. Keep the original file and check this computer.',
  'insufficient-space': 'This computer needs more free space before the backup can continue.',
  'workspace-busy': 'Finish the current work before continuing this backup operation.',
  'restore-unavailable': 'This workspace is not ready to restore this backup.',
  'recovery-required': 'This backup operation needs recovery. Keep its files and contact support.',
  expired: 'This saved transfer has expired. Keep the original backup file.',
} as const;
export type PrivateBackupTransferErrorCode = keyof typeof PRIVATE_BACKUP_TRANSFER_ERRORS;
export interface PrivateBackupTransferArtifact { archiveBytes: number; archiveDigest: string }
export interface PrivateBackupTransferOperation {
  version: 2; id: string; workspaceId: string; kind: 'export' | 'upload';
  phase: PrivateBackupTransferPhase; createdAt: number; updatedAt: number; expiresAt: number | null;
  progress: { completedBytes: number; totalBytes: number | null };
  canCancel: boolean; requiresPassphrase: boolean;
  /** Required for upload operations, including interrupted/closed ones. */
  receivedBytes?: number; prefixCommitment?: string;
  artifact?: PrivateBackupTransferArtifact;
  /** Published only after complete authentication AND business graph validation. */
  preview?: PrivateBackupReceipt;
  error?: { code: PrivateBackupTransferErrorCode };
}
export interface PrivateBackupTransferPage {
  version: 2; workspaceId: string;
  limits: { archiveBytes: number; chunkBytes: typeof PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES };
  items: PrivateBackupTransferOperation[]; total: number; nextCursor: string | null;
}
export interface PrivateBackupDownloadTicket extends PrivateBackupTransferArtifact {
  url: string; filename: string; expiresAt: number;
}
/** SHA-256 of UTF-8 JSON.stringify(tuples), in this exact order, with lowercase
 * digests. At most 1024 tuples; this is NOT the whole-file archive digest. */
export type PrivateBackupChunkTuple = [offset: number, size: number, sha256: string];

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
const integer = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && Number(v) >= min;
export const privateBackupTransferId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
export const privateBackupTransferDigest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function artifact(v: unknown): PrivateBackupTransferArtifact | null {
  return object(v) && keys(v, ['archiveBytes', 'archiveDigest']) && integer(v.archiveBytes, 1) && v.archiveBytes <= PRIVATE_BACKUP_TRANSFER_MAX_BYTES && privateBackupTransferDigest(v.archiveDigest)
    ? { archiveBytes: v.archiveBytes, archiveDigest: v.archiveDigest } : null;
}
function receipt(v: unknown): PrivateBackupReceipt | null {
  if (!object(v) || !keys(v, ['digest', 'createdAt', 'workspaceId', 'fileCount', 'recordCount', 'plainBytes', 'included', 'excluded', 'restoreChanges'])) return null;
  const parsed = parsePrivateBackupReceipt(v);
  if (!parsed || parsed.createdAt.length > 40) return null;
  // Human-readable category labels, not filenames, evidence bodies, or errors.
  if ([parsed.included, parsed.excluded, parsed.restoreChanges].some(list => list.length > 20 || list.some(s => !s.trim() || new TextEncoder().encode(s).length > 300 || /[\u0000-\u001f\u007f]/.test(s)))) return null;
  return parsed;
}
export function parsePrivateBackupTransferOperation(v: unknown): PrivateBackupTransferOperation | null {
  if (!object(v) || !keys(v, ['version', 'id', 'workspaceId', 'kind', 'phase', 'createdAt', 'updatedAt', 'expiresAt', 'progress', 'canCancel', 'requiresPassphrase'], ['receivedBytes', 'prefixCommitment', 'artifact', 'preview', 'error']) ||
      v.version !== 2 || !privateBackupTransferId(v.id) || !privateBackupTransferId(v.workspaceId) || typeof v.kind !== 'string' || !['export', 'upload'].includes(v.kind) ||
      !PRIVATE_BACKUP_TRANSFER_PHASES.includes(v.phase as PrivateBackupTransferPhase) || !integer(v.createdAt, 1) || !integer(v.updatedAt, v.createdAt) ||
      !(v.expiresAt === null || integer(v.expiresAt, v.createdAt)) || typeof v.canCancel !== 'boolean' || typeof v.requiresPassphrase !== 'boolean' ||
      !object(v.progress) || !keys(v.progress, ['completedBytes', 'totalBytes']) || !integer(v.progress.completedBytes) ||
      !(v.progress.totalBytes === null || integer(v.progress.totalBytes, v.progress.completedBytes))) return null;
  const phase = v.phase as PrivateBackupTransferPhase;
  if (['staging', 'staged', 'applying', 'completed', 'cancelled', 'expired'].includes(phase) && v.canCancel) return null;
  if (v.requiresPassphrase && !['interrupted', 'failed', 'uploaded'].includes(phase)) return null;
  if (v.kind === 'upload') {
    const size = v.progress.totalBytes;
    if (!integer(size, 1) || size > PRIVATE_BACKUP_TRANSFER_MAX_BYTES || !integer(v.receivedBytes) || v.receivedBytes > size ||
        v.receivedBytes !== size && v.receivedBytes % PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES !== 0 || !privateBackupTransferDigest(v.prefixCommitment) ||
        ['capturing', 'ready'].includes(phase)) return null;
    if (['uploaded', 'checking', 'reviewed', 'staging', 'staged', 'applying', 'completed'].includes(phase) && v.receivedBytes !== size) return null;
    if (v.requiresPassphrase && v.receivedBytes !== size) return null;
  } else if (Object.hasOwn(v, 'receivedBytes') || Object.hasOwn(v, 'prefixCommitment') || ['uploading', 'uploaded', 'checking', 'reviewed', 'staging', 'staged', 'applying'].includes(phase)) return null;
  const parsedArtifact = v.artifact === undefined ? undefined : artifact(v.artifact);
  if (parsedArtifact === null || parsedArtifact && v.kind === 'upload' && parsedArtifact.archiveBytes !== v.progress.totalBytes) return null;
  if (parsedArtifact && ['capturing', 'uploading', 'cancelled', 'expired'].includes(phase)) return null;
  if (['ready', 'uploaded', 'checking', 'reviewed', 'staging', 'staged', 'applying', 'completed'].includes(phase) && !parsedArtifact) return null;
  const parsedPreview = v.preview === undefined ? undefined : receipt(v.preview);
  if (parsedPreview === null || parsedPreview && (!parsedArtifact || !['ready', 'reviewed', 'staging', 'staged', 'applying', 'completed'].includes(phase))) return null;
  if (parsedPreview && parsedPreview.digest !== parsedArtifact?.archiveDigest) return null;
  if (['reviewed', 'staging', 'staged', 'applying'].includes(phase) && !parsedPreview) return null;
  if (v.error !== undefined && (!object(v.error) || !keys(v.error, ['code']) || typeof v.error.code !== 'string' || !Object.hasOwn(PRIVATE_BACKUP_TRANSFER_ERRORS, v.error.code))) return null;
  return {
    version: 2, id: v.id, workspaceId: v.workspaceId, kind: v.kind as 'export' | 'upload', phase,
    createdAt: v.createdAt, updatedAt: v.updatedAt, expiresAt: v.expiresAt as number | null,
    progress: { completedBytes: v.progress.completedBytes, totalBytes: v.progress.totalBytes as number | null },
    canCancel: v.canCancel, requiresPassphrase: v.requiresPassphrase,
    ...(v.kind === 'upload' ? { receivedBytes: v.receivedBytes as number, prefixCommitment: v.prefixCommitment as string } : {}),
    ...(parsedArtifact ? { artifact: parsedArtifact } : {}), ...(parsedPreview ? { preview: parsedPreview } : {}),
    ...(v.error ? { error: { code: (v.error as { code: PrivateBackupTransferErrorCode }).code } } : {}),
  };
}
export function parsePrivateBackupTransferResponse(v: unknown): PrivateBackupTransferOperation | null {
  return object(v) && keys(v, ['operation']) ? parsePrivateBackupTransferOperation(v.operation) : null;
}
export function parsePrivateBackupTransferPage(v: unknown): PrivateBackupTransferPage | null {
  if (!object(v) || !keys(v, ['version', 'workspaceId', 'limits', 'items', 'total', 'nextCursor']) || v.version !== 2 || !privateBackupTransferId(v.workspaceId) ||
      !object(v.limits) || !keys(v.limits, ['archiveBytes', 'chunkBytes']) || !integer(v.limits.archiveBytes, 1) || v.limits.archiveBytes > PRIVATE_BACKUP_TRANSFER_MAX_BYTES || v.limits.chunkBytes !== PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES ||
      !Array.isArray(v.items) || v.items.length > PRIVATE_BACKUP_TRANSFER_MAX_ITEMS || !integer(v.total, v.items.length) ||
      !(v.nextCursor === null || typeof v.nextCursor === 'string' && /^[a-zA-Z0-9_-]{1,512}$/.test(v.nextCursor))) return null;
  const items = v.items.map(parsePrivateBackupTransferOperation);
  if (items.some(item => !item || item.workspaceId !== v.workspaceId) || new Set(items.map(item => item?.id)).size !== items.length) return null;
  return { version: 2, workspaceId: v.workspaceId, limits: { archiveBytes: v.limits.archiveBytes, chunkBytes: PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES }, items: items as PrivateBackupTransferOperation[], total: v.total, nextCursor: v.nextCursor as string | null };
}
export function parsePrivateBackupDownloadTicket(v: unknown): PrivateBackupDownloadTicket | null {
  if (!object(v) || !keys(v, ['url', 'filename', 'expiresAt', 'archiveBytes', 'archiveDigest']) || typeof v.url !== 'string' ||
      !/^\/api\/private-backup\/v2\/downloads\/[A-Za-z0-9_-]{32,128}$/.test(v.url) || typeof v.filename !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}\.realbud-backup$/.test(v.filename) || !integer(v.expiresAt, 1)) return null;
  const a = artifact({ archiveBytes: v.archiveBytes, archiveDigest: v.archiveDigest });
  return a ? { ...a, url: v.url, filename: v.filename, expiresAt: v.expiresAt } : null;
}
