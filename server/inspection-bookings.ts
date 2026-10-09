// Sherry's W5 saved plan: the latest reviewed draft, accepted bookings and
// manual moves. Private revisioned JSON (same idiom as inspection-rules.ts).
// Every draft is recomputed by the pure planner with accepted bookings and moves
// pinned, so a rerun keeps them where a person put them. Nothing here books,
// sends or calls Property Inspect: "accepted" means accepted into this draft plan.
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { draftInspectionPlan, inspectionTimesOverlap, type InspectionPlan, type InspectionProperty, type ManualChange, type PinnedAppointment } from './inspection-plan.ts';
import type { InspectionHistoryStore, HistoryProperty } from './inspection-history.ts';
import type { InspectionOfficeRules, InspectionRulesStore } from './inspection-rules.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';

type Pin = PinnedAppointment & { id: string };
type Move = Extract<ManualChange, { kind: 'move' }> & { id: string };
export interface InspectionBookingsState {
  version: 1; purpose: 'inspection-bookings'; revision: number; updatedAt: number | null;
  draft: { planStart: string; createdAt: number; plan: InspectionPlan } | null;
  accepted: Pin[]; manual: Move[];
}
/** What the planner needs besides the saved pins; the route builds it from Desk + history + rules. */
export interface PlanBase { properties: InspectionProperty[]; rules: InspectionOfficeRules }

const MAX_BYTES = 4_000_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const fail = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const validDate = (v: unknown): v is string => typeof v === 'string' && DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const pinOk = (p: unknown): p is Pin => object(p) && typeof p.id === 'string' && typeof p.propertyId === 'string' && validDate(p.date) &&
  typeof p.time === 'string' && TIME.test(p.time) && typeof p.inspector === 'string' && !!p.inspector && (p.externalId === undefined || typeof p.externalId === 'string');

export function readInspectionBookings(v: unknown): InspectionBookingsState {
  if (!object(v) || v.version !== 1 || v.purpose !== 'inspection-bookings' || !count(v.revision) || !(v.updatedAt === null || count(v.updatedAt)) ||
      !Array.isArray(v.accepted) || !v.accepted.every(pinOk) || !Array.isArray(v.manual) || !v.manual.every(m => pinOk(m) && (m as Move).kind === 'move')) throw new Error('bad');
  const d = v.draft;
  if (!(d === null || (object(d) && validDate(d.planStart) && count(d.createdAt) && object(d.plan) &&
      ['appointments', 'days', 'holds', 'notDue'].every(k => Array.isArray((d.plan as Record<string, unknown>)[k]))))) throw new Error('bad');
  return v as unknown as InspectionBookingsState;
}

