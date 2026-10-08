import { privateTempRoot } from './testing/private-fixture.ts';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { austinChecklist, createAustinPack, loadAustinPack, validateAustinPack, type AustinSignals } from './austin-pack.ts';
import { createInspectionRulesStore } from './inspection-rules.ts';
import { createMaintenanceReviewStore } from './maintenance-review.ts';
import { LOOP_CATALOG, LoopManager } from './routines.ts';
import { removeFixture } from './testing/private-fixture.ts';
import { hiddenAustinLoopIds } from '../shared/austin-pack.ts';
import type { CustomerPackOfficeSettings } from '../shared/customer-packs.ts';
import { austinAccountsCustomerPack, austinPropertyCustomerPack } from './customer-pack-definition.ts';

const cleanup: Array<() => unknown> = [];
afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });
const AUSTIN = ['bank-references', 'weekly-bills', 'inbound-triage', 'maintenance-review', 'rei-supplier-check', 'inspection-draft'];
// Tuesday 6 October 2026, 09:00 in Brisbane.
const NOW = Date.parse('2026-10-06T09:00:00+10:00');

function office(options: { zone?: string | null; signals?: Partial<AustinSignals> } = {}) {
  const dir = privateTempRoot(join(tmpdir(), 'rb-austin-pack-'));
  cleanup.push(() => removeFixture(dir));
  const loops = new LoopManager({ file: join(dir, 'loops.json'), hostTimezone: 'UTC', now: () => NOW, execute: async () => ({ ok: true, detail: 'Fictional run.' }) });
  cleanup.push(() => loops.close());
  const maintenance = createMaintenanceReviewStore({ file: join(dir, 'maintenance.json') });
  const inspection = createInspectionRulesStore({ file: join(dir, 'inspection.json') });
  const signals: AustinSignals = { gmail: false, redbark: false, tenants: 0, suppliers: 0, ...options.signals };
  const pack = createAustinPack({ loops, maintenance, inspection, file: join(dir, 'austin-pack.json'), now: () => NOW,
    officeTimeZone: async () => options.zone === undefined ? null : options.zone, signals: async () => signals });
  return { loops, maintenance, pack, signals, loop: (id: string) => loops.listLoops().find(l => l.id === id)! };
}

describe('Austin pack file', () => {
  it('declares the six workflows with the catalog schedules, plain plans and Brisbane time', () => {
    const pack = loadAustinPack();
    expect(pack).toMatchObject({ format: 'realbud-loop-pack', version: 1, revision: 1, timeZone: 'Australia/Brisbane' });
    expect(pack.loops.map(l => l.loopId)).toEqual(AUSTIN);
    for (const item of pack.loops) {
      const { type: _type, ...catalog } = LOOP_CATALOG.find(l => l.id === item.loopId)!.schedule;
      expect(item.schedule, item.loopId).toEqual(catalog);
    }
    expect(pack.connections.map(c => c.id)).toEqual(['gmail', 'redbark', 'rei']);
    expect(pack.rules.map(r => r.setting)).toEqual([{ basis: 'receivedDate', span: 'calendarMonth' }, { cycleMonths: 6, cycleBasis: 'completed' }]);
    expect(pack.loops.find(l => l.loopId === 'inbound-triage')?.note).toMatch(/7:30.*8:00/);
  });

  it('rejects credentials, machine paths, unknown workflows and extra fields', () => {
    const good = loadAustinPack();
    const variant = (change: (pack: Record<string, any>) => void) => { const copy = structuredClone(good) as unknown as Record<string, any>; change(copy); return copy; };
    expect(() => validateAustinPack(variant(p => { p.loops[0].plan.reads = 'Use password=fictional-not-a-real-secret-123'; }))).toThrow(/credentials/);
    expect(() => validateAustinPack(variant(p => { p.connections[0].how = 'See /Users/fictional/file'; }))).toThrow(/paths/);
    expect(() => validateAustinPack(variant(p => { p.loops[0].loopId = 'send-letters'; }))).toThrow(/loops/);
    expect(() => validateAustinPack(variant(p => { p.schedules = 'on'; }))).toThrow(/envelope/);
    expect(() => validateAustinPack(variant(p => { p.loops[1].schedule.time = '25:00'; }))).toThrow(/schedule/);
    expect(() => validateAustinPack(variant(p => { p.loops[5].schedule.intervalDays = 2; }))).toThrow(/schedule/);
  });
});

