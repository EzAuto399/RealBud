// The Austin pack's schedule: a versioned pack file declaring six catalog loops
// with their Brisbane schedules, plain plan text, required connections and the
// office's confirmed rules. The same door applies a customer pack's
// office/settings.json loops when that pack is imported (applyPackLoops), so a
// role pack sets its own workflows. Applying never switches a loop on and never
// overwrites an office edit: a loop whose time, days or cadence differ from the
// pack keeps them; a loop that matches only gets the office timezone. The
// maintenance month rule is set only while the office has never changed it.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUSTIN_CHECKLIST_IDS, AUSTIN_LOOP_IDS as LOOP_IDS, type AustinChecklistId, type AustinChecklistItem, type AustinPackLoop, type AustinPackView } from '../shared/austin-pack.ts';
import type { Loop, LoopId, LoopSchedule } from '../shared/contracts.ts';
import { validCalendarCadence, type CalendarCadence } from '../shared/routine-clock.ts';
import { DATA_DIR } from './config.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';
import { containsCredential } from './redact.ts';
import { parseClockTime, parseWeekdays } from './routines.ts';

const PACK_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'pack', 'workflows', 'austin-office', 'austin-schedule-v1.json');
const MAX_BYTES = 500_000;
type Schedule = { time: string; weekdays: number[] } & CalendarCadence;
export interface AustinLoopPack {
  format: 'realbud-loop-pack'; version: 1; id: string; revision: number; title: string; timeZone: string;
  connections: Array<{ id: string; name: string; how: string }>;
  rules: [{ id: 'maintenance-month'; text: string; setting: { basis: string; span: string } }, { id: 'inspection-cycle'; text: string; setting: { cycleMonths: number; cycleBasis: string } }];
  loops: Array<AustinPackLoop & { schedule: Schedule }>;
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string[], optional: string[] = []) => Object.keys(v).every(k => keys.includes(k) || optional.includes(k)) && keys.every(k => k in v);
const text = (v: unknown, max = 400) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
function bad(why: string): never { throw new Error(`The Auston pack file is not valid: ${why}.`); }

/** Rejects anything outside the fixed envelope, credentials and machine paths. */
export function validateAustinPack(raw: unknown): AustinLoopPack {
  const serialized = JSON.stringify(raw ?? null);
  if (serialized.length > MAX_BYTES || containsCredential(serialized) || /\/Users\/|[A-Za-z]:\\\\/.test(serialized)) bad('credentials, paths or size');
  if (!object(raw) || !exact(raw, ['format', 'version', 'id', 'revision', 'title', 'timeZone', 'connections', 'rules', 'loops']) || raw.format !== 'realbud-loop-pack' || raw.version !== 1 ||
      raw.id !== 'austin-office-schedule' || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1 || !text(raw.title, 100) || typeof raw.timeZone !== 'string') bad('envelope');
  try { new Intl.DateTimeFormat('en', { timeZone: raw.timeZone as string }).format(0); } catch { bad('timezone'); }
  if (!Array.isArray(raw.connections) || !raw.connections.every(c => object(c) && exact(c, ['id', 'name', 'how']) && text(c.id, 40) && text(c.name, 80) && text(c.how))) bad('connections');
  const rules = raw.rules as unknown[];
  if (!Array.isArray(rules) || rules.length !== 2 || !rules.every(r => object(r) && exact(r, ['id', 'text', 'setting']) && text(r.text) && object(r.setting))) bad('rules');
  const [month, cycle] = rules as Array<Record<string, Record<string, unknown>>>;
  if (month.id as unknown !== 'maintenance-month' || !['invoiceDate', 'receivedDate'].includes(String(month.setting.basis)) || !['calendarMonth', 'rolling30'].includes(String(month.setting.span)) ||
      cycle.id as unknown !== 'inspection-cycle' || !Number.isSafeInteger(cycle.setting.cycleMonths) || !['completed', 'planned'].includes(String(cycle.setting.cycleBasis))) bad('rules');
  if (!Array.isArray(raw.loops) || raw.loops.length !== LOOP_IDS.length) bad('loops');
  const seen = new Set<string>();
  for (const loop of raw.loops as unknown[]) {
    if (!object(loop) || !exact(loop, ['loopId', 'owner', 'schedule', 'plan', 'needs'], ['note']) || !(LOOP_IDS as readonly string[]).includes(String(loop.loopId)) || seen.has(String(loop.loopId)) ||
        !text(loop.owner, 60) || (loop.note !== undefined && !text(loop.note))) bad('loops');
    seen.add(String(loop.loopId));
    const s = loop.schedule, p = loop.plan;
    if (!object(s) || !exact(s, ['time', 'weekdays'], ['intervalDays', 'anchorDate', 'monthly']) || !parseClockTime(s.time) || !parseWeekdays(s.weekdays) || !validCalendarCadence(s as CalendarCadence)) bad(`${String(loop.loopId)} schedule`);
    if (!object(p) || !exact(p, ['reads', 'waitsFor', 'notifies', 'approval']) || ![p.reads, p.waitsFor, p.notifies, p.approval].every(v => text(v))) bad(`${String(loop.loopId)} plan`);
    if (!Array.isArray(loop.needs) || !loop.needs.every(n => (AUSTIN_CHECKLIST_IDS as readonly string[]).includes(String(n)))) bad(`${String(loop.loopId)} needs`);
  }
  return structuredClone(raw) as unknown as AustinLoopPack;
}

