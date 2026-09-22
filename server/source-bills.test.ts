import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkflowDatabase } from './workflow-database.ts';
import { SourceBillRegister, previewBillSource } from './source-bills.ts';
import { listExpectedBills, upsertExpectedBill } from './expected-bills.ts';
import { anchoredBillMonth, billDateInZone } from '../shared/bill-dates.ts';
import type { BillMailSource, BillFacts } from '../shared/source-bills.ts';

const resources: { dir: string; db: WorkflowDatabase }[] = [];
afterEach(() => { for (const { dir, db } of resources.splice(0)) { db.close(); rmSync(dir, { recursive: true, force: true }); } });
const source = (overrides: Partial<BillMailSource['message']> = {}): BillMailSource => ({ accountId: 'fictional-account', receiptId: 'scan-one', threadId: 'thread-one', message: {
  id: 'message-one', at: Date.parse('2026-01-31T01:00:00Z'), from: 'utility@example.test', subject: 'Fictional water bill',
  body: 'Fictional invoice dated 2026-01-31 for $123.45, due 2026-02-20.', bodyTruncated: false, attachments: [], ...overrides,
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
    expect(store.snapshot(range).calendar).toMatchObject([{ type: 'invoice-due', date: '2026-02-20', state: 'received' }]);
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
