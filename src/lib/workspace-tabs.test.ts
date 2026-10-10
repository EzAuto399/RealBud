import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { coreOfficeDesk, type OfficeDesk } from '@shared/desk-areas';
import { defaultDeskSections, type WorkspaceTabs } from '@shared/workspace-tabs';

// The provider's state and refs persist across static renders; effects don't run, so each read is called by hand.
const hooks = vi.hoisted(() => ({ states: [] as unknown[], refs: [] as { current: unknown }[], state: 0, ref: 0 }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = hooks.state++;
    if (!(index in hooks.states)) hooks.states[index] = initial;
    return [hooks.states[index], (value: unknown) => { hooks.states[index] = typeof value === 'function' ? (value as (previous: unknown) => unknown)(hooks.states[index]) : value; }];
  },
  useRef: (initial: unknown) => hooks.refs[hooks.ref++] ??= { current: initial },
  useEffect: () => {},
}));
vi.mock('@/state/store', () => ({ api: vi.fn() }));
import { api } from '@/state/store';
import { WorkspaceTabsProvider, announcementNeeds, budDeskChange, undoBudDeskChange, useWorkspaceTabs } from './workspace-tabs';

const before = defaultDeskSections();
const after = defaultDeskSections().map(section => ({ ...section, visible: section.id !== 'activity' }));
const state = (revision: number, history: WorkspaceTabs['history']): WorkspaceTabs => ({ version: 3, revision, tabs: [], desk: { sections: history[0]?.sections ?? before }, history });

describe('announced layout changes', () => {
  it('rereads only a revision this window does not hold', () => {
    expect(announcementNeeds({ revision: 7 }, 7, false)).toBe('held');
    expect(announcementNeeds({ revision: 7 }, 7, true)).toBe('held');
    expect(announcementNeeds({ revision: 8 }, 7, false)).toBe('reread');
    expect(announcementNeeds({ revision: 8 }, 7, true)).toBe('later');
    // A reconnect may have missed announcements; a recovery reset restarts the count at 1.
    expect(announcementNeeds({}, 7, false)).toBe('reread');
    expect(announcementNeeds({ revision: 1 }, 7, false)).toBe('reread');
    expect(announcementNeeds({ revision: 1 }, undefined, false)).toBe('reread');
  });
});

describe("Bud's Desk change and its Undo", () => {
  it('offers Undo only for the layout Bud saved, back to the layout before it', () => {
    const saved = state(7, [{ revision: 7, savedAt: 2, sections: after }, { revision: 4, savedAt: 1, sections: before }]);
    expect(budDeskChange(saved, 7)).toEqual({ revision: 7, toRevision: 4, summary: 'hid Activity' });
    // Desk moved on before this window read it, a saved-view-only change, or no earlier layout: no Undo.
    expect(budDeskChange(state(8, saved.history), 7)).toBeNull();
    expect(budDeskChange(state(9, saved.history), 9)).toBeNull();
    expect(budDeskChange(state(1, [{ revision: 1, savedAt: 1, sections: after }]), 1)).toBeNull();
    expect(budDeskChange(null, 7)).toBeNull();
    // A notice-only change is a change, named in the receipt.
    const notified = before.map(section => section.id === 'mail' ? { ...section, notify: 'each' as const } : section);
    expect(budDeskChange(state(8, [{ revision: 8, savedAt: 3, sections: notified }, { revision: 7, savedAt: 2, sections: before }]), 8))
      .toEqual({ revision: 8, toRevision: 7, summary: 'set Mail priorities notices to Each new item' });
  });

  it('restores against the revision Bud saved, and once Desk changed since changes nothing and offers Arrange Desk', async () => {
    const change = { revision: 7, toRevision: 4, summary: 'hid Activity' };
    const revert = vi.fn(async () => {});
    expect(await undoBudDeskChange(change, revert)).toEqual({ message: 'Desk is back as it was before Bud arranged it.' });
    expect(revert).toHaveBeenCalledWith(4, 7);
    const conflict = vi.fn(async () => { throw Object.assign(new Error('This card changed — open it again'), { status: 409, code: 'tabs_changed' }); });
    // Recovery in place: the notice names the cause and offers Arrange Desk.
    expect(await undoBudDeskChange(change, conflict)).toEqual({ message: "Desk was changed after Bud's change, so nothing was undone.", openArrange: true });
    // Any other failure keeps the service's own reason for the caller to show.
    const failed = Object.assign(new Error('Saved views could not be saved or checked.'), { status: 503, code: 'tabs_unavailable' });
    await expect(undoBudDeskChange(change, async () => { throw failed; })).rejects.toBe(failed);
  });
});

describe("the office's Desk preset", () => {
  it('keeps the last good preset after a failed read, so pack titles and areas stay', async () => {
    let seen: ReturnType<typeof useWorkspaceTabs> | null = null;
    const Probe = () => { seen = useWorkspaceTabs(); return null; };
    const render = () => { hooks.state = 0; hooks.ref = 0; renderToStaticMarkup(createElement(WorkspaceTabsProvider, null, createElement(Probe))); return seen!; };
    // A fictional pack that renames Mail priorities and runs Bank references.
    const office: OfficeDesk = { source: { kind: 'pack', packId: 'fictional-pack', revision: 2 },
      areas: coreOfficeDesk(['bank-references']).areas.map(area => area.id === 'mail' ? { ...area, title: 'Morning priorities' } : area) };
    vi.mocked(api)
      .mockResolvedValueOnce({ state: { version: 3, revision: 1, tabs: [], desk: { sections: defaultDeskSections() }, history: [] }, recovery: null, office })
      .mockRejectedValueOnce(new Error('Saved views could not be checked.'));
    expect(render().office).toBeNull();
    await render().refresh();
    expect(render().office).toEqual(office);
    await render().refresh();
    const failed = render();
    expect(failed.data).toBeNull();
    expect(failed.error).toBe('Saved views could not be checked.');
    expect(failed.office).toEqual(office);
  });
});
