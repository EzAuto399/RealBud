import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  PRIVATE_BACKUP_TRANSFER_API as API,
  PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES as CHUNK,
  PRIVATE_BACKUP_TRANSFER_ERRORS,
  PRIVATE_BACKUP_TRANSFER_MAX_BYTES as MAX,
  type PrivateBackupDownloadTicket,
  type PrivateBackupTransferOperation,
  type PrivateBackupTransferPage,
} from '../shared/private-backup-transfers.ts';
import { createPrivateBackupV2Api, type BackupV2ApiService } from './private-backup-v2-api.ts';

const FIELDS = 'Use the supported private-backup fields.';
const CONFIRM = 'Confirm staging this reviewed backup.';
const INVALID = PRIVATE_BACKUP_TRANSFER_ERRORS['storage-unavailable'];
const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DIGEST = 'ab'.repeat(32);
const PASS = 'p'.repeat(16);
const TOKEN = 'A'.repeat(32);
const UNKNOWN = { status: 404, body: { error: 'Unknown private-backup action.' } };

const EXPORT_OP: PrivateBackupTransferOperation = {
  version: 2,
  id: ID,
  workspaceId: WS,
  kind: 'export',
  phase: 'ready',
  createdAt: 1,
  updatedAt: 2,
  expiresAt: null,
  progress: { completedBytes: 1024, totalBytes: 1024 },
  canCancel: true,
  requiresPassphrase: false,
  artifact: { archiveBytes: 1024, archiveDigest: DIGEST },
};

const UPLOAD_OP: PrivateBackupTransferOperation = {
  version: 2,
  id: ID,
  workspaceId: WS,
  kind: 'upload',
  phase: 'uploading',
  createdAt: 1,
  updatedAt: 2,
  expiresAt: null,
  progress: { completedBytes: 0, totalBytes: CHUNK },
  canCancel: true,
  requiresPassphrase: false,
  receivedBytes: 0,
  prefixCommitment: DIGEST,
};

const PAGE: PrivateBackupTransferPage = {
  version: 2,
  workspaceId: WS,
  limits: { archiveBytes: MAX, chunkBytes: CHUNK },
  items: [EXPORT_OP],
  total: 1,
  nextCursor: null,
};

const TICKET: PrivateBackupDownloadTicket = {
  url: `${API}/downloads/${TOKEN}`,
  filename: 'Work.realbud-backup',
  expiresAt: 99,
  archiveBytes: 1024,
  archiveDigest: DIGEST,
};

function stub(overrides: Partial<BackupV2ApiService> = {}): BackupV2ApiService {
  const nope = async () => {
    throw new Error('service called');
  };
  return {
    list: nope,
    get: nope,
    startExport: nope,
    startUpload: nope,
    appendUpload: nope,
    sealUpload: nope,
    preview: nope,
    stage: nope,
    cancel: nope,
    downloadTicket: nope,
    ...overrides,
  };
}

function api(overrides: Partial<BackupV2ApiService> = {}) {
  return createPrivateBackupV2Api({ service: () => stub(overrides) });
}

async function rejectStatus(run: Promise<unknown>, status: number, message?: string) {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.notEqual(error.message, 'service called');
    assert.equal((error as Error & { status?: number }).status, status);
    if (message !== undefined) assert.equal(error.message, message);
    assert.doesNotMatch(error.message, /\/tmp|secret-key|scratch/i);
    return true;
  });
}

function duplicateLimit() {
  const query = new URLSearchParams();
  query.append('limit', '1');
  query.append('limit', '2');
  return query;
}

test('returns null outside the v2 prefix', async () => {
  const handle = api();
  assert.equal(await handle({ path: '/api/private-backup', method: 'GET' }), null);
  assert.equal(await handle({ path: '/api/private-backup/v2x/operations', method: 'GET' }), null);
  assert.equal(await handle({ path: '/api/other', method: 'GET' }), null);
});

