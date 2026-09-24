import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import * as store from '@/state/store';
import { MemoryReviewPanel, MemoryReviewSession, MemoryReviewText } from './MemoryReviewPanel';
import { MEMORY_REVIEW_API, MEMORY_REVIEW_ERRORS, type MemoryReviewItem, type MemoryReviewPreview } from '@shared/hermes-memory-review';

const first = '00000010', second = '00000020', digest = 'a'.repeat(64);
const row = (id = first, state: MemoryReviewItem['state'] = 'pending'): MemoryReviewItem => ({ id, state, action: 'replace', target: 'user', origin: 'foreground', createdAt: 1700000000000, decision: null, reviewDigest: null });
const preview = (id = first, reviewDigest = digest): MemoryReviewPreview => ({ version: 1, id, target: 'user', action: 'replace', origin: 'foreground', createdAt: 1700000000000, reviewDigest, before: 'Use Australian English.\n', after: 'Use Australian English.\n  Keep updates concise.\n', operationCount: 1, charLimit: 5000 });
const page = (items = [row()], nextCursor: string | null = null, total = items.length) => ({ version: 1, items, nextCursor, total, held: items.filter(item => item.state === 'recovery-required' || item.state === 'unavailable').length });
const receipt = (id = first, state: 'applied' | 'rejected' = 'applied', reviewDigest = digest) => ({ version: 1, id, state, reviewDigest, changed: state === 'applied', at: 1700000000001 });
function deferred<T = unknown>() { let resolve!: (value: T) => void; let reject!: (cause: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function transport() {
  const calls: { path: string; init?: RequestInit; response: ReturnType<typeof deferred> }[] = [];
  const session = new MemoryReviewSession((path, init) => { const response = deferred(); calls.push({ path, init, response }); return response.promise; });
  return { session, calls };
}
async function load(session: MemoryReviewSession, calls: ReturnType<typeof transport>['calls'], items = [row()]) {
  const loading = session.refresh(); calls.at(-1)!.response.resolve(page(items)); await loading;
}
async function select(session: MemoryReviewSession, calls: ReturnType<typeof transport>['calls'], id = first, value = preview(id)) {
  const loading = session.select(id); calls.at(-1)!.response.resolve(value); await loading;
}

// These exercise the same request coordinator used by the rendered component;
// the root application QA separately mounts the real screen and HTTP service.
describe('memory review decisions and reconciliation', () => {
  it('requires explicit approval, sends only the displayed digest and decision, and ignores a double click', async () => {
    const { session, calls } = transport(); await load(session, calls); await select(session, calls);
    await session.decide('approve'); expect(calls).toHaveLength(2);
    session.confirm(true); const applying = session.decide('approve'); const duplicate = session.decide('approve'); await duplicate;
    expect(calls).toHaveLength(3);
    expect(calls[2].path).toBe(`${MEMORY_REVIEW_API}/${first}/decision`);
    expect(calls[2].init).toEqual({ method: 'POST', body: JSON.stringify({ expectedDigest: digest, decision: 'approve' }) });
    expect(session.getSnapshot().selected?.state).toBe('pending');
    expect(session.getSnapshot().notice).not.toContain('was applied');
    calls[2].response.resolve(receipt()); await applying;
    expect(session.getSnapshot().selected?.state).toBe('applied');
    expect(session.getSnapshot().preview).toBeNull(); expect(session.getSnapshot().confirmed).toBe(false);
    await session.decide('approve'); expect(calls).toHaveLength(3);
  });

  it('serializes selection, start and refresh so an overlapping gesture cannot discard a valid first preview', async () => {
    const { session, calls } = transport(); await load(session, calls, [row(), row(second)]);
    const firstRead = session.select(first);
    await session.select(second); await session.refresh(); session.start();
    expect(calls).toHaveLength(2); expect(session.getSnapshot().selected?.id).toBe(first);
    calls[1].response.resolve(preview()); await firstRead;
    expect(session.getSnapshot().preview?.id).toBe(first); expect(session.getSnapshot().error).toBe('');
    session.confirm(true); const next = session.select(second);
    expect(session.getSnapshot().preview).toBeNull(); expect(session.getSnapshot().confirmed).toBe(false);
    calls[2].response.resolve(preview(second, 'b'.repeat(64))); await next;
    expect(session.getSnapshot().preview?.id).toBe(second); expect(session.getSnapshot().preview?.reviewDigest).toBe('b'.repeat(64));
    await session.decide('approve'); expect(calls).toHaveLength(3);
  });

  it('clears confirmation on refresh, suppresses concurrent reads, and refuses a mismatched proposal response', async () => {
    const { session, calls } = transport(); await load(session, calls); await select(session, calls); session.confirm(true);
    const refresh = session.refresh(); await session.refresh(); await session.select(first);
    expect(calls).toHaveLength(3); expect(session.getSnapshot().preview).toBeNull(); expect(session.getSnapshot().confirmed).toBe(false);
    calls[2].response.resolve(page()); await refresh;
    const mismatch = session.select(first); calls[3].response.resolve(preview(second)); await mismatch;
    expect(session.getSnapshot().error).toBe(MEMORY_REVIEW_ERRORS['stale-review']);
    expect(session.getSnapshot().preview).toBeNull(); session.confirm(true); await session.decide('approve'); expect(calls).toHaveLength(4);
  });

  it('drains a stopped lifecycle before its replacement reads and never adopts its stale preview', async () => {
    const { session, calls } = transport(); await load(session, calls);
    const oldRead = session.select(first); session.stop(); session.start(); session.start();
    expect(calls).toHaveLength(2); expect(session.getSnapshot().preview).toBeNull();
    calls[1].response.resolve(preview()); await oldRead;
    expect(calls).toHaveLength(3); expect(calls[2].path).toBe(MEMORY_REVIEW_API); expect(session.getSnapshot().preview).toBeNull();
    calls[2].response.resolve(page()); await vi.waitFor(() => expect(session.getSnapshot().busy).toBeNull());
    expect(session.getSnapshot().preview).toBeNull(); expect(session.getSnapshot().loaded).toBe(true);
    await select(session, calls, first, preview(first, 'b'.repeat(64))); expect(session.getSnapshot().preview?.reviewDigest).toBe('b'.repeat(64));
  });

  it('survives StrictMode start-stop-start during the initial list without duplicate requests or a stuck busy state', async () => {
    const { session, calls } = transport(); session.start(); session.stop(); session.start();
    expect(calls).toHaveLength(1); calls[0].response.resolve(page([row(second)]));
    await vi.waitFor(() => expect(calls).toHaveLength(2)); expect(session.getSnapshot().items).toEqual([]);
    calls[1].response.resolve(page()); await vi.waitFor(() => expect(session.getSnapshot().busy).toBeNull());
    expect(session.getSnapshot().items.map(item => item.id)).toEqual([first]);
  });

  it('uses a client deadline that outlasts the helper deadline and kill grace', async () => {
    const request = vi.spyOn(store, 'api').mockResolvedValue(page());
    try { const session = new MemoryReviewSession(); await session.refresh(); expect(request).toHaveBeenCalledWith(MEMORY_REVIEW_API, undefined, { timeoutMs: 35_000 }); }
    finally { request.mockRestore(); }
  });

  it('retains and reconciles a timed-out decision on its own bounded page before permitting any retry', async () => {
    const { session, calls } = transport(); await load(session, calls); await select(session, calls); session.confirm(true);
    const decision = session.decide('approve'); calls[2].response.reject(new Error('fictional account@example.invalid token ak_do_not_render'));
    await Promise.resolve(); await Promise.resolve();
    expect(session.getSnapshot().preview).toBeNull(); expect(session.getSnapshot().selected?.id).toBe(first);
    expect(session.getSnapshot().selected?.state).toBe('pending');
    await session.decide('approve'); expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1);
    calls[3].response.resolve(page([row('00000001')], '00000001', 2)); await Promise.resolve(); await Promise.resolve();
    expect(calls[4].path).toBe(`${MEMORY_REVIEW_API}?cursor=0000000f`);
    calls[4].response.resolve(page([{ ...row(first, 'applied'), decision: 'approve', reviewDigest: digest }], null, 2)); await decision;
    expect(session.getSnapshot().selected?.state).toBe('applied');
    expect(session.getSnapshot().notice).toContain('saved record confirms');
    expect(JSON.stringify(session.getSnapshot())).not.toContain('account@example.invalid');
    expect(JSON.stringify(session.getSnapshot())).not.toContain('ak_do_not_render');
    await session.decide('approve'); expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1);
  });

  it('keeps failed reconciliation uncertain rather than missing and never retries a decision before saved-state confirmation', async () => {
    const { session, calls } = transport(); await load(session, calls); await select(session, calls); session.confirm(true);
    const decision = session.decide('approve'); calls[2].response.resolve(receipt(second));
    await Promise.resolve(); await Promise.resolve(); calls[3].response.reject(new Error('untrusted raw error')); await decision;
    expect(session.getSnapshot().missing).toBe(false); expect(session.getSnapshot().needsCheck).toBe(true); expect(session.getSnapshot().preview).toBeNull();
    expect(session.getSnapshot().error).not.toContain('no longer listed');
    session.confirm(true); await session.decide('approve'); expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1);
    const uncertainSelection = session.select(first); expect(calls[4].path).toBe(MEMORY_REVIEW_API);
    calls[4].response.reject(new Error('saved-state read still unavailable')); await uncertainSelection;
    expect(session.getSnapshot().missing).toBe(false); expect(session.getSnapshot().needsCheck).toBe(true);
    await session.decide('approve'); expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1);
    const refresh = session.refresh(); calls[5].response.resolve(page()); await refresh;
    expect(session.getSnapshot().needsCheck).toBe(false); await session.decide('approve'); expect(calls).toHaveLength(6);
    await select(session, calls, first, preview(first, 'c'.repeat(64))); expect(session.getSnapshot().confirmed).toBe(false);
    session.confirm(true); const retry = session.decide('approve'); expect(JSON.parse(calls[7].init!.body as string)).toEqual({ expectedDigest: 'c'.repeat(64), decision: 'approve' });
    calls[7].response.resolve(receipt(first, 'applied', 'c'.repeat(64))); await retry;
  });

  it.each([
    ['applied', 'approve', 'b'.repeat(64)],
    ['recovery-required', 'approve', 'b'.repeat(64)],
    ['rejected', 'reject', digest],
    ['recovery-required', 'reject', digest],
  ] as const)('holds a saved %s record whose decision or digest differs from the uncertain approval (%s, %s)', async (state, savedDecision, savedDigest) => {
    const { session, calls } = transport(); await load(session, calls); await select(session, calls); session.confirm(true);
    const deciding = session.decide('approve'); calls[2].response.reject(new Error('response lost after dispatch'));
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    const foreign = { ...row(first, state), decision: savedDecision, reviewDigest: savedDigest };
    calls[3].response.resolve(page([foreign])); await deciding;
    expect(session.getSnapshot()).toMatchObject({ selected: row(), missing: false, needsCheck: true, preview: null, confirmed: false, error: MEMORY_REVIEW_ERRORS.conflict });
    expect(session.getSnapshot().items).toEqual([row()]);
    expect(session.getSnapshot().notice).toContain('does not match the decision you reviewed');
    expect(session.getSnapshot().notice).not.toContain('was applied');
    session.confirm(true); await session.decide('approve'); await session.decide('approve', true); await session.decide('reject', true);
    expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1);
    // Selecting the held item must reconcile, not preview or resume the other receipt.
    const checking = session.select(first); expect(calls[4].path).toBe(MEMORY_REVIEW_API);
    calls[4].response.resolve(page([foreign])); await checking;
    expect(session.getSnapshot().needsCheck).toBe(true); expect(session.getSnapshot().selected).toEqual(row());
    const refresh = session.refresh();
    calls[5].response.resolve(page([{ ...row(first, 'applied'), decision: 'approve', reviewDigest: digest }])); await refresh;
    expect(session.getSnapshot().needsCheck).toBe(false); expect(session.getSnapshot().selected?.state).toBe('applied');
    expect(session.getSnapshot().notice).toContain('saved record confirms');
  });

  it('keeps the dispatched digest across stop-start mid-decision and holds a replacement profile receipt', async () => {
    const { session, calls } = transport(); await load(session, calls); await select(session, calls); session.confirm(true);
    const deciding = session.decide('approve'); session.stop(); session.start();
    expect(session.getSnapshot().needsCheck).toBe(true); expect(calls).toHaveLength(3);
    calls[2].response.resolve(receipt()); await deciding;
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    // The previous lifecycle's successful response cannot confirm this lifecycle's profile.
    expect(session.getSnapshot().selected?.state).toBe('pending');
    calls[3].response.resolve(page([{ ...row(first, 'recovery-required'), decision: 'approve', reviewDigest: 'b'.repeat(64) }]));
    await vi.waitFor(() => expect(session.getSnapshot().busy).toBeNull());
    expect(session.getSnapshot()).toMatchObject({ needsCheck: true, missing: false, selected: row(), error: MEMORY_REVIEW_ERRORS.conflict, preview: null, confirmed: false });
    await session.decide('approve', true); expect(calls.filter(call => call.init?.method === 'POST')).toHaveLength(1);
  });

  it('allows an explicit resume after an uncertain request is reconciled to its exact saved approval', async () => {
    const { session, calls } = transport(); await load(session, calls); await select(session, calls); session.confirm(true);
    const deciding = session.decide('approve'); calls[2].response.reject(new Error('response lost after dispatch'));
    await vi.waitFor(() => expect(calls).toHaveLength(4));
    calls[3].response.resolve(page([{ ...row(first, 'recovery-required'), decision: 'approve', reviewDigest: digest }])); await deciding;
    expect(session.getSnapshot().needsCheck).toBe(false); expect(session.getSnapshot().selected?.state).toBe('recovery-required');
    await session.decide('approve'); expect(calls).toHaveLength(4);
    const resume = session.decide('approve', true);
    expect(JSON.parse(calls[4].init!.body as string)).toEqual({ expectedDigest: digest, decision: 'approve' });
    calls[4].response.resolve(receipt()); await resume;
    expect(session.getSnapshot().selected?.state).toBe('applied');
  });

  it('resumes only an already recorded decision and never creates a fresh approval from a recovery item', async () => {
    const { session, calls } = transport(); await load(session, calls, [{ ...row(first, 'recovery-required'), decision: 'reject', reviewDigest: digest }]); await session.select(first);
    session.confirm(true); await session.decide('approve'); await session.decide('approve', true); expect(calls).toHaveLength(1);
    const resume = session.decide('reject', true);
    expect(JSON.parse(calls[1].init!.body as string)).toEqual({ expectedDigest: digest, decision: 'reject' });
    calls[1].response.resolve(receipt(first, 'rejected')); await resume;
    expect(session.getSnapshot().selected?.state).toBe('rejected');
  });

  it('permits rejection without an approval checkbox and requires a matching saved receipt', async () => {
    const { session, calls } = transport(); await load(session, calls); await select(session, calls);
    const reject = session.decide('reject'); expect(JSON.parse(calls[2].init!.body as string)).toEqual({ expectedDigest: digest, decision: 'reject' });
    calls[2].response.resolve(receipt(first, 'rejected')); await reject;
    expect(session.getSnapshot().notice).toContain('saved preferences were not changed');
  });

  it('fails closed for extra private fields, nonadvancing pages, and late replies after leaving the screen', async () => {
    const { session, calls } = transport(); const invalid = session.refresh(); calls[0].response.resolve({ ...page(), accountKey: 'fictional-secret' }); await invalid;
    expect(session.getSnapshot().items).toEqual([]); expect(session.getSnapshot().error).toBe(MEMORY_REVIEW_ERRORS.unavailable);
    const loading = session.refresh(); calls[1].response.resolve(page([row()], first, 2)); await loading;
    const more = session.refresh(true); calls[2].response.resolve(page([row()], first, 2)); await more;
    expect(session.getSnapshot().items).toHaveLength(1); expect(session.getSnapshot().error).toBe(MEMORY_REVIEW_ERRORS.unavailable);
    const leaving = session.select(first); session.stop(); const snapshot = session.getSnapshot(); calls[3].response.resolve(preview()); await leaving;
    expect(session.getSnapshot()).toBe(snapshot);
  });
});

describe('memory review rendering boundaries', () => {
  it('renders complete text literally without HTML or Markdown interpretation and supports keyboard scrolling', () => {
    const literal = '  <script>alert("fixture")</script>\n**not formatting**\t[link](https://example.invalid)\n';
    const html = renderToStaticMarkup(createElement(MemoryReviewText, { label: 'Before', value: literal }));
    expect(html).toContain('tabindex="0"'); expect(html).toContain('white-space:pre'); expect(html).toContain('overflow-auto');
    expect(html).toContain('  &lt;script&gt;alert(&quot;fixture&quot;)&lt;/script&gt;\n**not formatting**\t[link](https://example.invalid)\n');
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<a '); expect(html).not.toContain('<strong>');
  });
  it('explains the business boundary and future conversation timing without an ongoing approval control', () => {
    const html = renderToStaticMarkup(createElement(MemoryReviewPanel));
    expect(html).toContain('do not update business records or grant permission to do work');
    expect(html).toContain('may require a new conversation'); expect(html).toContain('Refresh memory reviews');
    expect(html).not.toContain('Always approve'); expect(html).not.toContain('Apply reviewed change');
  });
});
