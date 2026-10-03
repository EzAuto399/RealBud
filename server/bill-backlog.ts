import { createHash } from 'node:crypto';
import type { BillReviewDraft } from '../shared/bill-review-drafts.ts';
import type { MailScanReceipt } from '../shared/mail-ingestion.ts';
import { mergeMailIntervals, subtractMailInterval } from '../shared/mail-ingestion.ts';
import type { RoutineCoverage, RoutineResult } from '../shared/routine-result.ts';
import { billDateInZone } from '../shared/bill-dates.ts';
import type { BillReviewDraftStore } from './bill-review-drafts.ts';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
/** The weekly runner's draft identity for one exact source digest. */
export function weeklyBillDraftId(workspaceId: string, sourceDigest: string): string {
  const h = hash(['weekly-bill-review-v1', workspaceId, sourceDigest]);
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

/** Open drafts the weekly runner created, oldest first, independent of what the
 * current collection still shows. A message that aged out of the lookback or
 * was regrouped by morning triage keeps its saved draft and exact request. */
export function weeklyBillBacklog(store: BillReviewDraftStore, workspaceId: string, seen: ReadonlySet<string>): BillReviewDraft[] {
  return store.open().filter(draft => !seen.has(draft.id) && draft.proposalRequest !== null && draft.sourceDigest !== null &&
    draft.id === weeklyBillDraftId(workspaceId, draft.sourceDigest));
}

/** Cumulative coverage for the reviewed account. A hole between runs, or a
 * window that was not fully read, stays uncovered until a later window that
 * was fully read includes it; an overlapping run never erases it by itself. */
export function nextBillCoverage(previous: RoutineResult | null, receipt: Pick<MailScanReceipt, 'accountId' | 'bindingRevision' | 'windowStartAt' | 'windowEndAt'>, covered: boolean): RoutineCoverage {
  const window = { startAt: receipt.windowStartAt, endAt: receipt.windowEndAt };
  if (!previous || previous.accountId !== receipt.accountId || previous.bindingRevision !== receipt.bindingRevision)
    return { ...window, uncovered: covered ? [] : [window] };
  // An older result without bookkeeping counts as unchecked if it recorded any gap.
  const legacy = { startAt: previous.windowStartAt, endAt: previous.windowEndAt };
  const prior = previous.coverage ?? { ...legacy, uncovered: previous.gaps.length ? [legacy] : [] };
  let uncovered = prior.uncovered;
  if (prior.endAt < window.startAt) uncovered = mergeMailIntervals([...uncovered, { startAt: prior.endAt, endAt: window.startAt }]);
  uncovered = covered ? subtractMailInterval(uncovered, window) : mergeMailIntervals([...uncovered, window]);
  return { startAt: Math.min(prior.startAt, window.startAt), endAt: Math.max(prior.endAt, window.endAt), uncovered };
}

/** Inclusive office dates for each uncovered interval; widening is conservative. */
export function uncoveredBillDates(coverage: RoutineCoverage, timeZone: string): { from: string; to: string }[] {
  return coverage.uncovered.map(i => ({ from: billDateInZone(i.startAt, timeZone), to: billDateInZone(i.endAt - 1, timeZone) }));
}