test('unknown methods and routes are 404 without service', async () => {
  const handle = api();
  assert.deepEqual(await handle({ path: `${API}/operations`, method: 'POST' }), UNKNOWN);
  assert.deepEqual(await handle({ path: `${API}/exports`, method: 'GET' }), UNKNOWN);
  assert.deepEqual(await handle({ path: `${API}/nope`, method: 'GET' }), UNKNOWN);
  assert.deepEqual(await handle({ path: `${API}/operations/${ID}/extra`, method: 'GET' }), UNKNOWN);
  assert.deepEqual(await handle({ path: `${API}/operations/not-a-uuid`, method: 'GET' }), UNKNOWN);
  assert.deepEqual(await handle({ path: `${API}/downloads/short`, method: 'GET' }), UNKNOWN);
  assert.deepEqual(await handle({ path: `${API}/downloads/${TOKEN}`, method: 'POST' }), UNKNOWN);
});

test('malformed input never reaches the service', async () => {
  const handle = api();
  const bytes = new Uint8Array([1]);
  const cases: Array<{ name: string; request: Parameters<ReturnType<typeof api>>[0] }> = [
    { name: 'list unknown workspace query', request: { path: `${API}/operations`, method: 'GET', query: new URLSearchParams({ workspaceId: WS }) } },
    { name: 'list path query', request: { path: `${API}/operations`, method: 'GET', query: new URLSearchParams({ path: '/tmp' }) } },
    { name: 'list duplicate limit', request: { path: `${API}/operations`, method: 'GET', query: duplicateLimit() } },
    { name: 'list invalid cursor', request: { path: `${API}/operations`, method: 'GET', query: new URLSearchParams({ cursor: '+++' }) } },
    { name: 'list limit 21', request: { path: `${API}/operations`, method: 'GET', query: new URLSearchParams({ limit: '21' }) } },
    { name: 'get rejects query', request: { path: `${API}/operations/${ID}`, method: 'GET', query: new URLSearchParams({ key: 'k' }) } },
    { name: 'export extra key', request: { path: `${API}/exports`, method: 'POST', body: { id: ID, passphrase: PASS, key: 'k' } } },
    { name: 'export short passphrase', request: { path: `${API}/exports`, method: 'POST', body: { id: ID, passphrase: 'p'.repeat(15) } } },
    { name: 'export long passphrase', request: { path: `${API}/exports`, method: 'POST', body: { id: ID, passphrase: 'p'.repeat(257) } } },
    { name: 'upload totalBytes 0', request: { path: `${API}/uploads`, method: 'POST', body: { id: ID, totalBytes: 0 } } },
    { name: 'upload totalBytes too large', request: { path: `${API}/uploads`, method: 'POST', body: { id: ID, totalBytes: MAX + 1 } } },
    { name: 'chunks extra query', request: { path: `${API}/uploads/${ID}/chunks`, method: 'PUT', query: new URLSearchParams({ offset: '0', dir: '/tmp' }), bytes, chunkDigest: DIGEST } },
    { name: 'chunks missing offset', request: { path: `${API}/uploads/${ID}/chunks`, method: 'PUT', bytes, chunkDigest: DIGEST } },
    { name: 'chunks unaligned offset', request: { path: `${API}/uploads/${ID}/chunks`, method: 'PUT', query: new URLSearchParams({ offset: '1' }), bytes, chunkDigest: DIGEST } },
    { name: 'chunks empty bytes', request: { path: `${API}/uploads/${ID}/chunks`, method: 'PUT', query: new URLSearchParams({ offset: '0' }), bytes: new Uint8Array(), chunkDigest: DIGEST } },
    { name: 'chunks json body', request: { path: `${API}/uploads/${ID}/chunks`, method: 'PUT', query: new URLSearchParams({ offset: '0' }), body: {}, bytes, chunkDigest: DIGEST } },
    { name: 'chunks uppercase digest', request: { path: `${API}/uploads/${ID}/chunks`, method: 'PUT', query: new URLSearchParams({ offset: '0' }), bytes, chunkDigest: DIGEST.toUpperCase() } },
    { name: 'seal archive digest field', request: { path: `${API}/uploads/${ID}/seal`, method: 'POST', body: { totalBytes: 1, expectedArchiveDigest: DIGEST } } },
    { name: 'preview chunkCommitment field', request: { path: `${API}/uploads/${ID}/preview`, method: 'POST', body: { passphrase: PASS, chunkCommitment: DIGEST } } },
    { name: 'cancel extra field', request: { path: `${API}/operations/${ID}/cancel`, method: 'POST', body: { id: ID } } },
    { name: 'ticket extra path field', request: { path: `${API}/operations/${ID}/download-ticket`, method: 'POST', body: { expectedArchiveDigest: DIGEST, path: '/tmp' } } },
  ];
  for (const { name, request } of cases) {
    try {
      await rejectStatus(handle(request), 400, FIELDS);
    } catch (error) {
      assert.fail(`${name}: ${(error as Error).message}`);
    }
  }
});