export function createInspectionBookingsStore(options: { file?: string; now?: () => number } = {}) {
  const file = options.file ?? join(DATA_DIR, 'inspection-bookings.json');
  const now = options.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => {}); return next; };
  const recovery = (): never => fail('The saved inspection plan needs recovery. Its file has been kept.', 503);
  const validate = (value: unknown) => { try { return readInspectionBookings(value); } catch { return recovery(); } };
  const load = async (): Promise<InspectionBookingsState> => {
    let raw: unknown;
    try { raw = await readPrivateJson(file, MAX_BYTES); } catch { return recovery(); }
    return raw === undefined ? { version: 1, purpose: 'inspection-bookings', revision: 0, updatedAt: null, draft: null, accepted: [], manual: [] } : validate(raw);
  };
  const plan = (state: InspectionBookingsState, base: PlanBase, planStart: string) => {
    try { return draftInspectionPlan({ properties: base.properties, rules: { ...base.rules, planStart }, accepted: state.accepted, manual: state.manual }); }
    catch (error) { return fail(error instanceof Error ? error.message : 'Check the inspection rules.', 400); }
  };
  const save = async (state: InspectionBookingsState, base: PlanBase, planStart: string) => {
    const at = Math.max(0, now());
    Object.assign(state, { draft: { planStart, createdAt: at, plan: plan(state, base, planStart) }, revision: state.revision + 1, updatedAt: at });
    await writePrivateJson(file, state, { maxBytes: MAX_BYTES, validate });
    return structuredClone(state);
  };
  const current = async (expectedRevision: unknown) => {
    if (!count(expectedRevision)) fail('Reload the inspection plan before changing it.', 400);
    const state = await load();
    if (state.revision !== expectedRevision) fail('The inspection plan changed since you opened it. Reload and try again.', 409);
    if (!state.draft) fail('Draft a plan first.', 409);
    return state as InspectionBookingsState & { draft: NonNullable<InspectionBookingsState['draft']> };
  };
  return {
    read: () => serial(load),
    /** Recomputes the draft from the base with accepted bookings and moves pinned. */
    draft: (input: { planStart: unknown; base: PlanBase }) => serial(async () => {
      if (!validDate(input.planStart)) fail('Plan start must be a date like 2026-10-05.', 400);
      return save(await load(), input.base, input.planStart as string);
    }),
    /** Accepts draft appointments by their stable ids into the saved plan. */
    accept: (input: { ids: unknown; expectedRevision: unknown; base: PlanBase }) => serial(async () => {
      if (!Array.isArray(input.ids) || !input.ids.length || input.ids.length > 1000 || !input.ids.every(id => typeof id === 'string')) fail('Choose at least one appointment to accept.', 400);
      const state = await current(input.expectedRevision);
      const byId = new Map(state.draft.plan.appointments.map(a => [a.id, a]));
      for (const id of input.ids as string[]) {
        const a = byId.get(id);
        if (!a) fail('An appointment is no longer in this draft. Reload and try again.', 409);
        if (a!.status !== 'draft') continue; // already accepted or moved
        state.accepted = [...state.accepted.filter(p => p.propertyId !== a!.propertyId), { id: a!.id, propertyId: a!.propertyId, date: a!.date, time: a!.time, inspector: a!.inspector }];
      }
      return save(state, input.base, state.draft.planStart);
    }),
    /** Moves one appointment to a date and time; kept there on every rerun. */
    move: (input: { id: unknown; date: unknown; time: unknown; expectedRevision: unknown; base: PlanBase }) => serial(async () => {
      if (typeof input.id !== 'string' || !validDate(input.date) || typeof input.time !== 'string' || !TIME.test(input.time)) fail('Choose a date like 2026-10-05 and a time like 09:30.', 400);
      const state = await current(input.expectedRevision);
      const a = state.draft.plan.appointments.find(x => x.id === input.id);
      if (!a) return fail('That appointment is no longer in this draft. Reload and try again.', 409);
      const date = input.date as string, time = input.time as string, rules = input.base.rules;
      const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
      if (!rules.workingDays.includes(weekday)) fail('That day is not a working day in the inspection rules.', 400);
      if (rules.closedDates.includes(date)) fail('The office is closed that day.', 400);
      const others = state.draft.plan.appointments.filter(x => x.id !== a.id && x.date === date && x.inspector === a.inspector);
      if (others.length >= rules.dailyCapacity) fail(`${a.inspector} already has ${others.length} inspections that day; the daily limit is ${rules.dailyCapacity}. Choose another day.`, 409);
      if (others.some(x => inspectionTimesOverlap(x.time, time, rules))) fail(`${a.inspector} already has an inspection or travel allowance at ${time} that day. Choose a free time.`, 409);
      state.manual = [...state.manual.filter(m => m.propertyId !== a.propertyId), { kind: 'move', id: a.id, propertyId: a.propertyId, date, time, inspector: a.inspector, ...(a.externalId ? { externalId: a.externalId } : {}) }];
      return save(state, input.base, state.draft.planStart);
    }),
  };
}
export type InspectionBookingsStore = ReturnType<typeof createInspectionBookingsStore>;

