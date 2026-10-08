import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowDatabase } from './workflow-database.ts';
import { SourceBillRegister, previewBillSource, rankDuplicateCandidates } from './source-bills.ts';
import type { JevRequest, JevResult } from './jev-client.ts';
import { listExpectedBills, upsertExpectedBill } from './expected-bills.ts';
import { anchoredBillMonth, billDateInZone } from '../shared/bill-dates.ts';
import type { BillMailSource, BillFacts, BillCalendarEntry, BillDuplicateCheck, BillDuplicateCandidate } from '../shared/source-bills.ts';
import { sameBillFacts, isBillFinancialReviewStale } from '../shared/source-bills.ts';

const resources: { dir: string; db: WorkflowDatabase }[] = [];
afterEach(() => { for (const { dir, db } of resources.splice(0)) { db.close(); rmSync(dir, { recursive: true, force: true }); } });
const source = (overrides: Partial<BillMailSource['message']> = {}): BillMailSource => ({ accountId: 'fictional-account', receiptId: 'scan-one', threadId: 'thread-one', message: {
  id: 'message-one', at: Date.parse('2026-01-31T01:00:00Z'), from: 'utility@example.test', subject: 'Fictional water bill',
  body: `Fictional invoice ${overrides.id ?? 'message-one'} dated 2026-01-31 for $123.45, due 2026-02-20.`, bodyTruncated: false, attachments: [], ...overrides,
} });
const facts = (): BillFacts => ({ propertyId: 'property-one', kind: 'Water', vendor: 'Fictional utility', amountCents: 12345, currency: 'AUD', invoiceDate: '2026-01-31', dueDate: '2026-02-20', note: 'Reviewed fictional message' });
const acceptance = (s = source()) => ({ expectedSourceDigest: previewBillSource(s).digest, sourceReviewed: true, facts: facts(), reviewReason: 'Manually confirmed source and property' });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'realbud-source-bills-')), db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 7) });
  resources.push({ dir, db });
  return { dir, db, store: new SourceBillRegister(db, { dataDir: dir, now: () => Date.parse('2026-02-01T00:00:00Z') }) };
}
const range = { from: '2026-01-01', to: '2026-06-30' };
const pattern = (occurrenceId: string, revision = 1) => ({ occurrenceId, expectedOccurrenceRevision: revision, intervalMonths: 1, anchorDate: '2026-01-31', windowBeforeDays: 0, windowAfterDays: 0, timeZone: 'Australia/Brisbane', reviewReason: 'Customer confirmed monthly final-day arrival' });

