import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock('@/state/store', () => ({ api: store.api, useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
// A static render never runs effects; record them so the test can run the unsaved-work guard's.
const hooks = vi.hoisted(() => ({ effects: [] as Array<{ effect: () => unknown; deps?: unknown[] }>, checks: [] as Array<() => boolean> }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useEffect: (effect: () => unknown, deps?: unknown[]) => { hooks.effects.push({ effect, deps }); } }));
vi.mock('@/lib/unsaved-work', async original => ({ ...await original<object>(), guardUnsavedWork: (check: () => boolean) => { hooks.checks.push(check); return () => {}; } }));
/** Runs the effects a mount would run once (empty deps) and returns the unsaved-work checks they registered. */
const mountGuards = () => { for (const { effect, deps } of hooks.effects) if (deps?.length === 0) effect(); return hooks.checks; };

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
    hooks.effects.length = 0; hooks.checks.length = 0;
    store.api.mockReturnValue(new Promise(() => {})); // settings still loading
    renderToStaticMarkup(createElement(AgencyWorkflowSetup, {}));
    const checks = mountGuards();
    expect(checks).toHaveLength(1);
    expect(checks[0]()).toBe(false);
  });
});
