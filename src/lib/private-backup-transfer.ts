import {
  PRIVATE_BACKUP_TRANSFER_API as API, PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES as CHUNK,
  PRIVATE_BACKUP_TRANSFER_MAX_BYTES as MAX_BYTES, PRIVATE_BACKUP_TRANSFER_MAX_ITEMS,
  parsePrivateBackupTransferResponse, parsePrivateBackupTransferPage, parsePrivateBackupDownloadTicket,
  parsePrivateBackupTransferOperation, privateBackupTransferDigest, privateBackupTransferId,
  type PrivateBackupTransferOperation as Operation, type PrivateBackupChunkTuple,
  type PrivateBackupDownloadTicket,
} from '@shared/private-backup-transfers';
import { localSessionFetch } from './local-session';
import { validBackupPassphrase } from './private-backup';

export interface PrivateBackupTransferRequest {
  method: 'GET' | 'POST' | 'PUT'; body?: unknown; bytes?: Uint8Array<ArrayBuffer>;
  sha256?: string; signal?: AbortSignal;
}
/** Injectable at the small HTTP boundary. Both fake and real responses still
 * pass all public parsers and workspace/request identity checks. */
export interface PrivateBackupTransferTransport {
  request(path: string, request: PrivateBackupTransferRequest): Promise<unknown>;
}
export class PrivateBackupTransferHttpError extends Error {
  readonly status: number;
  constructor(status: number) {
    super('The backup request was not confirmed. Check its saved progress before continuing.');
    this.name = 'PrivateBackupTransferHttpError'; this.status = status;
  }
}
export class PrivateBackupTransferUncertainError extends Error {
  readonly operationId: string;
  readonly operation: Operation | null;
  constructor(id: string, operation: Operation | null) {
    super(operation ? 'This step was not confirmed. Review its saved progress before continuing; keep the original backup file.'
      : 'This step was not confirmed and its saved progress could not be read. Keep the original file and check this operation before continuing.');
    this.name = 'PrivateBackupTransferUncertainError'; this.operationId = id; this.operation = operation;
  }
}
const invalid = (): never => { throw new Error('The backup response could not be verified. Check its saved progress before continuing.'); };
const MAX_RESPONSE_BYTES = 512 * 1024;
async function smallJson(response: Response): Promise<unknown> {
  if (!response.ok) { await response.body?.cancel(); throw new PrivateBackupTransferHttpError(response.status); }
  if (!response.headers.get('content-type')?.toLowerCase().includes('application/json')) { await response.body?.cancel(); return invalid(); }
  const declared = response.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_RESPONSE_BYTES)) { await response.body?.cancel(); return invalid(); }
  const reader = response.body?.getReader(); if (!reader) return invalid();
  let size = 0, text = '';
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); return invalid(); }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch { await reader.cancel().catch(() => {}); return invalid(); } finally { reader.releaseLock(); }
}
export const privateBackupTransferHttp: PrivateBackupTransferTransport = {
  async request(path, request) {
    const timeout = AbortSignal.timeout(30_000);
    const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
    const binary = request.bytes !== undefined;
    if (binary && (request.method !== 'PUT' || request.bytes!.length < 1 || request.bytes!.length > CHUNK || !privateBackupTransferDigest(request.sha256))) return invalid();
    const response = await localSessionFetch(path, {
      method: request.method, signal, cache: 'no-store',
      headers: binary ? { 'content-type': 'application/octet-stream', 'x-realbud-chunk-sha256': request.sha256! } : { 'content-type': 'application/json' },
      ...(binary ? { body: request.bytes } : request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    return smallJson(response);
  },
};
export async function privateBackupSha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}
export async function privateBackupChunkCommitment(tuples: readonly PrivateBackupChunkTuple[]): Promise<string> {
  if (tuples.length > MAX_BYTES / CHUNK) return invalid();
  let offset = 0;
  for (const [index, tuple] of tuples.entries()) {
    if (tuple.length !== 3 || tuple[0] !== offset || !Number.isSafeInteger(tuple[1]) || tuple[1] < 1 || tuple[1] > CHUNK ||
        index < tuples.length - 1 && tuple[1] !== CHUNK || !privateBackupTransferDigest(tuple[2])) return invalid();
    offset += tuple[1];
  }
  return privateBackupSha256(new TextEncoder().encode(JSON.stringify(tuples)));
}
const activePhases = new Set(['capturing', 'sealing', 'checking', 'staging', 'applying']);
const sealedPhases = new Set(['uploaded', 'checking', 'reviewed', 'staging', 'staged', 'applying', 'completed']);
const abort = (signal?: AbortSignal) => signal?.throwIfAborted();
const pause = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  abort(signal);
  const cancel = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); reject(signal?.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, milliseconds);
  signal?.addEventListener('abort', cancel, { once: true });
});