describe('source-linked bill acceptance', () => {
  it('separates stable source identity/digest from acquisition receipt provenance', () => {
    const first = previewBillSource(source()), next = previewBillSource({ ...source(), receiptId: 'scan-two' });
    expect(next.identity).toBe(first.identity); expect(next.digest).toBe(first.digest); expect(next.receiptId).not.toBe(first.receiptId);
    expect(previewBillSource(source({ body: 'Changed evidence' })).digest).not.toBe(first.digest);
    expect(previewBillSource({ ...source(), accountId: 'other-account' }).identity).not.toBe(first.identity);
    expect(previewBillSource(source({ attachments: [{ id: 'attachment', name: 'invoice.pdf', mimeType: 'application/pdf', size: 5 }] })).digest).not.toBe(first.digest);
  });
  it('accepts exact reviewed source once across repeated scans, retains encrypted evidence and refuses changed facts without correction', () => {
    const { store, dir } = fixture(), s = source();
    const saved = store.accept(acceptance(s), s, 'reviewer');
    expect(saved.state).toBe('received'); expect(saved.source.message.body).toBe(s.message.body);
    expect(store.accept(acceptance(s), { ...s, receiptId: 'later-scan' }, 'reviewer')).toEqual(saved);
    expect(store.snapshot(range).occurrences).toHaveLength(1);
    expect(store.snapshot(range).series).toEqual([]);
    expect(readFileSync(join(dir, 'workflow-state.sqlite')).includes(Buffer.from(s.message.body))).toBe(false);
    expect(() => store.accept({ ...acceptance(s), facts: { ...facts(), amountCents: 999 } }, s, 'reviewer')).toThrow(/correction/);
    expect(() => store.accept(acceptance(s), source({ body: 'New body' }), 'reviewer')).toThrow(/changed/);
  });
  it('requires explicit source review and does not pretend to read attachments or missing body content', () => {
    const { store } = fixture(), s = source({ bodyTruncated: true, attachments: [{ id: 'a', name: 'bill.pdf', mimeType: 'application/pdf', size: null }] });
    expect(() => store.accept({ ...acceptance(s), sourceReviewed: false }, s, 'reviewer')).toThrow(/reviewed/);
    expect(() => store.accept(acceptance(s), s, 'reviewer')).toThrow(/attachments/);
    const saved = store.accept({ ...acceptance(s), limitedSourceAcknowledged: true }, s, 'reviewer');
    expect(saved.source.message.bodyTruncated).toBe(true); expect(saved.source.message.attachments).toHaveLength(1);
  });
  it.each([
    { dueDate: '2026-02-30' }, { invoiceDate: '2026-03-01', dueDate: '2026-02-20' }, { amountCents: 12.34 }, { amountCents: -5 }, { currency: 'USD' },
  ])('rejects unsupported financial/date facts without changing the register: %j', invalid => {
    const { store } = fixture();
    expect(() => store.accept({ ...acceptance(), facts: { ...facts(), ...invalid } }, source(), 'reviewer')).toThrow();
    expect(store.snapshot(range).occurrences).toEqual([]);
  });
  it('corrects with optimistic revision and retains previous facts/source/actor, including cancellation', () => {
    const { store } = fixture(), old = store.accept(acceptance(), source(), 'reviewer');
    const updatedSource = source({ id: 'corrected-message', body: 'Corrected source, due 2026-02-25' });
    const request = { ...acceptance(updatedSource), facts: { ...facts(), dueDate: '2026-02-25' }, expectedRevision: old.revision, state: 'hold' };
    const corrected = store.correct(old.id, request, updatedSource, 'second-reviewer');
    expect(corrected.revision).toBe(2); expect(corrected.history[0].source).toEqual(old.source);
    expect(corrected.history[0].facts.dueDate).toBe('2026-02-20'); expect(corrected.reviewedBy).toBe('second-reviewer');
    expect(() => store.correct(old.id, request, updatedSource, 'reviewer')).toThrow(/changed/);
    expect(() => store.accept(acceptance(), source(), 'reviewer')).toThrow(/correction/);
    expect(() => store.correct(old.id, { ...request, expectedRevision: 2, state: 'paid' }, updatedSource, 'reviewer')).toThrow(/Payment confirmation/);
    const cancelled = store.correct(old.id, { ...request, expectedRevision: 2, state: 'cancelled' }, updatedSource, 'reviewer');
    expect(cancelled.history).toHaveLength(2); expect(store.snapshot(range).calendar).toEqual([]);
  });
  it('refuses cross-account corrections and another bill’s source identity', () => {
    const { store } = fixture(), original = store.accept(acceptance(), source(), 'reviewer');
    const other = source({ id: 'another-message' }); store.accept(acceptance(other), other, 'reviewer');
    expect(() => store.correct(original.id, { ...acceptance(other), expectedRevision: 1, state: 'received' }, other, 'reviewer')).toThrow(/another saved bill/);
    const moved = { ...source(), accountId: 'unrelated-account' };
    expect(() => store.correct(original.id, { ...acceptance(moved), expectedRevision: 1, state: 'received' }, moved, 'reviewer')).toThrow(/original source account/);
  });
  it('preserves the legacy v1 file, blocks legacy mutation of sourced identities and holds corrupt legacy bytes', () => {
    const { store, dir } = fixture();
    upsertExpectedBill({ propertyId: 'legacy-property', kind: 'Legacy water', status: 'expected' }, dir);
    const path = join(dir, 'expected-bills.json'), legacy = readFileSync(path);
    const accepted = store.accept(acceptance(), source(), 'reviewer');
    expect(readFileSync(path)).toEqual(legacy); expect(listExpectedBills(dir)).toHaveLength(1);
    expect(() => upsertExpectedBill({ id: accepted.id, propertyId: 'other', kind: 'Other', status: 'paid' }, dir)).toThrow(/current revision/);
    writeFileSync(path, 'damaged original bytes');
    expect(() => store.snapshot(range)).toThrow(/preserved/);
    expect(() => store.accept(acceptance(), source(), 'reviewer')).toThrow(/preserved/);
    expect(readFileSync(path, 'utf8')).toBe('damaged original bytes');
  });
  it('holds corrupt encrypted register content without filtering bad rows or rewriting it', () => {
    const { store, db } = fixture();
    const saved = db.create('bill-register', 'source-bills', { version: 1, occurrences: [null], series: [] });
    expect(() => store.snapshot(range)).toThrow(/preserved/);
    expect(() => store.accept(acceptance(), source(), 'reviewer')).toThrow(/preserved/);
    expect(db.get('bill-register', 'source-bills')).toEqual(saved);
  });
  it('reopens a durable encrypted occurrence and keeps exact source digest and history', () => {
    const { store, db, dir } = fixture();
    const saved = store.accept(acceptance(), source(), 'reviewer');
    const reopened = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 7) });
    try { expect(new SourceBillRegister(reopened, { dataDir: dir }).snapshot(range).occurrences).toEqual([saved]); }
    finally { reopened.close(); }
    expect(db.get('bill-register', 'source-bills')).toBeDefined();
  });
});

