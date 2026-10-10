import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

vi.mock('@/state/store', () => ({ api: vi.fn() }));
// Each render's answer to the unsaved-work guard (beforeunload and the update restart).
const guards = vi.hoisted(() => [] as boolean[]);
vi.mock('@/lib/unsaved-work', async original => ({ ...await original<object>(), useUnsavedGuard: (dirty: boolean) => { guards.push(dirty); } }));
import { SharedWorkPanel } from './SharedWorkPanel';

it('names the area with a real heading and a separate, labelled toggle', () => {
  const closed = renderToStaticMarkup(createElement(SharedWorkPanel));
  expect(closed).toContain('<section aria-labelledby="shared-work-heading"');
  expect(closed).toContain('<h2 id="shared-work-heading" class="text-[15px] font-medium text-ink">Shared work</h2>');
  expect(closed).toMatch(/<button type="button" class="[^"]*" aria-expanded="false" aria-controls="shared-work-panel">Show shared work<\/button>/);
  expect(closed).not.toMatch(/<button[^>]*>Shared work<\/button>/);
  expect(renderToStaticMarkup(createElement(SharedWorkPanel, { initialExpanded: true }))).toContain('aria-expanded="true" aria-controls="shared-work-panel">Hide shared work</button>');
});

it('holds beforeunload and the update restart only while share text is typed', () => {
  const answer = (initialDraft?: { title: string; summary: string }) => {
    guards.length = 0;
    renderToStaticMarkup(createElement(SharedWorkPanel, { initialExpanded: true, initialDraft }));
    return [...guards];
  };
  expect(answer()).toEqual([false]);
  expect(answer({ title: ' ', summary: '\n' })).toEqual([false]);
  expect(answer({ title: 'Fictional lease summary', summary: '' })).toEqual([true]);
  expect(answer({ title: '', summary: 'Fictional notes for review' })).toEqual([true]);
});
