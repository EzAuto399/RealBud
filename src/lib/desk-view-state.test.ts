import { describe, expect, it } from 'vitest';
import { coreOfficeDesk } from '@shared/desk-areas';
import { defaultDeskSections } from '@shared/workspace-tabs';
import { visibleDeskAreas } from './desk-view-state';

describe('Desk work-area tabs', () => {
  it("shows the office's available areas that are shown, in saved order", () => {
    const sections = [...defaultDeskSections()].reverse().map(section => ({ ...section, visible: section.id !== 'bills' }));
    expect(visibleDeskAreas(sections, coreOfficeDesk(['bank-references']))).toEqual(['shared-work', 'bank', 'mail']);
    expect(visibleDeskAreas(sections, coreOfficeDesk())).toEqual(['shared-work', 'mail']);
  });
  it("uses today's order and the core preset until the layout and the office preset are read", () => {
    expect(visibleDeskAreas(undefined, null)).toEqual(['mail', 'bills', 'shared-work']);
  });
});
