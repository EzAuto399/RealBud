import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AustinPackView } from '@shared/austin-pack';
import type { AgencySetupFacts } from '@/lib/setup-sequence';

const store = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn(), state: {} as Record<string, unknown> }));
vi.mock('@/state/store', () => ({ useStore: () => ({ state: store.state, dispatch: store.dispatch }), api: store.api }));
afterEach(() => { store.state = {}; officeFixture.snapshot = null; vi.unstubAllGlobals(); });
const officeFixture = vi.hoisted(() => ({ snapshot: null as unknown }));
vi.mock('@/lib/connected-apps-refresh', () => ({ useOfficeSources: () => ({ snapshot: officeFixture.snapshot, loading: false, error: '' }) }));

import { GoLiveCard, READ_RETRY_DELAYS_MS, boundedRead, dismissSetUp } from './GoLiveCard';
import { readGetStartedLocal, saveGetStartedLocal } from '@/lib/first-day';

const plan = { reads: 'r', waitsFor: 'w', notifies: 'n', approval: 'a' };
const pack = (gmail = false): AustinPackView => ({
  pack: { id: 'fictional-pack', revision: 1, title: 'Fictional Accounts pack' },
  timeZone: 'Australia/Brisbane', timeZoneFromOffice: true,
  installed: { revision: 1, at: 1, loopIds: ['bank-references', 'inbound-triage', 'maintenance-review'] },
  loops: ['bank-references', 'inbound-triage', 'maintenance-review'].map(loopId => ({ loopId, owner: 'Accounts', plan, needs: [] })),
  rules: [],
  checklist: [
    { id: 'gmail', label: 'Gmail connected', done: gmail, detail: 'Gmail detail' },
    { id: 'workflows', label: 'Each workflow reviewed and switched on', done: false, detail: '0 of 3 on.', next: 'bank-references' },
  ],
});
const agency: AgencySetupFacts = { agencyName: 'Harbour Agency', timeZone: 'Australia/Brisbane', packSelected: true, workflows: [] };
const loop = (id: string, name: string, enabled: boolean) => ({ id, name, enabled, available: true, nextRunAt: enabled ? 1_700_000_000_000 : null });
/** Stand in for the slices the real store hydrates: loops and Bud's status. */
const storeWith = (on: string[], hermes: unknown = null) => {
  store.state = {
    hermes,
    activityLoad: { jobs: 'ready', routines: 'ready' },
    loops: [loop('bank-references', 'Bank reference review', on.includes('bank-references')), loop('inbound-triage', 'Morning priorities', on.includes('inbound-triage')), loop('maintenance-review', 'Maintenance checks', on.includes('maintenance-review'))],
  };
};
const installing = { ready: false, autoSetup: { state: 'installing', code: 'installing', step: 1, total: 4, detail: 'Downloading Bud' } };
const linked = { agencyName: '', agencySetup: agency, websiteLink: 'linked' as const, austinPack: pack() };
const render = (props: Parameters<typeof GoLiveCard>[0]) => renderToStaticMarkup(createElement(GoLiveCard, props));

