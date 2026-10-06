import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LOOP_CATALOG, LoopManager, nextOccurrence } from './routines.ts';
import { parseLoopsFile } from './routine-persistence.ts';
import { removeFixture } from './testing/private-fixture.ts';
const clean: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of clean.splice(0).reverse()) await close(); });
const schedule = { type: 'daily' as const, time: '08:00', weekdays: [0,1,2,3,4,5,6], intervalDays: 2, anchorDate: '2026-10-02' };
describe('anchored calendar-day routine intervals', () => {
  it('runs every second Brisbane calendar day and skips earlier dates', () => {
    expect(nextOccurrence(schedule, Date.parse('2026-09-01T00:00:00Z'), 'Australia/Brisbane')).toBe(Date.parse('2026-10-01T22:00:00Z'));
    expect(nextOccurrence(schedule, Date.parse('2026-10-01T22:00:00Z'), 'Australia/Brisbane')).toBe(Date.parse('2026-10-03T22:00:00Z'));
  });
  it('preserves local time over daylight saving instead of adding forty-eight hours', () => {
    expect(nextOccurrence(schedule, Date.parse('2026-10-01T22:00:00Z'), 'Australia/Sydney')).toBe(Date.parse('2026-10-03T21:00:00Z'));
  });
  it('rejects impossible anchors and incomplete interval records', () => {
    for (const cadence of [{ intervalDays: 0, anchorDate: '2026-10-02' }, { intervalDays: 2, anchorDate: '2026-02-30' }, { intervalDays: 2 }]) {
      expect(() => parseLoopsFile({ version: 3, timezone: 'UTC', state: { 'weekly-bills': { enabled: false, handledThrough: 1, schedule: { time: '08:00', weekdays: [1], ...cadence } } }, runs: [] }, 'UTC')).toThrow();
    }
  });
  it('persists a retuned cadence through restart and records missed slots without replaying old work', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-interval-')); clean.push(() => removeFixture(dir));
    let now = Date.parse('2026-10-01T20:00:00Z'), calls = 0;
    const options = { file: join(dir, 'loops.json'), hostTimezone: 'UTC', now: () => now, execute: async () => { calls++; return { ok: true, detail: 'Fictional internal review.' }; } };
    let manager = new LoopManager(options);
    for (const intervalDays of [0, -1, 1.5, 32]) {
      expect(() => manager.patchClock('weekly-bills', { intervalDays })).toThrow('Choose an interval');
    }
    manager.setEnabled('morning-arrears', false); manager.setEnabled('owner-letter', false);
    manager.patchClock('weekly-bills', { ...schedule, enabled: true, timezone: 'Australia/Brisbane' });
    manager.close(); manager = new LoopManager(options); clean.push(async () => manager.close());
    expect(manager.listLoops().find(l => l.id === 'weekly-bills')?.schedule).toMatchObject(schedule);
    now = Date.parse('2026-10-01T22:00:01Z'); await manager.tick(); expect(calls).toBe(1);
    now = Date.parse('2026-10-05T10:00:01Z'); await manager.tick(); expect(calls).toBe(1);
    expect(manager.listRuns().some(run => run.loopId === 'weekly-bills' && run.status === 'missed')).toBe(true);
    expect(manager.patchClock('weekly-bills', { intervalDays: null, weekdays: [1] }).schedule.intervalDays).toBeUndefined();
  });
});

const catalog = (id: string) => ({ ...LOOP_CATALOG.find(loop => loop.id === id)!.schedule });
const bne = (iso: string) => Date.parse(`${iso}+10:00`);
describe('Austin loop defaults on the Brisbane clock', () => {
  it('runs bank references every second day from its anchor at 08:00', () => {
    expect(nextOccurrence(catalog('bank-references'), bne('2026-10-02T08:00:00'), 'Australia/Brisbane')).toBe(bne('2026-10-04T08:00:00'));
  });
  it('runs the supplier list check fortnightly on Mondays 08:15 from 12 October', () => {
    const schedule = catalog('rei-supplier-check');
    expect(schedule).toMatchObject({ time: '08:15', intervalDays: 14, anchorDate: '2026-10-12' });
    expect(new Date(Date.UTC(2026, 9, 12)).getUTCDay()).toBe(1);
    const first = nextOccurrence(schedule, bne('2026-10-06T09:00:00'), 'Australia/Brisbane')!;
    expect(first).toBe(bne('2026-10-12T08:15:00'));
    expect(nextOccurrence(schedule, first, 'Australia/Brisbane')).toBe(bne('2026-10-26T08:15:00'));
  });
  it('drafts inspections on the first weekday of each month at 09:00, skipping a weekend 1st', () => {
    const schedule = catalog('inspection-draft');
    expect(schedule).toMatchObject({ time: '09:00', monthly: 'first-weekday' });
    // 1 Nov 2026 is a Sunday, 1 Dec a Tuesday, 1 Aug 2026 a Saturday.
    expect(nextOccurrence(schedule, bne('2026-10-06T09:00:00'), 'Australia/Brisbane')).toBe(bne('2026-11-02T09:00:00'));
    expect(nextOccurrence(schedule, bne('2026-11-02T09:00:00'), 'Australia/Brisbane')).toBe(bne('2026-12-01T09:00:00'));
    expect(nextOccurrence(schedule, bne('2026-07-02T09:00:00'), 'Australia/Brisbane')).toBe(bne('2026-08-03T09:00:00'));
    expect(() => parseLoopsFile({ version: 3, timezone: 'UTC', state: { 'inspection-draft': { enabled: false, handledThrough: 1, schedule: { time: '09:00', weekdays: [1], monthly: 'first-weekday', intervalDays: 2, anchorDate: '2026-10-02' } } }, runs: [] }, 'UTC')).toThrow();
  });
  it('starts morning priorities at 07:30 so they are ready by 08:00, and keeps the other defaults', () => {
    expect(catalog('inbound-triage')).toMatchObject({ time: '07:30', weekdays: [1, 2, 3, 4, 5] });
    expect(catalog('weekly-bills')).toMatchObject({ time: '08:00', weekdays: [1] });
    expect(catalog('maintenance-review')).toMatchObject({ time: '08:30', weekdays: [1, 2, 3, 4, 5] });
  });
  it('keeps the monthly cadence through a timezone change and a restart, and never enables it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-monthly-')); clean.push(() => removeFixture(dir));
    const options = { file: join(dir, 'loops.json'), hostTimezone: 'UTC', now: () => bne('2026-10-06T09:00:00'), execute: async () => ({ ok: true, detail: 'Fictional draft.' }) };
    let manager = new LoopManager(options);
    expect(manager.listLoops().find(l => l.id === 'inspection-draft')).toMatchObject({ available: true, enabled: false, nextRunAt: null });
    expect(manager.patchClock('inspection-draft', { timezone: 'Australia/Brisbane' })).toMatchObject({ enabled: false, schedule: { monthly: 'first-weekday', timezone: 'Australia/Brisbane' } });
    manager.close(); manager = new LoopManager(options); clean.push(async () => manager.close());
    expect(manager.patchClock('inspection-draft', { enabled: true }).nextRunAt).toBe(bne('2026-11-02T09:00:00'));
    expect(() => manager.patchClock('inspection-draft', { intervalDays: 7, anchorDate: '2026-10-12' })).toThrow('Choose an interval');
  });
});
