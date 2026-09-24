import { describe, expect, it, vi } from 'vitest';
import type { OnboardingState } from '@shared/onboarding';
import { PRIVATE_BACKUP_TRANSFER_API as API, PRIVATE_BACKUP_TRANSFER_MAX_BYTES, PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES, type PrivateBackupTransferOperation as Operation } from '@shared/private-backup-transfers';
import { createBackupWelcomeApi } from './backup-welcome';

const initial: OnboardingState = { version: 1, scope: 'a'.repeat(64), revision: 7, stage: 'recovery' };
const workspace = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const receipt = { digest: 'a'.repeat(64), createdAt: '2026-09-24T00:00:00.000Z', workspaceId: workspace,
  fileCount: 2, recordCount: 3, plainBytes: 12, included: ['Business records'], excluded: ['Connections'], restoreChanges: ['Review schedules'] };
function operation(phase: Operation['phase'], id = other): Operation {
  const upload = !['capturing', 'sealing', 'ready'].includes(phase);
  const closed = ['cancelled', 'expired'].includes(phase);
  return { version: 2, id, workspaceId: workspace, kind: upload ? 'upload' : 'export', phase,
    createdAt: 1, updatedAt: 1, expiresAt: null, progress: { completedBytes: 12, totalBytes: 12 },
    canCancel: !['staging', 'staged', 'applying', 'completed', 'cancelled', 'expired'].includes(phase), requiresPassphrase: false,
    ...(upload ? { receivedBytes: 12, prefixCommitment: 'b'.repeat(64) } : {}),
    ...(!closed && !['capturing', 'uploading'].includes(phase) ? { artifact: { archiveBytes: 12, archiveDigest: receipt.digest } } : {}),
    ...(['reviewed', 'staging', 'staged', 'applying', 'completed'].includes(phase) ? { preview: receipt } : {}),
  };
}
const page = (items: Operation[] = []) => ({ version: 2, workspaceId: workspace,
  limits: { archiveBytes: PRIVATE_BACKUP_TRANSFER_MAX_BYTES, chunkBytes: PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES }, items, total: items.length, nextCursor: null as string | null });
function fixture() {
  let saved = { ...initial };
  const source = { status: { canRestore: true, bootstrap: true, staged: false, reason: 'Fresh workspace.', completed: null } as unknown,
    progress: page() as unknown, loseReply: false, commit: true };
  const request = vi.fn(async (path: string, init?: RequestInit): Promise<unknown> => {
    if (path === '/api/onboarding') {
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body as string);
        expect(body).toEqual({ expectedScope: saved.scope, expectedRevision: saved.revision, stage: 'profile' });
        if (source.commit) saved = { ...saved, stage: 'profile', revision: saved.revision + 1 };
        if (source.loseReply) throw new Error('lost reply');
      }
      return { ...saved };
    }
    if (path === '/api/private-backup') return source.status;
    if (path.startsWith(`${API}/operations?`)) return source.progress;
    throw new Error(`Unexpected local test path: ${path}`);
  });
  return { source, request, api: createBackupWelcomeApi(request), saved: () => saved,
    replace: (next: OnboardingState) => { saved = next; },
    writes: () => request.mock.calls.filter(([, init]) => init?.method === 'PUT') };
}

