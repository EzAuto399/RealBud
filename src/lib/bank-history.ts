import type { BankBatchSummary, BankHistoryPage } from '@shared/bank-reference-history';
import { BANK_REVIEW_ID } from '@shared/bank-review';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown, minimum = 0): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
const timestamp = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function parseBankHistory(value: unknown): BankHistoryPage {
  if (!object(value) || value.version !== 2 || !integer(value.total) || !Array.isArray(value.batches) || value.batches.length > 100 ||
    !(value.nextCursor === null || typeof value.nextCursor === 'string' && value.nextCursor.length > 0 && value.nextCursor.length <= 6000) ||
    value.batches.some(row => !object(row) || typeof row.id !== 'string' || !BANK_REVIEW_ID.test(row.id) || !integer(row.revision, 1) ||
      !timestamp(row.createdAt) || !integer(row.rows) || !hash(row.originalDigest) ||
      !(row.reviewedAt === undefined || timestamp(row.reviewedAt)) || !(row.outputDigest === undefined || hash(row.outputDigest)) ||
      !(row.supersededBy === undefined || typeof row.supersededBy === 'string' && BANK_REVIEW_ID.test(row.supersededBy))) ||
    new Set(value.batches.map(row => (row as BankBatchSummary).id)).size !== value.batches.length || value.total < value.batches.length) {
    throw new Error('The saved bank history could not be checked. Refresh history before loading another page.');
  }
  return value as unknown as BankHistoryPage;
}

export function bankHistoryUrl(cursor?: string): string {
  const query = new URLSearchParams({ limit: '20' });
  if (cursor) query.set('cursor', cursor);
  return `/api/bank-reference?${query}`;
}

export function appendBankHistory(current: BankHistoryPage, next: BankHistoryPage, requestedCursor: string): BankHistoryPage {
  if (current.nextCursor !== requestedCursor || current.total !== next.total || next.nextCursor === requestedCursor) throw new Error('This history page changed. Refresh history; your open review and decisions are kept.');
  const rows = new Map(current.batches.map(row => [row.id, row]));
  for (const row of next.batches) rows.set(row.id, row);
  if (rows.size > next.total) throw new Error('The history count changed. Refresh history; your open review and decisions are kept.');
  return { ...next, batches: [...rows.values()] };
}

/** An untouched/cleared row is not a draft; a chosen action or typed reason is. */
export function hasUnsavedBankDecisions(decisions: Record<string, { action?: string; propertyId?: string; reason: string }>): boolean {
  return Object.values(decisions).some(row => row.action === 'keep' || Boolean(row.propertyId?.trim()) || Boolean(row.reason.trim()));
}
