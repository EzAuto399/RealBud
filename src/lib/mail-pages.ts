import type { MailScanPage, MailTaskPage, MailWorkGroup, MailWorkItem, MailWorkspaceCounts } from '@shared/mail-ingestion';

const changed = (): never => { throw new Error('This mail page changed or could not be checked. Refresh the list before loading more. Your open edits are kept.'); };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const groups: MailWorkGroup[] = ['all', 'open', 'waiting', 'reference', 'snoozed', 'done'];
function counts(value: unknown): value is MailWorkspaceCounts {
  if (!record(value) || !['total', 'open', 'waiting', 'reference', 'snoozed', 'done', 'highPriority', 'needsReview'].every(key => count(value[key]))) return false;
  return ['open', 'waiting', 'reference', 'snoozed', 'done'].reduce((sum, key) => sum + Number(value[key]), 0) === value.total && Number(value.highPriority) <= Number(value.total) && Number(value.needsReview) <= Number(value.total);
}
function readPage(value: unknown): Record<string, unknown> {
  if (!record(value) || value.version !== 2 || !count(value.revision) || !count(value.total) || !Array.isArray(value.items) || value.items.length > 100 || value.items.length > value.total ||
    !(value.nextCursor === null || typeof value.nextCursor === 'string' && value.nextCursor.length > 0) ||
    value.items.some(item => !record(item) || typeof item.id !== 'string' || !item.id) || new Set(value.items.map(item => item.id)).size !== value.items.length) return changed();
  return value;
}
/** Keep scope in the request alongside its cursor; a changed search starts a fresh page. */
export function mailPageUrl(path: string, values: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== null && value !== undefined && value !== '') query.set(key, String(value));
  return `${path}?${query}`;
}
export function readMailTaskPage(value: unknown, scope?: { group: MailWorkGroup; q: string }): MailTaskPage {
  const page = readPage(value);
  if (!groups.includes(page.group as MailWorkGroup) || typeof page.q !== 'string' || !counts(page.counts) || Number(page.total) > page.counts.total ||
    scope && (page.group !== scope.group || page.q !== scope.q) ||
    (page.items as unknown[]).some(item => !record(item) || !count(item.revision) || typeof item.subject !== 'string' || typeof item.owner !== 'string' || typeof item.note !== 'string' || !Array.isArray(item.missingFacts))) return changed();
  return page as unknown as MailTaskPage;
}
export function readMailScanPage(value: unknown): MailScanPage {
  const page = readPage(value);
  if ((page.items as unknown[]).some(item => !record(item) || !['running', 'complete', 'partial', 'failed', 'interrupted'].includes(String(item.status)) || !count(item.startedAt) || !Array.isArray(item.gaps))) return changed();
  return page as unknown as MailScanPage;
}
/** Mail ordering is revision-bound: edits and snooze expiry require a fresh list,
 * so no continuation may merge a different revision or filter into visible rows. */
export function appendMailPage<P extends MailTaskPage | MailScanPage>(current: P, next: P, requestedCursor: string): P {
  if (!requestedCursor || current.nextCursor !== requestedCursor || current.revision !== next.revision || current.total !== next.total || next.nextCursor === requestedCursor ||
    ('group' in current && (!('group' in next) || current.group !== next.group || current.q !== next.q)) || ('group' in current) !== ('group' in next)) return changed();
  const ids = new Set(current.items.map(item => item.id));
  if (next.items.some(item => ids.has(item.id)) || current.items.length + next.items.length > current.total) return changed();
  return { ...next, items: [...current.items, ...next.items] };
}
/** A source review has its own identity. Paging must not replace its selected item. */
export function retainSelectedMailItem(items: MailWorkItem[], selected: MailWorkItem | null): MailWorkItem[] {
  return selected && !items.some(item => item.id === selected.id) ? [selected, ...items] : items;
}