describe('approved bill arrival patterns and calendar projection', () => {
  it('keeps a reviewed actual due date separate from human-approved predicted arrival windows', () => {
    const { store } = fixture(), bill = store.accept(acceptance(), source(), 'reviewer');
    expect(store.snapshot(range).calendar).toMatchObject([{ type: 'invoice-due', date: '2026-02-20', state: 'received' },
      { type: 'expected-payment', date: '2026-02-20', basis: 'reviewed-bill-due-date', billId: bill.id, state: 'received' }]);
    const series = store.approveSeries(pattern(bill.id), 'reviewer');
    expect(store.approveSeries(pattern(bill.id), 'reviewer')).toEqual(series);
    const calendar = store.snapshot(range).calendar;
    expect(calendar.filter(e => e.type === 'expected-arrival').map(e => e.date)).toEqual(['2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31', '2026-06-30']);
    expect(calendar.filter(e => e.type === 'expected-arrival').every(e => e.state === 'predicted' && e.billId === null)).toBe(true);
    expect(store.expectedRows()[0]).toMatchObject({ dueDate: '2026-02-20', sourceKind: 'mail-reviewed', status: 'received' });
  });
  it('anchors month ends and leap years without DST or repeated-clamping drift', () => {
    expect(anchoredBillMonth('2024-02-29', 12)).toBe('2025-02-28');
    expect(anchoredBillMonth('2024-02-29', 48)).toBe('2028-02-29');
    expect(anchoredBillMonth('2026-01-30', 1)).toBe('2026-02-28');
    expect(anchoredBillMonth('2026-01-30', 2)).toBe('2026-03-30');
    expect(anchoredBillMonth('2026-01-31', 3)).toBe('2026-04-30');
    expect(billDateInZone(Date.parse('2026-10-03T14:30:00Z'), 'Australia/Sydney')).toBe('2026-10-04');
    expect(billDateInZone(Date.parse('2026-10-04T14:30:00Z'), 'Australia/Sydney')).toBe('2026-10-05');
  });
  it('requires an observed anchor and a current reviewed occurrence, and rejects duplicate active patterns', () => {
    const { store } = fixture(), bill = store.accept(acceptance(), source(), 'reviewer');
    expect(() => store.approveSeries({ ...pattern(bill.id), anchorDate: '2026-07-31' }, 'reviewer')).toThrow(/actual arrival/);
    expect(() => store.approveSeries({ ...pattern(bill.id), expectedOccurrenceRevision: 2 }, 'reviewer')).toThrow(/changed/);
    store.approveSeries(pattern(bill.id), 'reviewer');
    const laterSource = source({ id: 'another-bill' }), later = store.accept(acceptance(laterSource), laterSource, 'reviewer');
    expect(() => store.approveSeries(pattern(later.id), 'reviewer')).toThrow(/already exists/);
  });
  it('reconciles an explicitly linked arrival with actual source and refuses duplicate occurrences for that period', () => {
    const { store } = fixture(), bill = store.accept(acceptance(), source(), 'reviewer');
    const series = store.approveSeries(pattern(bill.id), 'reviewer');
    const nextSource = source({ id: 'february-bill', at: Date.parse('2026-02-28T01:00:00Z') });
    const linked = { ...acceptance(nextSource), seriesId: series.id, expectedArrivalDate: '2026-02-28' };
    store.accept(linked, nextSource, 'reviewer');
    expect(store.snapshot(range).calendar.filter(e => e.type === 'expected-arrival').map(e => e.date)).not.toContain('2026-02-28');
    const duplicate = source({ id: 'duplicate-february' });
    expect(() => store.accept({ ...linked, expectedSourceDigest: previewBillSource(duplicate).digest }, duplicate, 'reviewer')).toThrow(/already has a received bill/);
  });
  it('records series revisions, rejects stale edits and requires pause before cancelling the founding bill', () => {
    const { store } = fixture(), bill = store.accept(acceptance(), source(), 'reviewer'), series = store.approveSeries(pattern(bill.id), 'reviewer');
    const correction = { ...acceptance(), expectedRevision: 1, state: 'cancelled' };
    expect(() => store.correct(bill.id, correction, source(), 'reviewer')).toThrow(/Pause/);
    const { occurrenceId: _, expectedOccurrenceRevision: __, ...settings } = pattern(bill.id);
    const paused = store.reviseSeries(series.id, { ...settings, expectedRevision: 1, active: false }, 'reviewer');
    expect(paused.history).toHaveLength(1); expect(paused.history[0].active).toBe(true);
    expect(() => store.reviseSeries(series.id, { ...settings, expectedRevision: 1, active: true }, 'reviewer')).toThrow(/changed/);
    store.correct(bill.id, correction, source(), 'reviewer');
    expect(store.snapshot(range).calendar).toEqual([]);
    expect(() => store.reviseSeries(series.id, { ...settings, expectedRevision: 2, active: true }, 'reviewer')).toThrow(/founding bill/);
  });
  it('retains a paused pattern link for corrections without allowing new paused assignments', () => {
    const { store } = fixture(), founding = store.accept(acceptance(), source(), 'reviewer');
    const series = store.approveSeries(pattern(founding.id), 'reviewer');
    const next = source({ id: 'paused-february', at: Date.parse('2026-02-28T01:00:00Z') });
    const linked = store.accept({ ...acceptance(next), seriesId: series.id, expectedArrivalDate: '2026-02-28' }, next, 'reviewer');
    const { occurrenceId: _, expectedOccurrenceRevision: __, ...settings } = pattern(founding.id);
    store.reviseSeries(series.id, { ...settings, expectedRevision: 1, active: false }, 'reviewer');
    const corrected = store.correct(linked.id, { ...acceptance(next), expectedRevision: 1, state: 'hold' }, next, 'reviewer');
    expect(corrected).toMatchObject({ state: 'hold', seriesId: series.id, expectedArrivalDate: '2026-02-28' });
    expect(() => store.correct(linked.id, { ...acceptance(next), expectedRevision: 2, state: 'received', seriesId: series.id, expectedArrivalDate: '2026-03-31' }, next, 'reviewer')).toThrow(/active approved/);
    const other = source({ id: 'paused-march' });
    expect(() => store.accept({ ...acceptance(other), seriesId: series.id, expectedArrivalDate: '2026-03-31' }, other, 'reviewer')).toThrow(/active approved/);
    const cancelled = store.correct(linked.id, { ...acceptance(next), expectedRevision: 2, state: 'cancelled' }, next, 'reviewer');
    expect(cancelled.seriesId).toBe(series.id); expect(cancelled.history).toHaveLength(2);
  });
  it('does not create a phantom expected arrival when a pattern already has received linked periods', () => {
    const { store } = fixture(), bill = store.accept(acceptance(), source(), 'reviewer');
    const original = { ...pattern(bill.id), windowBeforeDays: 1, windowAfterDays: 1 };
    const series = store.approveSeries(original, 'reviewer');
    const next = source({ id: 'received-february', at: Date.parse('2026-02-28T01:00:00Z') });
    store.accept({ ...acceptance(next), seriesId: series.id, expectedArrivalDate: '2026-02-28' }, next, 'reviewer');
    const { occurrenceId: _, expectedOccurrenceRevision: __, ...settings } = original;
    expect(() => store.reviseSeries(series.id, { ...settings, anchorDate: '2026-01-30', expectedRevision: 1, active: true }, 'reviewer')).toThrow(/Received bills are linked/);
    expect(store.snapshot(range).calendar.filter(e => e.type === 'expected-arrival').some(e => e.date.startsWith('2026-02'))).toBe(false);
    expect(store.snapshot(range).series[0].revision).toBe(1);
  });
  it('rejects unbounded calendar projection and never derives an invoice due date from a recurrence', () => {
    const { store } = fixture(), accepted = { ...acceptance(), facts: { ...facts(), dueDate: null } };
    const bill = store.accept(accepted, source(), 'reviewer'); store.approveSeries(pattern(bill.id), 'reviewer');
    expect(store.snapshot(range).calendar.every(e => e.type === 'expected-arrival')).toBe(true);
    expect(() => store.snapshot({ from: '2026-01-01', to: '2036-01-01' })).toThrow(/550 days/);
    expect(store.snapshot(range).occurrences[0].facts.dueDate).toBeNull();
  });
});