export function loadAustinPack(): AustinLoopPack { return validateAustinPack(JSON.parse(readFileSync(PACK_FILE, 'utf8'))); }

const sameClock = (a: Schedule, b: Schedule) => a.time === b.time && [...a.weekdays].sort().join() === [...b.weekdays].sort().join() &&
  a.intervalDays === b.intervalDays && a.anchorDate === b.anchorDate && a.monthly === b.monthly;

export interface AustinSignals { gmail: boolean; redbark: boolean; tenants: number; suppliers: number }
/** Pure: the setup checklist from what this PC can see. "REI signed in once" is a
 * recorded REI sign-in, or a tenant list that only a signed-in REI read can save.
 * Only the items the pack's workflows need are listed. */
export function austinChecklist(pack: AustinLoopPack, loops: readonly Loop[], signals: AustinSignals & { reiSignedIn: boolean }): AustinChecklistItem[] {
  const off = pack.loops.filter(item => !loops.find(loop => loop.id === item.loopId)?.enabled);
  const item = (id: AustinChecklistId, label: string, done: boolean, yes: string, no: string): AustinChecklistItem => ({ id, label, done, detail: done ? yes : no });
  const needed = new Set<AustinChecklistId>(['workflows', ...pack.loops.flatMap(loop => loop.needs)]);
  return ([
    item('gmail', 'Gmail connected', signals.gmail, 'The office Gmail is connected.', 'Connect the office Gmail in Connected apps.'),
    item('redbark', 'Redbark bank link connected', signals.redbark, 'Bud can read the ANZ rows from Redbark.', 'Connect Redbark in Connected apps, or add the ANZ CSV in the bank review each time.'),
    item('rei', 'Signed in to REI Cloud once', signals.reiSignedIn || signals.tenants > 0, 'REI Cloud has been signed in on this PC.', 'In Bank reference review, choose Refresh from REI and sign in on REI’s own page. Bud never sees your password.'),
    item('tenants', 'REI tenant list saved', signals.tenants > 0, `${signals.tenants} tenants saved.`, 'In Bank reference review, choose Refresh from REI to save the tenant list.'),
    item('suppliers', 'REI supplier list saved', signals.suppliers > 0, `${signals.suppliers} suppliers saved.`, 'In Bills, Maintenance checks, choose Refresh from REI to save the supplier list.'),
    { ...item('workflows', 'Each workflow reviewed and switched on', off.length === 0, `All ${pack.loops.length} workflows are on.`,
      `${pack.loops.length - off.length} of ${pack.loops.length} on. Open each one, read what it does, then switch it on.`), ...(off[0] ? { next: off[0].loopId } : {}) },
  ] satisfies AustinChecklistItem[]).filter(entry => needed.has(entry.id));
}

/** `loopIds`: the workflows a role pack set on this PC; absent means all six (the whole-office install). */
interface PackState { version: 1; purpose: 'austin-pack'; installed: { revision: number; at: number; loopIds?: string[] } | null; reiSignedInAt: number | null }
const readState = (v: unknown): PackState => {
  if (v === undefined) return { version: 1, purpose: 'austin-pack', installed: null, reiSignedInAt: null };
  if (!object(v) || v.version !== 1 || v.purpose !== 'austin-pack' || !(v.reiSignedInAt === null || Number.isSafeInteger(v.reiSignedInAt)) ||
      !(v.installed === null || (object(v.installed) && Number.isSafeInteger(v.installed.revision) && Number.isSafeInteger(v.installed.at) &&
        (v.installed.loopIds === undefined || (Array.isArray(v.installed.loopIds) && v.installed.loopIds.every(id => (LOOP_IDS as readonly unknown[]).includes(id))))))) {
    throw Object.assign(new Error('The saved Auston pack state needs recovery. Its file has been kept.'), { status: 503 });
  }
  return v as unknown as PackState;
};

export interface AustinPackDeps {
  loops: { listLoops(): Loop[]; patchClock(id: LoopId, patch: { timezone: string }): Loop };
  officeTimeZone: () => Promise<string | null>;
  maintenance: { read(): Promise<{ rule: { basis: string; span: string }; ruleRevision?: number }>; setRule(input: { rule: unknown; expectedRevision: unknown }): Promise<unknown> };
  inspection: { read(): Promise<{ rules: { cycleMonths: number; cycleBasis: string } }> };
  signals: () => Promise<AustinSignals>;
  file?: string; now?: () => number; pack?: () => AustinLoopPack;
}
export type AustinInstallResult = { loopId: string; outcome: 'applied' | 'kept' };

