import { privateTempRoot } from './testing/private-fixture.ts';
import { readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createInspectionBookingsStore, createInspectionsApi, planBase, runInspectionDraft, type PlanBase } from './inspection-bookings.ts';
import { createInspectionHistoryStore } from './inspection-history.ts';
import { createInspectionRulesStore, defaultInspectionRules } from './inspection-rules.ts';
import { removeFixture } from './testing/private-fixture.ts';

const portfolio = JSON.parse(readFileSync(new URL('../pack/workflows/austin-inspections/fixtures/synthetic-portfolio.json', import.meta.url), 'utf8'));
const { planStart: _start, ...officeRules } = portfolio.rules;
const base: PlanBase = { properties: portfolio.properties, rules: { ...officeRules, closedDates: ['2026-11-10'] } };
const directories: string[] = [];
const dir = async () => { const d = privateTempRoot(join(tmpdir(), 'realbud-inspection-bookings-')); directories.push(d); return d; };
afterEach(async () => { await Promise.all(directories.splice(0).map(path => removeFixture(path))); });

describe('inspection bookings store', () => {
  it('accepts and moves by stable id and keeps both on rerun', async () => {
    const file = join(await dir(), 'b.json');
    const store = createInspectionBookingsStore({ file, now: () => 5 });
    const first = await store.draft({ planStart: '2026-10-05', base });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const drafts = first.draft!.plan.appointments.filter(a => a.status === 'draft');
    expect(drafts.length).toBeGreaterThan(4);
    expect(first.draft!.plan.appointments.some(a => a.date === '2026-11-10')).toBe(false);
    const ids = drafts.slice(0, 3).map(a => a.id);
    const accepted = await store.accept({ ids, expectedRevision: 1, base });
    expect(accepted.accepted.map(p => p.id)).toEqual(ids);
    expect(accepted.draft!.plan.appointments.filter(a => ids.includes(a.id)).every(a => a.status === 'accepted')).toBe(true);
    await expect(store.accept({ ids, expectedRevision: 1, base })).rejects.toMatchObject({ status: 409 });

    const target = drafts[3]!;
    await expect(store.move({ id: target.id, date: '2026-11-10', time: '09:00', expectedRevision: 2, base })).rejects.toThrow(/closed/);
    await expect(store.move({ id: target.id, date: '2026-11-14', time: '09:00', expectedRevision: 2, base })).rejects.toThrow(/working day/);
    const moved = await store.move({ id: target.id, date: '2026-11-11', time: '14:00', expectedRevision: 2, base });
    expect(moved.draft!.plan.appointments.find(a => a.id === target.id)).toMatchObject({ date: '2026-11-11', time: '14:00', status: 'manual' });

    // Rerun with a later start and a changed portfolio order: pins stay put.
    const rerun = await store.draft({ planStart: '2026-10-05', base: { ...base, properties: [...base.properties].reverse() } });
    for (const id of ids) expect(rerun.draft!.plan.appointments.find(a => a.id === id)).toEqual(accepted.draft!.plan.appointments.find(a => a.id === id));
    expect(rerun.draft!.plan.appointments.find(a => a.id === target.id)).toMatchObject({ date: '2026-11-11', time: '14:00' });
  });

  it('refuses a move onto a taken time and a draft without inspectors', async () => {
    const store = createInspectionBookingsStore({ file: join(await dir(), 'b.json') });
    const { draft } = await store.draft({ planStart: '2026-10-05', base });
    const [a, b] = draft!.plan.appointments;
    await expect(store.move({ id: b!.id, date: a!.date, time: a!.time, expectedRevision: 1, base })).rejects.toMatchObject({ status: 409 });
    await expect(store.draft({ planStart: '2026-10-05', base: { ...base, rules: { ...base.rules, inspectors: [] } } })).rejects.toMatchObject({ status: 400 });
  });
});

