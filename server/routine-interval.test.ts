import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LOOP_CATALOG, LoopManager, nextOccurrence } from './routines.ts';
import { parseLoopsFile } from './routine-persistence.ts';
import { validateAustinPack } from './austin-pack.ts';
import { validateCustomerPack } from './customer-packs.ts';
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

// "Repeat at any cadence", packet A: the clock only. Brisbane keeps no daylight saving; Sydney's starts 4 Oct 2026 at 02:00.
const repeat = { type: 'daily' as const, time: '09:00', until: '17:00', everyMinutes: 2, weekdays: [1, 2, 3, 4, 5] };
const ok = async () => ({ ok: true, detail: 'Fictional internal review.' });
describe('minute repeats on the RealBud clock', () => {
  it('repeats inside its weekday window and skips a nonexistent DST minute', () => {
    expect(nextOccurrence(repeat, bne('2026-10-09T10:01:30'), 'Australia/Brisbane')).toBe(bne('2026-10-09T10:02:00'));
    expect(nextOccurrence(repeat, bne('2026-10-09T07:00:00'), 'Australia/Brisbane')).toBe(bne('2026-10-09T09:00:00'));
    // until is exclusive, so 16:58 is the last slot: Thursday rolls to Friday, Friday to Monday.
    expect(nextOccurrence(repeat, bne('2026-10-08T16:58:00'), 'Australia/Brisbane')).toBe(bne('2026-10-09T09:00:00'));
    expect(nextOccurrence(repeat, bne('2026-10-09T16:58:00'), 'Australia/Brisbane')).toBe(bne('2026-10-12T09:00:00'));
    // Without until the window runs to the end of the day.
    expect(nextOccurrence({ ...repeat, time: '20:00', until: undefined, everyMinutes: 120 }, bne('2026-10-09T22:00:00'), 'Australia/Brisbane')).toBe(bne('2026-10-12T20:00:00'));
    // Sydney 01:58 AEST is followed by 03:00 AEDT; 02:00–02:58 never exist that night.
    const allDay = { type: 'daily' as const, time: '00:00', everyMinutes: 2, weekdays: [0, 1, 2, 3, 4, 5, 6] };
    expect(nextOccurrence(allDay, Date.parse('2026-10-03T15:58:00Z'), 'Australia/Sydney')).toBe(Date.parse('2026-10-03T16:00:00Z'));
    expect(nextOccurrence(allDay, Date.parse('2026-10-03T16:00:00Z'), 'Australia/Sydney')).toBe(Date.parse('2026-10-03T16:02:00Z'));
    // A Saturday 23:30 bookmark still finds the 23-hour Sunday rather than jumping to Monday.
    expect(nextOccurrence({ ...allDay, time: '09:00', until: '10:00' }, Date.parse('2026-10-03T13:30:00Z'), 'Australia/Sydney')).toBe(Date.parse('2026-10-03T22:00:00Z'));
  });

  it('rejects a repeat of 0 or 1441 minutes, a window that ends before it starts, or one mixed with a day cadence', () => {
    const bad = [{ everyMinutes: 0 }, { everyMinutes: 1441 }, { everyMinutes: 2.5 }, { everyMinutes: 2, until: '08:00' }, { everyMinutes: 2, until: '09:00' },
      { until: '17:00' }, { everyMinutes: 2, intervalDays: 2, anchorDate: '2026-10-02' }, { everyMinutes: 2, monthly: 'first-weekday' }];
    for (const cadence of bad) {
      expect(() => parseLoopsFile({ version: 3, timezone: 'UTC', state: { 'weekly-bills': { enabled: false, handledThrough: 1, schedule: { time: '09:00', weekdays: [1], ...cadence } } }, runs: [] }, 'UTC')).toThrow();
    }
    expect(nextOccurrence({ ...repeat, everyMinutes: 0 }, 0, 'UTC')).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), 'rb-repeat-bad-')); clean.push(() => removeFixture(dir));
    const manager = new LoopManager({ file: join(dir, 'loops.json'), hostTimezone: 'UTC', now: () => bne('2026-10-09T08:00:00'), execute: ok });
    clean.push(async () => manager.close());
    for (const patch of [{ everyMinutes: 0 }, { everyMinutes: 1441 }, { time: '09:00', everyMinutes: 2, until: '08:59' }, { until: '17:00' }]) {
      expect(() => manager.patchClock('weekly-bills', patch)).toThrow('Choose a repeat');
    }
    expect(() => manager.patchClock('bank-references', { everyMinutes: 5 })).toThrow('no day interval');
    const switched = manager.patchClock('bank-references', { intervalDays: null, everyMinutes: 5 }).schedule;
    expect(switched.everyMinutes).toBe(5);
    expect(switched.intervalDays).toBeUndefined();
  });

  it('keeps the repeat through a restart and from a saved job, and clears it on request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-repeat-restart-')); clean.push(() => removeFixture(dir));
    const recipe = { id: 'fictional-repeat', title: 'Fictional queue check', status: 'active' as const, planApprovedAt: 1, revision: 1, approvedRevision: 1,
      schedule: { time: '09:00', weekdays: [1, 2, 3, 4, 5], everyMinutes: 5, until: '12:00' } };
    const options = { file: join(dir, 'loops.json'), hostTimezone: 'Australia/Brisbane', now: () => bne('2026-10-09T10:00:30'), execute: ok, listRecipes: () => [recipe] };
    let manager = new LoopManager(options);
    manager.patchClock('weekly-bills', { time: '09:00', until: '17:00', everyMinutes: 2, weekdays: [1, 2, 3, 4, 5], enabled: true, timezone: 'Australia/Brisbane' });
    manager.close(); manager = new LoopManager(options); clean.push(async () => manager.close());
    expect(manager.listLoops().find(l => l.id === 'weekly-bills')).toMatchObject({ schedule: { time: '09:00', everyMinutes: 2, until: '17:00' }, nextRunAt: bne('2026-10-09T10:02:00') });
    expect(manager.listLoops().find(l => l.id === 'recipe-fictional-repeat')).toMatchObject({ schedule: { everyMinutes: 5, until: '12:00' }, nextRunAt: bne('2026-10-09T10:05:00') });
    const cleared = manager.patchClock('weekly-bills', { everyMinutes: null }).schedule;
    expect(cleared.everyMinutes).toBeUndefined();
    expect(cleared.until).toBeUndefined();
  });

  function repeatClock(name: string, start: number, execute: (loop: { id: string }) => Promise<{ ok: boolean; detail: string }>, runDeadlineMs = 20) {
    const dir = mkdtempSync(join(tmpdir(), `rb-${name}-`)); clean.push(() => removeFixture(dir));
    const clock = { now: start };
    const manager = new LoopManager({ file: join(dir, 'loops.json'), hostTimezone: 'Australia/Brisbane', now: () => clock.now, runDeadlineMs, execute });
    clean.push(async () => manager.close());
    manager.setEnabled('morning-arrears', false); manager.setEnabled('owner-letter', false);
    const runs = () => manager.listRuns().filter(run => run.loopId === 'weekly-bills');
    return { manager, clock, runs };
  }
  const brisbaneRepeat = { time: '09:00', until: '17:00', everyMinutes: 2, weekdays: [1, 2, 3, 4, 5], enabled: true, timezone: 'Australia/Brisbane' };

  it('never overlaps: a slot due while the previous run works only moves the bookmark', async () => {
    let calls = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const { manager, clock, runs } = repeatClock('repeat-overlap', bne('2026-10-09T10:00:00'), async () => { calls++; await gate; return { ok: true, detail: 'Fictional.' }; });
    manager.patchClock('weekly-bills', brisbaneRepeat);
    for (const at of ['10:02:01', '10:04:01', '10:06:01', '10:08:01']) { clock.now = bne(`2026-10-09T${at}`); await manager.tick(); }
    expect(calls).toBe(1);
    expect(runs()).toHaveLength(1);
    expect(runs()[0]).toMatchObject({ status: 'running', scheduledFor: bne('2026-10-09T10:02:00') });
    release();
    await vi.waitFor(() => expect(runs()[0]!.status).toBe('completed'));
    clock.now = bne('2026-10-09T10:10:01'); await manager.tick();
    await vi.waitFor(() => expect(manager.busy).toBe(false));
    expect(calls).toBe(2);
    expect(runs().some(run => run.status === 'missed')).toBe(false);
  });

  it('after 3 hours asleep runs once for the latest slot and writes one skipped receipt', async () => {
    let calls = 0;
    const { manager, clock, runs } = repeatClock('repeat-sleep', bne('2026-10-09T10:00:00'), async () => { calls++; return { ok: true, detail: 'Fictional.' }; });
    manager.patchClock('weekly-bills', brisbaneRepeat);
    clock.now = bne('2026-10-09T13:00:05'); await manager.tick();
    await vi.waitFor(() => expect(manager.busy).toBe(false));
    expect(calls).toBe(1);
    expect(runs()).toHaveLength(2);
    expect(runs().find(run => run.status === 'completed')!.scheduledFor).toBe(bne('2026-10-09T13:00:00'));
    expect(runs().find(run => run.status === 'missed')).toMatchObject({ scheduledFor: bne('2026-10-09T10:02:00'), detail: expect.stringMatching(/^Skipped 89 times while this computer was asleep\./) });
    expect(manager.listLoops().find(l => l.id === 'weekly-bills')!.nextRunAt).toBe(bne('2026-10-09T13:02:00'));
  });

  it('after 13 hours asleep writes only the 12-hour receipt and runs once', async () => {
    let calls = 0;
    const { manager, clock, runs } = repeatClock('repeat-long-sleep', bne('2026-10-09T10:00:00'), async () => { calls++; return { ok: true, detail: 'Fictional.' }; });
    manager.patchClock('weekly-bills', { ...brisbaneRepeat, time: '00:00', until: null, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    clock.now = bne('2026-10-09T23:00:05'); await manager.tick();
    await vi.waitFor(() => expect(manager.busy).toBe(false));
    expect(calls).toBe(1);
    expect(runs()).toHaveLength(2);
    expect(runs().find(run => run.status === 'completed')!.scheduledFor).toBe(bne('2026-10-09T23:00:00'));
    expect(runs().find(run => run.status === 'missed')!.detail).toMatch(/more than 12 hours/);
  });

  it('a slow repeat does not hold the tick, so the morning money check still runs on time', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    // A one-minute deadline: a tick that awaited the repeat would sit on it that long.
    const { manager, clock } = repeatClock('repeat-slow', bne('2026-10-09T06:59:00'), async loop => { calls.push(loop.id); if (loop.id === 'weekly-bills') await gate; return { ok: true, detail: 'Fictional.' }; }, 60_000);
    manager.setEnabled('morning-arrears', true);
    manager.patchClock('weekly-bills', { ...brisbaneRepeat, time: '07:00', until: null, everyMinutes: 30, weekdays: [0, 1, 2, 3, 4, 5, 6] });
    const within = (tick: Promise<void>) => Promise.race([tick.then(() => 'done'), new Promise(resolve => setTimeout(() => resolve('held'), 500))]);
    clock.now = bne('2026-10-09T07:00:01');
    expect(await within(manager.tick())).toBe('done');
    clock.now = bne('2026-10-09T07:30:01');
    expect(await within(manager.tick())).toBe('done');
    expect(calls).toEqual(['weekly-bills', 'morning-arrears']);
    release();
    await vi.waitFor(() => expect(manager.busy).toBe(false));
  });

  it("trims the chattiest loop's oldest runs first, never another job's latest receipt", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rb-repeat-trim-')); clean.push(() => removeFixture(dir));
    const file = join(dir, 'loops.json'), base = bne('2026-10-09T09:00:00'), last = base + 2_099 * 120_000;
    const run = (id: string, loopId: string, loopName: string, scheduledFor: number) => ({ id, loopId, loopName, scheduledFor, status: 'completed', manual: false, loopRevision: 2, createdAt: scheduledFor, finishedAt: scheduledFor });
    const repeats = Array.from({ length: 2_100 }, (_, i) => run(`fictional-repeat-${i}`, 'weekly-bills', 'Weekly bills review', base + i * 120_000));
    writeFileSync(file, JSON.stringify({ version: 3, timezone: 'Australia/Brisbane', runs: [run('fictional-morning', 'morning-arrears', 'Morning money check', base - 86_400_000), ...repeats],
      state: { 'morning-arrears': { enabled: false, handledThrough: last, revision: 2 }, 'owner-letter': { enabled: false, handledThrough: last },
        'weekly-bills': { enabled: true, handledThrough: last, revision: 2, schedule: { time: '00:00', weekdays: [0, 1, 2, 3, 4, 5, 6], everyMinutes: 2, timezone: 'Australia/Brisbane' } } } }), { mode: 0o600 });
    const manager = new LoopManager({ file, hostTimezone: 'Australia/Brisbane', now: () => last + 121_000, runDeadlineMs: 20, execute: ok });
    clean.push(async () => manager.close());
    await manager.tick();
    await vi.waitFor(() => expect(manager.busy).toBe(false));
    const runs = manager.listRuns();
    expect(runs).toHaveLength(2_000);
    expect(runs.some(item => item.id === 'fictional-morning')).toBe(true);
    expect(runs.some(item => item.id === 'fictional-repeat-0')).toBe(false);
    expect(runs[0]).toMatchObject({ loopId: 'weekly-bills', scheduledFor: last + 120_000, status: 'completed' });
  });

  it('published packs keep a plain time and weekdays: a repeat or the mail ability is refused on import', () => {
    const austin = JSON.parse(readFileSync(new URL('../pack/workflows/austin-office/austin-schedule-v1.json', import.meta.url), 'utf8'));
    expect(() => validateAustinPack(austin)).not.toThrow();
    austin.loops[0].schedule = { time: '08:00', weekdays: [1], everyMinutes: 2 };
    expect(() => validateAustinPack(austin)).toThrow();
    const pack = JSON.parse(readFileSync(new URL('../pack/workflows/austin-maintenance-rehearsal/realbud-austin-maintenance-rehearsal-v1.json', import.meta.url), 'utf8'));
    pack.recipes[0].schedule = { time: '08:00', weekdays: [1] };
    expect(() => validateCustomerPack(pack)).not.toThrow();
    for (const extra of [{ everyMinutes: 2 }, { until: '17:00' }]) {
      pack.recipes[0].schedule = { time: '08:00', weekdays: [1], ...extra };
      expect(() => validateCustomerPack(pack)).toThrow();
    }
    pack.recipes[0].schedule = null;
    pack.recipes[0].capabilities = ['read-mail'];
    expect(() => validateCustomerPack(pack)).toThrow();
  });
});
