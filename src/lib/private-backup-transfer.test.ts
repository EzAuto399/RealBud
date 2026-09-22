import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES as CHUNK, PRIVATE_BACKUP_TRANSFER_MAX_BYTES as MAX_BYTES,
  parsePrivateBackupTransferOperation, parsePrivateBackupTransferPage, parsePrivateBackupDownloadTicket,
  type PrivateBackupTransferOperation as Operation, type PrivateBackupChunkTuple,
} from '@shared/private-backup-transfers';
import {
  PrivateBackupTransferClient, PrivateBackupTransferUncertainError, privateBackupChunkCommitment,
  privateBackupTransferHttp, requestPrivateBackupDownload,
  type PrivateBackupTransferTransport, type PrivateBackupTransferRequest,
} from './private-backup-transfer';
import { localSessionFetch } from './local-session';

vi.mock('./local-session', () => ({ localSessionFetch: vi.fn() }));
const ID = '00000000-0000-4000-8000-000000000001', WORKSPACE = '00000000-0000-4000-8000-000000000002';
const OTHER = '00000000-0000-4000-8000-000000000003', HASH = 'a'.repeat(64);
const digest = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const commitment = (value: PrivateBackupChunkTuple[]) => digest(JSON.stringify(value));
const operation = (size = CHUNK + 19): Operation => ({
  version: 2, id: ID, workspaceId: WORKSPACE, kind: 'upload', phase: 'uploading',
  createdAt: 1, updatedAt: 1, expiresAt: null, progress: { completedBytes: 0, totalBytes: size },
  canCancel: true, requiresPassphrase: false, receivedBytes: 0, prefixCommitment: commitment([]),
});
const receipt = () => ({ digest: HASH, createdAt: '2026-09-21T00:00:00.000Z', workspaceId: WORKSPACE,
  fileCount: 2, recordCount: 6001, plainBytes: 12, included: ['Private business records'], excluded: ['Account connections'], restoreChanges: ['Schedules remain off'] });
const reviewed = (): Operation => ({ ...operation(12), phase: 'reviewed', receivedBytes: 12,
  progress: { completedBytes: 12, totalBytes: 12 }, artifact: { archiveBytes: 12, archiveDigest: HASH }, preview: receipt() });
const ready = (): Operation => {
  const { receivedBytes: _received, prefixCommitment: _prefix, ...op } = reviewed();
  return { ...op, kind: 'export', phase: 'ready' };
};
const page = (op = operation()) => ({ version: 2, workspaceId: WORKSPACE, limits: { archiveBytes: MAX_BYTES, chunkBytes: CHUNK }, items: [op], total: 1, nextCursor: null });
const ticket = () => ({ url: '/api/private-backup/v2/downloads/' + 'x'.repeat(48), filename: 'RealBud-2026.realbud-backup', expiresAt: Date.now() + 60_000, archiveBytes: 12, archiveDigest: HASH });
function slicedFile(bytes: Uint8Array) {
  const reads: [number, number][] = [];
  return { reads, file: { size: bytes.length, arrayBuffer() { throw new Error('Whole-file reads are forbidden'); },
    slice(start = 0, end = bytes.length) {
      reads.push([start, end]); expect(end - start).toBeLessThanOrEqual(CHUNK);
      return { size: end - start, async arrayBuffer() { return bytes.slice(start, end).buffer; } } as Blob;
    },
  } };
}
/** Fictional small HTTP seam, not actual HTTP/browser proof. Hash verification
 * uses Node crypto independently of the browser implementation under test. */