/** No file, passphrase or download ticket is persisted. Caller-owned UUIDs and
 * server operation discovery provide recovery after navigation or reload. */
export class PrivateBackupTransferClient {
  private readonly workspaceId: string;
  private readonly transport: PrivateBackupTransferTransport;
  constructor(workspaceId: string, transport: PrivateBackupTransferTransport = privateBackupTransferHttp) {
    if (!privateBackupTransferId(workspaceId)) throw new Error('Choose the current workspace before continuing.');
    this.workspaceId = workspaceId; this.transport = transport;
  }
  private id(id: string) { if (!privateBackupTransferId(id)) throw new Error('The saved backup operation is unavailable.'); return id; }
  private operation(value: unknown, id: string): Operation {
    const parsed = parsePrivateBackupTransferResponse(value);
    if (!parsed || parsed.id !== id || parsed.workspaceId !== this.workspaceId) return invalid();
    return parsed;
  }
  async get(id: string, signal?: AbortSignal): Promise<Operation> {
    abort(signal);
    const result = await this.transport.request(`${API}/operations/${this.id(id)}`, { method: 'GET', signal });
    abort(signal); return this.operation(result, id);
  }
  async list(options: { limit?: number; cursor?: string; signal?: AbortSignal } = {}) {
    const limit = options.limit ?? PRIVATE_BACKUP_TRANSFER_MAX_ITEMS;
    if (!Number.isInteger(limit) || limit < 1 || limit > PRIVATE_BACKUP_TRANSFER_MAX_ITEMS || options.cursor !== undefined && !/^[A-Za-z0-9_-]{1,512}$/.test(options.cursor)) return invalid();
    abort(options.signal);
    const query = new URLSearchParams({ limit: String(limit), ...(options.cursor ? { cursor: options.cursor } : {}) });
    const result = parsePrivateBackupTransferPage(await this.transport.request(`${API}/operations?${query}`, { method: 'GET', signal: options.signal }));
    abort(options.signal);
    if (!result || result.workspaceId !== this.workspaceId) return invalid();
    return result;
  }
  private async mutation(id: string, path: string, request: PrivateBackupTransferRequest, accepted: (operation: Operation) => boolean): Promise<Operation> {
    this.id(id); abort(request.signal);
    try {
      const result = this.operation(await this.transport.request(path, request), id);
      abort(request.signal);
      if (!accepted(result)) return invalid();
      return result;
    } catch {
      // Pausing only interrupts browser transport. The next explicit resume
      // starts with GET; never translate an AbortSignal into server cancel.
      abort(request.signal);
      let saved: Operation | null = null;
      try { saved = await this.get(id, request.signal); } catch { abort(request.signal); }
      if (saved && accepted(saved)) return saved;
      throw new PrivateBackupTransferUncertainError(id, saved);
    }
  }
  startExport(id: string, passphrase: string, signal?: AbortSignal) {
    if (!validBackupPassphrase(passphrase)) throw new Error('Use a backup passphrase between 16 and 256 characters.');
    return this.mutation(id, `${API}/exports`, { method: 'POST', body: { id, passphrase }, signal }, op => op.kind === 'export' && !['cancelled', 'expired'].includes(op.phase));
  }
  startUpload(id: string, totalBytes: number, signal?: AbortSignal) {
    if (!Number.isSafeInteger(totalBytes) || totalBytes < 1 || totalBytes > MAX_BYTES) throw new Error('Choose a non-empty backup within the supported size.');
    return this.mutation(id, `${API}/uploads`, { method: 'POST', body: { id, totalBytes }, signal }, op => op.kind === 'upload' && op.progress.totalBytes === totalBytes && !['cancelled', 'expired'].includes(op.phase));
  }
  async poll(id: string, options: { signal?: AbortSignal; onOperation?: (operation: Operation) => void; intervalMs?: number } = {}) {
    const delay = Math.max(250, Math.min(10_000, options.intervalMs ?? 1000));
    for (;;) {
      const op = await this.get(id, options.signal);
      options.onOperation?.(structuredClone(op)); abort(options.signal);
      if (!activePhases.has(op.phase)) return op;
      await pause(delay, options.signal);
    }
  }
  /** Only slices are read. The compact tuple array is bounded to 1024 entries. */
  async uploadFile(id: string, file: Pick<File, 'size' | 'slice'>, options: { signal?: AbortSignal; onOperation?: (operation: Operation) => void } = {}): Promise<Operation> {
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_BYTES) throw new Error('Choose a non-empty backup within the supported size.');
    const tuples: PrivateBackupChunkTuple[] = [];
    const { signal } = options;
    let operation = await this.get(id, signal), confirmed = 0;
    const readChunk = async (offset: number) => {
      abort(signal);
      const end = Math.min(file.size, offset + CHUNK), slice = file.slice(offset, end);
      if (slice.size !== end - offset || slice.size > CHUNK) throw new Error('The selected backup file changed. Choose it again.');
      const bytes = new Uint8Array(await slice.arrayBuffer()); abort(signal);
      if (bytes.length !== end - offset) throw new Error('The selected backup file changed. Choose it again.');
      const sha256 = await privateBackupSha256(bytes); abort(signal);
      const tuple: PrivateBackupChunkTuple = [offset, bytes.length, sha256];
      const prior = tuples[offset / CHUNK];
      if (prior && prior[2] !== sha256) throw new Error('The selected backup file changed. Choose the original file again.');
      tuples[offset / CHUNK] = tuple;
      return { bytes, sha256 };
    };
    const verifyPrefix = async (op: Operation) => {
      if (op.kind !== 'upload' || op.progress.totalBytes !== file.size || op.receivedBytes === undefined || op.receivedBytes < confirmed) return invalid();
      const count = Math.ceil(op.receivedBytes / CHUNK);
      while (tuples.length < count) await readChunk(tuples.length * CHUNK);
      if (await privateBackupChunkCommitment(tuples.slice(0, count)) !== op.prefixCommitment) throw new Error('This is not the same backup file as the saved transfer. Choose the original file to continue.');
      abort(signal); confirmed = op.receivedBytes;
      options.onOperation?.(structuredClone(op)); abort(signal);
    };
    await verifyPrefix(operation);
    while (confirmed < file.size) {
      if (operation.phase !== 'uploading') throw new PrivateBackupTransferUncertainError(id, operation);
      const offset = confirmed, chunk = await readChunk(offset), expected = offset + chunk.bytes.length;
      operation = await this.mutation(id, `${API}/uploads/${id}/chunks?offset=${offset}`, { method: 'PUT', bytes: chunk.bytes, sha256: chunk.sha256, signal },
        op => op.kind === 'upload' && op.progress.totalBytes === file.size && op.receivedBytes !== undefined && op.receivedBytes >= expected && (op.phase === 'uploading' || sealedPhases.has(op.phase)));
      // Includes any additional chunks accepted from a second window. Check
      // their selected-file prefix before another write or a completed result.
      await verifyPrefix(operation);
    }
    if (sealedPhases.has(operation.phase)) return operation;
    if (operation.phase !== 'uploading') throw new PrivateBackupTransferUncertainError(id, operation);
    const chunkCommitment = await privateBackupChunkCommitment(tuples); abort(signal);
    operation = await this.mutation(id, `${API}/uploads/${id}/seal`, { method: 'POST', body: { totalBytes: file.size, chunkCommitment }, signal },
      op => op.kind === 'upload' && op.receivedBytes === file.size && op.prefixCommitment === chunkCommitment && sealedPhases.has(op.phase));
    await verifyPrefix(operation); return operation;
  }
  preview(id: string, passphrase: string, expectedArchiveDigest: string, signal?: AbortSignal) {
    if (!validBackupPassphrase(passphrase) || !privateBackupTransferDigest(expectedArchiveDigest)) throw new Error('Check the backup passphrase and selected file before continuing.');
    return this.mutation(id, `${API}/uploads/${this.id(id)}/preview`, { method: 'POST', body: { passphrase, expectedArchiveDigest }, signal },
      op => op.kind === 'upload' && op.artifact?.archiveDigest === expectedArchiveDigest && ['checking', 'reviewed', 'staging', 'staged', 'applying', 'completed'].includes(op.phase));
  }
  stage(reviewed: Operation, signal?: AbortSignal) {
    const current = parsePrivateBackupTransferOperation(reviewed);
    if (!current || current.workspaceId !== this.workspaceId || current.kind !== 'upload' || !['reviewed', 'staging'].includes(current.phase) || !current.preview || !current.artifact) throw new Error('Review the complete backup before preparing its restore.');
    const expectedArchiveDigest = current.artifact.archiveDigest;
    return this.mutation(current.id, `${API}/uploads/${current.id}/stage`, { method: 'POST', body: { expectedArchiveDigest, confirm: true }, signal },
      op => op.kind === 'upload' && op.artifact?.archiveDigest === expectedArchiveDigest && ['staging', 'staged', 'applying', 'completed'].includes(op.phase));
  }
  async cancel(id: string, signal?: AbortSignal) {
    const current = await this.get(id, signal);
    if (current.phase === 'cancelled') return current;
    if (!current.canCancel) throw new Error('This backup operation must be kept for restore or recovery.');
    return this.mutation(id, `${API}/operations/${this.id(id)}/cancel`, { method: 'POST', body: {}, signal }, op => op.phase === 'cancelled');
  }
  async downloadTicket(ready: Operation, signal?: AbortSignal): Promise<PrivateBackupDownloadTicket> {
    const current = parsePrivateBackupTransferOperation(ready);
    if (!current || current.workspaceId !== this.workspaceId || current.kind !== 'export' || current.phase !== 'ready' || !current.artifact) throw new Error('Wait until the backup is ready to download.');
    abort(signal);
    const result = parsePrivateBackupDownloadTicket(await this.transport.request(`${API}/operations/${current.id}/download-ticket`, {
      method: 'POST', body: { expectedArchiveDigest: current.artifact.archiveDigest }, signal,
    }));
    abort(signal);
    if (!result || result.archiveDigest !== current.artifact.archiveDigest || result.archiveBytes !== current.artifact.archiveBytes || result.expiresAt <= Date.now()) return invalid();
    return result;
  }
}

/** Requests the native browser download. This is not proof the user saved it.
 * No target=_blank: Electron routes new windows to the external browser. */
export function requestPrivateBackupDownload(value: PrivateBackupDownloadTicket, document: Document = globalThis.document) {
  const ticket = parsePrivateBackupDownloadTicket(value);
  if (!ticket || ticket.expiresAt <= Date.now()) throw new Error('Request a new download link for this saved backup.');
  const anchor = document.createElement('a');
  anchor.href = ticket.url; anchor.download = ticket.filename; anchor.referrerPolicy = 'no-referrer';
  document.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); }
}
