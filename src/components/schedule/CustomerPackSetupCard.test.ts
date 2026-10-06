import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { CustomerPack, OfficePacksView } from '@shared/customer-packs';

vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));

import { CustomerPackSetupCard, OfficePacks, parseOfficePacksView, skillReviewPending } from './CustomerPackSetupCard';
import type { PackSkillReviewState } from './PackSkillReview';

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
    expect(render({ state: 'ready', packs: [], refused: [] })).toContain('Your office hasn’t shared any packs yet. Ask your office owner to add your role pack on realbud.app, then press Check again.');
    expect(render({ state: 'not-linked' })).toContain('Connect this computer to your office first.');
    expect(render({ state: 'not-linked' })).toMatch(/<button type="button"[^>]*>Connect this computer<\/button>/);
    expect(render({ state: 'unavailable' })).not.toContain('>Connect this computer</button>');
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

  it('keeps office packs visible and puts every owner-only option in one collapsed section at the end', () => {
    const html = renderToStaticMarkup(createElement(CustomerPackSetupCard, { moreOptions: createElement('p', null, 'Fictional owner extra') }));
    const more = html.indexOf('<details class="border-t border-line pt-3"><summary');
    expect(html.match(/More setup options \(office owner\)/g)).toHaveLength(1);
    expect(html.indexOf('Packs from your office')).toBeLessThan(more);
    expect(html.indexOf('Refresh setup checks')).toBeLessThan(more);
    for (const owner of ['Start with department case reviews', 'Preview real estate office core pack', 'Preview a pack file', 'Earlier Auston office pack (all workflows in one)', 'Preview Auston office pack', 'Fictional owner extra']) expect(html.indexOf(owner)).toBeGreaterThan(more);
    // Collapsed by default and the card's last child, so pending changes, repair and previews never render inside it.
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html.endsWith('</details></section>')).toBe(true);
    expect(html.slice(more).match(/<details/g)).toHaveLength(1);
    expect(html).not.toContain('Local file checks');
  });

  it('keeps instruction review in view only while something waits for review', () => {
    const idle = { proposals: [], revisions: [], skillHistories: [{ pendingArchive: null }], hasMore: false, pendingUpgrades: [], learning: { supported: true, policyReady: true, enabled: true } } as unknown as PackSkillReviewState;
    expect(skillReviewPending(idle)).toBe(false);
    expect(skillReviewPending({ ...idle, proposals: [{}] } as unknown as PackSkillReviewState)).toBe(true);
    expect(skillReviewPending({ ...idle, pendingUpgrades: [{ packId: 'p', digest: 'd' }] })).toBe(true);
    expect(skillReviewPending({ ...idle, skillHistories: [{ pendingArchive: { expectedPreviewDigest: 'd' } }] } as unknown as PackSkillReviewState)).toBe(true);
  });
});
