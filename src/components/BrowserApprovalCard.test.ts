import { createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '@/state/store';
import type { BrowserApprovalCard } from '@shared/browser-approval-card';
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals, type Pending } from './PendingApproval';
import { ApprovalCard } from './ApprovalCard';

const fixture = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock('@/state/store', () => ({ useStore: () => ({ state: { desk: { properties: [] } }, dispatch: fixture.dispatch }) }));

const NOW = Date.now();
const pay = (extra: Partial<BrowserApprovalCard> = {}): BrowserApprovalCard => ({
  version: 1, purpose: 'browser-approval-card', id: '00000000-0000-4000-8000-00000000000c', kind: 'pay', site: 'portal.fictional-strata.example', control: 'Pay now',
  facts: [
    { name: 'recipient', value: 'Fictional Strata Pty Ltd', confirmed: true },
    { name: 'amount', value: '1240.00', confirmed: true },
    { name: 'currency', value: 'AUD', confirmed: true },
    { name: 'reference', value: 'LEVY-FICTIONAL-12', confirmed: true },
  ],
  expiresAt: NOW + 120_000,
  ...extra,
});
const message = (browserApproval: unknown, answered?: string): Message => ({ id: 'm-pay', role: 'bot', kind: 'options', at: 1,
  card: { title: 'Approval needed', subtitle: 'Pay AUD 1240.00 to Fictional Strata Pty Ltd', options: ['Allow', 'Deny'], requestId: 'req-pay', tool: 'browser_click_semantic', approvalPolicy: 'once',
    browserApproval: browserApproval as BrowserApprovalCard, ...(answered ? { answered } : {}) } });
const pending = (card: unknown): Pending => pendingApprovals([message(card)])[0];
const props = (value: Pending, now = NOW) => ({ pending: value, threadId: 'thread-1', productAsk: true, onCancelTurn: vi.fn(), now });
const panel = (value: Pending, now = NOW) => renderToStaticMarkup(createElement(PendingApprovalPanel, { pending: value, count: 1, index: 0, productAsk: true, now }));
const actions = (value: Pending, now = NOW) => renderToStaticMarkup(createElement(PendingApprovalActions, props(value, now)));
/** The decision row's callbacks, exactly as the composer wires them. */
function callbacks(value: Pending, now = NOW) {
  const options = props(value, now);
  const element = PendingApprovalActions(options);
  if (!isValidElement(element)) throw new Error('no decision row');
  return { ...(element.props as { onApprove: () => void; onDecline: () => void; onStop: () => void }), onCancelTurn: options.onCancelTurn };
}
const approveButton = (html: string) => html.match(/<button[^>]*>Pay[^<]*<\/button>|<button[^>]*>Approve<\/button>/)?.[0] ?? '';
beforeEach(() => fixture.dispatch.mockClear());

describe('consequential browser approval card', () => {
  it('confirmed: asks the real question, lists each confirmed fact and approves exactly once', () => {
    const value = pending(pay());
    const top = panel(value), row = actions(value);
    expect(top).toContain('Pay A$1,240.00 to Fictional Strata Pty Ltd?');
    expect(top).toContain('Button “Pay now” on portal.fictional-strata.example');
    expect(top).toContain('Needs your approval · this payment only'); expect(top).toContain('Expires in 2:00');
    expect(top).toContain('aria-label="Details confirmed on the page"');
    for (const text of ['Payee', 'Fictional Strata Pty Ltd', 'Amount', 'A$1,240.00', 'Reference', 'LEVY-FICTIONAL-12']) expect(top).toContain(text);
    expect(top.match(/Confirmed on the page/g)).toHaveLength(3); expect(top).not.toContain('Not confirmed');
    expect(approveButton(row)).toContain('>Pay A$1,240.00</button>'); expect(approveButton(row)).not.toContain('disabled=""');
    expect(row).toContain('Decline payment'); expect(row).toContain('Stop the task');
    expect(row).not.toContain('Always allow'); expect(row).not.toContain('Allow for this task'); expect(row).not.toContain('standing rule');
    const decide = callbacks(value);
    decide.onApprove();
    expect(fixture.dispatch).toHaveBeenCalledWith({ type: 'decideRequest', threadId: 'thread-1', requestId: 'req-pay', behavior: 'allow', message: undefined, scope: 'once', rule: undefined, alwaysAllow: undefined });
    decide.onDecline(); expect(fixture.dispatch).toHaveBeenLastCalledWith(expect.objectContaining({ behavior: 'deny' }));
    decide.onStop(); expect(decide.onCancelTurn).toHaveBeenCalledOnce();
  });

  it('unconfirmed: shows the gap and disables approval with a plain reason', () => {
    const card = pay(); card.facts[0] = { name: 'recipient', value: null, confirmed: false };
    const value = pending(card);
    const top = panel(value), row = actions(value);
    expect(top).toContain('Approve a payment on portal.fictional-strata.example?');
    expect(top).toContain('Not confirmed on the page'); expect(top).toContain('Not shown on the page');
    expect(approveButton(row)).toContain('disabled=""');
    expect(row).toContain('Bud could not confirm the payee on the page, so this payment cannot be approved here.');
    callbacks(value).onApprove(); expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it('expired: shows it expired, nothing was pressed, and cannot be approved', () => {
    const value = pending(pay());
    const later = NOW + 121_000;
    expect(panel(value, later)).toContain('Expired');
    const row = actions(value, later);
    expect(approveButton(row)).toContain('disabled=""');
    expect(row).toContain('This approval expired. Nothing was pressed.');
    expect(row).toContain('Stop the task');
    callbacks(value, later).onApprove(); expect(fixture.dispatch).not.toHaveBeenCalled();
  });

  it('stopped: leaves the waiting list and records that it can no longer be used', () => {
    expect(pendingApprovals([message(pay(), 'stopped')])).toEqual([]);
    const html = renderToStaticMarkup(createElement(ApprovalCard, { message: message(pay(), 'stopped'), productAsk: true }));
    expect(html).toContain('Pay A$1,240.00 to Fictional Strata Pty Ltd?');
    expect(html).toContain('Stopped. Nothing was pressed, and this approval can no longer be used.');
    expect(html).not.toContain('<button'); expect(html).not.toContain('Expires in');
  });

  it('damaged: holds the card instead of offering a generic approval', () => {
    const value = pending({ ...pay(), facts: [] });
    expect(value.browserApproval).toBeNull();
    expect(panel(value)).toContain('Approval details unavailable');
    const row = actions(value);
    expect(approveButton(row)).toContain('disabled=""'); expect(row).not.toContain('Allow once');
    expect(row).toContain('incomplete or damaged');
  });

  it('send: names the recipient and binds the message text without showing a hash', () => {
    const send: BrowserApprovalCard = { ...pay(), kind: 'send', control: 'Send', facts: [
      { name: 'to', value: 'owner@fictional.example', confirmed: true },
      { name: 'subject', value: 'Levy copy', confirmed: true },
      { name: 'bodyHash', value: null, confirmed: true },
    ] };
    const value = pending(send);
    const top = panel(value);
    expect(top).toContain('Send this message to owner@fictional.example?');
    expect(top).toContain('Message text'); expect(top).toContain('Bud read the message text on the page. If it changes, nothing is pressed.');
    expect(actions(value)).toContain('>Send this message</button>');
    expect(actions(value)).toContain('Decline message');
  });
});