test('rejects stage confirm before service access', async () => {
  const handle = api();
  await rejectStatus(
    handle({ path: `${API}/uploads/${ID}/stage`, method: 'POST', body: { expectedArchiveDigest: DIGEST, confirm: false } }),
    400,
    CONFIRM,
  );
  await rejectStatus(
    handle({ path: `${API}/uploads/${ID}/stage`, method: 'POST', body: { expectedArchiveDigest: DIGEST } }),
    400,
    CONFIRM,
  );
});

test('download GET only validates the token and does not call the service', async () => {
  const handle = api();
  assert.deepEqual(await handle({ path: `${API}/downloads/${TOKEN}`, method: 'GET' }), {
    status: 200,
    downloadTicket: TOKEN,
  });
  await rejectStatus(
    handle({ path: `${API}/downloads/${TOKEN}`, method: 'GET', query: new URLSearchParams({ path: '/tmp' }) }),
    400,
    FIELDS,
  );
});

test('forwards valid requests through parsed public projections', async () => {
  const bytes = new Uint8Array([7, 8, 9]);
  const calls: unknown[] = [];
  const handle = api({
    list: async (input) => {
      calls.push(['list', input]);
      return PAGE;
    },
    get: async (id) => {
      calls.push(['get', id]);
      return EXPORT_OP;
    },
    startExport: async (id, passphrase) => {
      calls.push(['startExport', id, passphrase]);
      return EXPORT_OP;
    },
    startUpload: async (id, totalBytes) => {
      calls.push(['startUpload', id, totalBytes]);
      return UPLOAD_OP;
    },
    appendUpload: async (id, offset, got, sha256) => {
      assert.equal(got, bytes);
      calls.push(['appendUpload', id, offset, sha256]);
      return UPLOAD_OP;
    },
    sealUpload: async (id, totalBytes, chunkCommitment) => {
      calls.push(['sealUpload', id, totalBytes, chunkCommitment]);
      return UPLOAD_OP;
    },
    preview: async (id, passphrase, expectedArchiveDigest) => {
      calls.push(['preview', id, passphrase, expectedArchiveDigest]);
      return UPLOAD_OP;
    },
    stage: async (id, expectedArchiveDigest) => {
      calls.push(['stage', id, expectedArchiveDigest]);
      return UPLOAD_OP;
    },
    cancel: async (id) => {
      calls.push(['cancel', id]);
      return EXPORT_OP;
    },
    downloadTicket: async (id, expectedArchiveDigest) => {
      calls.push(['downloadTicket', id, expectedArchiveDigest]);
      return TICKET;
    },
  });

  assert.deepEqual(
    await handle({ path: `${API}/operations`, method: 'GET', query: new URLSearchParams({ limit: '4', cursor: 'next_cursor-1' }) }),
    { status: 200, body: PAGE },
  );
  assert.deepEqual(await handle({ path: `${API}/exports`, method: 'POST', body: { id: ID, passphrase: PASS } }), {
    status: 202,
    body: { operation: EXPORT_OP },
  });
  assert.deepEqual(await handle({ path: `${API}/uploads`, method: 'POST', body: { id: ID, totalBytes: 1 } }), {
    status: 201,
    body: { operation: UPLOAD_OP },
  });
  assert.deepEqual(await handle({ path: `${API}/operations/${ID}`, method: 'GET' }), {
    status: 200,
    body: { operation: EXPORT_OP },
  });
  assert.deepEqual(
    await handle({
      path: `${API}/uploads/${ID}/chunks`,
      method: 'PUT',
      query: new URLSearchParams({ offset: '0' }),
      bytes,
      chunkDigest: DIGEST,
    }),
    { status: 200, body: { operation: UPLOAD_OP } },
  );
  assert.deepEqual(
    await handle({ path: `${API}/uploads/${ID}/seal`, method: 'POST', body: { totalBytes: 1, chunkCommitment: DIGEST } }),
    { status: 200, body: { operation: UPLOAD_OP } },
  );
  assert.deepEqual(
    await handle({
      path: `${API}/uploads/${ID}/preview`,
      method: 'POST',
      body: { passphrase: PASS, expectedArchiveDigest: DIGEST },
    }),
    { status: 202, body: { operation: UPLOAD_OP } },
  );
  assert.deepEqual(
    await handle({ path: `${API}/uploads/${ID}/stage`, method: 'POST', body: { expectedArchiveDigest: DIGEST, confirm: true } }),
    { status: 202, body: { operation: UPLOAD_OP } },
  );
  assert.deepEqual(await handle({ path: `${API}/operations/${ID}/cancel`, method: 'POST' }), {
    status: 200,
    body: { operation: EXPORT_OP },
  });
  assert.deepEqual(
    await handle({ path: `${API}/operations/${ID}/download-ticket`, method: 'POST', body: { expectedArchiveDigest: DIGEST } }),
    { status: 200, body: TICKET },
  );
  assert.deepEqual(await handle({ path: `${API}/downloads/${TOKEN}`, method: 'GET' }), {
    status: 200,
    downloadTicket: TOKEN,
  });

  assert.deepEqual(calls, [
    ['list', { limit: 4, cursor: 'next_cursor-1' }],
    ['startExport', ID, PASS],
    ['startUpload', ID, 1],
    ['get', ID],
    ['appendUpload', ID, 0, DIGEST],
    ['sealUpload', ID, 1, DIGEST],
    ['preview', ID, PASS, DIGEST],
    ['stage', ID, DIGEST],
    ['cancel', ID],
    ['downloadTicket', ID, DIGEST],
  ]);
});