describe('expected payment forecasts', () => {
  const payments = (calendar: BillCalendarEntry[]) => calendar.filter(e => e.type === 'expected-payment');
  const pages = (store: SourceBillRegister, query: { from: string; to: string }) => {
    const items: BillCalendarEntry[] = []; let cursor: string | undefined;
    do { const page = store.calendarPage({ ...query, cursor, limit: 1 }); items.push(...page.items); cursor = page.nextCursor ?? undefined; } while (cursor);
    return items;
  };
  function linkedPattern() {
    const f = fixture(), founding = f.store.accept(acceptance(), source(), 'reviewer');
    const series = f.store.approveSeries(pattern(founding.id), 'reviewer');
    expect(payments(f.store.snapshot(range).calendar).map(e => e.basis)).toEqual(['reviewed-bill-due-date']);
    const next = source({ id: 'february-bill', at: Date.parse('2026-02-28T01:00:00Z') });
    const linked = f.store.accept({ ...acceptance(next), facts: { ...facts(), dueDate: '2026-03-14' }, seriesId: series.id, expectedArrivalDate: '2026-02-28' }, next, 'reviewer');
    return { ...f, founding, series, next, linked };
  }
  it('forecasts payment on a received, unpaid bill due date and drops it on hold or cancellation', () => {
    const { store } = fixture(), bill = store.accept(acceptance(), source(), 'reviewer');
    expect(payments(store.snapshot(range).calendar)).toMatchObject([{ id: `payment:${bill.id}`, date: '2026-02-20', endDate: '2026-02-20', billId: bill.id }]);
    const held = store.correct(bill.id, { ...acceptance(), expectedRevision: 1, state: 'hold' }, source(), 'reviewer');
    expect(payments(store.snapshot(range).calendar)).toEqual([]);
    expect(store.snapshot(range).calendar.map(e => e.type)).toEqual(['invoice-due']);
    store.correct(bill.id, { ...acceptance(), expectedRevision: held.revision, state: 'cancelled' }, source(), 'reviewer');
    expect(store.snapshot(range).calendar).toEqual([]);
  });
  it('needs two reviewed bills before shifting approved arrival windows by their usual terms', () => {
    const { store, series, linked } = linkedPattern();
    // Founding: arrives 31 Jan, due 20 Feb (20 days). Linked: arrives 28 Feb, due 14 Mar (14 days). Median 17.
    const forecast = payments(store.snapshot(range).calendar);
    expect(forecast.map(e => [e.basis, e.date])).toEqual([
      ['reviewed-bill-due-date', '2026-02-20'], ['reviewed-bill-due-date', '2026-03-14'],
      ['approved-pattern-payment-terms', '2026-04-17'], ['approved-pattern-payment-terms', '2026-05-17'], ['approved-pattern-payment-terms', '2026-06-17']]);
    expect(forecast.filter(e => e.basis === 'approved-pattern-payment-terms').every(e => e.billId === null && e.seriesId === series.id && e.state === 'predicted')).toBe(true);
    expect(forecast.at(-1)!.paymentTerms).toEqual({ days: 17, reviewedBills: 2 });
    expect(forecast.find(e => e.billId === linked.id)!.paymentTerms).toBeUndefined();
    expect(store.snapshot(range).calendar.filter(e => e.type === 'invoice-due').map(e => e.date)).toEqual(['2026-02-20', '2026-03-14']);
    expect(pages(store, range).map(e => e.id).sort()).toEqual(store.snapshot(range).calendar.map(e => e.id).sort());
  });
  it('carries a forecast across a month boundary from an earlier arrival window', () => {
    const { store } = linkedPattern(), may = { from: '2026-05-01', to: '2026-05-31' };
    expect(payments(store.snapshot(may).calendar).map(e => e.id.slice(e.id.lastIndexOf(':') + 1) + '>' + e.date)).toEqual(['2026-04-30>2026-05-17']);
    expect(pages(store, may).filter(e => e.type === 'expected-payment').map(e => e.date)).toEqual(['2026-05-17']);
  });
  it('replaces stale forecasts after a correction, paid status or paused pattern', () => {
    const { store, founding, series, next, linked } = linkedPattern();
    store.correct(linked.id, { ...acceptance(next), expectedRevision: 1, state: 'received', facts: { ...facts(), dueDate: '2026-03-30' } }, next, 'reviewer');
    expect(payments(store.snapshot(range).calendar).filter(e => e.basis === 'approved-pattern-payment-terms').map(e => e.date)).toEqual(['2026-04-25', '2026-05-25', '2026-06-25']);
    store.correct(linked.id, { ...acceptance(next), expectedRevision: 2, state: 'received', facts: { ...facts(), dueDate: null } }, next, 'reviewer');
    expect(payments(store.snapshot(range).calendar).map(e => e.basis)).toEqual(['reviewed-bill-due-date']);
    store.correct(linked.id, { ...acceptance(next), expectedRevision: 3, state: 'received', facts: { ...facts(), dueDate: '2026-03-14' } }, next, 'reviewer');
    store.reviewFinancial(founding.id, { expectedRevision: 1, expectedSourceDigest: founding.source.digest, sourceReviewed: true, reviewReason: 'Reviewed fictional payment record.',
      observation: { provenance: 'simulated', sourceKind: 'external-record', sourceIds: ['fictional-payment'], locator: 'Fictional ledger', accountContext: 'Fictional office', observedAt: Date.parse('2026-01-31T12:00:00Z'),
        coverage: 'complete', entry: 'recorded', payment: 'confirmed-paid', funding: 'unknown', advance: 'unknown', note: '' } }, 'reviewer');
    const afterPaid = payments(store.snapshot(range).calendar);
    expect(afterPaid.some(e => e.billId === founding.id)).toBe(false);
    expect(afterPaid.filter(e => e.basis === 'approved-pattern-payment-terms')).toHaveLength(3);
    const { occurrenceId: _, expectedOccurrenceRevision: __, ...settings } = pattern(founding.id);
    store.reviseSeries(series.id, { ...settings, expectedRevision: 1, active: false }, 'reviewer');
    expect(payments(store.snapshot(range).calendar).map(e => e.basis)).toEqual(['reviewed-bill-due-date']);
    expect(pages(store, range).filter(e => e.seriesId === series.id && e.billId === null)).toEqual([]);
  });
});

