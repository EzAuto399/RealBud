import type { BillRecurrenceSeries, SourceBillOccurrence } from './source-bills.ts';
import type { MailThread } from './mail-ingestion.ts';

export interface SourceBillOccurrenceResult {
  occurrence: SourceBillOccurrence | null;
  originSeries: BillRecurrenceSeries | null;
}
export interface SourceBillSeriesResult {
  series: BillRecurrenceSeries;
  occurrence: SourceBillOccurrence;
}
export interface SourceBillCurrentSourceResult {
  itemId: string;
  accountId: string;
  receiptId: string;
  thread: MailThread;
}
export type ExpectedBillGroup = 'needs-you' | 'due-soon' | 'in-process' | 'settled';
export type ExpectedBillOrigin = 'all' | 'legacy' | 'source';
/** groups contains this page only. total/counts describe every matching row
 * inside this insertion snapshot; corrections remain visible on later reads. */
export interface ExpectedBillsPage<T> {
  version: 2;
  bills: T[];
  groups: Record<ExpectedBillGroup, T[]>;
  total: number;
  counts: { legacy: number; source: number };
  nextCursor: string | null;
  revision: string;
}
