import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkflowDatabase } from '../../server/workflow-database.ts';
import { BillReviewDraftStore } from '../../server/bill-review-drafts.ts';
import type { SourceBillOccurrence } from '@shared/source-bills';
import type { BillFinancialReviewDraft, BillReviewDraft } from '@shared/bill-review-drafts';
import { financialConfirmationKey, financialObservation, financialObservedAt, financialObservedDraft, financialObservedInput, financialReviewRequest, matchesFinancialReceipt, newFinancialDraft, recoveredFinancialDraftReceipt } from './bill-financial-review';
import { BillReviewDraftCoordinator, draftValue } from './bill-review-drafts';

const bill: SourceBillOccurrence = {
  id: `source-bill:${'a'.repeat(64)}`, revision: 2, createdAt: 1, history: [], state: 'received',
  facts: { propertyId: 'p1', vendor: 'Fictional Water', kind: 'Water', amountCents: 12345, currency: 'AUD', invoiceDate: '2026-01-01', dueDate: '2026-02-01', invoiceNumber: '0001/A', invoiceVersion: '2', note: '' },
  source: { accountId: 'fictional-account', receiptId: 'receipt1', threadId: 'ab', identity: 'b'.repeat(64), digest: 'c'.repeat(64), message: { id: 'cd', at: 1, from: 'fiction@example.test', subject: 'Fictional invoice', body: 'Fictional source', attachments: [] } },
  seriesId: null, expectedArrivalDate: null, reviewedAt: 1, reviewedBy: 'host', reviewReason: 'Source checked',
};
const evidence: BillFinancialReviewDraft = { provenance: 'simulated', sourceKind: 'external-record', sourceIds: ' receipt-1 \n ledger-2 ', locator: ' Ledger page 2 ', accountContext: ' Fictional account ', observedAt: '2026-01-01T10:30:00.000Z', coverage: 'complete', entry: 'recorded', payment: 'arranged-unconfirmed', funding: 'insufficient', advance: 'outstanding', note: ' Reviewed scope ', reviewReason: ' Checked the fictional ledger ' };
const value = () => ({ ...newFinancialDraft(bill, 'workspace-a'), financialReview: { ...evidence } });
const retained = (): BillReviewDraft => ({ version: 1, id: '11111111-1111-4111-8111-111111111111', revision: 1, createdAt: 1, updatedAt: 1, ...value() });
const receipt = () => {
  const sent = financialReviewRequest(value());
  return { ...bill, revision: bill.revision + 1, financialReview: { ...sent.observation, version: 1 as const, basisBillRevision: sent.expectedRevision, sourceDigest: sent.expectedSourceDigest, reviewedAt: 2, reviewedBy: 'host', reviewReason: sent.reviewReason } };
};

