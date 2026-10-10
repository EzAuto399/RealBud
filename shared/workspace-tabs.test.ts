import { describe, expect, it } from 'vitest';
import { coreOfficeDesk, type OfficeDesk } from './desk-areas.ts';
import {
  DESK_SECTION_IDS, defaultDeskSections, deskChangeSummary, deskSectionsOrDefault, effectiveDeskAreas, officeDefaultSections, parseDeskSections, parseOfficeDesk,
  parseWorkspaceTabs, parseWorkspaceTabsResponse, sameDeskSections, simpleDeskSections,
} from './workspace-tabs.ts';

const withSection = (id: string, fields: Record<string, unknown>) => defaultDeskSections().map(section => section.id === id ? { ...section, ...fields } : section);

describe('Desk section layout', () => {
  it('defaults to today\'s Desk order with every section visible', () => {
    expect(defaultDeskSections().map(section => section.id)).toEqual(['brief', 'mail', 'bills', 'bank', 'shared-work', 'go-live', 'queue', 'activity']);
    expect(defaultDeskSections().every(section => section.visible)).toBe(true);
    expect(simpleDeskSections().filter(section => section.visible).map(section => section.id)).toEqual(['brief', 'go-live', 'queue']);
  });
  it('accepts a reordered complete layout with hidden optional sections', () => {
    const sections = [...defaultDeskSections()].reverse().map(section => ({ ...section, visible: section.id === 'queue' }));
    expect(parseDeskSections(sections)).toEqual(sections);
  });
  it('accepts notices and a layout only where the area offers them', () => {
    const sections = defaultDeskSections().map(section => section.id === 'bills' ? { ...section, notify: 'each' as const, layout: 'review-list' as const } : section.id === 'bank' ? { ...section, notify: 'off' as const } : section);
    expect(parseDeskSections(sections)).toEqual(sections);
  });
  it.each([
    ['hidden Needs you', withSection('queue', { visible: false }), /Needs you always stays/],
    ['missing Needs you', defaultDeskSections().filter(section => section.id !== 'queue'), /every Desk section once/],
    ['duplicate ids', [...defaultDeskSections().slice(0, -1), { id: 'brief', visible: true }], /every Desk section once/],
    ['unknown ids', [...defaultDeskSections().slice(0, -1), { id: 'web-page', visible: true }], /every Desk section once/],
    ['extra fields', defaultDeskSections().map(section => ({ ...section, html: '<script>' })), /every Desk section once/],
    ['non-boolean visibility', defaultDeskSections().map(section => ({ ...section, visible: 'yes' })), /every Desk section once/],
    ['not a list', { sections: DESK_SECTION_IDS }, /every Desk section once/],
    ['notices on shared work', withSection('shared-work', { notify: 'each' }), /^Set notices only for Mail priorities, Bills and calendar or Bank references, to Each new item, One summary per run or Problems only\.$/],
    ['an unknown notice level', withSection('mail', { notify: 'loud' }), /Set notices only for/],
    ['a bills layout outside its list', withSection('bills', { layout: 'table' }), /^Choose a layout only for Bills and calendar \(Calendar or List\)\.$/],
    ['a layout on an area with one layout', withSection('mail', { layout: 'priority-list' }), /Choose a layout only for/],
  ])('rejects %s', (_name, value, message) => {
    expect(() => parseDeskSections(value)).toThrow(message);
    expect(deskSectionsOrDefault(value)).toEqual(defaultDeskSections());
  });
  it('treats a notice or layout change as a change and names it in plain words', () => {
    const before = defaultDeskSections(), after = withSection('bills', { notify: 'each', layout: 'review-list' }) as typeof before;
    expect(sameDeskSections(before, after)).toBe(false);
    expect(deskChangeSummary(before, after)).toBe('set Bills and calendar notices to Each new item; showed Bills and calendar as List');
    expect(deskChangeSummary(after, before)).toBe('set Bills and calendar notices to the office default; showed Bills and calendar in the office default layout');
    expect(deskChangeSummary(before, defaultDeskSections())).toBe('no change');
  });
  it('migrates version 1 to version 3 without changing tabs or revision', () => {
    const tab = { id: 'view-mail', label: 'Mail', visible: true, view: { kind: 'mail', filter: 'open' } };
    expect(parseWorkspaceTabs({ version: 1, revision: 4, tabs: [tab] })).toEqual({ version: 3, revision: 4, tabs: [tab], desk: { sections: defaultDeskSections() }, history: [] });
    expect(() => parseWorkspaceTabs({ version: 1, revision: 4, tabs: [], desk: { sections: defaultDeskSections() } })).toThrow();
  });
  it('migrates version 2 to version 3 with Bank references added at the end, shown, in the layout and its history', () => {
    const old = ['brief', 'mail', 'bills', 'shared-work', 'go-live', 'queue', 'activity'].map(id => ({ id, visible: id !== 'mail' }));
    const migrated = [...old, { id: 'bank', visible: true }];
    expect(parseWorkspaceTabs({ version: 2, revision: 3, tabs: [], desk: { sections: old }, history: [{ revision: 3, savedAt: 5, sections: old }] }))
      .toEqual({ version: 3, revision: 3, tabs: [], desk: { sections: migrated }, history: [{ revision: 3, savedAt: 5, sections: migrated }] });
  });
  it('fills a known section a stored layout lacks, and still refuses unknown ids or keys, duplicates and a hidden Needs you', () => {
    const stored = (sections: unknown[]) => ({ version: 3, revision: 1, tabs: [], desk: { sections }, history: [] });
    const without = defaultDeskSections().filter(section => section.id !== 'activity');
    expect(parseWorkspaceTabs(stored(without)).desk.sections).toEqual([...without, { id: 'activity', visible: true }]);
    expect(() => parseWorkspaceTabs(stored([...without, { id: 'web-page', visible: true }]))).toThrow(/every Desk section once/);
    expect(() => parseWorkspaceTabs(stored(without.map(section => ({ ...section, html: '<b>' }))))).toThrow(/every Desk section once/);
    expect(() => parseWorkspaceTabs(stored([...without, without[0]]))).toThrow(/every Desk section once/);
    expect(() => parseWorkspaceTabs(stored(without.map(section => section.id === 'queue' ? { ...section, visible: false } : section)))).toThrow(/Needs you/);
    // What the sheet or Bud sends is strict: it lists every section.
    expect(() => parseDeskSections(without)).toThrow(/every Desk section once/);
  });
  it('rejects history newer than the state, duplicated, or over ten entries', () => {
    const sections = defaultDeskSections();
    const state = (history: unknown[]) => ({ version: 3, revision: 3, tabs: [], desk: { sections }, history });
    expect(parseWorkspaceTabs(state([{ revision: 3, savedAt: 5, sections }, { revision: 0, savedAt: null, sections }])).history).toHaveLength(2);
    expect(() => parseWorkspaceTabs(state([{ revision: 4, savedAt: 5, sections }]))).toThrow();
    expect(() => parseWorkspaceTabs(state([{ revision: 2, savedAt: 5, sections }, { revision: 2, savedAt: 6, sections }]))).toThrow();
    expect(() => parseWorkspaceTabs(state(Array.from({ length: 11 }, (_, revision) => ({ revision, savedAt: 1, sections }))))).toThrow();
    expect(() => parseWorkspaceTabs(state([{ revision: 1, savedAt: 'yesterday', sections }]))).toThrow();
    expect(() => parseWorkspaceTabs(state([{ revision: 1, savedAt: 1, sections: withSection('shared-work', { notify: 'each' }) }]))).toThrow(/Set notices only/);
  });
  it('requires the server to answer with version 3 and the office preset', () => {
    const state = { version: 3, revision: 0, tabs: [], desk: { sections: defaultDeskSections() }, history: [] };
    expect(parseWorkspaceTabsResponse({ state, recovery: null, office: coreOfficeDesk() }).office).toEqual(coreOfficeDesk());
    expect(() => parseWorkspaceTabsResponse({ state: { version: 1, revision: 0, tabs: [] }, recovery: null, office: coreOfficeDesk() })).toThrow();
    expect(() => parseWorkspaceTabsResponse({ state: { ...state, version: 2 }, recovery: null, office: coreOfficeDesk() })).toThrow();
    expect(() => parseWorkspaceTabsResponse({ state, recovery: null })).toThrow();
  });
});

