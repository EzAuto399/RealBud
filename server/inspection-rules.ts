// The office's routine-inspection rules (Sherry's W5) as a private revisioned
// store: 0600 JSON (temp → fsync → rename), a damaged file holds every change,
// every change carries the caller's `expectedRevision`, and the last 10 replaced
// versions are kept so a change can be undone. The plan start is chosen per
// draft, so it is not stored here. Called only behind the desktop session check.
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { checkRules, type InspectionRules } from './inspection-plan.ts';
import { readPrivateJsonWithFallback, writePrivateJson } from './private-json.ts';

export type InspectionOfficeRules = Omit<InspectionRules, 'planStart' | 'closedDates'> & { closedDates: string[] };
export interface InspectionRulesState {
  version: 1; purpose: 'inspection-rules'; revision: number; updatedAt: number | null;
  rules: InspectionOfficeRules; history: Array<{ rules: InspectionOfficeRules; replacedAt: number }>;
}

export const MAX_RULE_HISTORY = 10;
const MAX_BYTES = 200_000;
const KEYS = 'horizonMonths,cycleMonths,cycleBasis,workingDays,closedDates,inspectors,dayStart,appointmentMinutes,travelMinutes,dailyCapacity';
const fail = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Sherry confirmed a six-month cycle from the completed date (5 Oct). The other
 * values are starting points the office sets; inspectors start empty. */
export function defaultInspectionRules(): InspectionOfficeRules {
  return { horizonMonths: 6, cycleMonths: 6, cycleBasis: 'completed', workingDays: [1, 2, 3, 4, 5], closedDates: [], inspectors: [],
    dayStart: '09:00', appointmentMinutes: 30, travelMinutes: 15, dailyCapacity: 6 };
}

/** Returns clean rules or throws a plain sentence (status 400) a person can act on. */
export function validateInspectionRules(value: unknown): InspectionOfficeRules {
  if (!object(value) || !exact(value, KEYS)) return fail(`Inspection rules need exactly: ${KEYS.split(',').join(', ')}.`, 400);
  const v = value as unknown as InspectionOfficeRules;
  if (!Number.isInteger(v.horizonMonths) || v.horizonMonths > 24 || !Number.isInteger(v.cycleMonths) || v.cycleMonths > 24) fail('Plan length and inspection cycle must be whole months from 1 to 24.', 400);
  if (!Array.isArray(v.workingDays) || new Set(v.workingDays).size !== v.workingDays.length) fail('Choose each working day once (0 = Sunday to 6 = Saturday).', 400);
  if (!Array.isArray(v.closedDates) || v.closedDates.length > 366 || v.closedDates.some(d => typeof d !== 'string' || !DATE.test(d) || new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) !== d) || new Set(v.closedDates).size !== v.closedDates.length) {
    fail('Closed dates must be distinct dates like 2026-12-25, at most 366.', 400);
  }
  if (!Array.isArray(v.inspectors) || v.inspectors.length > 20 || v.inspectors.some(n => typeof n !== 'string' || !n.trim() || n.length > 80 || /[\x00-\x1f\x7f]/.test(n)) || new Set(v.inspectors.map(n => (n as string).trim())).size !== v.inspectors.length) {
    fail('List up to 20 distinct inspector names in plain text.', 400);
  }
  if (typeof v.dayStart !== 'string' || typeof v.cycleBasis !== 'string') fail('Day start must be a time like 09:00, and the cycle must follow the completed or planned date.', 400);
  // The planner's own check is the judge of a workable rule set. Inspectors may still
  // be empty while the office sets the cycle; a draft then asks for one.
  try { checkRules({ ...v, planStart: '2026-01-01', inspectors: v.inspectors.length ? v.inspectors : ['-'] }); }
  catch (error) { return fail(error instanceof Error ? error.message : 'Check the inspection rules.', 400); }
  return { horizonMonths: v.horizonMonths, cycleMonths: v.cycleMonths, cycleBasis: v.cycleBasis, workingDays: [...v.workingDays].sort(), closedDates: [...v.closedDates].sort(),
    inspectors: v.inspectors.map(n => n.trim()), dayStart: v.dayStart, appointmentMinutes: v.appointmentMinutes, travelMinutes: v.travelMinutes, dailyCapacity: v.dailyCapacity };
}

