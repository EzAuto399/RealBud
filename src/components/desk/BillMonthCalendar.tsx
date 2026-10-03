import type { BillCalendarEntry } from '@shared/source-bills';
import { displayBillDate } from '@/lib/source-bill-form';

/** A calendar month as `YYYY-MM`. Dates stay calendar strings; no system timezone. */
export type BillMonth = string;
export type BillMonthStep = 'previous' | 'next' | 'current';

const MAX_MARKERS = 3;
const button = 'min-h-11 rounded-lg border border-line px-3 py-2 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-agency';
const monthNames = new Intl.DateTimeFormat('en-AU', { month: 'long', timeZone: 'UTC' });
const monthTitle = new Intl.DateTimeFormat('en-AU', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const weekdays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const parts = (month: BillMonth) => month.split('-').map(Number) as [number, number];
const pad = (value: number) => String(value).padStart(2, '0');
const lastDay = (month: BillMonth) => { const [year, index] = parts(month); return new Date(Date.UTC(year, index, 0)).getUTCDate(); };

/** First and last calendar day of a month, the range the bill calendar reads. */
export function billMonthRange(month: BillMonth): { from: string; to: string } {
  return { from: `${month}-01`, to: `${month}-${pad(lastDay(month))}` };
}
export function shiftBillMonth(month: BillMonth, delta: number): BillMonth {
  const [year, index] = parts(month);
  const date = new Date(Date.UTC(year, index - 1 + delta, 1));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}`;
}
/** Monday-first weeks; days outside the month are null. */
export function billMonthWeeks(month: BillMonth): (string | null)[][] {
  const [year, index] = parts(month);
  const lead = (new Date(Date.UTC(year, index - 1, 1)).getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [...Array<null>(lead).fill(null), ...Array.from({ length: lastDay(month) }, (_, day) => `${month}-${pad(day + 1)}`)];
  while (cells.length % 7) cells.push(null);
  return Array.from({ length: cells.length / 7 }, (_, week) => cells.slice(week * 7, week * 7 + 7));
}
const order: Record<BillCalendarEntry['type'], number> = { 'invoice-due': 0, 'expected-payment': 1, 'expected-arrival': 2 };
/** Entries touching a day. A predicted range marks every day it covers. Due dates sort first, then expected payments, then expected arrivals. */
export function billEntriesOnDay(entries: BillCalendarEntry[], day: string): BillCalendarEntry[] {
  return entries.filter(entry => entry.date <= day && day <= (entry.endDate || entry.date))
    .sort((a, b) => order[a.type] - order[b.type] || a.vendor.localeCompare(b.vendor) || a.id.localeCompare(b.id));
}
const days = (count: number) => `${count} day${count === 1 ? '' : 's'}`;
/** Which approved evidence a payment forecast came from. */
export function billPaymentBasis(entry: BillCalendarEntry): string {
  if (entry.basis === 'reviewed-bill-due-date') return 'From the due date you reviewed on this received bill, which is not marked paid.';
  const terms = entry.paymentTerms;
  if (!terms) return 'Forecast from your approved arrival pattern.';
  const gap = terms.days === 0 ? 'on the day the bill arrives' : `~${days(terms.days)} after the bill arrives`;
  return `Usually due ${gap} (from ${terms.reviewedBills} reviewed bills), added to your approved arrival window.`;
}
export const billMonthTitle = (month: BillMonth) => { const [year, index] = parts(month); return monthTitle.format(Date.UTC(year, index - 1, 1)); };
export function billDayLabel(day: string, entries: BillCalendarEntry[]): string {
  const [year, index, date] = day.split('-').map(Number) as [number, number, number];
  const count = (type: BillCalendarEntry['type']) => entries.filter(entry => entry.type === type).length;
  const due = count('invoice-due'), payments = count('expected-payment'), expected = count('expected-arrival');
  const counts = entries.length ? [due && `${due} due`, payments && `${payments} expected payment${payments === 1 ? '' : 's'}`, expected && `${expected} expected`].filter(Boolean).join(', ') : 'no bills';
  return `${date} ${monthNames.format(Date.UTC(year, index - 1, date))}: ${counts}`;
}

export function BillMonthCalendar({ entries, month, today, busy, actionsDisabled, label, selectedDay, onSelectDay, onOpenBill, onOpenPattern, onMonth, hasMore, onLoadMore }: {
  entries: BillCalendarEntry[]; month: BillMonth; today: string; busy: boolean; actionsDisabled: boolean;
  label: (propertyId: string) => string; selectedDay: string | null; onSelectDay: (day: string | null) => void;
  onOpenBill: (billId: string) => void; onOpenPattern: (seriesId: string) => void; onMonth: (step: BillMonthStep) => void;
  hasMore: boolean; onLoadMore: () => void;
}) {
  const weeks = billMonthWeeks(month);
  const dayEntries = selectedDay?.startsWith(`${month}-`) ? billEntriesOnDay(entries, selectedDay) : null;
  const inMonth = weeks.flat().some(day => day && billEntriesOnDay(entries, day).length);
  const open = (entry: BillCalendarEntry) => (entry.billId || entry.seriesId) && <button type="button" className={button} disabled={actionsDisabled} onClick={() => entry.billId ? onOpenBill(entry.billId) : onOpenPattern(entry.seriesId!)}>{entry.billId ? 'Open received bill' : 'Review arrival pattern'}</button>;
  return <section aria-label="Bill calendar" className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h4 className="font-medium">{billMonthTitle(month)}</h4>
      <div className="flex gap-2">
        <button type="button" className={button} aria-label="Previous month" disabled={busy} onClick={() => onMonth('previous')}>‹</button>
        <button type="button" className={button} disabled={busy || today.startsWith(`${month}-`)} onClick={() => onMonth('current')}>This month</button>
        <button type="button" className={button} aria-label="Next month" disabled={busy} onClick={() => onMonth('next')}>›</button>
      </div>
    </div>
    <p className="text-xs text-ink-secondary">Due = from a received bill. Expected = predicted from an approved pattern, not an invoice. Expected payment (dotted) = forecast from bills you reviewed, not a due date or a payment.</p>
    <div role="group" aria-label={`Bills in ${billMonthTitle(month)}`} className="grid min-w-0 grid-cols-7 gap-px overflow-hidden rounded-lg border border-line bg-line">
      {weekdays.map(short => <div key={short} aria-hidden="true" className="bg-paper px-1 py-1 text-center text-xs text-ink-secondary">{short}</div>)}
      {weeks.flatMap((week, row) => week.map((day, column) => {
        if (!day) return <div key={`${row}:${column}`} aria-hidden="true" className="bg-paper" />;
        const items = billEntriesOnDay(entries, day), shown = items.slice(0, MAX_MARKERS), extra = items.length - shown.length;
        const isToday = day === today, selected = day === selectedDay;
        return <div key={day} className="min-w-0 bg-sheet">
          <button type="button" aria-label={billDayLabel(day, items)} aria-pressed={selected} aria-current={isToday ? 'date' : undefined}
            className={`flex h-full min-h-11 w-full min-w-0 flex-col items-stretch gap-1 p-1 text-left focus-visible:outline-2 focus-visible:outline-agency min-[720px]:min-h-24 ${selected ? 'bg-selected' : ''}`}
            onClick={() => onSelectDay(selected ? null : day)}>
            <span aria-hidden="true" className={`self-start rounded-full px-1.5 text-xs ${isToday ? 'bg-agency font-semibold text-sheet' : 'text-ink'}`}>{Number(day.slice(8))}</span>
            <span aria-hidden="true" className="flex flex-wrap items-center gap-1 min-[720px]:hidden">
              {shown.map(entry => <span key={entry.id} data-marker={entry.type} className={`h-2 w-2 ${entry.type === 'expected-arrival' ? 'rounded-full border border-ink-secondary' : entry.type === 'expected-payment' ? 'rotate-45 border border-agency' : 'rounded-full bg-agency'}`} />)}
              {extra > 0 && <span className="text-[10px] leading-none text-ink-secondary">+{extra}</span>}
            </span>
            <span aria-hidden="true" className="hidden min-w-0 flex-col gap-1 min-[720px]:flex">
              {shown.map(entry => entry.type === 'expected-arrival'
                ? <span key={entry.id} data-chip="expected" className="truncate rounded border border-dashed border-ink-secondary px-1 text-xs text-ink-secondary">Expected · {entry.vendor}</span>
                : entry.type === 'expected-payment'
                  ? <span key={entry.id} data-chip="payment" className="truncate rounded border border-dotted border-agency px-1 text-xs text-agency">Expected payment · {entry.vendor}</span>
                  : <span key={entry.id} data-chip="due" className="truncate rounded bg-agency px-1 text-xs text-sheet">{entry.vendor}</span>)}
              {extra > 0 && <span className="text-xs text-ink-secondary">+{extra} more</span>}
            </span>
          </button>
        </div>;
      }))}
    </div>
    {!inMonth && !hasMore && <p className="text-sm text-ink-secondary">No due dates, expected payments or expected arrivals this month.</p>}
    {hasMore && <div className="flex flex-wrap items-center gap-2"><p role="status" className="text-sm text-hold">Some entries for this month are not loaded yet.</p><button type="button" className={button} disabled={busy} onClick={onLoadMore}>Load more for this month</button></div>}
    {selectedDay && dayEntries && <div aria-label={`Bills on ${displayBillDate(selectedDay)}`} role="region" className="rounded-lg border border-line p-3 space-y-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2"><h5 className="font-medium">{displayBillDate(selectedDay)}</h5><button type="button" className={button} onClick={() => onSelectDay(null)}>Close day</button></div>
      {!dayEntries.length ? <p className="text-ink-secondary">No due dates, expected payments or expected arrivals on the loaded pages.</p> : <ul className="space-y-2">{dayEntries.map(entry => {
        const dates = `${displayBillDate(entry.date)}${entry.endDate && entry.endDate !== entry.date ? ` – ${displayBillDate(entry.endDate)}` : ''}`;
        if (entry.type === 'expected-payment') return <li key={entry.id} data-entry="payment" className="rounded border border-dotted border-agency p-2 space-y-1">
          <p className="break-words font-medium text-agency">Expected payment · {entry.vendor}</p>
          <p className="break-words">{dates} · {label(entry.propertyId)} · {entry.kind}</p>
          <p className="text-xs text-ink-secondary">{billPaymentBasis(entry)} A forecast, not a due date or a payment.</p>
          {open(entry)}
        </li>;
        const expected = entry.type === 'expected-arrival';
        return <li key={entry.id} className={`rounded border p-2 space-y-1 ${expected ? 'border-dashed border-ink-secondary' : 'border-agency'}`}>
          <p className={`font-medium ${expected ? 'text-ink-secondary' : 'text-ink'}`}>{expected ? 'Expected' : 'Due'} · {dates}</p>
          <p className="break-words">{label(entry.propertyId)} · {entry.kind} · {entry.vendor}</p>
          <p className="text-xs text-ink-secondary">{expected ? 'Predicted from your approved arrival pattern. Not an invoice or due date.' : 'Due date entered in the received bill’s source review.'}</p>
          {open(entry)}
        </li>;
      })}</ul>}
    </div>}
  </section>;
}