describe('return from private backup to welcome', () => {
  it('returns after a cancelled picker with one revision-bound preference write, preserving backup data', async () => {
    const f = fixture();
    expect(await f.api.back(initial)).toEqual({ ...initial, stage: 'profile', revision: 8 });
    expect(f.writes()).toHaveLength(1);
    expect(f.request.mock.calls.every(([path, init]) => !init?.method || init.method === 'GET' || path === '/api/onboarding')).toBe(true);
    expect(await f.api.read()).toEqual(f.saved()); // authoritative state used after reload
  });
  it.each(['cancelled', 'expired', 'ready'] as const)('keeps settled %s history and allows normal setup', async phase => {
    const f = fixture(); const history = page([operation(phase)]); f.source.progress = history;
    await f.api.back(initial);
    expect(f.source.progress).toEqual(history); expect(f.saved().stage).toBe('profile');
  });
  it.each(['capturing', 'sealing', 'uploading', 'uploaded', 'checking', 'reviewed', 'staging', 'staged', 'applying', 'completed', 'failed', 'interrupted'] as const)('refuses %s work even with an unstaged status', async phase => {
    const f = fixture(); f.source.progress = page([operation(phase)]);
    await expect(f.api.back(initial)).rejects.toThrow('saved backup progress'); expect(f.writes()).toHaveLength(0);
  });
  it.each(['profile', 'office-rules', 'complete'] as const)('never resets saved %s onboarding', async stage => {
    const f = fixture(); f.replace({ ...initial, stage });
    await expect(f.api.back(initial)).rejects.toThrow('changed'); expect(f.writes()).toHaveLength(0);
  });
  it.each([
    { canRestore: false }, { bootstrap: false }, { staged: true, receipt }, { completionWarning: 'Restore needs recovery.' },
  ])('refuses unsafe backup status %j', async change => {
    const f = fixture(); f.source.status = { ...(f.source.status as object), ...change };
    await expect(f.api.back(initial)).rejects.toThrow('restore or other saved work'); expect(f.writes()).toHaveLength(0);
  });
  it.each(['onboarding', 'progress', 'status'] as const)('refuses unavailable or malformed %s', async source => {
    for (const unavailable of [false, true]) {
      const f = fixture(); const original = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (path, init) => {
        if (path === (source === 'onboarding' ? '/api/onboarding' : source === 'status' ? '/api/private-backup' : `${API}/operations?limit=20`)) {
          if (unavailable) throw new Error('unavailable'); return {};
        }
        return original(path, init);
      });
      await expect(f.api.back(initial)).rejects.toThrow(); expect(f.writes()).toHaveLength(0);
    }
  });
  it('rejects a stale revision or a different scope before writing', async () => {
    for (const next of [{ ...initial, revision: 8 }, { ...initial, scope: 'b'.repeat(64) }]) {
      const f = fixture(); f.replace(next);
      await expect(f.api.back(initial)).rejects.toThrow('changed'); expect(f.writes()).toHaveLength(0);
    }
  });
  it('rechecks onboarding after reading backup progress', async () => {
    const f = fixture(); const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (path, init) => {
      const value = await original(path, init);
      if (path === '/api/private-backup') f.replace({ ...initial, stage: 'complete', revision: 9 });
      return value;
    });
    await expect(f.api.back(initial)).rejects.toThrow('changed'); expect(f.writes()).toHaveLength(0);
  });
  it('confirms a committed lost reply only through exact authoritative readback', async () => {
    const f = fixture(); f.source.loseReply = true;
    expect(await f.api.back(initial)).toEqual({ ...initial, stage: 'profile', revision: 8 }); expect(f.writes()).toHaveLength(1);
  });
  it.each([false, true])('does not claim success when the write is unconfirmed (lost reply %s)', async loseReply => {
    const f = fixture(); f.source.loseReply = loseReply; f.source.commit = false;
    await expect(f.api.back(initial)).rejects.toThrow('not confirmed'); expect(f.writes()).toHaveLength(1); expect(f.saved()).toEqual(initial);
  });
  it('does not repeat a PUT when readback is unavailable or belongs to another scope', async () => {
    for (const changedScope of [false, true]) {
      const f = fixture(); const original = f.request.getMockImplementation()!;
      f.request.mockImplementation(async (path, init) => {
        if (path === '/api/onboarding' && !init && f.writes().length) {
          if (!changedScope) throw new Error('readback unavailable');
          return { ...f.saved(), scope: 'b'.repeat(64) };
        }
        return original(path, init);
      });
      await expect(f.api.back(initial)).rejects.toThrow('not confirmed'); expect(f.writes()).toHaveLength(1);
    }
  });
  it('prevents same-turn duplicate actions and respects cancellation before mutation', async () => {
    const f = fixture(); const first = f.api.back(initial);
    await expect(f.api.back(initial)).rejects.toThrow('already being checked');
    await first; expect(f.writes()).toHaveLength(1);
    const cancelled = fixture(); const control = new AbortController(); control.abort();
    await expect(cancelled.api.back(initial, control.signal)).rejects.toThrow(); expect(cancelled.request).not.toHaveBeenCalled();
  });
  it('walks all pages with consistent workspace and total before returning', async () => {
    const f = fixture(); const first = { ...page([operation('cancelled')]), total: 2, nextCursor: 'next' };
    const second = { ...page([operation('expired', '00000000-0000-4000-8000-000000000003')]), total: 2 };
    f.source.progress = first; const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((path, init) => path.includes('&cursor=') ? Promise.resolve(second) : original(path, init));
    await f.api.back(initial); expect(f.writes()).toHaveLength(1);
  });
  it.each(['workspace', 'duplicate', 'total', 'truncated', 'head'] as const)('rejects %s changes in paginated progress', async change => {
    const f = fixture(); const first = { ...page([operation('cancelled')]), total: 2, nextCursor: 'next' };
    const second = { ...page([operation('expired', '00000000-0000-4000-8000-000000000003')]), total: 2 };
    if (change === 'workspace') { second.workspaceId = other; second.items[0].workspaceId = other; }
    if (change === 'duplicate') second.items[0].id = other;
    if (change === 'total') second.total = 3;
    if (change === 'truncated') first.nextCursor = null as unknown as string;
    let heads = 0; const original = f.request.getMockImplementation()!;
    f.request.mockImplementation((path, init) => {
      if (path.includes('&cursor=')) return Promise.resolve(second);
      if (path.startsWith(`${API}/operations?`)) { heads++; return Promise.resolve(change === 'head' && heads > 1 ? page() : first); }
      return original(path, init);
    });
    await expect(f.api.back(initial)).rejects.toThrow('changed'); expect(f.writes()).toHaveLength(0);
  });
});
