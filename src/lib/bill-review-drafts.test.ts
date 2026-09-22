import { describe, expect, it } from 'vitest';
import type { BillReviewDraft, BillReviewDraftValue } from '@shared/bill-review-drafts';
import { BillReviewDraftCoordinator } from './bill-review-drafts';

const value = (): BillReviewDraftValue => ({ workspaceId: 'office-a', state: 'editing', billId: null, billRevision: null, itemId: null, messageId: null, sourceDigest: null,
  fields: { propertyId: '', kind: '', vendor: '', amount: '12.', invoiceDate: '', dueDate: '', note: 'Keep my raw note' }, billState: 'received', reason: '', seriesId: '', arrivalDate: '', proposalRequest: null });
const saved = (fields = value(), revision = 1, id = 'review-a'): BillReviewDraft => ({ version: 1, id, revision, createdAt: 1, updatedAt: revision, ...fields });
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

describe('encrypted bill-review draft coordinator', () => {
  it('serializes a later edit behind an in-flight create and preserves raw fields', async () => {
    const gate = deferred<{ draft: BillReviewDraft }>(), calls: any[] = [];
    const store = new BillReviewDraftCoordinator(async (_path, init) => { const body = JSON.parse(String(init?.body)); calls.push(body); return calls.length === 1 ? gate.promise : { draft: saved(body.value, 2) }; });
    store.edit('review-a', value(), false); const flush = store.flush('office-a', 'review-a');
    const newer = value(); newer.fields.note = 'Typed while saving'; store.edit('review-a', newer, false);
    gate.resolve({ draft: saved() }); await flush;
    expect(calls.map(call => call.expectedRevision)).toEqual([null, 1]);
    expect(calls[1].value.fields.amount).toBe('12.');
    expect(store.get('office-a', 'review-a')).toMatchObject({ revision: 2, dirty: false, value: { fields: { note: 'Typed while saving' } } });
  });
  it('reconciles an exact durable readback after a lost write response', async () => {
    const calls: string[] = [];
    const store = new BillReviewDraftCoordinator(async (path, init) => { calls.push(`${init?.method ?? 'GET'} ${path}`); if (init) throw new Error('Lost response'); return { draft: saved() }; });
    store.edit('review-a', value(), false); await store.flush('office-a', 'review-a');
    expect(calls).toEqual(['POST /api/bill-review-drafts', 'GET /api/bill-review-drafts/review-a']);
    expect(store.hasUnpersisted()).toBe(false);
  });
  it('keeps unsaved notes and request identity when persistence fails before dispatch', async () => {
    const fields = value(); fields.itemId = 'a'.repeat(64); fields.messageId = 'def'; fields.sourceDigest = 'b'.repeat(64);
    fields.proposalRequest = { requestId: 'request-a', itemId: fields.itemId, messageId: 'def', expectedSourceDigest: fields.sourceDigest };
    const store = new BillReviewDraftCoordinator(async () => { throw new Error('Disk unavailable'); });
    store.edit('review-a', fields, false);
    await expect(store.flush('office-a', 'review-a')).rejects.toThrow('Draft not saved');
    expect(store.get('office-a', 'review-a')?.value).toEqual(fields); expect(store.hasUnpersisted()).toBe(true);
  });
  it('holds a two-window CAS conflict without rebasing over the other staff note', async () => {
    const remote = value(); remote.fields.note = 'Other window note'; let writes = 0;
    const store = new BillReviewDraftCoordinator(async (_path, init) => { if (init) { writes++; throw Object.assign(new Error('Conflict'), { status: 409 }); } return { draft: saved(remote, 2) }; });
    store.adopt(saved()); const local = value(); local.fields.note = 'My newer note'; store.edit('review-a', local, false);
    await expect(store.flush('office-a', 'review-a')).rejects.toThrow('another window');
    await expect(store.flush('office-a', 'review-a')).rejects.toThrow('another window');
    expect(writes).toBe(1); expect(store.get('office-a', 'review-a')).toMatchObject({ revision: 1, conflict: true, value: { fields: { note: 'My newer note' } }, remote: { fields: { note: 'Other window note' } } });
  });
  it('does not let refresh or another mounted panel overwrite unacknowledged typing', () => {
    const store = new BillReviewDraftCoordinator(); store.adopt(saved()); const local = value(); local.fields.note = 'New typing'; store.edit('review-a', local, false);
    store.adopt(saved(value(), 3)); store.setActive('office-a', 'review-a');
    expect(store.get('office-a', store.activeId('office-a')!)?.value.fields.note).toBe('New typing');
    expect(store.get('office-b', 'review-a')).toBeUndefined();
  });
  it('rejects a save/readback from another workspace and keeps the original values', async () => {
    const foreign = saved({ ...value(), workspaceId: 'office-b' });
    const store = new BillReviewDraftCoordinator(async () => ({ draft: foreign }));
    store.edit('review-a', value(), false); await expect(store.flush('office-a', 'review-a')).rejects.toThrow('Draft not saved');
    expect(store.get('office-a', 'review-a')?.revision).toBeNull(); expect(store.hasUnpersisted()).toBe(true);
  });
  it('keeps a newer acknowledged save when an older read arrives later', async () => {
    const store = new BillReviewDraftCoordinator(async (_path, init) => ({ draft: saved(JSON.parse(String(init?.body)).value, 2) }));
    store.adopt(saved()); const newer = value(); newer.fields.note = 'Acknowledged revision two'; store.edit('review-a', newer, false);
    await store.flush('office-a', 'review-a'); store.adopt(saved());
    expect(store.get('office-a', 'review-a')).toMatchObject({ revision: 2, dirty: false, value: { fields: { note: 'Acknowledged revision two' } } });
    expect(() => store.adopt(saved(value(), 2))).toThrow('same saved revision');
    expect(store.get('office-a', 'review-a')?.value.fields.note).toBe('Acknowledged revision two');
  });
  it('preserves the exact request tuple in a saved separate conflict copy', async () => {
    const fields = value(); fields.proposalRequest = { requestId: 'same-request', itemId: 'a', messageId: 'b', expectedSourceDigest: 'c' };
    const store = new BillReviewDraftCoordinator(async (_path, init) => { const body = JSON.parse(String(init?.body)); return { draft: saved(body.value, 1, body.id) }; });
    store.edit('copy', fields, false); await store.flush('office-a', 'copy');
    expect(store.get('office-a', 'copy')?.value.proposalRequest).toEqual(fields.proposalRequest);
  });
});
