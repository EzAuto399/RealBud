import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '@/state/store';

vi.mock('@/state/store', () => ({ useStore: () => ({ state: { desk: { properties: [] } }, dispatch: vi.fn() }) }));
import { ApprovalCard } from './ApprovalCard';

const message = (card: Record<string, unknown>): Message => ({ id: 'app-message', role: 'bot', kind: 'options', at: 1, card: { title: 'Approval needed',
  subtitle: 'Bud wants to use Gmail.\nAction: Fetch emails (GMAIL_FETCH_EMAILS)', detail: '{\n  "name": "GMAIL_FETCH_EMAILS"\n}', options: ['Allow', 'Deny'],
  requestId: 'request-app', tool: 'bud_connected_app_action', ...card } as Message['card'] });
const render = (card: Record<string, unknown>) => renderToStaticMarkup(createElement(ApprovalCard, { message: message(card), productAsk: true }));

describe('an approval card in the conversation', () => {
  it('keeps the exact request under a collapsed "Exact request" disclosure below the plain lines', () => {
    for (const html of [render({}), render({ answered: 'allow' })]) {
      expect(html.indexOf('Action: Fetch emails')).toBeLessThan(html.indexOf('<summary'));
      expect(html).toMatch(/<details[^>]*><summary[^>]*>Exact request<\/summary><pre[^>]*aria-label="Exact request"/);
    }
    expect(render({ detail: undefined })).not.toContain('Exact request');
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
    // Still waiting, or a malformed answerer: the full card.
    expect(render({ answeredBy: { name: 'Fictional Sam', via: 'telegram', at } })).toContain('Waiting for your answer below');
    expect(render({ answered: 'allow', answeredBy: { name: 'Fictional Sam', via: 'pager' } })).toContain('Approved');
  });
});
