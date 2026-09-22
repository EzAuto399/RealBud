import type { IncomingMessage } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createPrivateBackupApi, type PrivateBackupApiHost } from './private-backup-api.ts';
import { needsSession, sessionOk, SESSION_TOKEN } from './session-auth.ts';

const passphrase = 'synthetic-backup-passphrase-only';
const backup = { format: 'realbud-private-business', version: 1, kdf: 'scrypt-32768-8-1', salt: 'a'.repeat(32), payload: { v: 1, alg: 'aes-256-gcm', iv: 'synthetic', tag: 'synthetic', ct: 'synthetic-encrypted-data' } };
const receipt = { digest: 'b'.repeat(64), createdAt: '2026-09-21T00:00:00Z', workspaceId: '11111111-1111-4111-8111-111111111111', fileCount: 2, recordCount: 1, plainBytes: 1234,
  included: ['Saved private mail', 'Source-linked bills'], excluded: ['Provider credentials', 'Office membership'], restoreChanges: ['Schedules remain paused'] };
function fixture() {
  let busy = false;
  const service = {
    status: vi.fn(async () => ({ state: 'none', receipt: null })),
    exportBackup: vi.fn(async (_passphrase: string) => ({ backup, receipt })),
    previewBackup: vi.fn(async (_backup: unknown, _passphrase: string) => receipt),
    stageRestore: vi.fn(async (_input: { backup: unknown; passphrase: string; expectedDigest: string }) => ({ state: 'staged', receipt })),
  };
  const host = {
    service: vi.fn(() => service as unknown as ReturnType<PrivateBackupApiHost['service']>),
    restoreReadiness: vi.fn(() => ({ canRestore: !busy, reason: busy ? 'A restore is already pending.' : 'Fresh private workspace.', bootstrap: true })),
    beginRestore: vi.fn(() => { busy = true; }), restoreFailed: vi.fn(async () => { busy = false; }),
  } satisfies PrivateBackupApiHost;
  return { service, host, handle: createPrivateBackupApi(host), restore: () => ({ backup, passphrase, expectedDigest: receipt.digest, confirm: true }) };
}

