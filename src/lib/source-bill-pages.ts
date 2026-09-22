import type { SourceBillPage } from '@shared/source-bills';
import type { ExpectedBillsPage } from '@shared/source-bills-api';

/** Encode filters together with the cursor; never reuse a cursor after changing scope. */
export function billPageUrl(path: string, values: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  return `${path}?${query}`;
}

export function mergeBillRows<T extends { id: string }>(current: T[], next: T[]): T[] {
  const rows = new Map(current.map(row => [row.id, row]));
  for (const row of next) rows.set(row.id, row);
  return [...rows.values()];
}

/** A page belongs to its insertion snapshot, even if later corrections changed
 * the live revision. A refreshed first page starts a new snapshot. */
export function appendBillPage<T extends { id: string }>(current: SourceBillPage<T>, next: SourceBillPage<T>, requestedCursor: string): SourceBillPage<T> {
  if (current.nextCursor !== requestedCursor || current.snapshotCursor !== next.snapshotCursor || next.nextCursor === requestedCursor) throw new Error('This bill page changed. Refresh the list before loading more.');
  return { ...next, items: mergeBillRows(current.items, next.items) };
}

export function expectedBillsPage<T>(value: unknown): ExpectedBillsPage<T> {
  const page = value as ExpectedBillsPage<T> | null;
  if (!page || page.version !== 2 || !Array.isArray(page.bills) || !Number.isSafeInteger(page.total) || page.total < 0 ||
    !page.counts || !Number.isSafeInteger(page.counts.legacy) || !Number.isSafeInteger(page.counts.source) || page.counts.legacy < 0 || page.counts.source < 0 ||
    !(page.nextCursor === null || typeof page.nextCursor === 'string') || typeof page.revision !== 'string' ||
    !page.groups || !['needs-you', 'due-soon', 'in-process', 'settled'].every(group => Array.isArray(page.groups[group as keyof typeof page.groups]))) throw new Error('The bill page could not be checked. Refresh before continuing.');
  return page;
}
