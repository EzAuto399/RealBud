// Kevin's rate and levy reference numbers per property, imported from the REI
// property list CSV, as a private revisioned store (same idiom as
// inspection-rules.ts): 0600 JSON, a damaged file holds every change, every
// import carries `expectedRevision`. A number only proposes a property for a bill
// review; it never decides one, and an address is never guessed from similarity.
// REI period/status is kept as an unconfirmed observation, never paid status.
// Called only behind the desktop session check.
import { join } from 'node:path';
import type { BillReferenceKind, PropertyBillReference, PropertyBillReferenceDirectory, PropertyBillReferenceEntry, PropertyBillReferenceHeld,
  PropertyBillReferenceMatch, PropertyBillReferenceRejected, PropertyBillReferenceShared, PropertyBillPatternSuggestion, PropertyBillReferenceView } from '../shared/source-bills.ts';
import { DATA_DIR } from './config.ts';
import { normalizeAddress, parseCsvTable } from './csv-ledger.ts';
import { readPrivateJsonWithFallback, writePrivateJson } from './private-json.ts';

const MAX_BYTES = 2_000_000, MAX_CSV = 1_000_000, MAX_ROWS = 2_000, MIN_MATCH_DIGITS = 6;
const KINDS: BillReferenceKind[] = ['council', 'water', 'levy'];
const KIND_LABEL: Record<BillReferenceKind, string> = { council: 'council rate number', water: 'water rate number', levy: 'levy reference' };
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const fail = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const clean = (v: string, max: number) => v.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const header = (h: string) => h.toLowerCase().replace(/[^a-z]/g, '');

export interface DirectoryProperty { id: string; address: string; propertyCode?: string }

/** Splits one cell into accepted refs and rejected parts with plain reasons. */
export function readReferenceCell(cell: string, kind: BillReferenceKind): { refs: PropertyBillReference[]; rejected: { raw: string; reason: string }[] } {
  const refs: PropertyBillReference[] = [], rejected: { raw: string; reason: string }[] = [];
  for (const part of cell.split(/\s*\|\s*|\s+l\s+/)) {
    const raw = clean(part, 80), digits = raw.replace(/\s+/g, '');
    if (!raw) continue;
    if (/^(nil|n\/?a|none)\.?$/i.test(raw)) rejected.push({ raw, reason: 'Marked NIL, so there is no number to match.' });
    else if (!/^\d+$/.test(digits)) rejected.push({ raw, reason: 'Has letters or symbols. Copy the number from a bill.' });
    // Spreadsheets keep 15 significant digits and turn the rest into zeros.
    else if (digits.length > 15 && /000$/.test(digits)) rejected.push({ raw, reason: 'Looks cut off by the spreadsheet (ends in zeros). Copy the number from a bill.' });
    else if (!refs.some(r => r.digits === digits)) refs.push({ kind, digits, raw });
  }
  return { refs, rejected };
}

/** "2026 JUL" / "2026JAN" → "2026-07"; anything else → null. */
export function readReiPeriod(cell: string): string | null {
  const m = clean(cell, 40).toUpperCase().match(/^(\d{4})\s*([A-Z]{3})/);
  const month = m ? MONTHS.indexOf(m[2]!) : -1;
  return m && month >= 0 ? `${m[1]}-${String(month + 1).padStart(2, '0')}` : null;
}
const monthLabel = (period: string) => `${MONTHS[Number(period.slice(5)) - 1]![0]}${MONTHS[Number(period.slice(5)) - 1]!.slice(1).toLowerCase()} ${period.slice(0, 4)}`;
const addMonths = (period: string, n: number) => { const t = Number(period.slice(0, 4)) * 12 + Number(period.slice(5)) - 1 + n; return `${Math.floor(t / 12)}-${String(t % 12 + 1).padStart(2, '0')}`; };

function matchProperty(properties: DirectoryProperty[], code: string, street: string): { id?: string; reason?: string } {
  const want = code.toLowerCase();
  let hits = want ? properties.filter(p => p.propertyCode?.toLowerCase() === want) : [];
  if (!hits.length && street) {
    const s = normalizeAddress(street);
    hits = properties.filter(p => normalizeAddress(p.address) === s || normalizeAddress(p.address.split(',')[0] ?? '') === s);
  }
  if (hits.length === 1) return { id: hits[0]!.id };
  return { reason: hits.length ? 'Matches more than one Desk property. Add its code on Desk.' : 'No Desk property with this code or street. Add it on Desk, then import again.' };
}