test('get and cancel may target either operation kind', async () => {
  assert.deepEqual(await api({ get: async () => UPLOAD_OP })({ path: `${API}/operations/${ID}`, method: 'GET' }), {
    status: 200,
    body: { operation: UPLOAD_OP },
  });
  assert.deepEqual(await api({ cancel: async () => EXPORT_OP })({ path: `${API}/operations/${ID}/cancel`, method: 'POST' }), {
    status: 200,
    body: { operation: EXPORT_OP },
  });
});

test('rejects foreign ids, wrong kinds, and private fields in service output', async () => {
  await rejectStatus(
    api({ get: async () => ({ ...EXPORT_OP, id: OTHER }) })({ path: `${API}/operations/${ID}`, method: 'GET' }),
    500,
    INVALID,
  );
  await rejectStatus(
    api({ startUpload: async () => EXPORT_OP })({ path: `${API}/uploads`, method: 'POST', body: { id: ID, totalBytes: 1 } }),
    500,
    INVALID,
  );
  await rejectStatus(
    api({ startExport: async () => UPLOAD_OP })({ path: `${API}/exports`, method: 'POST', body: { id: ID, passphrase: PASS } }),
    500,
    INVALID,
  );
  await rejectStatus(
    api({ get: async () => ({ ...EXPORT_OP, path: '/tmp/scratch', key: 'secret-key' }) })({
      path: `${API}/operations/${ID}`,
      method: 'GET',
    }),
    500,
    INVALID,
  );
  await rejectStatus(
    api({ downloadTicket: async () => ({ ...TICKET, filename: '../secret.realbud-backup' }) })({
      path: `${API}/operations/${ID}/download-ticket`,
      method: 'POST',
      body: { expectedArchiveDigest: DIGEST },
    }),
    500,
    INVALID,
  );
});

test('does not map service exceptions into a response body', async () => {
  const handle = api({
    list: async () => {
      throw new Error('ENOENT /var/secret-key');
    },
  });
  await assert.rejects(handle({ path: `${API}/operations`, method: 'GET' }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'ENOENT /var/secret-key');
    return true;
  });
});
