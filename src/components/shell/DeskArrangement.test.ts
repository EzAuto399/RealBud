import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { defaultDeskSections, defaultShellLayout, simpleDeskSections } from '@shared/workspace-tabs';

// The shell's imports read window at load (desktop capabilities); node has none.
vi.hoisted(() => { vi.stubGlobal('window', {}); });
vi.mock('@/state/store', () => ({ api: vi.fn(), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
import { ArrangeDeskView, moveDeskSection, type ArrangeDeskViewProps } from './DeskArrangement';

const noop = () => {};
const stored = { sections: defaultDeskSections(), shell: defaultShellLayout() };
const props = (fields: Partial<ArrangeDeskViewProps> = {}): ArrangeDeskViewProps => ({
  dialogRef: null, ready: true, saving: false, message: '', stale: false, stored, current: stored, history: [],
  onChange: noop, onSave: noop, onRestore: noop, onReopen: noop, onClose: noop, ...fields,
});
const html = (fields: Partial<ArrangeDeskViewProps> = {}) => renderToStaticMarkup(createElement(ArrangeDeskView, props(fields)));

describe('Arrange Desk sheet', () => {
  it('keeps every old Customize desk control: show, hide, order, reset and the simple desk', () => {
    const markup = html();
    for (const label of ['Morning brief', 'Mail priorities', 'Bills and calendar', 'Shared work', 'Get started', 'Activity', 'Needs you']) expect(markup).toContain(label);
    expect(markup).toContain('aria-label="Show Morning brief on my Desk"');
    expect(markup).toContain('aria-label="Move Mail priorities up"');
    expect(markup).toContain('aria-label="Move Activity down"');
    expect(markup).toContain('Reset to recommended');
    expect(markup).toContain('>Simple desk<');
    expect(markup).not.toMatch(/Hermes|MCP|broker/);
  });
  it('says layouts are saved on this computer', () => {
    expect(html()).toContain('Saved on this computer');
  });
  it('keeps Needs you and Approvals waiting fixed', () => {
    const markup = html();
    expect(markup).toMatch(/aria-label="Needs you always shows"[^>]*disabled|disabled[^>]*aria-label="Needs you always shows"/);
    expect(markup).toMatch(/aria-label="Approvals waiting always shows"[^>]*disabled|disabled[^>]*aria-label="Approvals waiting always shows"/);
  });
  it('moves sections within bounds without touching the original', () => {
    const original = defaultDeskSections();
    expect(moveDeskSection(original, 1, -1).map(section => section.id).slice(0, 2)).toEqual(['mail', 'brief']);
    expect(moveDeskSection(original, 0, -1)).toEqual(original);
    expect(moveDeskSection(original, original.length - 1, 1)).toEqual(original);
    expect(original).toEqual(defaultDeskSections());
  });
  it('disables the first Move up and last Move down', () => {
    const markup = html();
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Move Morning brief up"|aria-label="Move Morning brief up"[^>]*disabled=""/);
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*aria-label="Move Activity down"|aria-label="Move Activity down"[^>]*disabled=""/);
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
});
