import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/state/store', () => ({ useStore: () => ({ state: {}, dispatch: vi.fn() }), api: vi.fn() }));

import { parseReiSignIn, reiWaitingLine, type ReiSignIn, type ReiSignInStore } from '@/lib/rei-sign-in';
import { ReiSignInCard } from './ReiSignInCard';

const view = (over: Partial<ReiSignIn> = {}): ReiSignIn => ({ state: 'needed', at: null, used: true, signingIn: false, waiting: [{ loopId: 'bank-references', name: 'Bank reference review' }], ...over });
const store = (over: Partial<ReiSignInStore> = {}): ReiSignInStore => ({ view: view(), opening: false, opened: false, justSignedIn: false, error: '', ...over });
const render = (rei: ReiSignInStore) => renderToStaticMarkup(createElement(ReiSignInCard, { rei }));

describe('REI sign-in on Desk', () => {
  it('shows one primary Sign in to REI action, the waiting work and the password promise while REI needs a sign-in', () => {
    const html = render(store());
    expect(html).toContain('aria-label="REI sign-in"');
    expect(html).toContain('REI needs you to sign in');
    expect(html).toContain('Bud is waiting to finish Bank reference review.');
    expect(html).toContain('You type your password on REI’s own page. Bud never sees it.');
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toMatch(/class="pm-decision[^"]*bg-agency[^"]*"[^>]*>.*Sign in to REI<\/button>/);
    expect(html).not.toMatch(/cookie|token|password manager|Hermes/i);
  });

  it('answers at once while opening, says where the page is once open, and shows a plain error with the action still there', () => {
    const opening = render(store({ opening: true }));
    expect(opening).toContain('Opening REI’s sign-in page…');
    expect(opening).toContain('aria-busy="true"');
    expect(opening).toContain('disabled=""');
    expect(render(store({ view: view({ signingIn: true }) }))).toContain('REI’s sign-in page is open in your work browser. Bud carries on by itself once you’re signed in.');
    const failed = render(store({ error: 'The work browser couldn’t open REI’s sign-in page.' }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('>Sign in to REI</button>');
  });

  it('is absent when REI is signed in or not checked, and closes on a calm success line after signing in here', () => {
    expect(render(store({ view: view({ state: 'signed_in', waiting: [] }) }))).toBe('');
    expect(render(store({ view: view({ state: 'unknown', waiting: [] }) }))).toBe('');
    expect(render(store({ view: null }))).toBe('');
    const done = render(store({ view: view({ state: 'signed_in', waiting: [] }), justSignedIn: true }));
    expect(done).toContain('Signed in to REI. Bud is carrying on with today’s REI work.');
    expect(done).toContain('>Dismiss</button>');
  });
});

describe('REI sign-in reply', () => {
  it('accepts only a well-formed reply and names the waiting work in plain words', () => {
    expect(parseReiSignIn({ state: 'needed', at: null, used: true, signingIn: true, waiting: [{ loopId: 'a', name: 'Bank reference review' }, { loopId: 'b', name: 'REI morning refresh' }] }))
      .toEqual({ state: 'needed', at: null, used: true, signingIn: true, waiting: [{ loopId: 'a', name: 'Bank reference review' }, { loopId: 'b', name: 'REI morning refresh' }] });
    for (const bad of [null, {}, { state: 'live', at: null, used: true, signingIn: false, waiting: [] }, { state: 'needed', at: 'today', used: true, signingIn: false, waiting: [] },
      { state: 'needed', at: null, used: true, waiting: [] }, { state: 'needed', at: null, used: true, signingIn: false, waiting: [{ name: 1 }] }]) expect(parseReiSignIn(bad)).toBeNull();
    expect(reiWaitingLine(view({ waiting: [{ loopId: 'a', name: 'Bank reference review' }, { loopId: 'b', name: 'Supplier list check' }, { loopId: 'c', name: 'REI morning refresh' }] })))
      .toBe('Bud is waiting to finish Bank reference review, Supplier list check and REI morning refresh.');
    expect(reiWaitingLine(view({ waiting: [] }))).toBe('REI signed you out. Sign in so Bud can read REI today.');
  });
});