describe('installing the Austin pack', () => {
  it('sets the office timezone on all six and leaves every one off', async () => {
    const { pack, loop } = office();
    expect((await pack.view()).installed).toBeNull();
    const result = await pack.install();
    expect(result.results).toEqual(AUSTIN.map(loopId => ({ loopId, outcome: 'applied' })));
    expect(result.installed).toEqual({ revision: 1, at: NOW });
    expect(result).toMatchObject({ timeZone: 'Australia/Brisbane', timeZoneFromOffice: false });
    for (const id of AUSTIN) expect(loop(id), id).toMatchObject({ enabled: false, nextRunAt: null, schedule: { timezone: 'Australia/Brisbane' } });
    // Loops outside the pack are untouched.
    expect(loop('morning-arrears').schedule.timezone).toBeUndefined();
  });

  it('uses the agency timezone when the office has one, and a repeat install changes nothing', async () => {
    const { pack, loop } = office({ zone: 'Australia/Sydney' });
    await pack.install();
    const revisions = AUSTIN.map(id => loop(id).revision);
    expect(loop('maintenance-review').schedule.timezone).toBe('Australia/Sydney');
    await pack.install();
    expect(AUSTIN.map(id => loop(id).revision)).toEqual(revisions);
  });

  it('never overwrites an office edit or an office on/off choice', async () => {
    const { pack, loops, loop } = office();
    loops.patchClock('weekly-bills', { time: '09:15' });
    loops.patchClock('maintenance-review', { enabled: true });
    const result = await pack.install();
    expect(result.results.find(r => r.loopId === 'weekly-bills')).toEqual({ loopId: 'weekly-bills', outcome: 'kept' });
    expect(loop('weekly-bills').schedule).toMatchObject({ time: '09:15' });
    expect(loop('weekly-bills').schedule.timezone).toBeUndefined();
    expect(loop('maintenance-review')).toMatchObject({ enabled: true, schedule: { timezone: 'Australia/Brisbane' } });
  });

  it('reports a pack loop id with no loop on this PC as unknown and sets nothing for it', async () => {
    const { pack, loops, loop } = office();
    loops.patchClock('weekly-bills', { time: '09:15' });
    const before = loops.listLoops();
    const results = await pack.applyPackLoops([
      { id: 'recipe-fictional-missing-job', schedule: { type: 'daily', time: '08:00', weekdays: [1] } },
      { id: 'weekly-bills', schedule: { type: 'daily', time: '08:00', weekdays: [1] } },
      { id: 'owner-letter', schedule: { type: 'daily', time: '16:00', weekdays: [5] } },
    ]);
    expect(results).toEqual([
      { loopId: 'recipe-fictional-missing-job', outcome: 'unknown' },
      { loopId: 'weekly-bills', outcome: 'kept' },
      { loopId: 'owner-letter', outcome: 'applied' },
    ]);
    expect(loops.listLoops().map(l => l.id)).toEqual(before.map(l => l.id));
    expect(loop('weekly-bills')).toMatchObject({ enabled: false, schedule: { time: '09:15' } });
  });

  it("sets the confirmed maintenance month rule only while the office has not chosen one", async () => {
    const untouched = office();
    await untouched.pack.install();
    expect((await untouched.maintenance.read()).rule).toEqual({ basis: 'receivedDate', span: 'calendarMonth' });
    expect((await untouched.pack.view()).rules.every(rule => rule.matches)).toBe(true);
    const edited = office();
    await edited.maintenance.setRule({ rule: { basis: 'invoiceDate', span: 'rolling30' }, expectedRevision: 0 });
    await edited.pack.install();
    expect((await edited.maintenance.read()).rule).toEqual({ basis: 'invoiceDate', span: 'rolling30' });
    expect((await edited.pack.view()).rules.find(rule => rule.id === 'maintenance-month')?.matches).toBe(false);
  });

  describe("importing Sherry's role pack never overwrites a person's choice", () => {
    const sherry = () => (JSON.parse(austinPropertyCustomerPack().files!['office/settings.json']!) as CustomerPackOfficeSettings).loops.map(({ id, schedule }) => ({ id, schedule }));

    it('keeps a month rule the person already chose', async () => {
      const f = office();
      await f.maintenance.setRule({ rule: { basis: 'invoiceDate', span: 'calendarMonth' }, expectedRevision: 0 });
      await f.pack.applyPackLoops(sherry());
      expect(await f.maintenance.read()).toMatchObject({ rule: { basis: 'invoiceDate', span: 'calendarMonth' }, ruleRevision: 1 });
    });

    it('gives an unset rule the pack default, and a re-import changes nothing', async () => {
      const f = office();
      await f.pack.applyPackLoops(sherry());
      const first = await f.maintenance.read(), revisions = AUSTIN.map(id => f.loop(id).revision);
      expect(first).toMatchObject({ rule: { basis: 'receivedDate', span: 'calendarMonth' }, ruleRevision: 1 });
      await f.pack.applyPackLoops(sherry());
      expect(await f.maintenance.read()).toEqual(first);
      expect(AUSTIN.map(id => f.loop(id).revision)).toEqual(revisions);
    });

    it('keeps a loop timezone already set when the office has none', async () => {
      const f = office();
      f.loops.patchClock('maintenance-review', { timezone: 'Australia/Sydney' });
      await f.pack.applyPackLoops(sherry());
      expect(f.loop('maintenance-review').schedule.timezone).toBe('Australia/Sydney');
      expect(f.loop('inspection-draft').schedule.timezone).toBe('Australia/Brisbane');
    });
  });

  it('shows the next Brisbane run once the office switches W4 on after review', async () => {
    const { pack, loops } = office();
    await pack.install();
    expect(loops.patchClock('maintenance-review', { enabled: true }).nextRunAt).toBe(Date.parse('2026-10-07T08:30:00+10:00'));
  });
});