describe('financial claim construction', () => {
  it('starts unknown independently of an accepted bill, with no saved source confirmation', () => {
    const draft = newFinancialDraft(bill, 'workspace-a');
    expect(draft).toMatchObject({ billId: bill.id, billRevision: 2, sourceDigest: bill.source.digest, proposalRequest: null, fields: { invoiceNumber: '0001/A', invoiceVersion: '2' } });
    expect(draft.financialReview).toMatchObject({ provenance: 'simulated', entry: 'unknown', payment: 'unknown', funding: 'unknown', advance: 'unknown', observedAt: '' });
    expect(draft).not.toHaveProperty('sourceReviewed');
    expect(draft.financialReview).not.toHaveProperty('sourceReviewed');
  });
  it('retains independent arranged payment, insufficient funding and outstanding advance', () => {
    const sent = financialReviewRequest(value());
    expect(sent).toMatchObject({ expectedRevision: 2, expectedSourceDigest: bill.source.digest, sourceReviewed: true, reviewReason: 'Checked the fictional ledger', observation: { sourceIds: ['receipt-1', 'ledger-2'], locator: 'Ledger page 2', accountContext: 'Fictional account', entry: 'recorded', payment: 'arranged-unconfirmed', funding: 'insufficient', advance: 'outstanding' } });
  });
  it.each(['sourceIds', 'locator', 'accountContext'] as const)('requires %s for nonunknown claims', key => {
    expect(() => financialObservation({ ...evidence, [key]: '' })).toThrow('provide evidence');
  });
  it.each(['csv-status', 'unknown'] as const)('holds financial claims from %s evidence', sourceKind => {
    expect(() => financialObservation({ ...evidence, sourceKind })).toThrow('cannot establish');
    expect(financialObservation({ ...evidence, sourceKind, entry: 'unknown', payment: 'unknown', funding: 'unknown', advance: 'unknown' }).payment).toBe('unknown');
  });
  it('does not infer an absent entry or advance from a partial check', () => {
    expect(() => financialObservation({ ...evidence, coverage: 'partial', entry: 'not-recorded' })).toThrow('complete check');
    expect(() => financialObservation({ ...evidence, coverage: 'partial', advance: 'none' })).toThrow('complete check');
    expect(() => financialObservation({ ...evidence, coverage: 'unknown' })).toThrow('scope');
  });
  it('does not infer account entry from a document that can support a payment claim', () => {
    expect(() => financialObservation({ ...evidence, sourceKind: 'document' })).toThrow('external record');
    expect(financialObservation({ ...evidence, sourceKind: 'document', entry: 'unknown', payment: 'confirmed-paid' }).payment).toBe('confirmed-paid');
  });
  it('rejects duplicate, excessive and malformed evidence references', () => {
    for (const sourceIds of ['one\none', 'a'.repeat(201), 'one\u0000', Array.from({ length: 21 }, (_, i) => String(i)).join('\n')]) expect(() => financialObservation({ ...evidence, sourceIds })).toThrow('evidence references');
  });
  it('requires an explicit valid observation time and reason', () => {
    for (const date of ['', '2026-02-30T10:30:00.000Z', '2026-01-01', '2099-01-01T00:00:00.000Z', '2026-01-01T10:30']) expect(() => financialObservedAt(date)).toThrow();
    expect(financialObservedAt('2026-01-01T10:30:00.000Z')).toBe(Date.UTC(2026, 0, 1, 10, 30));
    expect(() => financialReviewRequest({ ...value(), financialReview: { ...evidence, reviewReason: ' ' } })).toThrow('Explain');
  });
  it('stores an absolute observation time so another device cannot reinterpret its timezone', () => {
    const local = '2026-01-01T10:30:00', saved = financialObservedDraft(local);
    expect(saved).toBe(new Date(local).toISOString());
    expect(financialObservedInput(saved)).toBe(local);
    expect(financialObservedDraft('2026-02-30T10:30')).toBe('2026-02-30T10:30');
  });
});

describe('financial claim receipt checks', () => {
  it('acknowledges only the exact immediately resulting claim after a lost response', () => {
    expect(matchesFinancialReceipt(receipt(), bill.id, financialReviewRequest(value()))).toBe(true);
  });
  it.each(['revision', 'source', 'reason', 'payment', 'basis', 'evidence', 'bill'] as const)('rejects mismatched %s readback', change => {
    const row = receipt();
    if (change === 'revision') row.revision++;
    if (change === 'source') row.source = { ...row.source, digest: 'e'.repeat(64) };
    if (change === 'reason') row.financialReview.reviewReason = 'Someone else reviewed';
    if (change === 'payment') row.financialReview.payment = 'confirmed-paid';
    if (change === 'basis') row.financialReview.basisBillRevision++;
    if (change === 'evidence') row.financialReview.sourceIds = ['other'];
    if (change === 'bill') row.id = `source-bill:${'d'.repeat(64)}`;
    expect(matchesFinancialReceipt(row, bill.id, financialReviewRequest(value()))).toBe(false);
  });
});

