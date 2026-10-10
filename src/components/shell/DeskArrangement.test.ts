import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { defaultDeskSections, defaultShellLayout, simpleDeskSections } from '@shared/workspace-tabs';
import { coreOfficeDesk, type OfficeDesk } from '@shared/desk-areas';

// The shell's imports read window at load (desktop capabilities); node has none.
vi.hoisted(() => { vi.stubGlobal('window', {}); });
vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
import { ArrangeDeskView, swapDeskSections, withAreaChoice, type ArrangeDeskViewProps } from './DeskArrangement';
import { withShellPanel } from './shell-layout';

const noop = () => {};
const stored = { sections: defaultDeskSections(), shell: defaultShellLayout() };
const props = (fields: Partial<ArrangeDeskViewProps> = {}): ArrangeDeskViewProps => ({
  dialogRef: null, ready: true, saving: false, message: '', stale: false, stored, current: stored, history: [], office: coreOfficeDesk(),
  onChange: noop, onSave: noop, onRestore: noop, onUndo: noop, onReopen: noop, onClose: noop, ...fields,
});
const html = (fields: Partial<ArrangeDeskViewProps> = {}) => renderToStaticMarkup(createElement(ArrangeDeskView, props(fields)));
const disabled = (markup: string, pattern: string) => new RegExp(`<button[^>]*disabled=""[^>]*${pattern}|${pattern}[^>]*disabled=""`).test(markup);
const fieldset = (markup: string, legend: string) => markup.slice(markup.indexOf(`>${legend}</legend>`), markup.indexOf('</fieldset>', markup.indexOf(`>${legend}</legend>`)));
// An office whose pack renames the areas and leaves bank references out.
const pack: OfficeDesk = { source: { kind: 'pack', packId: 'fictional-office', revision: 1 }, areas: [
  { id: 'bills', title: 'Bills & calendar', layout: 'calendar', notify: 'each', available: true },
  { id: 'mail', title: 'Morning priorities', layout: 'priority-list', notify: 'summary', available: true },
  { id: 'bank', title: 'Bank references', layout: 'review-list', notify: 'off', available: false },
] };