/** Parses the REI property list (header spelling tolerated) against current Desk properties. */
export function importPropertyReferences(csv: string, properties: DirectoryProperty[]): Pick<PropertyBillReferenceDirectory, 'entries' | 'held' | 'rejected'> {
  if (typeof csv !== 'string' || !csv.trim() || csv.length > MAX_CSV) return fail('Choose the property list CSV (up to 1 MB).', 400);
  let table: string[][];
  try { table = parseCsvTable(csv); } catch { return fail('That CSV has an unclosed quote. Save it again from the spreadsheet.', 400); }
  const [head = [], ...rows] = table;
  if (rows.length > MAX_ROWS) fail(`The property list can have up to ${MAX_ROWS} rows.`, 400);
  const col = (...names: string[]) => head.findIndex(h => names.includes(header(h)));
  const at = { code: col('code', 'propertycode'), street: col('street', 'address'), period: col('lastofperiod', 'period'), status: col('lastofstatus', 'status'),
    council: col('councilratenumber', 'councilrate', 'council'), water: col('waterratenumber', 'waterrate', 'water'), levy: col('referencenumber', 'levyreference', 'levy') };
  if (at.code < 0 && at.street < 0) fail('The CSV needs a CODE or Street column.', 400);
  if (at.council < 0 && at.water < 0 && at.levy < 0) fail('The CSV needs a Council Rate Number, Water Rate number or Reference Number column.', 400);
  const get = (row: string[], i: number) => i >= 0 ? row[i] ?? '' : '';
  const entries: PropertyBillReferenceEntry[] = [], held: PropertyBillReferenceHeld[] = [], rejected: PropertyBillReferenceRejected[] = [];
  for (const row of rows) {
    const code = clean(get(row, at.code), 40), street = clean(get(row, at.street), 160);
    if (!code && !street) continue;
    const refs: PropertyBillReference[] = [];
    for (const kind of KINDS) {
      const read = readReferenceCell(get(row, at[kind]), kind);
      refs.push(...read.refs); rejected.push(...read.rejected.map(r => ({ code: code || street, kind, ...r })));
    }
    const period = readReiPeriod(get(row, at.period)), status = clean(get(row, at.status), 40) || null;
    const match = matchProperty(properties, code, street);
    if (!match.id) { held.push({ code, street, reason: match.reason!, refs: refs.length }); continue; }
    if (entries.some(e => e.propertyId === match.id)) { held.push({ code, street, reason: 'Another row already matched this Desk property.', refs: refs.length }); continue; }
    entries.push({ propertyId: match.id, code, refs, rei: period || status ? { period, status } : null });
  }
  return { entries, held, rejected };
}

/** Same kind and number on more than one property: a person confirms which. */
export function sharedReferences(entries: PropertyBillReferenceEntry[]): PropertyBillReferenceShared[] {
  const by = new Map<string, PropertyBillReferenceEntry[]>();
  for (const e of entries) for (const r of e.refs) by.set(`${r.kind}:${r.digits}`, [...(by.get(`${r.kind}:${r.digits}`) ?? []), e]);
  return [...by].filter(([, list]) => list.length > 1).map(([key, list]) => {
    const names = list.map(e => e.code || e.propertyId);
    return { kind: key.split(':')[0] as BillReferenceKind, digits: key.split(':')[1]!, propertyIds: list.map(e => e.propertyId),
      message: `Shared by ${names.slice(0, -1).join(', ')} and ${names.at(-1)} — confirm` };
  });
}

/** Quarterly suggestion per property and kind from REI's last period; next
 * around the first quarter on or after `today` (YYYY-MM-DD). */