describe('financial draft preservation through existing encrypted-draft transport', () => {
  it('creates, edits and reopens the actual UI draft in the encrypted store without extra bill-fact fields', () => {
    const directory = mkdtempSync(join(tmpdir(), 'realbud-financial-ui-contract-')), key = Buffer.alloc(32, 73);
    let database = new WorkflowDatabase({ dir: directory, key });
    try {
      const store = new BillReviewDraftStore(database, { workspaceId: 'workspace-a', now: () => 1000 });
      const id = randomUUID(), initial = newFinancialDraft(bill, 'workspace-a');
      const created = store.create(id, null, initial);
      expect(created.fields).not.toHaveProperty('amountCents');
      expect(created.fields).not.toHaveProperty('currency');
      const entered = { ...initial, financialReview: { ...evidence, note: 'Fictional financial note that must survive reload' } };
      const saved = store.update(id, created.revision, entered);
      expect(readFileSync(join(directory, 'workflow-state.sqlite')).includes(Buffer.from(entered.financialReview.note))).toBe(false);
      database.close(); database = new WorkflowDatabase({ dir: directory, key });
      const reopened = new BillReviewDraftStore(database, { workspaceId: 'workspace-a' });
      expect(reopened.get(id)).toEqual(saved);
      expect(reopened.page().items).toEqual([expect.objectContaining({ id, hasFinancialReview: true })]);
      // The server contract remains strict; the original accidental spread is rejected.
      expect(() => reopened.create(randomUUID(), null, { ...initial, fields: { ...initial.fields, amountCents: 12345, currency: 'AUD' } })).toThrow(expect.objectContaining({ status: 400 }));
    } finally { database.close(); rmSync(directory, { recursive: true, force: true }); }
  });
  it('keeps the optional financial fields in the projection without adding them to legacy drafts', () => {
    const saved = retained(), projected = draftValue(saved);
    expect(projected.financialReview).toEqual(evidence);
    projected.financialReview!.note = 'Edited';
    expect(saved.financialReview?.note).toBe(evidence.note);
    const legacy = { ...saved }; delete legacy.financialReview;
    expect(draftValue(legacy)).not.toHaveProperty('financialReview');
  });
  it('keeps financial notes locally when a concurrent saved draft wins', async () => {
    const initial = retained(), remote = { ...retained(), revision: 2, financialReview: { ...evidence, note: 'Other window note' } };
    const coordinator = new BillReviewDraftCoordinator(async (_path, init) => { if (init?.method) throw new Error('CAS conflict'); return { draft: remote }; });
    coordinator.adopt(initial);
    coordinator.edit(initial.id, { ...draftValue(initial), financialReview: { ...evidence, note: 'My preserved note' } }, false);
    await expect(coordinator.flush(initial.workspaceId, initial.id)).rejects.toThrow('changed in another window');
    expect(coordinator.get(initial.workspaceId, initial.id)).toMatchObject({ dirty: true, conflict: true, value: { financialReview: { note: 'My preserved note' } }, remote: { financialReview: { note: 'Other window note' } } });
  });
  it('accepts an exact financial draft readback after a lost save acknowledgment', async () => {
    const saved = retained();
    const coordinator = new BillReviewDraftCoordinator(async (_path, init) => { if (init?.method) throw new Error('lost response'); return { draft: saved }; });
    coordinator.edit(saved.id, draftValue(saved), false);
    expect(await coordinator.flush(saved.workspaceId, saved.id)).toMatchObject({ dirty: false, revision: 1, value: { financialReview: evidence } });
  });
  it('reopens a durable draft after a committed claim lost its reply and closes only the draft receipt', async () => {
    let durable = JSON.parse(JSON.stringify(retained())) as BillReviewDraft;
    const writes: string[] = [];
    const reopened = new BillReviewDraftCoordinator(async (path, init) => {
      if (!init?.method) return { draft: durable };
      writes.push(path);
      const sent = JSON.parse(String(init.body));
      durable = { ...durable, ...sent.value, revision: durable.revision + 1 };
      return { draft: durable };
    });
    reopened.adopt(durable);
    // The renderer and its confirmation were lost; only server-persisted data remains.
    const restored = reopened.get(durable.workspaceId, durable.id)!;
    const savedClaim = recoveredFinancialDraftReceipt(restored.value, receipt());
    expect(savedClaim?.revision).toBe(3);
    expect(restored.value.billRevision).toBe(2);
    expect(restored.value.financialReview).not.toHaveProperty('sourceReviewed');
    reopened.edit(durable.id, { ...restored.value, state: 'accepted' }, false);
    await reopened.flush(durable.workspaceId, durable.id);
    expect(durable.state).toBe('accepted');
    expect(writes).toEqual([`/api/bill-review-drafts/${durable.id}`]);
    expect(savedClaim?.revision).toBe(3);
  });
  it('invalidates another panel’s confirmation when shared draft evidence or its bill binding changes', () => {
    const coordinator = new BillReviewDraftCoordinator(), initial = retained();
    coordinator.adopt(initial);
    const confirmed = financialConfirmationKey(coordinator.get(initial.workspaceId, initial.id)!.value);
    for (const changed of [
      { ...draftValue(initial), financialReview: { ...evidence, payment: 'confirmed-paid' as const } },
      { ...draftValue(initial), billRevision: 3 },
      { ...draftValue(initial), sourceDigest: 'f'.repeat(64) },
      { ...draftValue(initial), financialReview: { ...evidence, sourceIds: 'a different ledger' } },
    ]) {
      coordinator.edit(initial.id, changed, false);
      expect(financialConfirmationKey(coordinator.get(initial.workspaceId, initial.id)!.value)).not.toBe(confirmed);
      expect(recoveredFinancialDraftReceipt(changed, receipt())).toBeNull();
    }
  });
});