describe('Arrange Desk sheet', () => {
  it('says what it changes, in plain words', () => {
    const markup = html();
    expect(markup).toContain('Changes this computer&#x27;s Desk. Your office&#x27;s workflows and permissions stay the same.');
    expect(markup).not.toMatch(/Hermes|MCP|broker|RealBud clock/);
  });

  it('lists one row per available work area with show, move, notices and layout where they exist', () => {
    const areas = fieldset(html(), 'Work areas (tabs)');
    for (const name of ['Mail priorities', 'Bills and calendar', 'Shared work']) {
      expect(areas).toContain(`aria-label="Show ${name} on my Desk"`);
      expect(areas).toContain(`aria-label="Move ${name} up"`);
    }
    // Bank references is not an area this core office uses.
    expect(areas).not.toContain('Bank references');
    expect(areas).toContain('aria-label="Mail priorities notices"');
    expect(areas).toContain('aria-label="Bills and calendar notices"');
    expect(areas).not.toContain('Shared work notices');
    // Only bills can show more than one layout.
    expect(areas).toContain('aria-label="Bills and calendar layout"');
    expect(areas).not.toContain('Mail priorities layout');
    expect(areas).toMatch(/<option value="each">Each new item<\/option><option value="summary" selected="">One summary per run<\/option><option value="off">Problems only<\/option>/);
    expect(areas).toMatch(/<option value="calendar" selected="">Calendar<\/option><option value="review-list">List<\/option>/);
    // Movers stay among the areas: the first area can't move up, the last can't move down.
    expect(disabled(areas, 'aria-label="Move Mail priorities up"')).toBe(true);
    expect(disabled(areas, 'aria-label="Move Shared work down"')).toBe(true);
    expect(disabled(areas, 'aria-label="Move Bills and calendar up"')).toBe(false);
  });

  it("uses the office's names, order and defaults, and shows this computer's choices", () => {
    const sections = withAreaChoice(defaultDeskSections(), 'bills', { layout: 'review-list' }, pack);
    const areas = fieldset(html({ office: pack, current: { sections, shell: stored.shell } }), 'Work areas (tabs)');
    expect(areas).toContain('aria-label="Show Morning priorities on my Desk"');
    expect(areas).toContain('aria-label="Bills &amp; calendar notices"');
    expect(areas).toMatch(/<option value="each" selected="">Each new item<\/option>/);
    expect(areas).toMatch(/<option value="review-list" selected="">List<\/option>/);
    expect(areas).not.toContain('Shared work');
  });

  it('lists the cards on Tasks as show or hide only, with Needs you locked and its reason', () => {
    const cards = fieldset(html(), 'Cards on Tasks');
    for (const name of ['Get started', 'Morning brief', 'Activity']) expect(cards).toContain(`aria-label="Show ${name} on my Desk"`);
    expect(cards).toMatch(/aria-label="Needs you always shows"[^>]*disabled|disabled[^>]*aria-label="Needs you always shows"/);
    expect(cards).toContain('Always shown: approvals, safety and recovery stay visible.');
    expect(cards).not.toContain('Move ');
    expect(cards).not.toContain('Mail priorities');
  });

  it('keeps Approvals waiting fixed in the side panel', () => {
    expect(html()).toMatch(/aria-label="Approvals waiting always shows"[^>]*disabled|disabled[^>]*aria-label="Approvals waiting always shows"/);
  });

  it('moves a work area past the cards between it and the next area, and leaves every card in its slot', () => {
    const original = defaultDeskSections();
    const moved = swapDeskSections(original, 'shared-work', 'bills');
    expect(moved.map(section => section.id)).toEqual(['brief', 'mail', 'shared-work', 'bank', 'bills', 'go-live', 'queue', 'activity']);
    expect(original).toEqual(defaultDeskSections());
  });

  it("stores a notice or layout choice only when it differs from the office's", () => {
    const office = coreOfficeDesk();
    const each = withAreaChoice(defaultDeskSections(), 'bills', { notify: 'each', layout: 'review-list' }, office);
    expect(each.find(section => section.id === 'bills')).toEqual({ id: 'bills', visible: true, notify: 'each', layout: 'review-list' });
    const back = withAreaChoice(each, 'bills', { notify: 'summary', layout: 'calendar' }, office);
    expect(back).toEqual(defaultDeskSections());
  });

  it('resets to the office default and offers Simple desk', () => {
    const changed = { sections: swapDeskSections(defaultDeskSections(), 'mail', 'bills'), shell: stored.shell };
    expect(disabled(html(), '>Reset to office default<')).toBe(true);
    expect(disabled(html({ current: changed }), '>Reset to office default<')).toBe(false);
    // A pack's preset order is the default it resets to.
    expect(disabled(html({ office: pack }), '>Reset to office default<')).toBe(false);
    expect(html()).toContain('>Simple desk<');
  });

  it('undoes the last saved tab or card change only when there is an earlier layout and no unsaved draft, and says why not', () => {
    const none = html();
    expect(none).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="rb-arrange-undo-reason"[^>]*>Undo last tab or card change<\/button>/);
    expect(none).toContain('<p id="rb-arrange-undo-reason" class="mt-1 text-[12px] text-ink-muted">Nothing to undo: no earlier tab or card layout saved yet.</p>');
    const simple = { sections: simpleDeskSections(), shell: stored.shell };
    const history = [{ revision: 3, savedAt: 1_700_000_000_000, sections: simpleDeskSections() }, { revision: 1, savedAt: null, sections: defaultDeskSections() }];
    const markup = html({ stored: simple, current: simple, history });
    expect(disabled(markup, '>Undo last tab or card change<')).toBe(false);
    expect(markup).not.toContain('rb-arrange-undo-reason');
    // Undo would restore and then drop the draft: it waits for Save, or for the draft to be dropped.
    for (const current of [{ sections: defaultDeskSections(), shell: stored.shell }, { sections: simpleDeskSections(), shell: withShellPanel(stored.shell, 'today', false) }]) {
      const draft = html({ stored: simple, current, history });
      expect(draft).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="rb-arrange-undo-reason"[^>]*>Undo last tab or card change<\/button>/);
      expect(draft).toContain('>Save your changes first, or close Arrange Desk to drop them.</p>');
    }
  });

  it('disables Save until the draft differs, and on a conflict keeps the draft with the reopen message', () => {
    expect(html()).toMatch(/<button[^>]*disabled=""[^>]*>Save</);
    const draft = { sections: simpleDeskSections(), shell: stored.shell };
    expect(html({ current: draft })).not.toMatch(/<button[^>]*disabled=""[^>]*>Save</);
    const stale = html({ current: draft, stale: true });
    expect(stale).toContain('This card changed — open it again');
    expect(stale).toContain('Open again');
    expect(stale).toMatch(/<button[^>]*disabled=""[^>]*>Save</);
  });

  it('lists the change history with Restore, marking the current layout', () => {
    const simple = { sections: simpleDeskSections(), shell: stored.shell };
    const markup = html({ stored: simple, current: simple, history: [
      { revision: 2, savedAt: 1_700_000_000_000, sections: simpleDeskSections() },
      { revision: 0, savedAt: null, sections: defaultDeskSections() },
    ] });
    expect(markup).toContain('>Change history<');
    expect(markup).toContain('Before customizing');
    expect(markup).toContain('Current');
    expect(markup).toContain('aria-label="Restore layout from Before customizing"');
    // The current layout cannot be restored over itself.
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Restore layout from (?!Before)[^"]*"/);
  });

  it('leaves out the history section when nothing was saved yet', () => {
    expect(html()).not.toContain('Change history');
  });

  it("ends with this computer's layout, after the change history and before Save", () => {
    const markup = html({ layout: createElement('label', null, 'Spacing'), history: [{ revision: 0, savedAt: null, sections: defaultDeskSections() }] });
    expect(markup).toMatch(/<h3 id="rb-arrange-computer"[^>]*>On this computer<\/h3><label>Spacing<\/label>/);
    expect(markup.indexOf('Change history')).toBeLessThan(markup.indexOf('On this computer'));
    expect(markup.indexOf('On this computer')).toBeLessThan(markup.indexOf('>Save<'));
    expect(html()).not.toContain('On this computer');
  });
});
