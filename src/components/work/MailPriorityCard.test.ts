import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { MailPriorityCardView, mailCardVisible, setMailItemStatus, type MailCardSnapshot } from './MailPriorityCard';
import type { MailScanReceipt, MailTaskPage, MailWorkItem } from '@shared/mail-ingestion';

vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ dispatch: vi.fn() }) }));
vi.mock('@/lib/workspace-tabs', () => ({ useWorkspaceTabs: () => ({ data: null }) }));


const counts = { total: 9, open: 6, waiting: 2, reference: 0, snoozed: 0, done: 1, highPriority: 1, needsReview: 3 };
const scan = (status: MailScanReceipt['status']): MailScanReceipt => ({ id: 'scan-1', accountId: 'a', bindingRevision: 'b', startedAt: 1, completedAt: 2, windowStartAt: Date.UTC(2026, 8, 24),
  windowEndAt: 3, status, messageCount: 10, threadCount: 4, pages: 1, gaps: status === 'complete' ? [] : ['gap'], inputDigest: null });
const snapshot = (over: Partial<MailCardSnapshot> = {}): MailCardSnapshot => ({ version: 2, revision: 4, latestScan: scan('complete'),
  latestReview: { runId: 'r', sourceReceiptId: 'scan-1', at: 2 }, counts, nextSnoozeAt: null, schedule: { revision: 1 }, operation: null, ...over });
const item = (id: string, over: Partial<MailWorkItem> = {}): MailWorkItem => ({ id, revision: 7, accountId: 'a', threadId: 't', subject: `Subject ${id}`, sourceMessageIds: [], sourceDigest: 'd',
  sourceReceiptId: 'scan-1', disposition: 'reply-review', priority: 'normal', owner: '', reason: '', nextAction: `Reply to ${id}`, missingFacts: [], status: 'open', snoozedUntil: null,
  note: '', reviewed: false, newEvidence: false, firstSeenAt: 1, updatedAt: 1, lastMessageAt: 1, ...over });
const page = (items: MailWorkItem[], group: MailTaskPage['group'] = 'open'): MailTaskPage => ({ version: 2, revision: 4, counts, group, q: '', items, total: items.length, nextCursor: null });
const noop = () => undefined;
const render = (props: Partial<Parameters<typeof MailPriorityCardView>[0]> = {}) => renderToStaticMarkup(createElement(MailPriorityCardView, {
  snapshot: snapshot(), page: page([item('1')]), tab: 'open', showAll: false, busy: false, preparing: false, uncertainReview: false, notice: '', error: '',
  onTab: noop, onShowAll: noop, onOpen: noop, onDone: noop, onPrepare: noop, ...props }));

describe('MailPriorityCard', () => {
  it('stays hidden when mail work is not set up or could not be read', () => {
    expect(render({ snapshot: null })).toBe('');
    expect(render({ snapshot: snapshot({ latestScan: null, latestReview: null, counts: { ...counts, total: 0, open: 0, waiting: 0, done: 0 } }) })).toBe('');
    expect(mailCardVisible(snapshot({ latestScan: null }))).toBe(true);
  });

  it('shows tab counts as a tablist with the selected tab', () => {
    const html = render();
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/role="tab"[^>]*aria-selected="true"[^>]*>Needs you 6</);
    expect(html).toMatch(/aria-selected="false"[^>]*>Waiting 2</);
    expect(html).toMatch(/aria-selected="false"[^>]*>Done 1</);
  });

  it('labels row actions from the disposition and shows high priority only', () => {
    const html = render({ page: page([item('1'), item('2', { disposition: 'hold', priority: 'high' }), item('3', { disposition: 'urgent-review', priority: 'low' })]) });
    expect(html).toContain('aria-label="Review reply: Subject 1"');
    expect(html).toContain('aria-label="Check source: Subject 2"');
    expect(html).toContain('aria-label="Review now: Subject 3"');
    expect(html.match(/High priority/g)).toHaveLength(1);
    expect(html).not.toContain('low');
    expect(html).toContain('aria-label="Done: Subject 1"');
    expect(render({ tab: 'done', page: page([item('9', { status: 'done' })], 'done') })).toContain('aria-label="Reopen: Subject 9"');
  });

  it('shows five rows then Show all', () => {
    const many = Array.from({ length: 7 }, (_, i) => item(String(i)));
    const html = render({ page: page(many) });
    expect(html.match(/<li /g)).toHaveLength(5);
    expect(html).toContain('Show all 7');
    expect(render({ page: page(many), showAll: true }).match(/<li /g)).toHaveLength(7);
  });

  it('Done sends the item revision with the status', async () => {
    const request = vi.fn().mockResolvedValue({});
    await setMailItemStatus(request, item('1'), 'done');
    expect(request).toHaveBeenCalledWith('/api/mail-workspace/items/1', { method: 'PATCH', body: JSON.stringify({ expectedRevision: 7, status: 'done' }) });
  });

  it('shows the coverage line only when the scan is partial', () => {
    expect(render()).not.toContain('Some couldn’t be read');
    const html = render({ snapshot: snapshot({ latestScan: scan('partial') }) });
    expect(html).toContain('Read 10 emails since');
    expect(html).toContain('See which');
    expect(html).toContain('Open full view');
  });

  it('offers Prepare priorities only when no review covers the latest collection', () => {
    expect(render()).not.toContain('Prepare priorities');
    expect(render({ snapshot: snapshot({ latestReview: null }) })).toContain('Prepare priorities');
    expect(render({ snapshot: snapshot({ latestReview: { runId: 'r', sourceReceiptId: 'old', at: 1 } }), preparing: true })).toMatch(/disabled=""[^>]*>Prepare priorities/);
  });
});
