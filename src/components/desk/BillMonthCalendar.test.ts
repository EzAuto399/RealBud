import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BillCalendarEntry } from '@shared/source-bills';
import { BillMonthCalendar, billEntriesOnDay, billPaymentBasis, billMonthRange, billMonthWeeks, shiftBillMonth } from './BillMonthCalendar';

vi.mock('@/state/store', () => ({ api: vi.fn() }));

const due = (id: string, date: string, vendor = 'City Water'): BillCalendarEntry => ({ id, type: 'invoice-due', date, endDate: date, propertyId: 'p1', kind: 'Water', vendor, billId: `bill-${id}`, seriesId: null, basis: 'human-reviewed-invoice-date', state: 'received' });
const expected = (id: string, date: string, endDate = date, vendor = 'Council'): BillCalendarEntry => ({ id, type: 'expected-arrival', date, endDate, propertyId: 'p1', kind: 'Rates', vendor, billId: null, seriesId: `series-${id}`, basis: 'approved-arrival-pattern', state: 'predicted' });
const payment = (id: string, date: string, endDate = date, vendor = 'Council'): BillCalendarEntry => ({ id, type: 'expected-payment', date, endDate, propertyId: 'p1', kind: 'Rates', vendor, billId: null, seriesId: `series-${id}`, basis: 'approved-pattern-payment-terms', state: 'predicted', paymentTerms: { days: 14, reviewedBills: 3 } });
const render = (overrides: Partial<Parameters<typeof BillMonthCalendar>[0]> = {}) => renderToStaticMarkup(createElement(BillMonthCalendar, {
  entries: [], month: '2026-10', today: '2026-10-02', busy: false, actionsDisabled: false, label: () => 'Sample property', selectedDay: null,
  onSelectDay: vi.fn(), onOpenBill: vi.fn(), onOpenPattern: vi.fn(), onMonth: vi.fn(), hasMore: false, onLoadMore: vi.fn(), ...overrides,
}));

describe('bill month calendar dates', () => {
  it('computes first and last day for month changes, including leap years and year ends', () => {
    expect(billMonthRange('2026-10')).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(billMonthRange(shiftBillMonth('2026-10', 1))).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(billMonthRange(shiftBillMonth('2028-03', -1))).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(shiftBillMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftBillMonth('2026-01', -1)).toBe('2025-12');
  });
  it('lays weeks out Monday to Sunday', () => {
    const weeks = billMonthWeeks('2026-10'); // 1 October 2026 is a Thursday.
    expect(weeks[0]).toEqual([null, null, null, '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04']);
    expect(weeks.every(week => week.length === 7)).toBe(true);
    expect(weeks.flat().filter(Boolean)).toHaveLength(31);
  });
  it('marks every day of an expected-arrival range', () => {
    const range = expected('r', '2026-10-05', '2026-10-07');
    expect(['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'].map(day => billEntriesOnDay([range], day).length)).toEqual([0, 1, 1, 1, 0]);
  });
});

