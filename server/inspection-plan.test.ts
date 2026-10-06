import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addMonths, draftInspectionPlan, dueDate, type InspectionPlanInput, type InspectionProperty, type InspectionRules } from './inspection-plan.ts';

const fixture = JSON.parse(readFileSync(new URL('../pack/workflows/austin-inspections/fixtures/synthetic-portfolio.json', import.meta.url), 'utf8')) as {
  synthetic: true; rules: InspectionRules; properties: InspectionProperty[];
};
const input = (over: Partial<InspectionPlanInput> = {}, rules: Partial<InspectionRules> = {}): InspectionPlanInput =>
  ({ properties: fixture.properties, ...over, rules: { ...fixture.rules, ...rules } });
const at = (plan: ReturnType<typeof draftInspectionPlan>, id: string) => plan.appointments.find((a) => a.propertyId === id);
const property = (id: string) => fixture.properties.find((p) => p.id === id)!;

describe('draftInspectionPlan', () => {
  it('uses a fictional fixture', () => {
    expect(fixture.synthetic).toBe(true);
    expect(fixture.properties.every((p) => p.id.startsWith('SYN-P'))).toBe(true);
  });

  it('computes due dates from either basis and clamps month ends', () => {
    expect(dueDate(property('SYN-P07'), { cycleBasis: 'completed', cycleMonths: 6 })).toBe('2026-12-29');
    expect(dueDate(property('SYN-P07'), { cycleBasis: 'planned', cycleMonths: 6 })).toBe('2026-12-01');
    expect(addMonths('2026-08-31', 6)).toBe('2027-02-28');
    expect(at(draftInspectionPlan(input()), 'SYN-P07')?.dueDate).toBe('2026-12-29');
    expect(at(draftInspectionPlan(input({}, { cycleBasis: 'planned' })), 'SYN-P07')?.dueDate).toBe('2026-12-01');
  });

  it('groups one area on one day in fixed time slots', () => {
    const plan = draftInspectionPlan(input());
    expect(['SYN-P01', 'SYN-P02', 'SYN-P03'].map((id) => [at(plan, id)?.date, at(plan, id)?.time]))
      .toEqual([['2026-11-10', '09:00'], ['2026-11-10', '09:45'], ['2026-11-10', '10:30']]);
    expect(plan.days.find((d) => d.date === '2026-11-10')?.areas).toEqual(['Northvale']);
    expect(plan.days.every((d) => d.areas.length === 1)).toBe(true);
  });

  it('overflows past daily capacity to the next working day', () => {
    expect(at(draftInspectionPlan(input()), 'SYN-P04')).toMatchObject({ date: '2026-11-11', time: '09:00' });
  });

  it('skips weekends, closed dates and days without access', () => {
    expect(at(draftInspectionPlan(input()), 'SYN-P05')?.date).toBe('2026-12-14'); // due Sunday 13 Dec
    expect(at(draftInspectionPlan(input({}, { closedDates: ['2026-12-14'] })), 'SYN-P05')?.date).toBe('2026-12-15');
    expect(at(draftInspectionPlan(input()), 'SYN-P12')).toMatchObject({ date: '2027-01-20', reason: expect.stringContaining('Wednesdays only') });
  });

  it('keeps an accepted booking exactly as booked on rerun', () => {
    const accepted = [{ id: 'insp-accepted-1', propertyId: 'SYN-P02', date: '2026-11-17', time: '09:45', inspector: 'fictional-inspector-A', externalId: 'fictional-pi-100' }];
    const first = draftInspectionPlan(input({ accepted }));
    const second = draftInspectionPlan(input({ accepted }, { dailyCapacity: 2 }));
    const expected = { id: 'insp-accepted-1', date: '2026-11-17', time: '09:45', status: 'accepted', externalId: 'fictional-pi-100' };
    expect(at(first, 'SYN-P02')).toMatchObject(expected);
    expect(at(second, 'SYN-P02')).toMatchObject(expected);
    expect(first.appointments.filter((a) => a.date === '2026-11-17' && a.time === '09:45')).toHaveLength(1);
  });

  it('preserves a manual move, including over an accepted booking', () => {
    const accepted = [{ propertyId: 'SYN-P05', date: '2026-12-14', time: '09:00', inspector: 'fictional-inspector-A', externalId: 'fictional-pi-200' }];
    const manual = [{ kind: 'move' as const, propertyId: 'SYN-P05', date: '2026-12-16', time: '13:00', inspector: 'fictional-inspector-A' }];
    const plan = draftInspectionPlan(input({ accepted, manual }));
    expect(at(plan, 'SYN-P05')).toMatchObject({ date: '2026-12-16', time: '13:00', status: 'manual', externalId: 'fictional-pi-200' });
    expect(draftInspectionPlan(input({ accepted, manual }))).toEqual(plan);
    const held = draftInspectionPlan(input({ manual: [{ kind: 'hold', propertyId: 'SYN-P06', note: 'Fictional: tenant leaving.' }] }));
    expect(held.holds).toContainEqual(expect.objectContaining({ propertyId: 'SYN-P06', kind: 'manual-hold' }));
  });

  it('holds overdue, no-history and unschedulable properties instead of dropping them', () => {
    const plan = draftInspectionPlan(input());
    expect(plan.holds).toContainEqual(expect.objectContaining({ propertyId: 'SYN-P10', kind: 'overdue', dueDate: '2026-09-01' }));
    expect(plan.holds).toContainEqual(expect.objectContaining({ propertyId: 'SYN-P11', kind: 'no-history', dueDate: null }));
    expect(at(plan, 'SYN-P10')).toBeUndefined();
    const sundayOnly = fixture.properties.map((p) => (p.id === 'SYN-P08' ? { ...p, accessWeekdays: [0] } : p));
    expect(draftInspectionPlan(input({ properties: sundayOnly })).holds).toContainEqual(expect.objectContaining({ propertyId: 'SYN-P08', kind: 'unschedulable' }));
    const accounted = new Set([...plan.appointments, ...plan.holds, ...plan.notDue].map((x) => x.propertyId));
    expect(accounted.size).toBe(fixture.properties.length);
  });

  it('gives identical output for identical input, whatever the input order', () => {
    const plan = draftInspectionPlan(input());
    expect(draftInspectionPlan(input())).toEqual(plan);
    expect(draftInspectionPlan(input({ properties: [...fixture.properties].reverse() }))).toEqual(plan);
    expect(at(plan, 'SYN-P01')?.id).toBe('insp-SYN-P01-due-2026-11-10');
  });

  it('rejects rules it cannot plan with', () => {
    expect(() => draftInspectionPlan(input({}, { inspectors: [] }))).toThrow('Add at least one inspector.');
    expect(() => draftInspectionPlan(input({}, { planStart: '2026-02-30' }))).toThrow('Plan start');
  });
});