export function suggestPatterns(entries: PropertyBillReferenceEntry[], today: string): PropertyBillPatternSuggestion[] {
  const month = today.slice(0, 7);
  return entries.flatMap(e => {
    const last = e.rei?.period;
    if (!last) return [];
    let next = addMonths(last, 3);
    while (next < month) next = addMonths(next, 3);
    return [...new Set(e.refs.map(r => r.kind))].map(kind => ({ propertyId: e.propertyId, kind, intervalMonths: 3 as const, lastPeriod: last, nextAround: next,
      message: `Suggested from REI: quarterly, next around ${monthLabel(next)}` }));
  });
}

/** Whole-number equality first (spaces and hyphens between digits joined);
 * a number inside a longer run counts only with 9+ digits and one owner.
 * More than one property → ambiguous, so the review is held. */
export function matchBillReference(entries: PropertyBillReferenceEntry[], text: string): PropertyBillReferenceMatch {
  const plain = text.match(/\d+/g) ?? [], joined = (text.match(/\d(?:[ -]?\d)*/g) ?? []).map(run => run.replace(/\D/g, ''));
  const tokens = new Set([...plain, ...joined]);
  const refs = entries.flatMap(e => e.refs.filter(r => r.digits.length >= MIN_MATCH_DIGITS).map(r => ({ e, r })));
  const pick = (hits: typeof refs, how: 'whole' | 'within'): PropertyBillReferenceMatch | null => {
    const owners = [...new Set(hits.map(h => h.e.propertyId))];
    if (!owners.length) return null;
    if (owners.length > 1) return { state: 'ambiguous', propertyIds: owners, evidence: `The ${KIND_LABEL[hits[0]!.r.kind]} ${hits[0]!.r.raw} belongs to more than one property. Choose the property.` };
    const { e, r } = hits[0]!;
    return { state: 'matched', propertyId: e.propertyId, kind: r.kind, digits: r.digits, how,
      evidence: `Matched by ${KIND_LABEL[r.kind]} ${r.raw}${how === 'within' ? ' (found inside a longer number)' : ''}`, rei: e.rei };
  };
  return pick(refs.filter(h => tokens.has(h.r.digits)), 'whole') ??
    pick(refs.filter(h => h.r.digits.length >= 9 && [...tokens].some(t => t.length > h.r.digits.length && t.includes(h.r.digits))), 'within') ?? { state: 'none' };
}

function validRef(v: unknown): PropertyBillReference {
  if (!object(v) || Object.keys(v).sort().join() !== 'digits,kind,raw' || !KINDS.includes(v.kind as BillReferenceKind) || typeof v.digits !== 'string' || !/^\d{1,40}$/.test(v.digits) || typeof v.raw !== 'string' || v.raw.length > 80) throw new Error('bad');
  return { kind: v.kind as BillReferenceKind, digits: v.digits, raw: v.raw };
}
const str = (v: unknown, max: number) => { if (typeof v !== 'string' || v.length > max) throw new Error('bad'); return v; };
const nstr = (v: unknown, max: number) => v === null ? null : str(v, max);

/** Throws on anything unexpected; a damaged file is kept and holds changes. */
export function readPropertyReferenceDirectory(v: unknown): PropertyBillReferenceDirectory {
  if (!object(v) || Object.keys(v).sort().join() !== 'entries,held,purpose,rejected,revision,updatedAt,version' || v.version !== 1 || v.purpose !== 'property-bill-references' ||
      !count(v.revision) || !(v.updatedAt === null || count(v.updatedAt)) || !Array.isArray(v.entries) || !Array.isArray(v.held) || !Array.isArray(v.rejected)) throw new Error('bad');
  const entries = v.entries.map(e => {
    if (!object(e) || !Array.isArray(e.refs) || !(e.rei === null || object(e.rei))) throw new Error('bad');
    const rei = e.rei === null ? null : { period: nstr((e.rei as Record<string, unknown>).period, 7), status: nstr((e.rei as Record<string, unknown>).status, 40) };
    return { propertyId: str(e.propertyId, 200), code: str(e.code, 40), refs: e.refs.map(validRef), rei };
  });
  if (new Set(entries.map(e => e.propertyId)).size !== entries.length) throw new Error('bad');
  const held = v.held.map(h => { if (!object(h) || !count(h.refs)) throw new Error('bad'); return { code: str(h.code, 40), street: str(h.street, 160), reason: str(h.reason, 200), refs: h.refs }; });
  const rejected = v.rejected.map(r => { if (!object(r) || !KINDS.includes(r.kind as BillReferenceKind)) throw new Error('bad');
    return { code: str(r.code, 160), kind: r.kind as BillReferenceKind, raw: str(r.raw, 80), reason: str(r.reason, 200) }; });
  return { version: 1, purpose: 'property-bill-references', revision: v.revision, updatedAt: v.updatedAt, entries, held, rejected };
}