export function createAustinPack(deps: AustinPackDeps) {
  const file = deps.file ?? join(DATA_DIR, 'austin-pack.json'), now = deps.now ?? Date.now, pack = deps.pack ?? loadAustinPack;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => {}); return next; };
  const load = async () => readState(await readPrivateJson(file, 10_000));
  const zone = async (p: AustinLoopPack) => { const office = await deps.officeTimeZone(); return { timeZone: office || p.timeZone, timeZoneFromOffice: Boolean(office) }; };

  /** One door for pack loops. A loop whose clock differs from the pack keeps the
   * office's clock; a matching one gets the office timezone, else the pack's. */
  async function applyLoops(items: Array<{ loopId: string; schedule: Schedule; timezone?: string }>): Promise<AustinInstallResult[]> {
    const office = await deps.officeTimeZone(), results: AustinInstallResult[] = [];
    for (const item of items) {
      const loop = deps.loops.listLoops().find(candidate => candidate.id === item.loopId);
      // ponytail: "edited" means differs from this pack revision; a later revision that changes a time also keeps the older pack time.
      if (!loop || !sameClock(loop.schedule, item.schedule)) { results.push({ loopId: item.loopId, outcome: 'kept' }); continue; }
      const timezone = office || item.timezone;
      if (timezone && loop.schedule.timezone !== timezone) deps.loops.patchClock(item.loopId as LoopId, { timezone });
      results.push({ loopId: item.loopId, outcome: 'applied' });
    }
    // The confirmed month rule, only while the office has never chosen one.
    const maintenance = items.some(item => item.loopId === 'maintenance-review') ? await deps.maintenance.read() : null, month = pack().rules[0].setting;
    if (maintenance && (maintenance.ruleRevision ?? 0) === 0 && (maintenance.rule.basis !== month.basis || maintenance.rule.span !== month.span)) {
      await deps.maintenance.setRule({ rule: month, expectedRevision: 0 });
    }
    return results;
  }

  async function view(): Promise<AustinPackView> {
    const full = pack(), state = await load(), loops = deps.loops.listLoops();
    const scope = state.installed?.loopIds, p = scope ? { ...full, loops: full.loops.filter(item => scope.includes(item.loopId)) } : full;
    const [maintenance, inspection, signals] = await Promise.all([deps.maintenance.read(), deps.inspection.read(), deps.signals()]);
    const [month, cycle] = p.rules;
    return {
      pack: { id: p.id, revision: p.revision, title: p.title }, ...await zone(p), installed: state.installed,
      loops: p.loops.map(({ schedule: _schedule, ...item }) => item),
      rules: [
        { id: month.id, text: month.text, matches: maintenance.rule.basis === month.setting.basis && maintenance.rule.span === month.setting.span },
        { id: cycle.id, text: cycle.text, matches: inspection.rules.cycleMonths === cycle.setting.cycleMonths && inspection.rules.cycleBasis === cycle.setting.cycleBasis },
      ],
      checklist: austinChecklist(p, loops, { ...signals, reiSignedIn: state.reiSignedInAt !== null }),
    };
  }

  return {
    view: () => serial(view),
    /** Applies the pack as reviewable proposals: every loop stays as on or off as it was. */
    install: () => serial(async (): Promise<AustinPackView & { results: AustinInstallResult[] }> => {
      const p = pack(), state = await load();
      const results = await applyLoops(p.loops.map(item => ({ loopId: item.loopId, schedule: item.schedule, timezone: p.timeZone })));
      await writePrivateJson(file, { ...state, installed: { revision: p.revision, at: Math.max(0, now()) } });
      return { ...await view(), results };
    }),
    /** A customer pack's office/settings.json loops, applied when the pack is
     * installed. The Austin workflows among them are recorded, so this PC's
     * checklist lists only the workflows its role packs set. */
    applyPackLoops: (loops: ReadonlyArray<{ id: string; schedule: LoopSchedule }>) => serial(async (): Promise<AustinInstallResult[]> => {
      const state = await load();
      const results = await applyLoops(loops.map(({ id, schedule }) => ({ loopId: id, schedule, timezone: schedule.timezone })));
      const added = loops.map(loop => loop.id).filter(id => (LOOP_IDS as readonly string[]).includes(id));
      if (added.length) {
        const before = state.installed ? state.installed.loopIds ?? [...LOOP_IDS] : [];
        await writePrivateJson(file, { ...state, installed: { revision: pack().revision, at: Math.max(0, now()), loopIds: LOOP_IDS.filter(id => before.includes(id) || added.includes(id)) } });
      }
      return results;
    }),
    /** A REI Cloud sign-in finished in the work browser (any handover: W1, supplier check, Ask). */
    noteReiSignedIn: () => serial(async () => {
      const state = await load();
      if (state.reiSignedInAt === null) await writePrivateJson(file, { ...state, reiSignedInAt: Math.max(0, now()) });
    }),
  };
}
