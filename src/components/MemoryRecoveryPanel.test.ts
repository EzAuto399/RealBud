import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import * as store from '@/state/store';
import { MEMORY_REVIEW_API, MEMORY_REVIEW_ERRORS } from '@shared/hermes-memory-review';
import { MEMORY_RECOVERY_API, type MemoryRecoveryItem } from '@shared/hermes-memory-recovery';
import { MemoryRecoveryPanel, MemoryRecoverySession, MemoryReviewRequestCoordinator } from './MemoryRecoveryPanel';
import { MemoryReviewSession } from './MemoryReviewPanel';

const key = `${'8'.repeat(62)}10`, second = `${'8'.repeat(62)}20`, earlier = `${'0'.repeat(63)}1`, digest = 'a'.repeat(64);
const row = (recordKey = key, state: MemoryRecoveryItem['state'] = 'interrupted', recoveryDigest = digest): MemoryRecoveryItem => ({
  key: recordKey, state, createdAt: 1700000000000, closedAt: state === 'closed' ? 1700000000100 : null,
  recoveryDigest: state === 'recovery-required' ? null : recoveryDigest,
});
const page = (items = [row()], nextCursor: string | null = null) => ({ version: 1, items, nextCursor });
const receipt = (recordKey = key, recoveryDigest = digest) => ({ version: 1, key: recordKey, state: 'closed', closedAt: 1700000000100, recoveryDigest });
function deferred<T = unknown>() {
  let resolve!: (value: T) => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function transport() {
  const calls: { path: string; init?: RequestInit; response: ReturnType<typeof deferred> }[] = [];
  const request = (path: string, init?: RequestInit) => { const response = deferred(); calls.push({ path, init, response }); return response.promise; };
  const session = new MemoryRecoverySession(request);
  return { session, calls, request };
}
async function load(session: MemoryRecoverySession, calls: ReturnType<typeof transport>['calls'], items = [row()], cursor: string | null = null) {
  const loading = session.refresh(); calls.at(-1)!.response.resolve(page(items, cursor)); await loading;
}
async function prepare(fixture: ReturnType<typeof transport>) {
  await load(fixture.session, fixture.calls); await fixture.session.select(key); fixture.session.confirm(true);
}
const postCalls = (calls: ReturnType<typeof transport>['calls']) => calls.filter(call => call.init?.method === 'POST');

describe('interrupted proposal closures', () => {
  it('requires explicit confirmation, binds the exact digest, and ignores duplicate or competing actions', async () => {
    const { session, calls } = transport(); await load(session, calls, [row(), row(second)]); await session.select(key);
    await session.close(); expect(calls).toHaveLength(1);
    session.confirm(true); const closing = session.close();
    await session.close(); await session.select(second); await session.refresh(); session.start();
    expect(calls).toHaveLength(2); expect(session.getSnapshot().selected?.key).toBe(key);
    expect(calls[1]).toMatchObject({ path: `${MEMORY_RECOVERY_API}/${key}/close`, init: { method: 'POST', body: JSON.stringify({ expectedDigest: digest }) } });
    expect(session.getSnapshot().selected?.state).toBe('interrupted'); expect(session.getSnapshot().notice).not.toContain('confirms');
    calls[1].response.resolve(receipt()); await closing;
    expect(session.getSnapshot()).toMatchObject({ selected: row(key, 'closed'), confirmed: false, needsCheck: false, busy: null });
    expect(session.getSnapshot().notice).toContain('saved record confirms');
    await session.close(); expect(postCalls(calls)).toHaveLength(1);
  });

  it('invalidates confirmation on a different selection and every refresh', async () => {
    const { session, calls } = transport(); await load(session, calls, [row(), row(second)]); await session.select(key); session.confirm(true);
    await session.select(second); expect(session.getSnapshot().confirmed).toBe(false); await session.close(); expect(calls).toHaveLength(1);
    session.confirm(true); const checking = session.refresh(); session.confirm(true); await session.close();
    expect(session.getSnapshot().confirmed).toBe(false); calls[1].response.resolve(page([row(), row(second)])); await checking;
    await session.close(); expect(postCalls(calls)).toHaveLength(0);
  });

  it.each(['closed', 'recovery-required'] as const)('never offers a fresh closure for a %s record', async state => {
    const { session, calls } = transport(); await load(session, calls, [row(key, state)]); await session.select(key);
    session.confirm(true); await session.close(); expect(session.getSnapshot().confirmed).toBe(false); expect(calls).toHaveLength(1);
  });

  it('reconciles a lost response on a bounded full-width cursor page without automatically retrying the POST', async () => {
    const fixture = transport(), { session, calls } = fixture; await prepare(fixture);
    const closing = session.close(); calls[1].response.reject(new Error('fictional ak_secret@example.invalid /private/profile'));
    await vi.waitFor(() => expect(calls).toHaveLength(3));
    expect(session.getSnapshot().needsCheck).toBe(true); session.confirm(true); await session.close();
    calls[2].response.resolve(page([row(earlier)], earlier));
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    expect(calls[3].path).toBe(`${MEMORY_RECOVERY_API}?cursor=${'8'.repeat(62)}0f`);
    calls[3].response.resolve(page([row(key, 'closed')])); await closing;
    expect(session.getSnapshot()).toMatchObject({ needsCheck: false, missing: false, selected: row(key, 'closed') });
    expect(session.getSnapshot().notice).toContain('saved record confirms'); expect(postCalls(calls)).toHaveLength(1);
    expect(JSON.stringify(session.getSnapshot())).not.toContain('ak_secret'); expect(JSON.stringify(session.getSnapshot())).not.toContain('/private/profile');
  });

  it.each([
    ['different digest', row(key, 'closed', 'b'.repeat(64))],
    ['changed interrupted draft', row(key, 'interrupted', 'b'.repeat(64))],
    ['unreadable recovery record', row(key, 'recovery-required')],
  ])('holds a %s after an uncertain close until the exact saved version is found', async (_name, foreign) => {
    const fixture = transport(), { session, calls } = fixture; await prepare(fixture);
    const closing = session.close(); calls[1].response.resolve(receipt(second));
    await vi.waitFor(() => expect(calls).toHaveLength(3)); calls[2].response.resolve(page([foreign as MemoryRecoveryItem])); await closing;
    expect(session.getSnapshot()).toMatchObject({ selected: row(), needsCheck: true, missing: false, confirmed: false, error: MEMORY_REVIEW_ERRORS.conflict });
    expect(session.getSnapshot().items).toEqual([row()]); expect(session.getSnapshot().notice).not.toContain('confirms');
    session.confirm(true); await session.close(); expect(postCalls(calls)).toHaveLength(1);
    const reselect = session.select(key); expect(calls[3].path).toBe(MEMORY_RECOVERY_API);
    calls[3].response.resolve(page([row(key, 'closed')])); await reselect;
    expect(session.getSnapshot().needsCheck).toBe(false); expect(session.getSnapshot().notice).toContain('saved record confirms');
  });

  it('holds an absent selected row and does not mistake an unrelated closed row for its receipt', async () => {
    const fixture = transport(), { session, calls } = fixture; await prepare(fixture);
    const closing = session.close(); calls[1].response.reject(new Error('lost response'));
    await vi.waitFor(() => expect(calls).toHaveLength(3)); calls[2].response.resolve(page([row(second, 'closed')]));
    await vi.waitFor(() => expect(calls).toHaveLength(4)); calls[3].response.resolve(page([row(second, 'closed')])); await closing;
    expect(session.getSnapshot()).toMatchObject({ selected: row(), needsCheck: true, missing: true, confirmed: false });
    expect(session.getSnapshot().notice).not.toContain('confirms'); session.confirm(true); await session.close(); expect(postCalls(calls)).toHaveLength(1);
    const checking = session.refresh(); calls[4].response.resolve(page([row(key, 'closed')])); await checking;
    expect(session.getSnapshot()).toMatchObject({ needsCheck: false, missing: false, selected: row(key, 'closed') });
  });

  it('allows another explicit close only after an exact still-interrupted row and a fresh confirmation', async () => {
    const fixture = transport(), { session, calls } = fixture; await prepare(fixture);
    const closing = session.close(); calls[1].response.resolve(receipt(key, 'b'.repeat(64)));
    await vi.waitFor(() => expect(calls).toHaveLength(3)); calls[2].response.resolve(page()); await closing;
    expect(session.getSnapshot()).toMatchObject({ selected: row(), needsCheck: false, confirmed: false });
    expect(session.getSnapshot().notice).toContain('still interrupted'); expect(session.getSnapshot().notice).not.toContain('confirms');
    await session.close(); expect(postCalls(calls)).toHaveLength(1);
    session.confirm(true); const retry = session.close(); expect(postCalls(calls)).toHaveLength(2);
    calls[3].response.resolve(receipt()); await retry;
  });

  it('keeps uncertainty across failed reconciliation and another selection without disclosing transport errors', async () => {
    const fixture = transport(), { session, calls } = fixture; await load(session, calls, [row(), row(second)]); await session.select(key); session.confirm(true);
    const closing = session.close(); calls[1].response.reject(new Error('fictional-secret'));
    await vi.waitFor(() => expect(calls).toHaveLength(3)); calls[2].response.reject(new Error('fictional-private-path')); await closing;
    expect(session.getSnapshot()).toMatchObject({ needsCheck: true, missing: false, selected: row() });
    await session.select(second); const checking = session.select(key); expect(calls[3].path).toBe(MEMORY_RECOVERY_API);
    calls[3].response.reject(new Error('still unavailable')); await checking;
    session.confirm(true); await session.close(); expect(postCalls(calls)).toHaveLength(1);
    expect(JSON.stringify(session.getSnapshot())).not.toContain('fictional-');
  });

  it('drains StrictMode initial reads, ignores stale replies, and resets confirmation on restart', async () => {
    const { session, calls } = transport(); session.start(); session.stop(); session.start(); session.start();
    expect(calls).toHaveLength(1); calls[0].response.resolve(page([row(second)]));
    await vi.waitFor(() => expect(calls).toHaveLength(2)); expect(session.getSnapshot().items).toEqual([]);
    calls[1].response.resolve(page()); await vi.waitFor(() => expect(session.getSnapshot().busy).toBeNull());
    await session.select(key); session.confirm(true); session.stop(); session.start();
    expect(session.getSnapshot().confirmed).toBe(false); calls[2].response.resolve(page()); await vi.waitFor(() => expect(session.getSnapshot().busy).toBeNull());
    await session.close(); expect(postCalls(calls)).toHaveLength(0);
  });

  it('preserves the dispatched digest across stop-start and checks saved state before trusting a late success', async () => {
    const fixture = transport(), { session, calls } = fixture; await prepare(fixture);
    const closing = session.close(); session.stop(); session.start();
    expect(calls).toHaveLength(2); expect(session.getSnapshot().needsCheck).toBe(true);
    calls[1].response.resolve(receipt()); await closing;
    await vi.waitFor(() => expect(calls).toHaveLength(3)); expect(session.getSnapshot().selected?.state).toBe('interrupted');
    calls[2].response.resolve(page([row(key, 'closed', 'b'.repeat(64))])); await vi.waitFor(() => expect(session.getSnapshot().busy).toBeNull());
    expect(session.getSnapshot()).toMatchObject({ needsCheck: true, selected: row(), confirmed: false, error: MEMORY_REVIEW_ERRORS.conflict });
    await session.close(); expect(postCalls(calls)).toHaveLength(1);
  });

  it('rejects extra fields and nonadvancing pages without replacing existing rows', async () => {
    const { session, calls } = transport(); const first = session.refresh(); calls[0].response.resolve({ ...page(), privateProfile: 'fictional-secret' }); await first;
    expect(session.getSnapshot()).toMatchObject({ loaded: false, items: [], error: MEMORY_REVIEW_ERRORS.unavailable });
    await load(session, calls, [row()], key); const more = session.refresh(true); calls[2].response.resolve(page([row()], key)); await more;
    expect(session.getSnapshot().items).toEqual([row()]); expect(session.getSnapshot().error).toBe(MEMORY_REVIEW_ERRORS.unavailable);
    expect(JSON.stringify(session.getSnapshot())).not.toContain('fictional-secret');
  });

  it('treats a closure with extra fields as unknown and checks saved state rather than trusting it', async () => {
    const fixture = transport(), { session, calls } = fixture; await prepare(fixture);
    const closing = session.close(); calls[1].response.resolve({ ...receipt(), helperAuthority: 'fictional-secret' });
    await vi.waitFor(() => expect(calls).toHaveLength(3)); expect(session.getSnapshot().needsCheck).toBe(true);
    calls[2].response.resolve(page([row(key, 'closed')])); await closing;
    expect(JSON.stringify(session.getSnapshot())).not.toContain('fictional-secret'); expect(postCalls(calls)).toHaveLength(1);
  });

  it('respects the Windows hold and uses the established client deadline', async () => {
    const request = vi.spyOn(store, 'api').mockRejectedValue(new Error(MEMORY_REVIEW_ERRORS['platform-unverified']));
    try {
      const session = new MemoryRecoverySession(); await session.refresh(); session.confirm(true); await session.close();
      expect(request).toHaveBeenCalledExactlyOnceWith(MEMORY_RECOVERY_API, undefined, { timeoutMs: 35_000 });
      expect(session.getSnapshot()).toMatchObject({ items: [], error: MEMORY_REVIEW_ERRORS['platform-unverified'], confirmed: false });
    } finally { request.mockRestore(); }
  });
});

describe('shared memory request queue and recovery rendering', () => {
  it('serializes the real normal and recovery sessions, including initial reads, and drains rejected requests', async () => {
    const { calls, request } = transport(), coordinator = new MemoryReviewRequestCoordinator(request);
    const normal = new MemoryReviewSession(coordinator.request), recovery = new MemoryRecoverySession(coordinator.request);
    const a = normal.refresh(), b = recovery.refresh();
    expect(coordinator.getSnapshot()).toBe(true); await vi.waitFor(() => expect(calls).toHaveLength(1)); expect(calls[0].path).toBe(MEMORY_REVIEW_API);
    calls[0].response.reject(new Error('read failed')); await a;
    await vi.waitFor(() => expect(calls).toHaveLength(2)); expect(calls[1].path).toBe(MEMORY_RECOVERY_API); expect(coordinator.getSnapshot()).toBe(true);
    calls[1].response.resolve(page()); await b; expect(coordinator.getSnapshot()).toBe(false); expect(recovery.getSnapshot().loaded).toBe(true);
    const c = normal.refresh(); await vi.waitFor(() => expect(calls).toHaveLength(3));
    calls[2].response.resolve({ version: 1, items: [], nextCursor: null, total: 0, held: 0 }); await c;
    expect(normal.getSnapshot().loaded).toBe(true); expect(coordinator.getSnapshot()).toBe(false);
  });

  it('keeps controls disabled while the other panel owns the queue and shows explicit closure confirmation', async () => {
    const fixture = transport(), { session, calls } = fixture; await load(session, calls); await session.select(key);
    const pending = deferred(), coordinator = new MemoryReviewRequestCoordinator(() => pending.promise);
    const otherRead = coordinator.request(MEMORY_REVIEW_API);
    const html = renderToStaticMarkup(createElement(MemoryRecoveryPanel, { session, coordinator }));
    expect(html).toContain('aria-label="Interrupted memory proposals" aria-busy="true"');
    expect(html).toMatch(/disabled=""[^>]*>Close interrupted proposal/);
    expect(html).toMatch(/type="checkbox"[^>]*disabled=""/);
    expect(html).toContain('Closing does not change saved preferences or undo an earlier memory decision.');
    expect(html).toContain('I understand that closing this interrupted proposal stops its retries');
    expect(html).not.toContain('never applied'); expect(html).not.toContain(digest);
    pending.resolve({}); await otherRead;
  });

  it('renders held and historical rows without an active close control', async () => {
    const { session, calls } = transport(), coordinator = new MemoryReviewRequestCoordinator();
    await load(session, calls, [row(key, 'closed'), row(second, 'recovery-required')]);
    await session.select(key); const history = renderToStaticMarkup(createElement(MemoryRecoveryPanel, { session, coordinator }));
    expect(history).toContain('This record was closed'); expect(history).not.toContain('Close interrupted proposal</button>');
    await session.select(second); const held = renderToStaticMarkup(createElement(MemoryRecoveryPanel, { session, coordinator }));
    expect(held).toContain('Contact your RealBud administrator'); expect(held).not.toContain('Close interrupted proposal</button>');
  });
});