describe('Get started card', () => {
  it('lists all five steps on a fresh computer, with unread steps not checked yet and nothing done', () => {
    const html = render({ agencyName: '' });
    expect(html).toContain('aria-label="Get started"');
    expect(html).toContain('>Get started</h2>');
    expect(html).toContain('0 of 5 done');
    for (const title of ['1. Paste the link code your office sent you', '2. Bud is setting itself up', '3. Import your office’s pack', '4. Connect the office Gmail', '5. Review and switch on your workflows']) expect(html).toContain(title);
    expect(html).toContain('Not checked yet');
    expect(html).not.toContain('· Done');
    // One action for the current step, plus Bud's progress.
    expect(html.match(/aria-label="Enter link code"/g)).toHaveLength(1);
    expect(html.match(/aria-label="See progress"/g)).toHaveLength(1);
    expect(html).not.toMatch(/ready/i);
  });

  it('shows Bud as working while it installs and moves on to the next open step', () => {
    storeWith([], installing);
    const html = render(linked);
    expect(html).toContain('2 of 5 done');
    expect(html).toContain('· Working');
    expect(html).toContain('This usually takes about 10 minutes and you don’t need to do anything.');
    expect(html).toContain('animate-spin');
    expect(html).toContain('motion-reduce:animate-none');
    // Pack imported (done); Gmail is now the one current action.
    expect(html.match(/aria-label="Connect Gmail"/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="Enter link code"');
  });

  it('counts workflows that are on and offers to review the next one', () => {
    storeWith(['bank-references', 'inbound-triage'], { ready: true });
    const html = render({ ...linked, austinPack: pack(true) });
    expect(html).toContain('4 of 5 done');
    expect(html).toContain('2 of 3 on. Open each workflow, read what it does, then switch it on.');
    expect(html.match(/aria-label="Review Maintenance checks"/g)).toHaveLength(1);
    expect(html).not.toContain('aria-label="See progress"');
  });

  it('folds to one dismissible set-up line once every step is done, and never says ready', () => {
    storeWith(['bank-references', 'inbound-triage', 'maintenance-review'], { ready: true });
    const html = render({ ...linked, austinPack: pack(true) });
    expect(html).toContain('aria-label="Get started"');
    expect(html).toContain('You’re set up. Ask Bud whenever you need a hand.');
    expect(html).toContain('>Dismiss</button>');
    expect(html).not.toContain('Get started steps');
    expect(html).not.toMatch(/ready/i);
    // Bud still installing keeps the card up even with everything else done.
    storeWith(['bank-references', 'inbound-triage', 'maintenance-review'], installing);
    expect(render({ ...linked, austinPack: pack(true) })).toContain('4 of 5 done');
  });

  it('folds to one line in compact mode only when hidden, and carries the Desk menu beside it', () => {
    const html = render({ agencyName: '', compact: true, menu: createElement('span', { id: 'fictional-menu' }) });
    expect(html).toContain('>Hide</button>');
    expect(html).toContain('id="fictional-menu"');
    storeWith(['bank-references', 'inbound-triage', 'maintenance-review'], { ready: true });
    const done = render({ ...linked, austinPack: pack(true), menu: createElement('span', { id: 'fictional-menu' }) });
    expect(done).toContain('You’re set up.');
    expect(done).toContain('id="fictional-menu"');
  });

  it('remembers on this computer that the set-up line was dismissed, and still shows it when storage is blocked', () => {
    storeWith(['bank-references', 'inbound-triage', 'maintenance-review'], { ready: true });
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value) });
    expect(render({ ...linked, austinPack: pack(true) })).toContain('You’re set up.');
    dismissSetUp();
    // The finished line goes; the first-day guide stays until it is dismissed too.
    const guideOnly = render({ ...linked, austinPack: pack(true) });
    expect(guideOnly).not.toContain('You’re set up.');
    expect(guideOnly).toContain('aria-label="Your first day with Bud"');
    saveGetStartedLocal({ ...readGetStartedLocal(), guideDismissed: true });
    expect(render({ ...linked, austinPack: pack(true) })).toBe('');
    // Dismissal is for the finished line only; unfinished setup still shows the checklist.
    storeWith(['bank-references'], { ready: true });
    expect(render({ ...linked, austinPack: pack(true) })).toContain('4 of 5 done');
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    storeWith(['bank-references', 'inbound-triage', 'maintenance-review'], { ready: true });
    expect(() => dismissSetUp()).not.toThrow();
    expect(render({ ...linked, austinPack: pack(true) })).toContain('You’re set up.');
  });

  it('shows progress, lets the current step be skipped for now and brought back, and never counts a skipped step as done', () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value), removeItem: (key: string) => void saved.delete(key) });
    storeWith([], { ready: true });
    const before = render(linked);
    expect(before).toContain('role="progressbar" aria-label="Get started progress" aria-valuemin="0" aria-valuemax="5" aria-valuenow="3"');
    expect(before.match(/>Skip for now</g)).toHaveLength(1);
    expect(before).toContain('aria-label="Skip for now: Connect the office Gmail"');
    saveGetStartedLocal({ ...readGetStartedLocal(), skipped: ['gmail'] });
    const after = render(linked);
    expect(after).toContain('3 of 5 done · 1 skipped');
    expect(after).toContain('4. Connect the office Gmail<span class="text-[12px] text-ink-muted"> · Skipped</span>');
    expect(after).toContain('aria-label="Back to this step: Connect the office Gmail"');
    // The next open step is now the one current action.
    expect(after).toContain('aria-label="Skip for now: Review and switch on your workflows"');
    expect(after).not.toContain('You’re set up.');
  });

  it('hands Desk\'s one filled action to another card when quiet', () => {
    const loud = render({ agencyName: '' });
    expect(loud).toMatch(/border-agency bg-agency text-white[^"]*"[^>]*>Enter link code/);
    const quiet = render({ agencyName: '', quiet: true });
    expect(quiet).toContain('>Enter link code</button>');
    expect(quiet).not.toMatch(/bg-agency text-white[^"]*"[^>]*>Enter link code/);
  });

  it('shows this computer\'s role workflows on the first day, folded until setup is done, with what each reads and asks', () => {
    const saved = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => void saved.set(key, value), removeItem: (key: string) => void saved.delete(key) });
    const sherry: AustinPackView = { ...pack(true), installed: { revision: 1, at: 1, loopIds: ['maintenance-review', 'rei-supplier-check', 'inspection-draft'] } };
    storeWith([], { ready: true });
    const folded = render({ ...linked, austinPack: sherry });
    expect(folded).toContain('aria-label="Your first day with Bud"');
    expect(folded).toContain('aria-expanded="false"');
    expect(folded).toContain('· 0 of 2 tried');
    expect(folded).not.toContain('Try it with Bud');
    // Kevin's three, unfolded once setup is done; one tried shows as tried.
    saveGetStartedLocal({ ...readGetStartedLocal(), tried: ['weekly-bills'] });
    const kevin: AustinPackView = { ...pack(true), installed: { revision: 1, at: 1, loopIds: ['bank-references', 'weekly-bills', 'inbound-triage'] } };
    store.state = { hermes: { ready: true }, activityLoad: { jobs: 'ready', routines: 'ready' }, loops: ['bank-references', 'weekly-bills', 'inbound-triage', 'maintenance-review'].map(id => loop(id, id, true)) };
    const open = render({ ...linked, austinPack: kevin });
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain('· 1 of 3 tried');
    for (const name of ['Bank reference review', 'Weekly bills review', 'Morning priorities']) expect(open).toContain(`aria-label="Try it with Bud: ${name}"`);
    expect(open).not.toContain('Maintenance checks');
    expect(open).toContain('<span class="text-ink">Needs your OK:</span> Uploading the exact file to REI.');
    expect(open).toContain('aria-label="Tried"');
    // No role pack, or a pack that could not be read: no guide.
    expect(render({ ...linked, austinPack: { ...pack(true), installed: null } })).not.toContain('Your first day with Bud');
    expect(render({ ...linked, austinPack: 'unavailable' })).not.toContain('Your first day with Bud');
  });

  it('names the app the linked office service offers with no account, without a role pack', () => {
    store.state = { config: { composio: { managed: true } } };
    officeFixture.snapshot = { configured: true, checkedAt: new Date().toISOString(), tools: { available: false, names: [] }, services: {
      gmail: { connected: false, status: 'NOT_CONNECTED', accountSelectionRequired: false, accounts: [] },
    } };
    const html = render({ ...linked, austinPack: { ...pack(), installed: null } });
    expect(html.match(/aria-label="Connect Gmail"/g)).toHaveLength(1);
    expect(html).toContain('Sign in to Gmail in your browser.');
  });
});

