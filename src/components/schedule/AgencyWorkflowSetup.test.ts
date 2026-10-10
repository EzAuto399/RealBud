import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/state/store', () => ({ api: store.api, useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
// Each render's answer to the unsaved-work guard (beforeunload and the update restart).
const guards = vi.hoisted(() => [] as boolean[]);
vi.mock('@/lib/unsaved-work', async original => ({ ...await original<object>(), useUnsavedGuard: (dirty: boolean) => { guards.push(dirty); } }));

import { AgencyWorkflowSetup } from './AgencyWorkflowSetup';

describe('agency workflow setup steps', () => {
  const html = () => renderToStaticMarkup(createElement(AgencyWorkflowSetup, {}));

  it('names its tabs plainly, without step numbers or an explainer paragraph', () => {
    const markup = html();
    const nav = markup.match(/<nav aria-label="Agency setup steps"[^>]*>(.*?)<\/nav>/)?.[1] ?? '';
    expect([...nav.matchAll(/>([^<>]+)<\/button>/g)].map(match => match[1])).toEqual(['Agency', 'Gmail', 'Property references', 'Review workflows']);
    expect(markup).not.toMatch(/\b[1-3][ab]?\. /);
    expect(markup).not.toContain('All three workspace setup steps happen here');
  });
});

describe('unsaved agency settings', () => {
  it('registers one guard for beforeunload and the update restart, holding nothing before an edit', () => {
    guards.length = 0;
    store.api.mockReturnValue(new Promise(() => {})); // settings still loading
    renderToStaticMarkup(createElement(AgencyWorkflowSetup, {}));
    expect(guards).toEqual([false]);
  });
});