function uploadHost(bytes: Uint8Array, initialChunks = 0) {
  let op = operation(bytes.length), tuples: PrivateBackupChunkTuple[] = [];
  const calls: { path: string; method: string }[] = [];
  let afterPut: (() => void) | undefined, beforePut: (() => void) | undefined, loseSeal = false;
  const accept = (offset: number, input: Uint8Array, sha256: string) => {
    expect(offset).toBe(op.receivedBytes); expect(digest(input)).toBe(sha256);
    expect(input.length).toBe(Math.min(CHUNK, bytes.length - offset));
    tuples.push([offset, input.length, sha256]);
    op = { ...op, updatedAt: op.updatedAt + 1, receivedBytes: offset + input.length,
      progress: { completedBytes: offset + input.length, totalBytes: bytes.length }, prefixCommitment: commitment(tuples) };
  };
  for (let i = 0; i < initialChunks; i++) { const offset = i * CHUNK, data = bytes.slice(offset, offset + CHUNK); accept(offset, data, digest(data)); }
  const transport: PrivateBackupTransferTransport = { async request(path, request) {
    calls.push({ path, method: request.method });
    if (request.method === 'GET') return { operation: structuredClone(op) };
    if (request.method === 'PUT') {
      beforePut?.();
      accept(Number(new URL(path, 'http://localhost').searchParams.get('offset')), request.bytes!, request.sha256!);
      const callback = afterPut; afterPut = undefined; callback?.();
      return { operation: structuredClone(op) };
    }
    if (path.endsWith('/seal')) {
      expect(request.body).toEqual({ totalBytes: bytes.length, chunkCommitment: commitment(tuples) });
      op = { ...op, phase: 'uploaded', requiresPassphrase: true, artifact: { archiveBytes: bytes.length, archiveDigest: digest(bytes) } };
      if (loseSeal) { loseSeal = false; throw new TypeError('Lost fictional acknowledgement'); }
      return { operation: structuredClone(op) };
    }
    throw new Error('Unexpected test operation');
  } };
  return { transport, calls, current: () => op, set: (next: Operation) => { op = next; },
    afterPut: (fn: () => void) => { afterPut = fn; }, beforePut: (fn?: () => void) => { beforePut = fn; },
    loseSeal: () => { loseSeal = true; }, accept,
  };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); vi.mocked(localSessionFetch).mockReset(); });

describe('private backup public projections', () => {
  it('accepts only public, bounded fields and copies nested receipts', () => {
    const input = reviewed(), result = parsePrivateBackupTransferOperation(input)!;
    expect(result).toEqual(input); result.preview!.included.push('Changed');
    expect(input.preview!.included).toEqual(['Private business records']);
    expect(parsePrivateBackupTransferOperation({ ...input, scratchPath: '/private/file' })).toBeNull();
    expect(parsePrivateBackupTransferOperation({ ...input, error: { code: 'storage-unavailable', message: 'secret path' } })).toBeNull();
    expect(parsePrivateBackupTransferOperation({ ...input, artifact: { ...input.artifact, key: 'secret' } })).toBeNull();
    expect(parsePrivateBackupTransferOperation({ ...input, preview: { ...input.preview, passphrase: 'secret' } })).toBeNull();
  });
  it.each([
    { receivedBytes: 1 }, { receivedBytes: CHUNK * 4 }, { prefixCommitment: HASH.toUpperCase() },
    { progress: { completedBytes: 7, totalBytes: 6 } }, { progress: { completedBytes: 0, totalBytes: MAX_BYTES + 1 } },
    { phase: 'reviewed' }, { phase: 'staged', canCancel: true }, { requiresPassphrase: true },
    { expiresAt: 0 }, { updatedAt: 0 }, { phase: 'new-unknown-phase' },
  ])('rejects inconsistent transfer state %j', change => {
    expect(parsePrivateBackupTransferOperation({ ...operation(), ...change })).toBeNull();
  });
  it('bounds pages, rejects repeated identities and cross-workspace records', () => {
    expect(parsePrivateBackupTransferPage(page())).toEqual(page());
    expect(parsePrivateBackupTransferPage({ ...page(), items: [operation(), operation()], total: 2 })).toBeNull();
    expect(parsePrivateBackupTransferPage(page({ ...operation(), workspaceId: OTHER }))).toBeNull();
    expect(parsePrivateBackupTransferPage({ ...page(), items: Array(21).fill(operation()), total: 21 })).toBeNull();
    expect(parsePrivateBackupTransferPage({ ...page(), nextCursor: '../path' })).toBeNull();
  });
  it('rejects coerced operation kinds and binds reviewed contents to the exact archive digest', () => {
    expect(parsePrivateBackupTransferOperation({ ...operation(), kind: ['upload'] })).toBeNull();
    expect(parsePrivateBackupTransferOperation({ ...ready(), kind: ['export'] })).toBeNull();
    expect(parsePrivateBackupTransferOperation({ ...reviewed(), preview: { ...receipt(), digest: 'b'.repeat(64) } })).toBeNull();
    // The archived workspace identity is historical and can differ from the
    // current destination; only the receipt-to-artifact digest must match.
    expect(parsePrivateBackupTransferOperation({ ...reviewed(), preview: { ...receipt(), workspaceId: OTHER } })).not.toBeNull();
  });
  it.each(['https://example.test/file', '//example.test/file', '/api/private-backup/v2/downloads/../file', '/api/private-backup/v2/downloads/' + 'x'.repeat(48) + '?session=secret'])('rejects unsafe download URL %s', url => {
    expect(parsePrivateBackupDownloadTicket({ ...ticket(), url })).toBeNull();
  });
});