describe('bounded setup reads', () => {
  afterEach(() => { vi.useRealTimers(); store.api.mockReset(); });
  /** Mirrors fetch: a hung read rejects once its signal aborts. */
  const replyWith = (replies: unknown[]) => store.api.mockImplementation((_path: string, init: RequestInit) => {
    const reply = replies.shift();
    if (reply === 'fail') return Promise.reject(new Error('fictional failure'));
    if (reply === 'hang') return new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
    return Promise.resolve(reply);
  });
  const reader = () => {
    const seen = { value: undefined as unknown };
    const read = boundedRead('/api/fictional-setup', body => body, update => { seen.value = update(seen.value); });
    return { seen, read };
  };

  it('tries a timed-out read again a few bounded times, and a failed refresh reads as unknown, not the old value', async () => {
    vi.useFakeTimers();
    replyWith(['hang', { linked: true }, 'fail', 'fail', 'fail', 'fail']);
    const { seen, read } = reader();
    read.refresh();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(seen.value).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(READ_RETRY_DELAYS_MS[0]);
    expect(store.api).toHaveBeenCalledTimes(2);
    expect(seen.value).toEqual({ linked: true });
    // A refresh (the link card changed) that keeps failing: the old read may be stale, so it is unknown.
    read.refresh();
    for (const delay of READ_RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(store.api).toHaveBeenCalledTimes(3 + READ_RETRY_DELAYS_MS.length);
    expect(seen.value).toBe('unavailable');
    read.stop();
  });

  it('stops retrying once the card goes away', async () => {
    vi.useFakeTimers();
    replyWith(['fail', 'fail']);
    const { seen, read } = reader();
    read.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.value).toBe('unavailable');
    read.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(store.api).toHaveBeenCalledTimes(1);
  });
});
