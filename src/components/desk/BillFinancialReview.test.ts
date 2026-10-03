import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { BillFinancialReview as Review } from '@shared/source-bills';
import type { BillFinancialReviewDraft } from '@shared/bill-review-drafts';
import { BillFinancialFields, BillFinancialSummary } from './BillFinancialReview';

vi.mock('@/state/store', () => ({ api: vi.fn() }));
const review: Review = { version: 1, basisBillRevision: 1, sourceDigest: 'a'.repeat(64), reviewedAt: 1, reviewedBy: 'fictional-reviewer', reviewReason: 'Checked fictional evidence', provenance: 'simulated', sourceKind: 'external-record', sourceIds: ['ledger-row-1'], locator: '<script>ledger</script>', accountContext: 'Fictional account', observedAt: 1, coverage: 'partial', entry: 'recorded', payment: 'arranged-unconfirmed', funding: 'insufficient', advance: 'outstanding', note: 'Limited scope' };
const draft: BillFinancialReviewDraft = { ...review, sourceIds: 'ledger-row-1', observedAt: '2026-01-01T10:30:00.000Z' };
const summary = (value?: Review, stale = false) => renderToStaticMarkup(createElement(BillFinancialSummary, { review: value, stale }));

describe('compact financial review presentation', () => {
  it('renders legacy records with four independent unknown states', () => {
    const html = summary();
    for (const field of ['Entry', 'Payment', 'Funding', 'Advance']) expect(html).toContain(`<dt class="text-ink-secondary">${field}</dt><dd>Unknown</dd>`);
    expect(html).toContain('has not been reviewed');
    expect(html).not.toContain('Paid with reviewed evidence');
  });
  it('labels simulated claims and does not promote arranged payment to paid', () => {
    const html = summary(review);
    expect(html).toContain('Human-reviewed claim · Simulated evidence');
    expect(html).toContain('do not establish the live account position');
    expect(html).toContain('Arranged, payment unconfirmed');
    expect(html).toContain('Insufficient'); expect(html).toContain('Outstanding');
    expect(html).not.toContain('Paid with reviewed evidence');
    expect(html).toContain('&lt;script&gt;ledger&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });
  it('renders stale current states unknown while keeping the earlier claim visible as history', () => {
    const html = summary({ ...review, provenance: 'actual', payment: 'confirmed-paid' }, true);
    expect(html).toContain('Current financial states are unknown');
    expect(html).toContain('Earlier financial claim and evidence');
    expect(html.match(/<dd>Unknown<\/dd>/g)).toHaveLength(4);
    expect(html).toContain('Payment: Paid with reviewed evidence');
  });
  it('provides separate selectors, scope and evidence inputs without a restored confirmation', () => {
    const html = renderToStaticMarkup(createElement(BillFinancialFields, { value: draft, disabled: false, onChange: vi.fn() }));
    for (const field of ['Entry state', 'Payment state', 'Funding state', 'Advance state', 'Evidence basis', 'Evidence source type', 'Evidence location', 'Account context', 'Observed at (your local time)', 'Scope checked', 'Evidence references (one per line)']) expect(html).toContain(field);
    expect(html.match(/<option value="unknown"/g)).toHaveLength(6);
    expect(html).toContain('CSV status only');
    expect(html).not.toContain('type="checkbox"');
  });
});
