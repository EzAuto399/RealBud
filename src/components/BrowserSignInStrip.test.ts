import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { BrowserSignInStrip, parseBrowserSignIns, type BrowserSignInView } from './BrowserSignInStrip';

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
