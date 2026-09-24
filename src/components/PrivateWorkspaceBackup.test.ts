import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OnboardingState } from '@shared/onboarding';
import { PRIVATE_BACKUP_TRANSFER_MAX_BYTES, PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES, type PrivateBackupTransferOperation as Operation } from '@shared/private-backup-transfers';
import { api } from '@/state/store';
import { privateBackupTransferHttp } from '@/lib/private-backup-transfer';
import { BackupWelcomeAction, PrivateWorkspaceBackup } from './PrivateWorkspaceBackup';

const observed = vi.hoisted(() => ({ effects: [] as (() => unknown)[], setters: [] as ReturnType<typeof vi.fn>[], seed: new Map<number, unknown>() }));
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useEffect: (effect: () => unknown) => { observed.effects.push(effect); },
    useState: (value: unknown) => { const index = observed.setters.length, setter = vi.fn(); observed.setters.push(setter); return [observed.seed.has(index) ? observed.seed.get(index) : value, setter]; } };
});
vi.mock('@/state/store', () => ({ api: vi.fn() }));
vi.mock('@/lib/private-backup-transfer', async importOriginal => ({
  ...await importOriginal<typeof import('@/lib/private-backup-transfer')>(), privateBackupTransferHttp: { request: vi.fn() },
}));
const recovery: OnboardingState = { version: 1, scope: 'a'.repeat(64), revision: 1, stage: 'recovery' };
const render = (onboarding: OnboardingState | null, blocked: string | null = null, busy = false) => renderToStaticMarkup(createElement(BackupWelcomeAction, { onboarding, blocked, busy, onBack: vi.fn() }));
describe('private backup welcome action', () => {
  beforeEach(() => { observed.effects.length = 0; observed.setters.length = 0; vi.clearAllMocks(); });
  afterEach(() => vi.unstubAllGlobals());
  it('offers the explicit return only for saved recovery, with preservation copy', () => {
    expect(render(recovery)).toContain('Back to welcome');
    expect(render(recovery)).toContain('original files and saved backup copies stay unchanged');
    expect(render(recovery)).not.toContain('disabled=""');
    for (const stage of ['profile', 'office-rules', 'complete'] as const) expect(render({ ...recovery, stage })).toBe('');
    expect(render(null)).toBe('');
  });
  it('disables return during an action or when fresh status must be reviewed', () => {
    expect(render(recovery, null, true)).toContain('disabled=""');
    expect(render(recovery, 'Check backup status first.')).toContain('disabled=""');
    expect(render(recovery, 'Check backup status first.')).toContain('Check backup status first.');
  });
  it.each(['malformed', 'unavailable'])('keeps existing backup recovery available when onboarding is %s', async failure => {
    vi.stubGlobal('window', {});
    const status = { canRestore: true, bootstrap: true, staged: false, reason: 'Fresh workspace.', completed: null };
    vi.mocked(api).mockImplementation(async path => {
      if (path === '/api/onboarding') {
        if (failure === 'unavailable') throw Object.assign(new Error('unavailable'), { status: 503 });
        return { stage: 'recovery' }; // missing authoritative scope/revision
      }
      if (path === '/api/private-backup') return status;
      throw new Error('Unexpected test path');
    });
    vi.mocked(privateBackupTransferHttp.request).mockResolvedValue({ version: 2,
      workspaceId: '00000000-0000-4000-8000-000000000001',
      limits: { archiveBytes: PRIVATE_BACKUP_TRANSFER_MAX_BYTES, chunkBytes: PRIVATE_BACKUP_TRANSFER_CHUNK_BYTES }, items: [], total: 0, nextCursor: null });
    expect(renderToStaticMarkup(createElement(PrivateWorkspaceBackup))).not.toContain('Back to welcome');
    const cleanup = observed.effects[0]() as () => void;
    await vi.waitFor(() => expect(observed.setters[0]).toHaveBeenCalledWith(status));
    expect(observed.setters[1]).toHaveBeenCalled(); // saved progress was initialized too
    expect(observed.setters.at(-1)).toHaveBeenCalledWith(null); // return action stays unavailable
    expect(observed.setters[5]).not.toHaveBeenCalled(); // onboarding cannot replace backup status with an error
    cleanup();
  });
});

describe('private backup saved operation controls', () => {
  const status = { canRestore: true, bootstrap: true, staged: false, reason: 'Fresh workspace.', completed: null };
  const op = (change: Partial<Operation> = {}): Operation => ({ version: 2, id: '00000000-0000-4000-8000-000000000003', workspaceId: '00000000-0000-4000-8000-000000000001',
    kind: 'export', phase: 'capturing', createdAt: 1, updatedAt: 1, expiresAt: null, progress: { completedBytes: 0, totalBytes: null }, canCancel: true, requiresPassphrase: false, ...change });
  // Seeds status, saved items and the selection; every other state keeps its initial value.
  const renderSelected = (selected: Operation) => {
    observed.setters.length = 0; observed.seed.clear(); observed.seed.set(0, status); observed.seed.set(1, [selected]); observed.seed.set(2, selected.id);
    return renderToStaticMarkup(createElement(PrivateWorkspaceBackup));
  };
  beforeEach(() => { vi.stubGlobal('window', {}); });
  afterEach(() => { observed.seed.clear(); vi.unstubAllGlobals(); });
  it('offers Cancel this backup while a saved backup still runs, and keeps Remove temporary copy for idle ones', () => {
    expect(renderSelected(op())).toContain('>Cancel this backup</button>');
    const failed = renderSelected(op({ phase: 'failed', requiresPassphrase: true, error: { code: 'workspace-busy' } }));
    expect(failed).toContain('>Remove temporary copy</button>'); expect(failed).not.toContain('Cancel this backup</button>');
  });
  it('shows the specific busy reason when the service reports one, else the generic sentence', () => {
    const reasoned = renderSelected(op({ phase: 'failed', requiresPassphrase: true, error: { code: 'workspace-busy', reason: 'bud-replying' } }));
    expect(reasoned).toContain('Bud was still replying — try again when it finishes.'); expect(reasoned).not.toContain('Finish the current work');
    expect(renderSelected(op({ phase: 'failed', requiresPassphrase: true, error: { code: 'workspace-busy' } }))).toContain('Finish the current work before continuing this backup operation.');
  });
});
