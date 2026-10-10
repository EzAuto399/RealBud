import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { defaultDeskSections, type DeskSectionId } from '@shared/workspace-tabs';
import { DeskSections } from './DeskSections';

const render = Object.fromEntries(defaultDeskSections().map(section => [section.id, createElement('div', { 'data-section': section.id })])) as Record<DeskSectionId, ReactNode>;
const order = (sections: unknown) => [...renderToStaticMarkup(createElement(DeskSections, { sections, render })).matchAll(/data-section="([^"]+)"/g)].map(match => match[1]);

describe('DeskSections', () => {
  it('renders today\'s order when the layout is absent or invalid', () => {
    const today = ['brief', 'mail', 'bills', 'bank', 'shared-work', 'go-live', 'queue', 'activity'];
    expect(order(undefined)).toEqual(today);
    expect(order([{ id: 'queue', visible: true }])).toEqual(today);
    expect(order(defaultDeskSections().map(section => ({ ...section, visible: section.id !== 'queue' })))).toEqual(today);
  });
  it('renders the saved order and skips hidden sections', () => {
    const sections = [
      { id: 'queue', visible: true }, { id: 'activity', visible: true }, { id: 'brief', visible: false }, { id: 'mail', visible: true },
      { id: 'bills', visible: false }, { id: 'bank', visible: false }, { id: 'shared-work', visible: true }, { id: 'go-live', visible: false },
    ];
    expect(order(sections)).toEqual(['queue', 'activity', 'mail', 'shared-work']);
  });
});