export function viewPropertyReferences(state: PropertyBillReferenceDirectory, today: string): PropertyBillReferenceView {
  const shared = sharedReferences(state.entries), refs = { council: 0, water: 0, levy: 0 };
  for (const e of state.entries) for (const r of e.refs) refs[r.kind]++;
  return { ...state, shared, suggestions: suggestPatterns(state.entries, today),
    counts: { properties: state.entries.length, refs, rejected: state.rejected.length, held: state.held.length, shared: shared.length } };
}

export function createPropertyReferenceStore(options: { file?: string; now?: () => number } = {}) {
  const file = options.file ?? join(DATA_DIR, 'property-bill-references.json');
  const now = options.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => {}); return next; };
  const recovery = (): never => fail('Saved rate numbers need recovery. Their file has been kept.', 503);
  const validate = (value: unknown) => { try { return readPropertyReferenceDirectory(value); } catch { return recovery(); } };
  const load = async (): Promise<PropertyBillReferenceDirectory> => {
    let raw: unknown;
    try { raw = await readPrivateJsonWithFallback(file, MAX_BYTES, validate); } catch { return recovery(); }
    return raw === undefined ? { version: 1, purpose: 'property-bill-references', revision: 0, updatedAt: null, entries: [], held: [], rejected: [] } : validate(raw);
  };
  return {
    read: () => serial(load),
    /** Replaces the whole directory from one CSV; the file keeps the previous copy. */
    importCsv: (input: { csv: unknown; expectedRevision: unknown; properties: DirectoryProperty[] }) => serial(async () => {
      if (!count(input.expectedRevision)) fail('Reload rate numbers before importing.', 400);
      const parsed = importPropertyReferences(input.csv as string, input.properties);
      const state = await load();
      if (state.revision !== input.expectedRevision) fail('Rate numbers changed since you opened them. Reload and try again.', 409);
      const next: PropertyBillReferenceDirectory = { ...state, ...parsed, revision: state.revision + 1, updatedAt: Math.max(0, now()) };
      await writePrivateJson(file, next, { maxBytes: MAX_BYTES, validate, keepPrevious: true });
      return next;
    }),
  };
}
export type PropertyReferenceStore = ReturnType<typeof createPropertyReferenceStore>;

/** GET/PUT /api/bill-references, POST /api/bill-references/match. Called only behind the desktop session check. */
export function createPropertyReferenceApi(host: { store: PropertyReferenceStore; properties: () => DirectoryProperty[]; recovery: () => boolean; today?: () => string }) {
  const today = host.today ?? (() => new Date().toLocaleDateString('en-CA'));
  return async (path: string, method: string, body?: unknown): Promise<{ status: number; body: unknown } | null> => {
    const input = object(body) ? body : {};
    if (path === '/api/bill-references/match') {
      if (method !== 'POST') return { status: 405, body: { error: 'Use POST to match a bill reference.' } };
      if (typeof input.text !== 'string' || input.text.length > 400_000) fail('Send the bill text to match (up to 400,000 characters).', 400);
      return { status: 200, body: matchBillReference((await host.store.read()).entries, input.text as string) };
    }
    if (path !== '/api/bill-references') return null;
    if (method === 'GET') return { status: 200, body: viewPropertyReferences(await host.store.read(), today()) };
    if (method !== 'PUT') return { status: 405, body: { error: 'Use GET or PUT for rate numbers.' } };
    if (host.recovery()) fail('Recover the private book before importing rate numbers.', 503);
    const saved = await host.store.importCsv({ csv: input.csv, expectedRevision: input.expectedRevision, properties: host.properties() });
    return { status: 200, body: viewPropertyReferences(saved, today()) };
  };
}