describe('reviewed supplier reference and work description', () => {
  it('keeps legacy facts and their original audit hashes when a status correction sends both labels as null', () => {
    const { store, dir } = fixture(), s = source(), saved = store.accept(acceptance(s), s, 'reviewer');
    expect(Object.keys(saved.facts)).not.toContain('supplierReference');
    const reviewed = store.reviewFinancial(saved.id, { expectedRevision: 1, expectedSourceDigest: saved.source.digest, sourceReviewed: true, reviewReason: 'Fictional status left unknown',
      observation: { provenance: 'simulated', sourceKind: 'unknown', sourceIds: [], locator: '', accountContext: '', observedAt: Date.parse('2026-01-31T02:00:00Z'), coverage: 'unknown', entry: 'unknown', payment: 'unknown', funding: 'unknown', advance: 'unknown', note: '' } }, 'reviewer');
    const originalFacts = JSON.stringify(reviewed.facts), audit = JSON.stringify(reviewed.financialReview);
    const submitted = { ...facts(), supplierReference: null, workDescription: null };
    expect(sameBillFacts(reviewed.facts, submitted)).toBe(true);
    const corrected = store.correct(saved.id, { ...acceptance(s), facts: submitted, expectedRevision: 2, state: 'hold' }, s, 'reviewer');
    expect(JSON.stringify(corrected.facts)).toBe(originalFacts);
    expect(JSON.stringify(corrected.financialReview)).toBe(audit);
    expect(isBillFinancialReviewStale(corrected)).toBe(false);
    const reopened = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 7) });
    try { expect(new SourceBillRegister(reopened, { dataDir: dir }).getOccurrence(saved.id)).toEqual(corrected); } finally { reopened.close(); }
  });
  it('saves trimmed labels, refuses a client that silently drops them and allows an explicit clear', () => {
    const { store } = fixture(), s = source();
    const labelled = { ...facts(), supplierReference: ' SUP-FICTIONAL-042 ', workDescription: ' Fictional gutter clean ' };
    const saved = store.accept({ ...acceptance(s), facts: labelled }, s, 'reviewer');
    expect(saved.facts).toMatchObject({ supplierReference: 'SUP-FICTIONAL-042', workDescription: 'Fictional gutter clean' });
    expect(() => store.correct(saved.id, { ...acceptance(s), expectedRevision: 1, state: 'hold' }, s, 'reviewer')).toThrow(/explicitly clear/);
    const changed = store.correct(saved.id, { ...acceptance(s), facts: { ...labelled, workDescription: 'Fictional gutter repair' }, expectedRevision: 1, state: 'received' }, s, 'reviewer');
    expect(changed.history[0].facts.workDescription).toBe('Fictional gutter clean'); expect(changed.facts.workDescription).toBe('Fictional gutter repair');
    const cleared = store.correct(saved.id, { ...acceptance(s), facts: { ...facts(), supplierReference: null, workDescription: null }, expectedRevision: 2, state: 'received' }, s, 'reviewer');
    expect(cleared.facts).toMatchObject({ supplierReference: null, workDescription: null });
  });
  it.each([{ supplierReference: '' }, { supplierReference: 'x'.repeat(121) }, { workDescription: 'x'.repeat(1001) }, { workDescription: 'bad\u0000value' }, { supplierName: 'Fictional' }])('rejects invalid labels %j', changed => {
    const { store } = fixture(), s = source();
    expect(() => store.accept({ ...acceptance(s), facts: { ...facts(), ...changed } }, s, 'reviewer')).toThrow();
    expect(store.counts().occurrences).toBe(0);
  });
});