describe("the office's Desk preset", () => {
  const pack: OfficeDesk = { source: { kind: 'pack', packId: 'fictional-agency', revision: 2 }, areas: [
    { id: 'bank', title: 'Bank checks', layout: 'review-list', notify: 'each', available: true },
    { id: 'mail', title: 'Morning priorities', layout: 'priority-list', notify: 'summary', available: true },
    { id: 'bills', title: 'Bills & calendar', layout: 'calendar', notify: 'each', available: true },
  ] };
  it("lists the available areas in saved order, with this computer's notices and layout over the preset", () => {
    const sections = defaultDeskSections().map(section => section.id === 'bills' ? { ...section, layout: 'review-list' as const, visible: false } : section.id === 'mail' ? { ...section, notify: 'off' as const } : section);
    // The core preset offers Bank references only to an office that runs that workflow.
    expect(effectiveDeskAreas(sections, coreOfficeDesk())).toEqual([
      { id: 'mail', title: 'Mail priorities', layout: 'priority-list', notify: 'off', visible: true },
      { id: 'bills', title: 'Bills and calendar', layout: 'review-list', notify: 'summary', visible: false },
      { id: 'shared-work', title: 'Shared work', layout: 'review-list', notify: null, visible: true },
    ]);
    expect(effectiveDeskAreas(sections, coreOfficeDesk(['bank-references'])).map(area => area.id)).toEqual(['mail', 'bills', 'bank', 'shared-work']);
    expect(effectiveDeskAreas(sections, pack).map(area => area.title)).toEqual(['Morning priorities', 'Bills & calendar', 'Bank checks']);
  });
  it("starts the office default with the preset's areas in its order, in the area slots, with no personal choices", () => {
    expect(officeDefaultSections(pack)).toEqual(['brief', 'bank', 'mail', 'bills', 'shared-work', 'go-live', 'queue', 'activity'].map(id => ({ id, visible: true })));
    expect(officeDefaultSections(coreOfficeDesk())).toEqual(defaultDeskSections());
  });
  it('parses a preset strictly', () => {
    expect(parseOfficeDesk(pack)).toEqual(pack);
    expect(parseOfficeDesk(coreOfficeDesk(['bank-references']))).toEqual(coreOfficeDesk(['bank-references']));
    const area = pack.areas[0]!;
    for (const bad of [
      { ...pack, extra: true },
      { ...pack, source: { kind: 'pack', packId: '../elsewhere', revision: 2 } },
      { ...pack, source: { kind: 'core', packId: 'fictional-agency' } },
      { ...pack, areas: [area, area] },
      { ...pack, areas: [{ ...area, id: 'web-page' }] },
      { ...pack, areas: [{ ...area, layout: 'calendar' }] },
      { ...pack, areas: [{ ...area, notify: null }] },
      { ...pack, areas: [{ ...area, id: 'shared-work', notify: 'each' }] },
      { ...pack, areas: [{ ...area, title: ' ' }] },
      { ...pack, areas: [{ ...area, title: 'Bank‮checks' }] },
      { ...pack, areas: [{ ...area, script: 'x' }] },
    ]) expect(() => parseOfficeDesk(bad)).toThrow(/Desk setup could not be checked/);
  });
});