/** Throws on anything unexpected; a damaged file is kept and holds changes. */
export function readInspectionRules(v: unknown): InspectionRulesState {
  if (!object(v) || !exact(v, 'version,purpose,revision,updatedAt,rules,history') || v.version !== 1 || v.purpose !== 'inspection-rules' || !count(v.revision) ||
      !(v.updatedAt === null || count(v.updatedAt)) || !Array.isArray(v.history) || v.history.length > MAX_RULE_HISTORY) throw new Error('bad');
  const rules = validateInspectionRules(v.rules);
  const history = v.history.map(h => {
    if (!object(h) || !exact(h, 'rules,replacedAt') || !count(h.replacedAt)) throw new Error('bad');
    return { rules: validateInspectionRules(h.rules), replacedAt: h.replacedAt };
  });
  return { version: 1, purpose: 'inspection-rules', revision: v.revision, updatedAt: v.updatedAt, rules, history };
}

export function createInspectionRulesStore(options: { file?: string; now?: () => number } = {}) {
  const file = options.file ?? join(DATA_DIR, 'inspection-rules.json');
  const now = options.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => {}); return next; };
  const recovery = (): never => fail('Saved inspection rules need recovery. Their file has been kept.', 503);
  const validate = (value: unknown) => { try { return readInspectionRules(value); } catch { return recovery(); } };
  const load = async (): Promise<InspectionRulesState> => {
    let raw: unknown;
    try { raw = await readPrivateJsonWithFallback(file, MAX_BYTES, validate); } catch { return recovery(); }
    return raw === undefined ? { version: 1, purpose: 'inspection-rules', revision: 0, updatedAt: null, rules: defaultInspectionRules(), history: [] } : validate(raw);
  };
  return {
    read: () => serial(load),
    /** A local plan commit holds its current rules through the entire file write.
     * Queue order is rules → bookings. Never call another rules action or wait
     * for history, date/provider reads inside this lease. */
    withSnapshot<T>(work: (state: InspectionRulesState) => Promise<T>): Promise<T> {
      return serial(async () => work(await load()));
    },
    /** Replaces the rules; the replaced version goes to the front of `history`. */
    save: (input: { rules: unknown; expectedRevision: unknown }) => serial(async () => {
      const rules = validateInspectionRules(input.rules);
      if (!count(input.expectedRevision)) fail('Reload inspection rules before changing them.', 400);
      const state = await load();
      if (state.revision !== input.expectedRevision) fail('Inspection rules changed since you opened them. Reload and try again.', 409);
      if (JSON.stringify(rules) === JSON.stringify(state.rules)) return structuredClone(state);
      const at = Math.max(0, now());
      state.history = [{ rules: state.rules, replacedAt: at }, ...state.history].slice(0, MAX_RULE_HISTORY);
      Object.assign(state, { rules, revision: state.revision + 1, updatedAt: at });
      await writePrivateJson(file, state, { maxBytes: MAX_BYTES, validate, keepPrevious: true });
      return structuredClone(state);
    }),
  };
}
export type InspectionRulesStore = ReturnType<typeof createInspectionRulesStore>;

/** GET/PUT /api/inspection-rules. Called only behind the desktop session check. */
export function createInspectionRulesApi(host: { store: InspectionRulesStore; recovery: () => boolean }) {
  return async (path: string, method: string, body?: unknown): Promise<{ status: number; body: unknown } | null> => {
    if (path !== '/api/inspection-rules') return null;
    if (method === 'GET') return { status: 200, body: await host.store.read() };
    if (method !== 'PUT') return { status: 405, body: { error: 'Use GET or PUT for inspection rules.' } };
    if (host.recovery()) fail('Recover the private book before changing inspection rules.', 503);
    const input = object(body) ? body : {};
    return { status: 200, body: await host.store.save({ rules: input.rules, expectedRevision: input.expectedRevision }) };
  };
}