describe('Austin setup checklist', () => {
  it('starts with every item open and points at the first workflow still off', async () => {
    const { pack } = office();
    await pack.install();
    const items = (await pack.view()).checklist;
    expect(items.map(i => [i.id, i.done])).toEqual([['gmail', false], ['redbark', false], ['rei', false], ['tenants', false], ['suppliers', false], ['workflows', false]]);
    expect(items.find(i => i.id === 'workflows')).toMatchObject({ next: 'bank-references', detail: expect.stringMatching(/^0 of 6 on/) });
  });

  it('ticks items from what the PC can see, including a recorded REI sign-in', async () => {
    const { pack, loops } = office({ signals: { gmail: true, redbark: true, suppliers: 12 } });
    await pack.install();
    loops.patchClock('bank-references', { enabled: true });
    let items = (await pack.view()).checklist;
    expect(items.filter(i => i.done).map(i => i.id)).toEqual(['gmail', 'redbark', 'suppliers']);
    expect(items.find(i => i.id === 'workflows')).toMatchObject({ next: 'weekly-bills', detail: expect.stringMatching(/^1 of 6 on/) });
    await pack.noteReiSignedIn();
    items = (await pack.view()).checklist;
    expect(items.find(i => i.id === 'rei')?.done).toBe(true);
    expect(items.find(i => i.id === 'tenants')?.done).toBe(false);
  });

  it('counts a saved tenant list as a signed-in REI read and finishes when all six have a next run', async () => {
    const { pack, loops } = office({ signals: { gmail: true, redbark: true, tenants: 40, suppliers: 9 } });
    await pack.install();
    for (const loop of loops.listLoops()) if (AUSTIN.includes(loop.id)) loops.patchClock(loop.id, { enabled: true });
    const scheduled = loops.listLoops().filter(loop => AUSTIN.includes(loop.id));
    expect(scheduled).toHaveLength(6);
    expect(scheduled.every(loop => loop.enabled && loop.available && loop.nextRunAt !== null)).toBe(true);
    const items = (await pack.view()).checklist;
    expect(items.every(i => i.done)).toBe(true);
    expect(items.find(i => i.id === 'workflows')?.next).toBeUndefined();
  });

  it.each([
    { name: 'unavailable', fields: { available: false }, reason: 'is not currently available' },
    { name: 'without a recorded next run', fields: { nextRunAt: null }, reason: 'has no next run' },
  ])('keeps an enabled workflow $name incomplete', async ({ fields, reason }) => {
    const { pack, loops } = office();
    await pack.install();
    for (const loop of loops.listLoops()) if (AUSTIN.includes(loop.id)) loops.patchClock(loop.id, { enabled: true });
    const reported = loops.listLoops().map(loop => loop.id === 'bank-references' ? { ...loop, ...fields } : loop);
    const items = austinChecklist(loadAustinPack(), reported, { gmail: true, redbark: true, tenants: 40, suppliers: 9, reiSignedIn: true });
    expect(items.find(i => i.id === 'workflows')).toMatchObject({
      done: false, next: 'bank-references',
      detail: `5 of 6 scheduled. Bank reference review is switched on but ${reason}. Review its schedule.`,
    });
    expect(items.every(i => i.done)).toBe(false);
  });
});

describe('Schedule before a role pack (Windows #54)', () => {
  const visible = async (f: ReturnType<typeof office>, ran: string[] = []) => {
    const hidden = hiddenAustinLoopIds(await f.pack.view(), f.loops.listLoops(), new Set(ran));
    return f.loops.listLoops().map(l => l.id).filter(id => !hidden.has(id));
  };

  it('shows only the core jobs on a fresh PC, then Kevin\'s after his role pack', async () => {
    const f = office();
    expect(await visible(f)).toEqual(['morning-arrears', 'owner-letter', 'inbound-triage', 'rei-morning-refresh']);
    const kevin = JSON.parse(austinAccountsCustomerPack().files!['office/settings.json']!) as CustomerPackOfficeSettings;
    await f.pack.applyPackLoops(kevin.loops.map(({ id, schedule }) => ({ id, schedule })));
    expect(await visible(f)).toEqual(['morning-arrears', 'owner-letter', 'inbound-triage', 'bank-references', 'weekly-bills', 'rei-morning-refresh']);
    // REI morning refresh is a core loop, never hidden. The whole-office install sets all six Auston loops.
    await f.pack.install();
    expect(await visible(f)).toEqual(LOOP_CATALOG.map(l => l.id));
  });

  it('never hides a job that is on or has run', async () => {
    const f = office();
    f.loops.setEnabled('inspection-draft', true);
    expect(await visible(f, ['maintenance-review'])).toEqual(['morning-arrears', 'owner-letter', 'inbound-triage', 'maintenance-review', 'rei-morning-refresh', 'inspection-draft']);
  });
});
