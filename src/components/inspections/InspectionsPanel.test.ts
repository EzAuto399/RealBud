import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/state/store', () => ({ api: vi.fn(() => new Promise(() => {})), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));
// A static render can't type. While `typing.on`, state keeps its value across renders in call
// order, so a test can change a field as its onChange would, render again and read the guard.
const typing = vi.hoisted(() => ({ on: false, at: 0, values: [] as unknown[], guards: [] as boolean[] }));
vi.mock('react', async original => {
  const react = await original<typeof import('react')>();
  return { ...react, useState: (initial: unknown) => {
    if (!typing.on) return react.useState(initial);
    const at = typing.at++;
    if (!(at in typing.values)) typing.values[at] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
    return [typing.values[at], (next: unknown) => { typing.values[at] = typeof next === 'function' ? (next as (old: unknown) => unknown)(typing.values[at]) : next; }];
  } };
});
vi.mock('@/lib/unsaved-work', async original => ({ ...await original<object>(), useUnsavedGuard: (dirty: boolean) => { typing.guards.push(dirty); } }));
afterEach(() => { typing.on = false; typing.values.length = 0; });
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

describe('unsaved visit move', () => {
  it('holds beforeunload and the update restart only while an open Move form has a new date or time', () => {
    const answer = () => { typing.at = 0; typing.guards.length = 0; renderToStaticMarkup(createElement(InspectionsPanel)); return [...typing.guards]; };
    typing.on = true;
    expect(answer()).toEqual([]); // still loading: no visits
    typing.values[0] = readInspectionsView({ rules: { revision: 1, rules }, history: { revision: 1, records: {}, unmatched: [], lastImport: null }, properties: {},
      plan: { revision: 1, draft: { planStart: '2026-11-01', createdAt: 1, plan: { appointments: [appt('a', '2026-11-02', 'Bayside', '09:30')], holds: [], notDue: [] } } } });
    expect(answer()).toEqual([false]);
    const time = typing.values.lastIndexOf('09:30'), date = time - 1, moving = time - 2; // the visit's Move form: open, new date, new time
    typing.values[date] = '2026-11-03';
    expect(answer()).toEqual([false]); // the Move form is closed
    typing.values[moving] = true;
    expect(answer()).toEqual([true]);
    typing.values[date] = '2026-11-02';
    expect(answer()).toEqual([false]);
  });
});
