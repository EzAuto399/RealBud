import { describe, expect, it, vi } from 'vitest';
import { defaultDeskSections, type WorkspaceTabs } from '@shared/workspace-tabs';

vi.mock('@/state/store', () => ({ api: vi.fn() }));
import { announcementNeeds, budDeskChange, undoBudDeskChange } from './workspace-tabs';

const before = defaultDeskSections();
const after = defaultDeskSections().map(section => ({ ...section, visible: section.id !== 'activity' }));
const state = (revision: number, history: WorkspaceTabs['history']): WorkspaceTabs => ({ version: 2, revision, tabs: [], desk: { sections: history[0]?.sections ?? before }, history });

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
