import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LoopManager, nextOccurrence } from './routines.ts';
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
