import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { defaultDeskSections, simpleDeskSections } from '@shared/workspace-tabs';

vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
import { DeskCustomizeView, moveDeskSection, toggleDeskSection, DESK_LAYOUT_CONFLICT } from './DeskCustomizePanel';

const noop = () => {};
const props = (fields: Partial<Parameters<typeof DeskCustomizeView>[0]> = {}) => ({
  draft: defaultDeskSections(), current: defaultDeskSections(), history: [], saving: false, stale: false, message: '',
  onChange: noop, onSave: noop, onRevert: noop, onReopen: noop, onClose: noop, ...fields,
});
const html = (fields: Partial<Parameters<typeof DeskCustomizeView>[0]> = {}) => renderToStaticMarkup(createElement(DeskCustomizeView, props(fields)));

describe('Customize desk panel', () => {
  it('names every section with plain labels and accessible reorder controls', () => {
    const markup = html();
    for (const label of ['Morning brief', 'Mail priorities', 'Bills and calendar', 'Shared work', 'Get started', 'Activity', 'Needs you']) expect(markup).toContain(label);
    expect(markup).toContain('aria-label="Move Mail priorities up"');
    expect(markup).toContain('aria-label="Move Activity down"');
    expect(markup).toContain('aria-label="Show Morning brief"');
    expect(markup).toContain('aria-label="Close Customize desk"');
    expect(markup).not.toMatch(/Hermes|MCP|broker/);
  });
  it('keeps Needs you visible and fixed', () => {
    expect(html()).toMatch(/aria-label="Needs you always shows"[^>]*disabled|disabled[^>]*aria-label="Needs you always shows"/);
    const index = defaultDeskSections().findIndex(section => section.id === 'queue');
    expect(toggleDeskSection(defaultDeskSections(), index)[index]).toEqual({ id: 'queue', visible: true });
    expect(toggleDeskSection(defaultDeskSections(), 0)[0]).toEqual({ id: 'brief', visible: false });
  });
  it('moves sections within bounds', () => {
    const moved = moveDeskSection(defaultDeskSections(), 1, -1).map(section => section.id);
    expect(moved.slice(0, 2)).toEqual(['mail', 'brief']);
    expect(moveDeskSection(defaultDeskSections(), 0, -1)).toEqual(defaultDeskSections());
  });
  it('disables Save until the draft changes, and on a conflict keeps the draft with the reopen message', () => {
    expect(html()).toMatch(/<button[^>]*disabled=""[^>]*>Save layout/);
    expect(html({ draft: simpleDeskSections() })).not.toMatch(/<button[^>]*disabled=""[^>]*>Save layout/);
    const stale = html({ draft: simpleDeskSections(), stale: true });
    expect(stale).toContain(DESK_LAYOUT_CONFLICT);
    expect(stale).toContain('Open again');
    expect(stale).toMatch(/<button[^>]*disabled=""[^>]*>Save layout/);
  });
  it('lists recent layouts with restore, marking the current one', () => {
    const markup = html({ current: simpleDeskSections(), history: [{ revision: 2, savedAt: 1_700_000_000_000, sections: simpleDeskSections() }, { revision: 0, savedAt: null, sections: defaultDeskSections() }] });
    expect(markup).toContain('Recent layouts');
    expect(markup).toContain('Before customizing');
    expect(markup).toContain('Current');
    expect(markup).toContain('aria-label="Restore layout from Before customizing"');
  });
});
