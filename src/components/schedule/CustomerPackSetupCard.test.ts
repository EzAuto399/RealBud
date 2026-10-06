import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CustomerPack, OfficePacksView } from '@shared/customer-packs';

vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));

import { CustomerPackSetupCard, OfficePacks, parseOfficePacksView } from './CustomerPackSetupCard';

const pack = { id: 'austin-accounts', revision: 2, title: 'Fictional accounts role' } as CustomerPack;
const ready: OfficePacksView = { state: 'ready', packs: [{ id: 'austin-accounts', title: 'Fictional accounts role', revision: 2, digest: 'd'.repeat(64), pack }], refused: [{ id: 'fictional-other', revision: 1, reason: "This pack isn't signed by RealBud, so it wasn't installed." }] };
const render = (view: OfficePacksView | null) => renderToStaticMarkup(createElement(OfficePacks, { view, busy: false, onPreview: () => {}, onRefresh: () => {} }));

describe('Packs from your office', () => {
  it('lists each signed pack with its role title, version and a named Preview, and says why others cannot be used', () => {
    const html = render(ready);
    expect(html).toContain('aria-label="Packs from your office"');
    expect(html).toContain('<strong class="font-medium">Fictional accounts role</strong> · version 2');
    expect(html).toContain('aria-label="Preview Fictional accounts role"');
    expect(html).toContain('fictional-other version 1 can’t be used: This pack isn&#x27;t signed by RealBud');
  });

  it('explains empty, unlinked, unavailable and checking states in plain words', () => {
    expect(render({ state: 'ready', packs: [], refused: [] })).toContain('Your office hasn’t shared any packs yet.');
    expect(render({ state: 'not-linked' })).toContain('Choose Connect to your office, then check again.');
    expect(render({ state: 'unavailable' })).toContain('couldn’t be checked right now. Nothing on this computer changed.');
    expect(render(null)).toContain('Checking your office for packs');
    for (const view of [{ state: 'not-linked' }, { state: 'unavailable' }, ready] as OfficePacksView[]) expect(render(view)).toContain('>Check again</button>');
  });

  it('refuses a malformed answer instead of showing a partial list', () => {
    expect(parseOfficePacksView(ready)).toEqual(ready);
    expect(parseOfficePacksView({ state: 'unavailable' })).toEqual({ state: 'unavailable' });
    expect(() => parseOfficePacksView({ state: 'ready', packs: [{ ...ready.packs[0], pack: { ...pack, id: 'other' } }], refused: [] })).toThrow(/could not be read/);
    expect(() => parseOfficePacksView({ state: 'ready', packs: [] })).toThrow();
    expect(() => parseOfficePacksView({ state: 'linked' })).toThrow();
  });

  it('puts the office packs first and keeps the earlier combined Auston pack collapsed', () => {
    const html = renderToStaticMarkup(createElement(CustomerPackSetupCard, {}));
    expect(html.indexOf('Packs from your office')).toBeLessThan(html.indexOf('Start with department case reviews'));
    expect(html).toMatch(/<details><summary[^>]*>Earlier Auston office pack \(all workflows in one\)<\/summary>[\s\S]*Preview Auston office pack/);
    expect(html).toContain('Preview a pack file');
  });
});
