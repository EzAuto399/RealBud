import { describe, expect, it } from 'vitest';
import { DESK_SECTION_IDS, defaultDeskSections, deskSectionsOrDefault, parseDeskSections, parseWorkspaceTabs, parseWorkspaceTabsResponse, simpleDeskSections } from './workspace-tabs.ts';

describe('Desk section layout', () => {
  it('defaults to today\'s Desk order with every section visible', () => {
    expect(defaultDeskSections().map(section => section.id)).toEqual(['brief', 'mail', 'bills', 'shared-work', 'go-live', 'queue', 'activity']);
    expect(defaultDeskSections().every(section => section.visible)).toBe(true);
    expect(simpleDeskSections().filter(section => section.visible).map(section => section.id)).toEqual(['brief', 'go-live', 'queue']);
  });
  it('accepts a reordered complete layout with hidden optional sections', () => {
    const sections = [...defaultDeskSections()].reverse().map(section => ({ ...section, visible: section.id === 'queue' }));
    expect(parseDeskSections(sections)).toEqual(sections);
  });
  it.each([
    ['hidden Needs you', defaultDeskSections().map(section => ({ ...section, visible: section.id !== 'queue' })), /Needs you always stays/],
    ['missing Needs you', defaultDeskSections().filter(section => section.id !== 'queue'), /every Desk section once/],
    ['duplicate ids', [...defaultDeskSections().slice(0, -1), { id: 'brief', visible: true }], /every Desk section once/],
    ['unknown ids', [...defaultDeskSections().slice(0, -1), { id: 'web-page', visible: true }], /every Desk section once/],
    ['extra fields', defaultDeskSections().map(section => ({ ...section, html: '<script>' })), /every Desk section once/],
    ['non-boolean visibility', defaultDeskSections().map(section => ({ ...section, visible: 'yes' })), /every Desk section once/],
    ['not a list', { sections: DESK_SECTION_IDS }, /every Desk section once/],
  ])('rejects %s', (_name, value, message) => {
    expect(() => parseDeskSections(value)).toThrow(message);
    expect(deskSectionsOrDefault(value)).toEqual(defaultDeskSections());
  });
  it('migrates version 1 to version 2 without changing tabs or revision', () => {
    const tab = { id: 'view-mail', label: 'Mail', visible: true, view: { kind: 'mail', filter: 'open' } };
    expect(parseWorkspaceTabs({ version: 1, revision: 4, tabs: [tab] })).toEqual({ version: 2, revision: 4, tabs: [tab], desk: { sections: defaultDeskSections() }, history: [] });
    expect(() => parseWorkspaceTabs({ version: 1, revision: 4, tabs: [], desk: { sections: defaultDeskSections() } })).toThrow();
  });
  it('rejects history newer than the state, duplicated, or over ten entries', () => {
    const sections = defaultDeskSections();
    const state = (history: unknown[]) => ({ version: 2, revision: 3, tabs: [], desk: { sections }, history });
    expect(parseWorkspaceTabs(state([{ revision: 3, savedAt: 5, sections }, { revision: 0, savedAt: null, sections }])).history).toHaveLength(2);
    expect(() => parseWorkspaceTabs(state([{ revision: 4, savedAt: 5, sections }]))).toThrow();
    expect(() => parseWorkspaceTabs(state([{ revision: 2, savedAt: 5, sections }, { revision: 2, savedAt: 6, sections }]))).toThrow();
    expect(() => parseWorkspaceTabs(state(Array.from({ length: 11 }, (_, revision) => ({ revision, savedAt: 1, sections }))))).toThrow();
    expect(() => parseWorkspaceTabs(state([{ revision: 1, savedAt: 'yesterday', sections }]))).toThrow();
  });
  it('requires the server to answer with version 2', () => {
    expect(() => parseWorkspaceTabsResponse({ state: { version: 1, revision: 0, tabs: [] }, recovery: null })).toThrow();
  });
});
