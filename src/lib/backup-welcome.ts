import type { OnboardingState } from '@shared/onboarding';
import { PRIVATE_BACKUP_TRANSFER_API, parsePrivateBackupTransferPage, type PrivateBackupTransferOperation } from '@shared/private-backup-transfers';
import { createFirstRunApi } from './first-run';
import { backupStatus, type BackupStatus } from './private-backup';

const changed = 'Your setup or backup progress changed. Check backup status before returning to welcome.';
const uncertain = 'Returning to welcome was not confirmed. Reload this window to check your saved setup before continuing. Your backup files have not been removed.';
const same = (a: OnboardingState, b: OnboardingState) => a.scope === b.scope && a.revision === b.revision && a.stage === b.stage;

/** Settled transfer history is harmless. Interrupted/failed work can still hold
 * restore artifacts, so absence of a staged receipt alone is not sufficient. */
export function backupWelcomeBlocked(status: BackupStatus | null, items: readonly PrivateBackupTransferOperation[]): string | null {
  if (!status) return 'Check backup status before returning to welcome.';
  if (status.staged || status.completed || status.completionWarning || !status.bootstrap || !status.canRestore) {
    return 'This workspace has a restore or other saved work to review. Resolve it here before returning to welcome.';
  }
  if (items.some(item => !['cancelled', 'expired'].includes(item.phase) && !(item.kind === 'export' && item.phase === 'ready' && !item.error))) {
    return 'Review saved backup progress first. If a temporary copy is no longer needed, remove it here before returning to welcome.';
  }
  return null;
}

export function createBackupWelcomeApi(request: (path: string, init?: RequestInit) => Promise<unknown>) {
  const setup = createFirstRunApi(request);
  let pending = false;
  async function checkBackup(signal?: AbortSignal) {
    const read = (path: string) => request(path, { method: 'GET', cache: 'no-store', signal });
    const firstPath = `${PRIVATE_BACKUP_TRANSFER_API}/operations?limit=20`;
    const first = parsePrivateBackupTransferPage(await read(firstPath));
    if (!first) throw new Error('Saved backup progress could not be verified. Check backup status before continuing.');
    let page = first;
    const items = [...first.items], ids = new Set(items.map(item => item.id)), cursors = new Set<string>();
    // Bound discovery, never treat truncated or changing history as empty.
    while (page.nextCursor !== null) {
      if (cursors.has(page.nextCursor) || cursors.size >= 100) throw new Error(changed);
      cursors.add(page.nextCursor);
      const next = parsePrivateBackupTransferPage(await read(`${firstPath}&cursor=${encodeURIComponent(page.nextCursor)}`));
      if (!next || next.workspaceId !== first.workspaceId || next.total !== first.total || !next.items.length || next.items.some(item => ids.has(item.id))) throw new Error(changed);
      for (const item of next.items) { ids.add(item.id); items.push(item); }
      page = next;
    }
    if (items.length !== first.total) throw new Error(changed);
    const current = parsePrivateBackupTransferPage(await read(firstPath));
    if (!current || JSON.stringify(current) !== JSON.stringify(first)) throw new Error(changed);
    const status = backupStatus(await read('/api/private-backup'));
    const blocked = backupWelcomeBlocked(status, items);
    if (blocked) throw new Error(blocked);
    signal?.throwIfAborted();
  }
  return {
    read: () => setup.read(),
    async back(expected: OnboardingState, signal?: AbortSignal): Promise<OnboardingState> {
      if (pending) throw new Error('Returning to welcome is already being checked.');
      pending = true;
      try {
        signal?.throwIfAborted();
        const current = await setup.read();
        if (expected.stage !== 'recovery' || !same(current, expected)) throw new Error(changed);
        await checkBackup(signal);
        const latest = await setup.read();
        if (!same(latest, current)) throw new Error(changed);
        signal?.throwIfAborted();
        const next = { ...current, stage: 'profile' as const, revision: current.revision + 1 };
        // A lost PUT reply may have committed. Only an exact authoritative
        // readback can confirm the transition; never repeat the mutation here.
        try { await setup.save(current, 'profile'); } catch { /* reconcile below */ }
        let saved: OnboardingState;
        try { saved = await setup.read(); } catch { throw new Error(uncertain); }
        if (!same(saved, next)) throw new Error(uncertain);
        signal?.throwIfAborted();
        return saved;
      } finally { pending = false; }
    },
  };
}