describe('bill month calendar presentation', () => {
  it('renders the month header, navigation, legend and today', () => {
    const html = render();
    expect(html).toContain('October 2026');
    expect(html).toContain('aria-label="Previous month"');
    expect(html).toContain('aria-label="Next month"');
    expect(html).toContain('This month');
    expect(html).toContain('Due = from a received bill. Expected = predicted from an approved pattern, not an invoice.');
    expect(html).toContain('aria-label="2 October: no bills" aria-pressed="false" aria-current="date"');
    expect(html).toContain('Expected payment (dotted) = forecast from bills you reviewed, not a due date or a payment.');
    expect(html).toContain('No due dates, expected payments or expected arrivals this month.');
    expect(html).not.toContain('Calendar from');
  });
  it('shows due dates and expected arrivals as distinct, labelled markers', () => {
    const html = render({ entries: [due('d', '2026-10-02', 'City Water'), expected('e', '2026-10-02')] });
    expect(html).toContain('aria-label="2 October: 1 due, 1 expected"');
    expect(html).toMatch(/data-chip="due" class="[^"]*bg-agency[^"]*">City Water</);
    expect(html).toMatch(/data-chip="expected" class="[^"]*border-dashed[^"]*">Expected · Council</);
    expect(html).toContain('data-marker="invoice-due"');
    expect(html).toContain('data-marker="expected-arrival"');
  });
  it('labels each day of an expected range and lists the whole range in the day panel', () => {
    const html = render({ entries: [expected('r', '2026-10-05', '2026-10-07')], selectedDay: '2026-10-06' });
    for (const day of [5, 6, 7]) expect(html).toContain(`aria-label="${day} October: 1 expected"`);
    expect(html).toContain('aria-label="8 October: no bills"');
    expect(html).toMatch(/Expected · [^<]*5[^<]*2026 – [^<]*7[^<]*2026/);
    expect(html).toContain('Not an invoice or due date.');
  });
  it('lists a selected day with the existing actions and respects disabled states', () => {
    const entries = [due('d', '2026-10-02'), expected('e', '2026-10-02')];
    const html = render({ entries, selectedDay: '2026-10-02' });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('Open received bill');
    expect(html).toContain('Review arrival pattern');
    expect(html).toContain('Due date entered in the received bill’s source review.');
    expect(html.indexOf('Open received bill')).toBeLessThan(html.indexOf('Review arrival pattern'));
    const locked = render({ entries, selectedDay: '2026-10-02', actionsDisabled: true });
    expect(locked.match(/disabled="">(Open received bill|Review arrival pattern)/g)).toHaveLength(2);
    expect(render({ entries })).not.toContain('Open received bill');
  });
  it('collapses a crowded day to three markers and +N more', () => {
    const entries = ['a', 'b', 'c', 'd', 'e'].map(id => due(id, '2026-10-09', `Vendor ${id}`));
    const html = render({ entries });
    expect(html).toContain('aria-label="9 October: 5 due"');
    expect(html).toContain('+2 more');
    expect(html.match(/data-chip="due"/g)).toHaveLength(3);
    expect(html).not.toContain('Vendor d');
  });
  it('offers loading the rest of the month without claiming the month is empty', () => {
    const html = render({ hasMore: true });
    expect(html).toContain('Load more for this month');
    expect(html).toContain('Some entries for this month are not loaded yet.');
    expect(html).not.toContain('No due dates, expected payments or expected arrivals this month.');
    expect(render({ hasMore: true, busy: true })).toMatch(/disabled="">Load more for this month/);
  });
});

describe('bill month calendar expected payments', () => {
  it('gives an expected payment a third marker and chip, ordered between due dates and arrivals', () => {
    const entries = [expected('e', '2026-10-14', '2026-10-14', 'Water Co'), payment('p', '2026-10-14'), due('d', '2026-10-14', 'Energy Co')];
    expect(billEntriesOnDay(entries, '2026-10-14').map(entry => entry.type)).toEqual(['invoice-due', 'expected-payment', 'expected-arrival']);
    const html = render({ entries });
    expect(html).toContain('aria-label="14 October: 1 due, 1 expected payment, 1 expected"');
    expect(html).toMatch(/data-marker="expected-payment" class="[^"]*rotate-45 border border-agency/);
    expect(html).toMatch(/data-chip="payment" class="[^"]*border-dotted[^"]*">Expected payment · Council</);
    expect(html.indexOf('data-chip="due"')).toBeLessThan(html.indexOf('data-chip="payment"'));
    expect(html.indexOf('data-chip="payment"')).toBeLessThan(html.indexOf('data-chip="expected"'));
  });
  it('lists the basis and existing action in the day panel without calling it a due date or payment', () => {
    const html = render({ entries: [payment('p', '2026-10-14', '2026-10-16')], selectedDay: '2026-10-15' });
    expect(html).toContain('Expected payment · Council');
    expect(html).toContain('Usually due ~14 days after the bill arrives (from 3 reviewed bills), added to your approved arrival window. A forecast, not a due date or a payment.');
    expect(html).toContain('Review arrival pattern');
    expect(html).not.toMatch(/>Due · /);
    const fromBill: BillCalendarEntry = { ...payment('b', '2026-10-14'), billId: 'bill-b', seriesId: null, basis: 'reviewed-bill-due-date', state: 'received', paymentTerms: undefined };
    const billHtml = render({ entries: [fromBill], selectedDay: '2026-10-14', actionsDisabled: true });
    expect(billHtml).toContain('From the due date you reviewed on this received bill, which is not marked paid.');
    expect(billHtml).toMatch(/disabled="">Open received bill/);
    expect(billPaymentBasis({ ...payment('z', '2026-10-14'), paymentTerms: { days: 1, reviewedBills: 2 } })).toBe('Usually due ~1 day after the bill arrives (from 2 reviewed bills), added to your approved arrival window.');
  });
});