describe('inspections api', () => {
  it('imports history, drafts from Desk properties and holds the rest', async () => {
    const d = await dir();
    const rules = createInspectionRulesStore({ file: join(d, 'r.json') });
    await rules.save({ expectedRevision: 0, rules: { ...defaultInspectionRules(), inspectors: ['fictional-inspector-A'] } });
    let recovery = false;
    const api = createInspectionsApi({ rules, history: createInspectionHistoryStore({ file: join(d, 'h.json') }), bookings: createInspectionBookingsStore({ file: join(d, 'b.json') }),
      properties: () => portfolio.properties.map((p: { id: string; address: string }) => ({ id: p.id, address: p.address })), recovery: () => recovery, today: () => '2026-10-05' });
    await api('/api/inspections/history/import', 'POST', { expectedRevision: 0, csv: 'id,area,last completed\nSYN-P01,Northvale,2026-05-10\nSYN-NOPE,Northvale,2026-05-10' });
    const drafted = await api('/api/inspections/draft', 'POST', {});
    const plan = (drafted!.body as { draft: { planStart: string; plan: { appointments: { propertyId: string }[]; holds: { propertyId: string; kind: string }[] } } }).draft;
    expect(plan.planStart).toBe('2026-10-05');
    expect(plan.plan.appointments.map(a => a.propertyId)).toEqual(['SYN-P01']);
    expect(plan.plan.holds.find(h => h.propertyId === 'SYN-P02')?.kind).toBe('no-history');
    const view = (await api('/api/inspections', 'GET'))!.body as { history: { unmatched: unknown[] }; properties: Record<string, string> };
    expect(view.history.unmatched).toHaveLength(1);
    expect(view.properties['SYN-P01']).toBe('1 Fictional Street, Northvale');
    expect(await api('/api/inspections/other', 'POST', {})).toBeNull();
    expect((await api('/api/inspections/draft', 'GET'))!.status).toBe(405);
    recovery = true;
    await expect(api('/api/inspections/draft', 'POST', {})).rejects.toMatchObject({ status: 503 });
  });
});

describe('inspection draft loop', () => {
  it('refreshes the saved draft, keeps accepted visits and says it is ready without booking', async () => {
    const d = await dir();
    const rules = createInspectionRulesStore({ file: join(d, 'r.json') });
    await rules.save({ expectedRevision: 0, rules: { ...defaultInspectionRules(), inspectors: ['fictional-inspector-A'] } });
    const history = createInspectionHistoryStore({ file: join(d, 'h.json') });
    await history.importCsv({ expectedRevision: 0, csv: 'id,area,last completed\nSYN-P01,Northvale,2026-05-10', properties: portfolio.properties });
    const bookings = createInspectionBookingsStore({ file: join(d, 'b.json') });
    const properties = () => portfolio.properties.map((p: { id: string; address: string }) => ({ id: p.id, address: p.address }));
    const host = { bookings, history, rules, properties, today: async () => '2026-10-05' };
    const first = await runInspectionDraft(host);
    expect(first).toMatchObject({ ok: true, status: 'awaiting-approval' });
    expect(first.detail).toMatch(/^New inspection draft ready to review: 1 to accept, \d+ held\. Nothing is booked\.$/);
    const saved = await bookings.read();
    const visit = saved.draft!.plan.appointments[0]!;
    await bookings.accept({ ids: [visit.id], expectedRevision: saved.revision, base: await planBase(properties(), history, rules) });
    const again = await runInspectionDraft({ ...host, today: async () => '2026-11-02' });
    const rerun = (await bookings.read()).draft!;
    expect(rerun.planStart).toBe('2026-11-02');
    expect(rerun.plan.appointments.find(a => a.id === visit.id)).toMatchObject({ date: visit.date, time: visit.time, status: 'accepted' });
    expect(again.detail).toMatch(/0 to accept/);
    expect(await runInspectionDraft({ ...host, properties: () => [] })).toMatchObject({ status: 'completed', detail: expect.stringMatching(/No properties/) });
  });
});