describe('private backup host boundary', () => {
  it('reports fresh-workspace readiness and metadata without exposing secrets or unsealed backup data', async () => {
    const f = fixture();
    expect(await f.handle('/api/private-backup', 'GET')).toEqual({ status: 200, body: { canRestore: true, reason: 'Fresh private workspace.', bootstrap: true, staged: false, receipt: null, completed: null } });
    f.service.status.mockResolvedValueOnce({ state: 'staged', receipt } as never);
    const result = await f.handle('/api/private-backup', 'GET');
    expect(result).toMatchObject({ status: 200, body: { staged: true, receipt } });
    expect(JSON.stringify(result)).not.toContain(passphrase); expect(JSON.stringify(result)).not.toContain(backup.payload.ct);
    expect(f.host.beginRestore).not.toHaveBeenCalled();
  });

  it('returns the durable completion receipt after a cold restore without starting new work', async () => {
    const f = fixture(), completed = { version: 1, restoredAt: '2026-09-21T01:00:00Z', receipt, rekeyed: true, reviewRequired: true };
    f.service.status.mockResolvedValueOnce({ state: 'none', receipt: null, completed } as never);
    expect(await f.handle('/api/private-backup', 'GET')).toMatchObject({ status: 200, body: { staged: false, completed } });
    expect(f.host.beginRestore).not.toHaveBeenCalled(); expect(f.service.stageRestore).not.toHaveBeenCalled();
  });

  it('exports only the service-produced encrypted backup and receipt under a safe download filename', async () => {
    const f = fixture(), result = await f.handle('/api/private-backup/export', 'POST', { passphrase });
    expect(f.service.exportBackup).toHaveBeenCalledExactlyOnceWith(passphrase);
    expect(result).toMatchObject({ status: 200, body: { backup, receipt } });
    const filename = (result!.body as { filename: string }).filename;
    expect(filename).toMatch(/^[A-Za-z0-9_.-]+$/); expect(filename).not.toContain(passphrase);
    expect(JSON.stringify(result)).not.toContain(passphrase);
    expect(f.host.beginRestore).not.toHaveBeenCalled();
  });

  it('previews through the validating service without staging or blocking existing work', async () => {
    const f = fixture(); f.host.restoreReadiness.mockReturnValue({ canRestore: false, bootstrap: true, reason: 'Existing business records are present.' });
    const result = await f.handle('/api/private-backup/preview', 'POST', { backup, passphrase });
    expect(result).toEqual({ status: 200, body: receipt }); expect(f.service.previewBackup).toHaveBeenCalledExactlyOnceWith(backup, passphrase);
    expect(f.host.beginRestore).not.toHaveBeenCalled(); expect(f.service.stageRestore).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(passphrase);
  });

  it.each([
    ['/api/private-backup/export', { passphrase, directory: '/tmp/elsewhere' }],
    ['/api/private-backup/export', { passphrase, key: 'synthetic-desk-key' }],
    ['/api/private-backup/preview', { backup, passphrase, sourceKey: 'synthetic-key' }],
    ['/api/private-backup/restore', { backup, passphrase, expectedDigest: receipt.digest, confirm: true, sqlite: 'arbitrary-sqlite-bytes' }],
    ['/api/private-backup/restore', { backup, passphrase, expectedDigest: receipt.digest, confirm: true, destination: '../another-workspace' }],
  ] as const)('rejects caller-controlled file or key fields at %s before touching the service', async (path, body) => {
    const f = fixture(); await expect(f.handle(path, 'POST', body)).rejects.toMatchObject({ status: 400 });
    expect(f.host.service).not.toHaveBeenCalled(); expect(f.host.beginRestore).not.toHaveBeenCalled();
  });

  it.each([undefined, null, [], 'not an object'])('rejects a malformed backup body before invoking the service', async body => {
    const f = fixture(); await expect(f.handle('/api/private-backup/export', 'POST', body)).rejects.toMatchObject({ status: 400 });
    expect(f.host.service).not.toHaveBeenCalled();
  });

  it.each([undefined, false, 'true', 1])('requires explicit restore confirmation, not %s', async confirm => {
    const f = fixture(); await expect(f.handle('/api/private-backup/restore', 'POST', { ...f.restore(), confirm })).rejects.toMatchObject({ status: 400 });
    expect(f.host.beginRestore).not.toHaveBeenCalled(); expect(f.service.stageRestore).not.toHaveBeenCalled();
  });

  it.each([
    { canRestore: false, bootstrap: true, reason: 'Existing private work must be preserved.' },
    { canRestore: true, bootstrap: false, reason: 'Restore requires the managed desktop startup.' },
  ])('refuses restoration when readiness is %j', async readiness => {
    const f = fixture(); f.host.restoreReadiness.mockReturnValue(readiness);
    await expect(f.handle('/api/private-backup/restore', 'POST', f.restore())).rejects.toMatchObject({ status: 409, message: readiness.reason });
    expect(f.host.beginRestore).not.toHaveBeenCalled(); expect(f.service.stageRestore).not.toHaveBeenCalled();
  });

  it('claims the restore guard before asynchronous staging and preserves the reviewed digest', async () => {
    const f = fixture(); let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
    f.service.stageRestore.mockImplementationOnce(async () => { expect(f.host.beginRestore).toHaveBeenCalledTimes(1); entered(); await pending; return { state: 'staged', receipt }; });
    const first = f.handle('/api/private-backup/restore', 'POST', f.restore()); await started;
    await expect(f.handle('/api/private-backup/restore', 'POST', f.restore())).rejects.toMatchObject({ status: 409 });
    release(); expect(await first).toEqual({ status: 200, body: { state: 'staged', receipt } });
    expect(f.service.stageRestore).toHaveBeenCalledExactlyOnceWith({ backup, passphrase, expectedDigest: receipt.digest });
    expect(f.host.restoreFailed).not.toHaveBeenCalled();
  });

  it('waits for restore failure recovery before allowing another staging attempt', async () => {
    const f = fixture(); const invalid = Object.assign(new Error('The reviewed backup digest changed.'), { status: 409 });
    let recovering!: () => void, release!: () => void;
    const reachedRecovery = new Promise<void>(resolve => { recovering = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
    f.service.stageRestore.mockRejectedValueOnce(invalid);
    const recover = f.host.restoreFailed.getMockImplementation()!;
    f.host.restoreFailed.mockImplementationOnce(async () => { recovering(); await pending; await recover(); });
    const result = f.handle('/api/private-backup/restore', 'POST', f.restore()); await reachedRecovery;
    await expect(f.handle('/api/private-backup/restore', 'POST', f.restore())).rejects.toMatchObject({ status: 409 });
    release(); await expect(result).rejects.toBe(invalid);
    expect((await f.handle('/api/private-backup/restore', 'POST', f.restore()))?.status).toBe(200);
    expect(f.host.restoreFailed).toHaveBeenCalledTimes(1);
  });

  it('keeps work blocked if restore recovery itself cannot complete', async () => {
    const f = fixture(); f.service.stageRestore.mockRejectedValueOnce(new Error('Synthetic invalid backup'));
    f.host.restoreFailed.mockRejectedValueOnce(Object.assign(new Error('Restore recovery is incomplete.'), { status: 503 }));
    await expect(f.handle('/api/private-backup/restore', 'POST', f.restore())).rejects.toMatchObject({ status: 503 });
    await expect(f.handle('/api/private-backup/restore', 'POST', f.restore())).rejects.toMatchObject({ status: 409 });
    expect(f.service.stageRestore).toHaveBeenCalledTimes(1);
  });

  it('passes unrelated paths through and rejects unsupported backup actions without reading data', async () => {
    const f = fixture(); expect(await f.handle('/api/private-backup-lookalike', 'GET')).toBeNull();
    for (const [path, method] of [['/api/private-backup', 'DELETE'], ['/api/private-backup/export', 'GET'], ['/api/private-backup/preview', 'PUT'], ['/api/private-backup/restore', 'GET'], ['/api/private-backup/unknown', 'POST']]) {
      expect(await f.handle(path, method, f.restore())).toEqual({ status: 404, body: { error: 'Unknown private-backup action.' } });
    }
    expect(f.host.service).not.toHaveBeenCalled(); expect(f.host.beginRestore).not.toHaveBeenCalled();
  });
});

describe('private backup desktop session boundary', () => {
  it.each(['/api/private-backup', '/api/private-backup/export', '/api/private-backup/preview', '/api/private-backup/restore'])(
    'protects %s from missing/stale sessions and foreign origins', path => {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS']) expect(needsSession(path, method)).toBe(true);
      const req = { url: path, method: 'POST', headers: { host: '127.0.0.1:8799' } } as unknown as IncomingMessage;
      expect(sessionOk(req, 8799)).toMatchObject({ ok: false, status: 401 });
      req.headers['x-realbud-session'] = 'old-session'; expect(sessionOk(req, 8799)).toMatchObject({ ok: false, status: 401 });
      req.headers['x-realbud-session'] = SESSION_TOKEN; req.headers.origin = 'https://untrusted.example';
      expect(sessionOk(req, 8799)).toMatchObject({ ok: false, status: 403 });
      req.headers.origin = 'http://127.0.0.1:8799'; expect(sessionOk(req, 8799)).toEqual({ ok: true });
    });
});
