import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@/state/store';
import { HERMES_MEMORY_APPROVAL } from '@shared/approval-policy';

vi.mock('@/state/store', () => ({ useStore: () => ({ state: { desk: { properties: [] } }, dispatch: vi.fn() }) }));
import { ApprovalCard } from './ApprovalCard';
import { PendingApprovalActions, PendingApprovalPanel, pendingApprovals } from './PendingApproval';

const message = (card: Record<string, unknown>, id = 'app-message'): Message => ({ id, role: 'bot', kind: 'options', at: 1, card: { title: 'Approval needed',
  subtitle: 'Bud wants to use Gmail.\nAction: Fetch emails (GMAIL_FETCH_EMAILS)', detail: '{\n  "name": "GMAIL_FETCH_EMAILS"\n}', options: ['Allow', 'Deny'],
  requestId: `request-${id}`, tool: 'bud_connected_app_action', ...card } as Message['card'] });
const render = (card: Record<string, unknown>) => renderToStaticMarkup(createElement(ApprovalCard, { message: message(card), productAsk: true }));
/** The transcript plus the oldest pending decision, wired as Composer wires it. */
function thread(messages: Message[], productAsk = true): string {
  const pending = pendingApprovals(messages), active = pending[0];
  return renderToStaticMarkup(createElement(Fragment, null,
    ...messages.map(value => createElement(ApprovalCard, { key: value.id, message: value, productAsk })),
    active && createElement(PendingApprovalPanel, { pending: active, count: pending.length, index: 0, productAsk }),
    active && createElement(PendingApprovalActions, { pending: active, threadId: 'thread', productAsk, onCancelTurn: vi.fn() }),
  ));
}
const count = (html: string, text: string) => html.split(text).length - 1;

describe('an approval card in the conversation', () => {
  it('keeps the exact request under a collapsed "Exact request" disclosure below the plain lines', () => {
    for (const html of [render({ answered: 'allow' }), render({ answered: 'deny' })]) {
      expect(html.indexOf('Action: Fetch emails')).toBeLessThan(html.indexOf('<summary'));
      expect(html).toMatch(/<details[^>]*><summary[^>]*>Exact request<\/summary><pre[^>]*aria-label="Exact request"/);
    }
    expect(render({ answered: 'allow', detail: undefined })).not.toContain('Exact request');
  });
  it('collapses an answered card to who answered it, where and when', () => {
    const at = '2026-10-08T05:16:00.000Z';
    for (const [via, word] of [['telegram', 'Telegram'], ['desktop', 'desktop']] as const) {
      const html = render({ answered: 'allow', answeredBy: { name: 'Fictional Sam', via, at } });
      expect(html).toMatch(new RegExp(`role="status"[^>]*>Allowed once by Fictional Sam via ${word} · \\d{1,2}:16`));
      expect(html).not.toContain('Exact request');
      expect(html).not.toContain('Approved');
    }
    expect(render({ answered: 'deny', answeredBy: { name: 'Fictional Sam', via: 'telegram', at } })).toContain('Denied by Fictional Sam via Telegram');
    // Still waiting: the composer has it. A malformed answerer: the full record.
    expect(render({ answeredBy: { name: 'Fictional Sam', via: 'telegram', at } })).toContain('Waiting for your answer below');
    expect(render({ answered: 'allow', answeredBy: { name: 'Fictional Sam', via: 'pager' } })).toContain('Approved');
  });
});

describe('one place to decide a pending approval', () => {
  it('shows the request once, in the composer, with only a readable waiting line in the transcript', () => {
    const value = message({ held: 'Check the recipient before sending.' });
    for (const productAsk of [true, false]) {
      const html = thread([value], productAsk);
      expect(count(html, 'Action: Fetch emails')).toBe(1);
      expect(count(html, 'Check the recipient before sending.')).toBe(1);
      expect(count(html, '>Exact request</summary>')).toBe(1);
      expect(count(html, '>Allow once</button>')).toBe(1);
    }
    const marker = render({});
    expect(marker).toContain('Waiting for your answer below');
    expect(marker).not.toMatch(/<button|<pre|<details/);
  });

  it('shows browser facts and memory reviews once', () => {
    const browser = message({ tool: 'browser_click_semantic', approvalPolicy: 'once', browserApproval: {
      version: 1, purpose: 'browser-approval-card', id: '00000000-0000-4000-8000-00000000000c', kind: 'pay',
      site: 'portal.fictional-strata.example', control: 'Pay now', expiresAt: Date.now() + 120_000,
      facts: [
        { name: 'recipient', value: 'Fictional Strata Pty Ltd', confirmed: true },
        { name: 'amount', value: '1240.00', confirmed: true },
        { name: 'currency', value: 'AUD', confirmed: true },
        { name: 'reference', value: 'LEVY-FICTIONAL-12', confirmed: true },
      ],
    } });
    const browserHtml = thread([browser]);
    expect(count(browserHtml, 'aria-label="Details confirmed on the page"')).toBe(1);
    expect(count(browserHtml, 'LEVY-FICTIONAL-12')).toBe(1);
    expect(browserHtml).toContain('Decline payment');
    // Settled: the transcript keeps the full record.
    const stopped = renderToStaticMarkup(createElement(ApprovalCard, { message: { ...browser, card: { ...browser.card!, answered: 'stopped' } }, productAsk: true }));
    expect(stopped).toContain('LEVY-FICTIONAL-12');

    const content = 'Remember the fictional office preference.';
    const memory = message({ tool: HERMES_MEMORY_APPROVAL, subtitle: content, approvalPolicy: 'once', memoryReview: { description: 'Save to memory: add to memory', content, complete: true } });
    const memoryHtml = thread([memory]);
    expect(count(memoryHtml, content)).toBe(1);
    expect(memoryHtml).toContain('aria-label="Complete proposed memory change"');
  });

  it('keeps the full record for anything the composer does not show', () => {
    for (const card of [{ answered: 'allow' }, { answered: 'deny' }, { dismissed: true }]) {
      const value = message(card);
      expect(pendingApprovals([value])).toEqual([]);
      expect(render(card)).toContain('Action: Fetch emails');
    }
  });

  it('shows queued decisions one at a time, and the answered one stays as a record', () => {
    const first = message({}, 'first'), second = message({ subtitle: 'Create the fictional calendar event' }, 'second');
    const waiting = thread([first, second]);
    expect(waiting).toContain('1 of 2');
    expect(count(waiting, 'Action: Fetch emails')).toBe(1);
    expect(count(waiting, 'Waiting for your answer below')).toBe(2);
    const next = thread([{ ...first, card: { ...first.card!, answered: 'allow' } }, second]);
    expect(count(next, 'Action: Fetch emails')).toBe(1);
    expect(count(next, 'Create the fictional calendar event')).toBe(1);
    expect(next).toContain('Approved');
    expect(count(next, '>Allow once</button>')).toBe(1);
  });
});
