import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: { loopRuns: [] } }) }));
import { BillFollowUpList, BillRoutineResult } from './BillRoutineStatus';
import type { RoutineResult } from '@shared/routine-result';
import type { BillFollowUp, BillFollowUpPage } from '@shared/bill-followups';

it('makes source scope and coverage gaps visible without asserting a payment', () => {
  const result = { accountId: 'fictional-mail', detail: '2 candidates, 1 held.', windowStartAt: 1, windowEndAt: 2, finishedAt: 3,
    gaps: ['Fictional page missing'], findings: [] } as unknown as RoutineResult;
  const html = renderToStaticMarkup(createElement(BillRoutineResult, { result }));
  expect(html).toContain('Latest weekly bills result'); expect(html).toContain('fictional-mail');
  expect(html).toContain('Fictional page missing');
  expect(html).toContain('Saved bill reviews'); expect(html).toContain('expected arrival windows remain separate');
  expect(html).not.toContain('confirmed-paid');
});

const item = (n: number, patch: Partial<BillFollowUp> = {}): BillFollowUp => ({ id: `arrival-${n}`, revision: 1, propertyId: 'fictional-property', label: `Water · Fictional utility ${n}`,
  state: 'coverage-hold', from: '2026-09-20', to: '2026-09-25', reason: 'Review missing coverage.', evidenceKey: 'a'.repeat(64), active: true, firstSeenAt: 1,
  status: 'open', owner: '', followUpOn: '', history: [], ...patch });
const render = (page: BillFollowUpPage) => renderToStaticMarkup(createElement(BillFollowUpList, { page, busy: false, onDecide: () => {}, onPlan: () => {}, onFilter: () => {}, onMore: () => {} }));

it('shows compact follow-up rows with one primary action each and a way to every remaining finding', () => {
  const html = render({ version: 1, filter: 'open', total: 45, counts: { open: 44, resolved: 1 }, nextCursor: 'next',
    items: [item(1, { owner: 'Kevin', followUpOn: '2026-10-09', history: [{ at: 1, action: 'planned', note: 'Assigned to Kevin; follow up on 2026-10-09.' }] }),
      item(2, { status: 'resolved', active: false, history: [{ at: 1, action: 'resolved', note: '' }] })] });
  expect(html).toContain('Arrival follow-ups · 44 open');
  expect(html).toContain('aria-label="Resolve fictional-property · Water · Fictional utility 1"');
  expect(html).toContain('aria-label="Reopen fictional-property · Water · Fictional utility 2"');
  expect(html.match(/<button type="button"/g)).toHaveLength(3); // two row actions + show more
  expect(html).toContain('Coverage hold · Kevin · Follow up 2026-10-09');
  expect(html).toContain('Not in the latest review');
  expect(html).toContain('aria-label="Assign fictional-property · Water · Fictional utility 1"');
  expect(html).not.toContain('aria-label="Assign fictional-property · Water · Fictional utility 2"');
  expect(html).toContain('Show more follow-ups');
  expect(html).toContain('type="date"');
});

it('shows an empty state without a load-more control', () => {
  const html = render({ version: 1, filter: 'resolved', total: 0, counts: { open: 0, resolved: 0 }, nextCursor: null, items: [] });
  expect(html).toContain('No resolved follow-ups.'); expect(html).not.toContain('Show more follow-ups');
});
