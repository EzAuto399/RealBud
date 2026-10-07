import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

vi.mock('@/state/store', () => ({ useStore: () => ({ state: { desk: null, bots: [], groups: [] }, dispatch: vi.fn() }), visibleMessages: () => [], api: vi.fn() }));
import { BudWaiting } from './ContextPanel';

it('mirrors Bud\'s waiting cards above the Desk rows, each opening its conversation', () => {
  const open = vi.fn();
  const html = renderToStaticMarkup(createElement(BudWaiting, { rows: [{ key: 'bud:r1', line: 'Gmail · Send email · 2 min left', open }, { key: 'bud:r2', line: 'Outlook · List messages', open }] }));
  expect(html).toContain('Bud is waiting on you: 2');
  expect(html).toContain('aria-label="Open the conversation: Gmail · Send email · 2 min left"');
  expect(renderToStaticMarkup(createElement(BudWaiting, { rows: [] }))).toBe('');
});
