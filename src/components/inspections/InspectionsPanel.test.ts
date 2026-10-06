import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/state/store', () => ({ api: vi.fn(() => new Promise(() => {})), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
import { groupPlan, InspectionsPanel, readInspectionsView, rulesSummary } from './InspectionsPanel';

const rules = { horizonMonths: 6, cycleMonths: 6, cycleBasis: 'completed' as const, workingDays: [1, 2, 3, 4, 5], closedDates: ['2026-12-24', '2027-01-02'],
  inspectors: ['fictional-inspector-A', 'fictional-inspector-B'], dayStart: '09:30', appointmentMinutes: 45, travelMinutes: 20, dailyCapacity: 5 };
const appt = (id: string, date: string, area: string, time: string) => ({ id, propertyId: id, address: `${id} Fictional St`, area, date, time, inspector: 'fictional-inspector-A', dueDate: date, status: 'draft' as const, reason: 'Due.' });

describe('inspections panel', () => {
  it('summarises the rules in plain words', () => {
    expect(rulesSummary(rules)).toBe('fictional-inspector-A and fictional-inspector-B · Mon, Tue, Wed, Thu, Fri from 09:30 · 45 min + 20 min travel · up to 5 a day each · every 6 months from the completed date · closed 2 days (2026-12-24 … 2027-01-02)');
  });
  it('groups by day, then area, then time', () => {
    const grouped = groupPlan([appt('c', '2026-11-02', 'Bayside', '10:35'), appt('a', '2026-11-02', 'Bayside', '09:30'), appt('b', '2026-11-01', 'Northvale', '09:30'), appt('d', '2026-11-02', 'Alpha', '11:00')]);
    expect(grouped.map(d => [d.date, d.areas.map(g => [g.area, g.items.map(i => i.id).join('')])])).toEqual([
      ['2026-11-01', [['Northvale', 'b']]], ['2026-11-02', [['Alpha', 'd'], ['Bayside', 'ac']]]]);
  });
  it('rejects a malformed answer', () => {
    expect(() => readInspectionsView({ rules: {} })).toThrow(/unexpected/);
  });
  it('renders a loading state before the plan arrives', () => {
    expect(renderToStaticMarkup(createElement(InspectionsPanel))).toContain('Loading inspections');
  });
});
