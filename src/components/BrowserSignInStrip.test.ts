import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/state/store';
import { BrowserSignInStrip, parseBrowserSignIns, useBrowserSignIns, type BrowserSignInView } from './BrowserSignInStrip';

// Run the hook's real effect and state writes without a DOM renderer.
const hook = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as Array<() => void | (() => void)> }));
vi.mock('react', async importOriginal => ({ ...await importOriginal<typeof import('react')>(),
  useCallback: <T,>(callback: T) => callback,
  useRef: <T,>(initial: T) => ({ current: initial }),
  useEffect: (effect: () => void | (() => void)) => { hook.effects.push(effect); },
  useState: <T,>(initial: T) => {
    const index = hook.cursor++;
    if (!(index in hook.values)) hook.values[index] = initial;
    return [hook.values[index], (next: T) => { hook.values[index] = next; }];
  },
}));
vi.mock('@/state/store', () => ({ api: vi.fn() }));

const view = (extra: Partial<BrowserSignInView> = {}): BrowserSignInView => ({
  id: '00000000-0000-4000-8000-0000000000d1', site: 'Fictional Portal', origin: 'https://app.fictional-portal.example', state: 'waiting',
  message: "Sign in to Fictional Portal here. Bud carries on when you're signed in.", ...extra,
});
const render = (value: BrowserSignInView, extra: Record<string, unknown> = {}) =>
  renderToStaticMarkup(createElement(BrowserSignInStrip, { handover: value, onDone: vi.fn(), onStop: vi.fn(), ...extra }));

describe('BrowserSignInStrip', () => {
  it('hands the site over with Done and Stop', () => {
    const html = render(view());
    expect(html).toContain('aria-label="Sign in to Fictional Portal"');
    expect(html).toContain('Sign in to Fictional Portal here. Bud carries on when you&#x27;re signed in.');
    expect(html).toContain('aria-label="Done signing in to Fictional Portal"');
    expect(html).toContain('aria-label="Stop signing in to Fictional Portal"');
    expect(html).not.toMatch(/Hermes|MCP|broker|settings/i);
  });
  it('asks to switch a wrong account and keeps Done, and shows an ended handover without buttons', () => {
    const wrong = render(view({ state: 'wrong_account', message: 'This is signed in to a different account than this task allows. Switch account, then press Done.' }));
    expect(wrong).toContain('Switch account, then press Done.');
    expect(wrong).toContain('>Done</button>');
    const ended = render(view({ state: 'timed_out', message: 'Sign-in to Fictional Portal was not finished within 15 minutes, so Bud paused. Ask again when you are ready.' }));
    expect(ended).toContain('so Bud paused');
    expect(ended).not.toContain('<button');
    expect(render(view(), { error: 'This sign-in has already ended.' })).toContain('role="alert"');
  });
  it('rejects a malformed reply instead of showing a strip', () => {
    expect(parseBrowserSignIns({ handovers: [view()] })).toEqual([view()]);
    expect(() => parseBrowserSignIns({ handovers: [{ ...view(), state: 'typing' }] })).toThrow();
    expect(() => parseBrowserSignIns({})).toThrow();
  });
});

describe('useBrowserSignIns polling', () => {
  afterEach(() => { vi.useRealTimers(); vi.mocked(api).mockReset(); });
  it('keeps one read in flight so a slow reply still shows the handover', async () => {
    vi.useFakeTimers();
    let active = 0, maxActive = 0;
    vi.mocked(api).mockImplementation(() => {
      active++; maxActive = Math.max(maxActive, active);
      return new Promise(resolve => setTimeout(() => { active--; resolve({ handovers: [view()] }); }, 2500));
    });
    hook.values.length = 0; hook.cursor = 0; hook.effects.length = 0;
    useBrowserSignIns({ threadId: 'fictional-thread', busy: true, enabled: true });
    const cleanups = hook.effects.map(effect => effect());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(maxActive).toBe(1);
    expect(hook.values[0]).toEqual([view()]);
    for (const cleanup of cleanups) cleanup?.();
    const calls = vi.mocked(api).mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.mocked(api).mock.calls.length).toBe(calls);
  });
});
