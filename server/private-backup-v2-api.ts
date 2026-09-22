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

function fail(message: string, status = 400): never {
  throw Object.assign(new Error(message), { status });
}

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