/** Desk properties + saved history → planner input. No history means no dates, so the planner holds it. */
const planningProperties = (properties: HistoryProperty[], h: Awaited<ReturnType<InspectionHistoryStore['read']>>): InspectionProperty[] => properties.map(p => {
  const rec = h.records[p.id];
  return { id: p.id, address: p.address, area: rec?.area || 'No area set',
    ...(rec?.lastCompleted ? { lastCompleted: rec.lastCompleted } : {}), ...(rec?.lastPlanned ? { lastPlanned: rec.lastPlanned } : {}),
    ...(rec?.accessNote ? { accessNote: rec.accessNote } : {}) };
});
export async function planBase(properties: HistoryProperty[], history: InspectionHistoryStore, rules: InspectionRulesStore): Promise<PlanBase> {
  const [h, r] = await Promise.all([history.read(), rules.read()]);
  return { rules: r.rules, properties: planningProperties(properties, h) };
}

/** The monthly Inspection draft loop: refreshes the saved draft from Desk, history
 * and rules (accepted and moved visits stay pinned) and says it is ready. Books nothing. */
export async function runInspectionDraft(host: { bookings: InspectionBookingsStore; history: InspectionHistoryStore; rules: InspectionRulesStore;
  properties: () => HistoryProperty[]; today: () => Promise<string> }): Promise<{ ok: true; status: 'awaiting-approval' | 'completed'; detail: string }> {
  const properties = host.properties();
  if (!properties.length) return { ok: true, status: 'completed', detail: 'No properties to plan yet. Add properties on Desk; the next draft includes them.' };
  const [history, planStart] = await Promise.all([host.history.read(), host.today()]);
  const prepared = planningProperties(properties, history);
  const saved = await host.rules.withSnapshot(current => host.bookings.draft({ planStart, base: { properties: prepared, rules: current.rules } }));
  const { plan } = saved.draft!;
  const toAccept = plan.appointments.filter(a => a.status === 'draft').length;
  return { ok: true, status: 'awaiting-approval', detail: `New inspection draft ready to review: ${toAccept} to accept, ${plan.holds.length} held. Nothing is booked.` };
}

/** /api/inspections*. Called only behind the desktop session check. */
export function createInspectionsApi(host: { bookings: InspectionBookingsStore; history: InspectionHistoryStore; rules: InspectionRulesStore;
  properties: () => HistoryProperty[]; recovery: () => boolean; today: () => string }) {
  return async (path: string, method: string, body?: unknown): Promise<{ status: number; body: unknown } | null> => {
    const input = object(body) ? body : {};
    if (path === '/api/inspections') {
      if (method !== 'GET') return { status: 405, body: { error: 'Use GET for the inspection plan.' } };
      const [rules, history, plan] = await Promise.all([host.rules.read(), host.history.read(), host.bookings.read()]);
      return { status: 200, body: { rules, history, plan, properties: Object.fromEntries(host.properties().map(p => [p.id, p.address])) } };
    }
    const action = /^\/api\/inspections\/(history\/import|draft|accept|move)$/.exec(path)?.[1];
    if (!action) return null;
    if (method !== 'POST') return { status: 405, body: { error: 'Use POST for this inspection plan change.' } };
    if (host.recovery()) fail('Recover the private book before changing the inspection plan.', 503);
    if (action === 'history/import') return { status: 200, body: await host.history.importCsv({ csv: input.csv, properties: host.properties(), expectedRevision: input.expectedRevision }) };
    // Read unrelated inputs before the lease. No bookings operation calls rules
    // in reverse order; the lease covers its async load and durable file commit.
    const properties = host.properties(), history = await host.history.read();
    const prepared = planningProperties(properties, history), planStart = action === 'draft' ? input.planStart ?? host.today() : undefined;
    const saved = await host.rules.withSnapshot(current => {
      if (host.recovery()) return fail('Recover the private book before changing the inspection plan.', 503);
      const base: PlanBase = { properties: prepared, rules: current.rules };
      if (action === 'draft') return host.bookings.draft({ planStart, base });
      if (action === 'accept') return host.bookings.accept({ ids: input.ids, expectedRevision: input.expectedRevision, base });
      return host.bookings.move({ id: input.id, date: input.date, time: input.time, expectedRevision: input.expectedRevision, base });
    });
    return { status: 200, body: saved };
  };
}
