import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AustinPackView } from '@shared/austin-pack';
import type { AgencySetupFacts } from '@/lib/setup-sequence';

const store = vi.hoisted(() => ({ dispatch: vi.fn(), api: vi.fn(), state: {} as Record<string, unknown> }));
vi.mock('@/state/store', () => ({ useStore: () => ({ state: store.state, dispatch: store.dispatch }), api: store.api }));
afterEach(() => { store.state = {}; officeFixture.snapshot = null; });
const officeFixture = vi.hoisted(() => ({ snapshot: null as unknown }));
vi.mock('@/lib/connected-apps-refresh', () => ({ useOfficeSources: () => ({ snapshot: officeFixture.snapshot, loading: false, error: '' }) }));

import { GoLiveCard } from './GoLiveCard';

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

  it('disappears once every step is done, and never says ready', () => {
    storeWith(['bank-references', 'inbound-triage', 'maintenance-review'], { ready: true });
    expect(render({ ...linked, austinPack: pack(true) })).toBe('');
    // Bud still installing keeps the card up even with everything else done.
    storeWith(['bank-references', 'inbound-triage', 'maintenance-review'], installing);
    expect(render({ ...linked, austinPack: pack(true) })).toContain('4 of 5 done');
  });

  it('folds to one line in compact mode only when hidden, and carries the Desk menu beside it', () => {
    const html = render({ agencyName: '', compact: true, menu: createElement('span', { id: 'fictional-menu' }) });
    expect(html).toContain('>Hide</button>');
    expect(html).toContain('id="fictional-menu"');
    storeWith(['bank-references', 'inbound-triage', 'maintenance-review'], { ready: true });
    expect(render({ ...linked, austinPack: pack(true), menu: createElement('span', { id: 'fictional-menu' }) })).toBe('');
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
