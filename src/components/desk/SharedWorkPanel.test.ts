import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

vi.mock('@/state/store', () => ({ api: vi.fn() }));
import { SharedWorkPanel } from './SharedWorkPanel';

it('names the area with a real heading and a separate, labelled toggle', () => {
  const closed = renderToStaticMarkup(createElement(SharedWorkPanel));
  expect(closed).toContain('<section aria-labelledby="shared-work-heading"');
  expect(closed).toContain('<h2 id="shared-work-heading" class="text-[15px] font-medium text-ink">Shared work</h2>');
  expect(closed).toMatch(/<button type="button" class="[^"]*" aria-expanded="false" aria-controls="shared-work-panel">Show shared work<\/button>/);
  expect(closed).not.toMatch(/<button[^>]*>Shared work<\/button>/);
  expect(renderToStaticMarkup(createElement(SharedWorkPanel, { initialExpanded: true }))).toContain('aria-expanded="true" aria-controls="shared-work-panel">Hide shared work</button>');
});