describe('bounded file upload and recovery', () => {
  it('matches the host tuple commitment without any whole-file hash API', async () => {
    const tuples: PrivateBackupChunkTuple[] = [[0, CHUNK, HASH], [CHUNK, 9, 'b'.repeat(64)]];
    expect(await privateBackupChunkCommitment(tuples)).toBe(commitment(tuples));
    expect(await privateBackupChunkCommitment([])).toBe(digest('[]'));
    await expect(privateBackupChunkCommitment([[0, 1, HASH], [CHUNK, 1, HASH]])).rejects.toThrow();
    await expect(privateBackupChunkCommitment(Array(1025).fill([0, CHUNK, HASH]))).rejects.toThrow();
  });
  it('uploads only fixed slices, verifies receipts, seals once and never accesses web storage', async () => {
    vi.stubGlobal('localStorage', { getItem() { throw new Error('Forbidden storage'); }, setItem() { throw new Error('Forbidden storage'); } });
    vi.stubGlobal('sessionStorage', { getItem() { throw new Error('Forbidden storage'); }, setItem() { throw new Error('Forbidden storage'); } });
    const bytes = new Uint8Array(CHUNK * 2 + 39).fill(42), host = uploadHost(bytes), input = slicedFile(bytes);
    const result = await new PrivateBackupTransferClient(WORKSPACE, host.transport).uploadFile(ID, input.file);
    expect(result.phase).toBe('uploaded'); expect(result.artifact?.archiveDigest).toBe(digest(bytes));
    expect(input.reads).toEqual([[0, CHUNK], [CHUNK, CHUNK * 2], [CHUNK * 2, bytes.length]]);
    expect(host.calls.map(c => c.method)).toEqual(['GET', 'PUT', 'PUT', 'PUT', 'POST']);
  });
  it('resumes from a reselected file only after checking all accepted prefix bytes', async () => {
    const bytes = new Uint8Array(CHUNK * 2 + 5).fill(12), host = uploadHost(bytes, 1), input = slicedFile(bytes);
    await new PrivateBackupTransferClient(WORKSPACE, host.transport).uploadFile(ID, input.file);
    expect(input.reads[0]).toEqual([0, CHUNK]);
    expect(host.calls.filter(c => c.method === 'PUT').map(c => c.path.split('?')[1])).toEqual([`offset=${CHUNK}`, `offset=${2 * CHUNK}`]);
  });
  it('refuses a same-size changed prefix before any write', async () => {
    const original = new Uint8Array(CHUNK + 7), changed = original.slice(); changed[0] = 1;
    const host = uploadHost(original, 1);
    await expect(new PrivateBackupTransferClient(WORKSPACE, host.transport).uploadFile(ID, slicedFile(changed).file)).rejects.toThrow('not the same backup');
    expect(host.calls.map(c => c.method)).toEqual(['GET']);
  });
  it('reconciles an accepted chunk with a lost response before sending the next chunk', async () => {
    const bytes = new Uint8Array(CHUNK + 7), host = uploadHost(bytes);
    host.afterPut(() => { throw new TypeError('Lost response'); });
    await new PrivateBackupTransferClient(WORKSPACE, host.transport).uploadFile(ID, slicedFile(bytes).file);
    expect(host.calls.map(c => c.method)).toEqual(['GET', 'PUT', 'GET', 'PUT', 'POST']);
  });
  it('does not blindly retry an unacknowledged chunk; a later explicit resume reads status first', async () => {
    const bytes = new Uint8Array(12), host = uploadHost(bytes), client = new PrivateBackupTransferClient(WORKSPACE, host.transport);
    host.beforePut(() => { throw new Error('Fictional storage failure'); });
    await expect(client.uploadFile(ID, slicedFile(bytes).file)).rejects.toMatchObject({ name: 'PrivateBackupTransferUncertainError', operationId: ID, operation: { receivedBytes: 0 } });
    expect(host.calls.map(c => c.method)).toEqual(['GET', 'PUT', 'GET']);
    host.beforePut();
    await client.uploadFile(ID, slicedFile(bytes).file);
    expect(host.calls.map(c => c.method)).toEqual(['GET', 'PUT', 'GET', 'GET', 'PUT', 'POST']);
  });
  it('verifies extra prefix data accepted by a second window before any later write', async () => {
    const bytes = new Uint8Array(CHUNK * 2 + 9), host = uploadHost(bytes);
    host.afterPut(() => { const changed = bytes.slice(CHUNK, CHUNK * 2); changed[0] = 9; host.accept(CHUNK, changed, digest(changed)); });
    await expect(new PrivateBackupTransferClient(WORKSPACE, host.transport).uploadFile(ID, slicedFile(bytes).file)).rejects.toThrow('not the same backup');
    expect(host.calls.map(c => c.method)).toEqual(['GET', 'PUT']);
  });
  it('reconciles a lost sealing acknowledgement without sealing twice', async () => {
    const bytes = new Uint8Array(9), host = uploadHost(bytes); host.loseSeal();
    const result = await new PrivateBackupTransferClient(WORKSPACE, host.transport).uploadFile(ID, slicedFile(bytes).file);
    expect(result.phase).toBe('uploaded'); expect(host.calls.map(c => c.method)).toEqual(['GET', 'PUT', 'POST', 'GET']);
  });
  it('pause aborts browser work without cancelling server state, and resume checks the persisted prefix', async () => {
    const bytes = new Uint8Array(CHUNK + 5), host = uploadHost(bytes), controller = new AbortController();
    host.afterPut(() => controller.abort());
    const client = new PrivateBackupTransferClient(WORKSPACE, host.transport);
    await expect(client.uploadFile(ID, slicedFile(bytes).file, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(host.current().receivedBytes).toBe(CHUNK); expect(host.calls.map(c => c.method)).toEqual(['GET', 'PUT']);
    await client.uploadFile(ID, slicedFile(bytes).file);
    expect(host.calls[2].method).toBe('GET'); expect(host.calls.some(c => c.path.endsWith('/cancel'))).toBe(false);
  });
  it('rejects cross-workspace, wrong request and stale progress responses without another write', async () => {
    for (const override of [{ workspaceId: OTHER }, { id: OTHER }]) {
      const request = vi.fn(async () => ({ operation: { ...operation(5), ...override } }));
      await expect(new PrivateBackupTransferClient(WORKSPACE, { request }).uploadFile(ID, slicedFile(new Uint8Array(5)).file)).rejects.toThrow('could not be verified');
      expect(request).toHaveBeenCalledTimes(1);
    }
    const bytes = new Uint8Array(CHUNK + 7), host = uploadHost(bytes, 1);
    host.afterPut(() => host.set(operation(bytes.length)));
    await expect(new PrivateBackupTransferClient(WORKSPACE, host.transport).uploadFile(ID, slicedFile(bytes).file)).rejects.toBeInstanceOf(PrivateBackupTransferUncertainError);
    expect(host.calls.map(c => c.method)).toEqual(['GET', 'PUT', 'GET']);
  });
});

describe('operation controls and narrow download', () => {
  it('keeps the exact start ID and reconciles a lost admission response, without repeating POST', async () => {
    const request = vi.fn(async (_path: string, req: PrivateBackupTransferRequest) => { if (req.method === 'POST') throw new Error('Lost response'); return { operation: operation(9) }; });
    const result = await new PrivateBackupTransferClient(WORKSPACE, { request }).startUpload(ID, 9);
    expect(result.id).toBe(ID); expect(request.mock.calls.map(c => c[1].method)).toEqual(['POST', 'GET']);
    expect(request.mock.calls[0][1].body).toEqual({ id: ID, totalBytes: 9 });
    expect(request.mock.calls[1][0]).toBe(`/api/private-backup/v2/operations/${ID}`);
  });
  it('keeps an unresolved start identity when status is unavailable, without creating a replacement', async () => {
    const request = vi.fn(async () => { throw new Error('Disconnected'); });
    await expect(new PrivateBackupTransferClient(WORKSPACE, { request }).startUpload(ID, 9)).rejects.toMatchObject({ operationId: ID, operation: null });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('stages only a completed reviewed projection and recovers the same staged result after a lost reply', async () => {
    const request = vi.fn(async (_path: string, req: PrivateBackupTransferRequest) => { if (req.method === 'POST') throw new Error('Lost response'); return { operation: { ...reviewed(), phase: 'staged', canCancel: false } }; });
    const client = new PrivateBackupTransferClient(WORKSPACE, { request });
    expect(() => client.stage(operation())).toThrow('Review the complete backup');
    const result = await client.stage(reviewed()); expect(result.phase).toBe('staged');
    expect(request.mock.calls.map(c => c[1].method)).toEqual(['POST', 'GET']);
    expect(request.mock.calls[0][1].body).toEqual({ expectedArchiveDigest: HASH, confirm: true });
  });
  it('reconciles preview without repeating the passphrase POST and rejects a different archive receipt', async () => {
    const request = vi.fn(async (_path: string, req: PrivateBackupTransferRequest) => { if (req.method === 'POST') throw new Error('Lost response'); return { operation: reviewed() }; });
    const client = new PrivateBackupTransferClient(WORKSPACE, { request });
    expect((await client.preview(ID, 'Fictional passphrase for testing', HASH)).phase).toBe('reviewed');
    expect(request.mock.calls.map(c => c[1].method)).toEqual(['POST', 'GET']);
    request.mockClear();
    await expect(client.preview(ID, 'Fictional passphrase for testing', 'b'.repeat(64))).rejects.toMatchObject({ name: 'PrivateBackupTransferUncertainError', operationId: ID });
    expect(request.mock.calls.map(c => c[1].method)).toEqual(['POST', 'GET']);
  });
  it('checks cancellation permission, never cancels a staged restore, and reconciles a lost cancel reply', async () => {
    const request = vi.fn(async () => ({ operation: { ...reviewed(), phase: 'staged', canCancel: false } }));
    await expect(new PrivateBackupTransferClient(WORKSPACE, { request }).cancel(ID)).rejects.toThrow('must be kept');
    expect(request).toHaveBeenCalledTimes(1);
    const op = operation(12);
    let cancelled = false;
    const cancellable = vi.fn(async (_path: string, req: PrivateBackupTransferRequest) => {
      if (req.method === 'POST') { cancelled = true; throw new Error('Lost reply'); }
      return { operation: cancelled ? { ...op, phase: 'cancelled', canCancel: false } : op };
    });
    expect((await new PrivateBackupTransferClient(WORKSPACE, { request: cancellable }).cancel(ID)).phase).toBe('cancelled');
    expect(cancellable.mock.calls.map(c => c[1].method)).toEqual(['GET', 'POST', 'GET']);
  });
  it('stops polling after a pause without issuing any further request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController(), request = vi.fn(async () => ({ operation: { ...ready(), phase: 'sealing', preview: undefined, artifact: undefined } }));
    const work = new PrivateBackupTransferClient(WORKSPACE, { request }).poll(ID, { signal: controller.signal, intervalMs: 250 });
    const assertion = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(0); controller.abort(); await assertion;
    await vi.advanceTimersByTimeAsync(1000); expect(request).toHaveBeenCalledTimes(1);
  });
  it('polls only reads and stops on interrupted work without requesting a passphrase operation again', async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValueOnce({ operation: { ...reviewed(), phase: 'checking', preview: undefined } })
      .mockResolvedValueOnce({ operation: { ...operation(12), phase: 'interrupted' } });
    const onOperation = vi.fn(), work = new PrivateBackupTransferClient(WORKSPACE, { request }).poll(ID, { onOperation, intervalMs: 250 });
    await vi.advanceTimersByTimeAsync(250);
    expect((await work).phase).toBe('interrupted'); expect(onOperation).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.every(c => c[1].method === 'GET')).toBe(true);
  });
  it('requests a validated artifact-only link and clicks an anchor without fetching a Blob or opening a new window', async () => {
    const download = ticket(), request = vi.fn(async (_path: string, _request: PrivateBackupTransferRequest) => download);
    const result = await new PrivateBackupTransferClient(WORKSPACE, { request }).downloadTicket(ready());
    const anchor = { href: '', download: '', referrerPolicy: '', click: vi.fn(), remove: vi.fn() };
    const document = { createElement: vi.fn(() => anchor), body: { append: vi.fn() } };
    requestPrivateBackupDownload(result, document as unknown as Document);
    expect(anchor.href).toBe(download.url); expect(anchor.download).toBe(download.filename); expect(anchor.referrerPolicy).toBe('no-referrer');
    expect(anchor).not.toHaveProperty('target'); expect(anchor.click).toHaveBeenCalledTimes(1); expect(anchor.remove).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(1); expect(request.mock.calls[0][0]).toContain('/download-ticket');
  });
  it('refuses expired links or a ticket for a different completed artifact', async () => {
    expect(() => requestPrivateBackupDownload({ ...ticket(), expiresAt: 1 })).toThrow('new download link');
    const request = vi.fn(async () => ({ ...ticket(), archiveDigest: 'b'.repeat(64) }));
    await expect(new PrivateBackupTransferClient(WORKSPACE, { request }).downloadTicket(ready())).rejects.toThrow('could not be verified');
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe('real HTTP adapter boundary', () => {
  it('uses the ordinary session-capable binary helper with a bounded exact body and digest header', async () => {
    vi.mocked(localSessionFetch).mockResolvedValueOnce(Response.json({ operation: operation(12) }));
    const bytes = new Uint8Array([1, 2, 3]);
    await privateBackupTransferHttp.request(`/api/private-backup/v2/uploads/${ID}/chunks?offset=0`, { method: 'PUT', bytes, sha256: digest(bytes) });
    const [path, init] = vi.mocked(localSessionFetch).mock.calls[0];
    expect(path).toContain('/chunks?offset=0'); expect(init.body).toBe(bytes);
    expect(new Headers(init.headers).get('content-type')).toBe('application/octet-stream');
    expect(new Headers(init.headers).get('x-realbud-chunk-sha256')).toBe(digest(bytes));
    expect(init.cache).toBe('no-store'); expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it('rejects oversized/invalid control responses and never exposes raw server error text', async () => {
    vi.mocked(localSessionFetch).mockResolvedValueOnce(new Response('{"private":"secret"}', { status: 500 }))
      .mockResolvedValueOnce(new Response('x'.repeat(512 * 1024 + 1), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response('not-json', { headers: { 'content-type': 'application/json' } }));
    await expect(privateBackupTransferHttp.request('/api/private-backup/v2/operations', { method: 'GET' })).rejects.toMatchObject({ status: 500 });
    await expect(privateBackupTransferHttp.request('/api/private-backup/v2/operations', { method: 'GET' })).rejects.toThrow('could not be verified');
    await expect(privateBackupTransferHttp.request('/api/private-backup/v2/operations', { method: 'GET' })).rejects.toThrow('could not be verified');
  });
});