describe('Jev ordering for duplicate bill review', () => {
  const bill = (f: Partial<BillFacts> = {}): BillFacts => ({ propertyId: 'book-fict0001', kind: 'Water', vendor: 'Fictional Water Co', amountCents: 12345, currency: 'AUD',
    invoiceDate: '2026-01-31', dueDate: '2026-02-20', note: 'Tenant Fictional Person called about it', invoiceNumber: 'FW-1001', workDescription: 'Fictional tenant name in the work notes', ...f });
  const next = { invoiceDate: '2026-02-28', dueDate: '2026-03-20' };
  /** Fictional labelled pairs (bill under review, saved candidate, same bill?). Kept as data so an eval script can replay them against Jev. */
  const pairs: { name: string; bill: BillFacts; candidate: BillFacts; same: boolean }[] = [
    { name: 'resent identical invoice', bill: bill(), candidate: bill(), same: true },
    { name: 'supplier name recased', bill: bill(), candidate: bill({ vendor: 'FICTIONAL WATER CO' }), same: true },
    { name: 'amount not yet confirmed on the saved copy', bill: bill(), candidate: bill({ amountCents: null }), same: true },
    { name: 'saved copy has the supplier reference', bill: bill(), candidate: bill({ supplierReference: 'REI-FICT-77' }), same: true },
    { name: 'same reference, one copy missing the invoice number', bill: bill({ invoiceNumber: null, supplierReference: 'REI-FICT-77' }), candidate: bill({ supplierReference: 'REI-FICT-77' }), same: true },
    { name: 'reminder repeats the same invoice', bill: bill({ note: 'Reminder' }), candidate: bill(), same: true },
    { name: 'strata levy, one copy with invoice number', bill: bill({ vendor: 'Fictional Strata', kind: 'Strata', invoiceNumber: null, amountCents: 90000 }), candidate: bill({ vendor: 'Fictional Strata', kind: 'Strata', invoiceNumber: 'ST-9', amountCents: 90000 }), same: true },
    { name: 'same supplier and amount, next month (hard negative)', bill: bill({ ...next, invoiceNumber: 'FW-1002' }), candidate: bill(), same: false },
    { name: 'same supplier and amount, next month, no invoice numbers (hard negative)', bill: bill({ ...next, invoiceNumber: null }), candidate: bill({ invoiceNumber: null }), same: false },
    { name: 'same invoice number, different supplier (hard negative)', bill: bill({ vendor: 'Fictional Power Ltd', kind: 'Electricity', amountCents: 20990 }), candidate: bill(), same: false },
    { name: 'same invoice number and amount, different supplier (hard negative)', bill: bill({ vendor: 'Fictional Gas Pty' }), candidate: bill(), same: false },
    { name: 'same invoice number, different property', bill: bill({ propertyId: 'book-fict0002' }), candidate: bill(), same: false },
    { name: 'same supplier and dates, different property', bill: bill({ propertyId: 'book-fict0002', invoiceNumber: 'FW-2001' }), candidate: bill(), same: false },
    { name: 'same supplier and date, different bill kind', bill: bill({ kind: 'Sewerage', invoiceNumber: 'FW-1001S' }), candidate: bill(), same: false },
    { name: 'quarterly repeat three months on', bill: bill({ invoiceDate: '2026-04-30', dueDate: '2026-05-20', invoiceNumber: 'FW-1004' }), candidate: bill(), same: false },
    { name: 'council rates instalment two of four', bill: bill({ vendor: 'Fictional Council', kind: 'Rates', amountCents: 45000, invoiceNumber: 'R-2', dueDate: '2026-05-31' }), candidate: bill({ vendor: 'Fictional Council', kind: 'Rates', amountCents: 45000, invoiceNumber: 'R-1' }), same: false },
    { name: 'same amount and date, different supplier, no invoice numbers', bill: bill({ vendor: 'Fictional Gardens', kind: 'Garden', invoiceNumber: null }), candidate: bill({ invoiceNumber: null }), same: false },
    { name: 'same supplier and date, different amount and invoice', bill: bill({ amountCents: 9900, invoiceNumber: 'FW-1009' }), candidate: bill(), same: false },
  ];
  const candidate = (n: number, f: BillFacts = bill()): BillDuplicateCandidate => ({ billId: `source-bill:${n.toString(16).padStart(64, '0')}`, revision: 1, matchedRevision: 1,
    sourceDigest: 'd'.repeat(64), facts: f, subject: 'Fictional subject with a tenant name', receivedAt: 1, match: 'invoice-identity' });
  const check = (candidates: BillDuplicateCandidate[]): BillDuplicateCheck => ({ version: 1, sourceDigest: 'a'.repeat(64), reviewDigest: 'b'.repeat(64), candidates, complete: true });
  const allowed = ['propertyId', 'kind', 'supplier', 'amountCents', 'currency', 'invoiceDate', 'dueDate', 'invoiceNumber', 'invoiceVersion', 'supplierReference'].sort();
  /** Answers from a fixed noul per bill id; records each request and the calls in flight. */
  function jev(noul: (state: Record<string, Record<string, unknown>>, key: string) => number | JevResult) {
    const asked: JevRequest[] = []; let inFlight = 0, peak = 0;
    const decide = async (request: JevRequest): Promise<JevResult> => {
      asked.push(request); peak = Math.max(peak, ++inFlight);
      await new Promise(resolve => setTimeout(resolve, 1)); inFlight--;
      const state = request.state as Record<string, Record<string, unknown>>, answers: Record<string, { type: 'noul'; noul: number }> = {};
      for (const key of Object.keys(request.questions)) { const value = noul(state, key); if (typeof value !== 'number') return value; answers[key] = { type: 'noul', noul: value }; }
      return { ok: true, answers, model: 'fictional-jev', ms: 1 };
    };
    return { decide, asked, peak: () => peak };
  }

  it.each(pairs)('labels the fictional pair: $name', async ({ bill: under, candidate: saved, same }) => {
    // The oracle answers from the label; the plumbing must carry it to the right candidate and send only minimal fields.
    const { decide, asked } = jev(() => same ? 0.95 : 0.05);
    const ranked = await rankDuplicateCandidates(check([candidate(1, saved)]), under, decide);
    expect(ranked.candidates[0]!.likely).toBe(same ? 'same' : 'different');
    const state = asked[0]!.state as Record<string, Record<string, unknown>>;
    expect(Object.keys(state).sort()).toEqual(['bill', 'c0']);
    for (const side of [state.bill!, state.c0!]) expect(Object.keys(side).sort()).toEqual(allowed);
    expect(state.bill!.supplier).toBe(under.vendor); expect(state.c0!.amountCents).toBe(saved.amountCents);
    expect(JSON.stringify(asked)).not.toMatch(/tenant|Fictional Person|subject|note|workDescription/i);
    expect(asked[0]!.questions.c0).toMatchObject({ type: 'noul' });
  });

  it('orders by noul in batches of eight with at most two calls at once, labelling only at the edges and keeping the hold inputs', async () => {
    const nouls = [0.5, 0.92, 0.05, 0.5, 0.3, 0.97, 0.1, 0.89, 0.11, 0.6, 0.02, 0.4, 0.9, 0.7, 0.2, 0.8, 0.55, 0.45, 0.35, 0.65];
    const original = check(nouls.map((_, n) => candidate(n, bill({ invoiceNumber: `FW-${n}` }))));
    const frozen = structuredClone(original);
    const scored = jev((state, key) => nouls[Number(String(state[key]!.invoiceNumber).slice(3))]!);
    const ranked = await rankDuplicateCandidates(original, bill(), scored.decide);
    expect(scored.asked.map(request => Object.keys(request.questions).length)).toEqual([8, 8, 4]);
    expect(scored.peak()).toBeLessThanOrEqual(2);
    const order = ranked.candidates.map(c => Number(String(c.facts.invoiceNumber).slice(3)));
    expect(order.map(n => nouls[n])).toEqual(nouls.slice().sort((a, b) => b - a));
    expect(order.slice(order.indexOf(0), order.indexOf(0) + 2)).toEqual([0, 3]); // ties keep today's order
    expect(Object.fromEntries(ranked.candidates.filter(c => c.likely).map(c => [nouls[Number(String(c.facts.invoiceNumber).slice(3))], c.likely]))).toEqual({
      0.97: 'same', 0.92: 'same', 0.9: 'same', 0.1: 'different', 0.05: 'different', 0.02: 'different' });
    expect(ranked).toMatchObject({ reviewDigest: original.reviewDigest, complete: true, sourceDigest: original.sourceDigest });
    expect(original).toEqual(frozen);
  });

  it.each<[string, (state: Record<string, Record<string, unknown>>, key: string) => number | JevResult]>([
    ['a refused call', () => ({ ok: false, reason: 'refused' })],
    ['an over-budget office', () => ({ ok: false, reason: 'budget' })],
    ['a timeout in the last batch', (state, key) => String(state[key]!.invoiceNumber) === 'FW-17' ? { ok: false, reason: 'timeout' } : 0.99],
    ['a missing answer', (_state, key) => key === 'c3' ? ({ ok: true, answers: {}, model: 'fictional-jev', ms: 1 }) : 0.99],
  ])('keeps today\'s order and no labels after %s', async (_name, noul) => {
    const original = check(Array.from({ length: 18 }, (_, n) => candidate(n, bill({ invoiceNumber: `FW-${n}` }))));
    const { decide } = jev(noul);
    expect(await rankDuplicateCandidates(original, bill(), decide)).toEqual(original);
  });

  it('keeps today\'s order when decide throws, the review is closed, or there is nothing to rank', async () => {
    const original = check([candidate(1), candidate(2)]);
    expect(await rankDuplicateCandidates(original, bill(), async () => { throw new Error('fictional'); })).toEqual(original);
    const closed = new AbortController(); closed.abort();
    expect(await rankDuplicateCandidates(original, bill(), jev(() => 0.99).decide, { signal: closed.signal })).toEqual(original);
    const { decide, asked } = jev(() => 0.99);
    expect(await rankDuplicateCandidates(check([]), bill(), decide)).toEqual(check([])); expect(asked).toEqual([]);
  });

  it('never changes the hold: a "likely different" label still needs the person\'s confirmation', async () => {
    const { store } = fixture(), first = source({ id: 'message-one' }), second = source({ id: 'message-two' }), reviewed = { ...facts(), invoiceNumber: 'FW-1001' };
    store.accept({ ...acceptance(first), facts: reviewed }, first, 'reviewer');
    const found = store.duplicateCandidates({ expectedSourceDigest: previewBillSource(second).digest, facts: reviewed }, second);
    const ranked = await rankDuplicateCandidates(found, reviewed, jev(() => 0.01).decide);
    expect(ranked.candidates[0]!.likely).toBe('different');
    expect(ranked.reviewDigest).toBe(found.reviewDigest);
    expect(() => store.accept({ ...acceptance(second), facts: reviewed }, second, 'reviewer')).toThrow(expect.objectContaining({ code: 'bill_duplicate_review_required' }));
    expect(store.accept({ ...acceptance(second), facts: reviewed, reviewReason: 'Two separate fictional originals checked', duplicateReview: { reviewDigest: ranked.reviewDigest } }, second, 'reviewer').duplicateReview?.reviewDigest).toBe(found.reviewDigest);
  });
});
