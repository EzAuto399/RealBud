import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BillDuplicateCheck } from '@shared/source-bills';
import type { MailScanReceipt } from '@shared/mail-ingestion';
import { BillCollectionReceipt, BillDuplicateReview, billCollectionNotice } from './SourceBillsPanel';

vi.mock('@/state/store', () => ({ api: vi.fn() }));
const check: BillDuplicateCheck = { version: 1, sourceDigest: 'a'.repeat(64), reviewDigest: 'b'.repeat(64), complete: true, candidates: [{ billId: `source-bill:${'e'.repeat(64)}`, revision: 3, matchedRevision: 1, sourceDigest: 'c'.repeat(64), subject: '<script>invoice</script>', receivedAt: 1,
  facts: { propertyId: 'property', kind: 'Water', vendor: 'Utility', currency: 'AUD', amountCents: 12500, invoiceDate: '2026-09-01', dueDate: '2026-10-01', note: '' } }] };
const render = (overrides: Partial<Parameters<typeof BillDuplicateReview>[0]> = {}) => renderToStaticMarkup(createElement(BillDuplicateReview, {
  check, loading: false, error: '', checked: false, disabled: false, label: () => 'Sample property', onConfirm: vi.fn(), onOpen: vi.fn(), onRetry: vi.fn(), ...overrides,
}));

describe('matching bill review presentation', () => {
  it('shows candidates, their matching revision and a way to preserve the draft while inspecting them', () => {
    const html = render();
    expect(html).toContain('aria-label="Matching saved bills"');
    expect(html).toContain('Sample property');
    expect(html).toContain('Matching revision 1 · current revision 3');
    expect(html).toContain('Save draft and open matching bill');
    expect(html).toContain('Return to it through Saved bill reviews');
    expect(html).toContain('&lt;script&gt;invoice&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('confirm this is a separate invoice');
    expect(html).not.toContain('checked=""');
  });
  it('does not offer a separate-invoice override when checking failed or is incomplete', () => {
    const failed = render({ check: null, error: 'Matching bills could not be checked. Your draft is kept; retry before saving.' });
    expect(failed).toContain('role="alert"');
    expect(failed).not.toContain('type="checkbox"');
    const incomplete = render({ check: { ...check, complete: false, reviewDigest: null } });
    expect(incomplete).toContain('Saving is held');
    expect(incomplete).not.toContain('type="checkbox"');
  });
  it('does not present stale candidates or an approval while a new read is pending', () => {
    const html = render({ loading: true, checked: true });
    expect(html).toContain('Checking saved bills');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain('Save draft and open matching bill');
  });
  it('describes a complete empty result with its exact-match limitation', () => {
    const html = render({ check: { ...check, candidates: [], reviewDigest: null } });
    expect(html).toContain('No exact match found');
    expect(html).toContain('Check the original invoice');
    expect(html).not.toContain('type="checkbox"');
  });
  it('shows a conflicting invoice number without a separate-invoice override', () => {
    const html = render({ check: { ...check, candidates: [{ ...check.candidates[0], match: 'invoice-conflict', facts: { ...check.candidates[0].facts, invoiceNumber: '000142/A', invoiceVersion: '2' } }] } });
    expect(html).toContain('000142/A');
    expect(html).toContain('version 2');
    expect(html).toContain('reconcile the correction');
    expect(html).toContain('Save draft and open matching bill');
    expect(html).not.toContain('type="checkbox"');
  });
});

describe('bill mail collection feedback', () => {
  const receipt: MailScanReceipt = { id: 'scan', accountId: 'selected-account', bindingRevision: 'binding',
    startedAt: Date.parse('2026-09-30T16:00:00Z'), completedAt: Date.parse('2026-09-30T16:01:00Z'),
    windowStartAt: Date.parse('2026-09-23T16:00:00Z'), windowEndAt: Date.parse('2026-09-30T16:00:00Z'),
    status: 'complete', messageCount: 4, threadCount: 3, pages: 1, gaps: [], inputDigest: 'a'.repeat(64) };
  const renderReceipt = (overrides: Partial<MailScanReceipt> = {}) => renderToStaticMarkup(createElement(BillCollectionReceipt, { receipt: { ...receipt, ...overrides }, timeZone: 'Australia/Brisbane' }));

  it('keeps complete collection distinct from completed bill or attachment review', () => {
    const html = renderReceipt(), visible = html.split('<details>')[0];
    expect(visible).toContain('Latest mail collection: complete');
    expect(visible).toContain('4 messages · 3 conversations · 1 pages');
    expect(visible).toContain('Select a saved message to review its bill facts');
    expect(visible).toContain('does not confirm that bill facts or attachment contents were reviewed');
    expect(visible).not.toContain('Coverage is not confirmed complete');
  });

  it.each(['partial', 'failed', 'interrupted', 'running'] as const)('keeps %s collection and its next action visible without opening details', status => {
    const html = renderReceipt({ status, messageCount: 0, threadCount: 0, pages: 0, gaps: ['Provider stopped before the next page.'] });
    const visible = html.split('<details>')[0];
    expect(visible).toContain(`Latest mail collection: ${status}`);
    expect(visible).toContain('Coverage is not confirmed complete');
    expect(visible).toContain('An empty list does not establish that no bills arrived or that an expected bill is missing');
    expect(visible).not.toContain('scope was collected');
    expect(visible).toContain(billCollectionNotice({ ...receipt, status }));
    expect(html).toContain('Provider stopped before the next page.');
  });

  it('shows the requested interval in the office timezone across a UTC day boundary', () => {
    const visible = renderReceipt().split('<details>')[0];
    const format = (timeZone: string, at: number) => new Intl.DateTimeFormat(undefined, { timeZone, year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(at);
    expect(visible).toContain(`Requested source window: ${format('Australia/Brisbane', receipt.windowStartAt)} to ${format('Australia/Brisbane', receipt.windowEndAt)} · Australia/Brisbane.`);
    expect(visible).not.toContain(format('UTC', receipt.windowEndAt));
  });

  it('never treats a missing receipt as successful collection', () => {
    expect(billCollectionNotice(null)).toContain('No bill mail collection receipt is available');
    expect(billCollectionNotice(null)).toContain('Refresh saved sources');
    expect(billCollectionNotice(null)).not.toContain('scope was collected');
  });
});
