// Per-property inspection history for Sherry's W5 plan: area group, last
// completed/planned dates and access notes. Private revisioned JSON (same idiom
// as inspection-rules.ts). A CSV import matches rows to Desk properties by id or
// exact address only; anything else is held for a person, never guessed.
import { join } from 'node:path';
import { DATA_DIR } from './config.ts';
import { parseCsvTable } from './csv-ledger.ts';
import { readPrivateJson, writePrivateJson } from './private-json.ts';

export interface InspectionHistoryRecord { area: string; lastCompleted: string | null; lastPlanned: string | null; accessNote: string }
export interface UnmatchedHistoryRow { row: number; property: string; area: string; lastCompleted: string; lastPlanned: string; accessNote: string; reason: string }
export interface InspectionHistoryState {
  version: 1; purpose: 'inspection-history'; revision: number; updatedAt: number | null;
  records: Record<string, InspectionHistoryRecord>; unmatched: UnmatchedHistoryRow[];
  lastImport: { at: number; matched: number; unmatched: number } | null;
}
export interface HistoryProperty { id: string; address: string }

const MAX_BYTES = 4_000_000;
const MAX_ROWS = 5_000;
const fail = (message: string, status: number): never => { throw Object.assign(new Error(message), { status }); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\x00-\x08\x0b-\x1f\x7f]/.test(v);
const validIso = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const isoOrNull = (v: unknown): v is string | null => v === null || (typeof v === 'string' && validIso(v));
const key = (v: string) => v.trim().replace(/\s+/g, ' ').toLowerCase();

/** Reads YYYY-MM-DD or Australian D/M/YYYY. Blank → null; unreadable → undefined. */
export function readHistoryDate(value: string): string | null | undefined {
  const v = value.trim();
  if (!v) return null;
  if (validIso(v)) return v;
  const au = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v);
  if (!au) return undefined;
  const iso = `${au[3]}-${au[2]!.padStart(2, '0')}-${au[1]!.padStart(2, '0')}`;
  return validIso(iso) ? iso : undefined;
}

const ALIASES = {
  property: ['property', 'propertyid', 'id', 'address', 'propertyaddress', 'propertyaddressorid'],
  area: ['area', 'areagroup', 'group', 'suburb'],
  lastCompleted: ['lastcompleted', 'lastcompleteddate', 'completed', 'lastinspected', 'lastinspection'],
  lastPlanned: ['lastplanned', 'lastplanneddate', 'planned'],
  accessNote: ['accessnotes', 'accessnote', 'access', 'notes'],
} as const;

/** Pure: parse the CSV and match each row to one Desk property by id or exact address. */
export function matchHistoryCsv(csv: string, properties: HistoryProperty[]) {
  const table = parseCsvTable(csv);
  if (table.length < 2) fail('The inspection history file has no rows under its header.', 400);
  if (table.length - 1 > MAX_ROWS) fail(`Import at most ${MAX_ROWS} inspection history rows at a time.`, 400);
  const headers = table[0]!.map(h => h.toLowerCase().replace(/[^a-z]/g, ''));
  const col = (names: readonly string[]) => headers.findIndex(h => names.includes(h));
  const at = { property: col(ALIASES.property), area: col(ALIASES.area), lastCompleted: col(ALIASES.lastCompleted), lastPlanned: col(ALIASES.lastPlanned), accessNote: col(ALIASES.accessNote) };
  if (at.property < 0 || at.area < 0 || (at.lastCompleted < 0 && at.lastPlanned < 0)) {
    fail('The file needs columns for property (address or id), area and last completed or last planned date.', 400);
  }
  const byId = new Map(properties.map(p => [p.id, p]));
  const byAddress = new Map<string, HistoryProperty[]>();
  for (const p of properties) byAddress.set(key(p.address), [...(byAddress.get(key(p.address)) ?? []), p]);
  const records: Record<string, InspectionHistoryRecord> = {};
  const unmatched: UnmatchedHistoryRow[] = [];
  table.slice(1).forEach((cells, index) => {
    const cell = (i: number) => (i >= 0 ? cells[i] ?? '' : '').trim().slice(0, 500);
    const raw = { row: index + 2, property: cell(at.property), area: cell(at.area), lastCompleted: cell(at.lastCompleted), lastPlanned: cell(at.lastPlanned), accessNote: cell(at.accessNote) };
    const hold = (reason: string) => { unmatched.push({ ...raw, reason }); };
    const addressMatches = byAddress.get(key(raw.property)) ?? [];
    const property = byId.get(raw.property) ?? (addressMatches.length === 1 ? addressMatches[0] : undefined);
    if (!raw.property) return hold('No property address or id.');
    if (!property) return hold(addressMatches.length > 1 ? 'More than one Desk property has this address.' : 'No Desk property has this id or exact address.');
    if (records[property.id]) return hold(`Another row already matched ${property.address}.`);
    if (!raw.area) return hold('No area group.');
    const lastCompleted = readHistoryDate(raw.lastCompleted), lastPlanned = readHistoryDate(raw.lastPlanned);
    if (lastCompleted === undefined || lastPlanned === undefined) return hold('A date could not be read. Use 2026-04-30 or 30/04/2026.');
    records[property.id] = { area: raw.area, lastCompleted, lastPlanned, accessNote: raw.accessNote };
  });
  return { records, unmatched };
}

export function readInspectionHistory(v: unknown): InspectionHistoryState {
  if (!object(v) || !exact(v, 'version,purpose,revision,updatedAt,records,unmatched,lastImport') || v.version !== 1 || v.purpose !== 'inspection-history' ||
      !count(v.revision) || !(v.updatedAt === null || count(v.updatedAt)) || !object(v.records) || !Array.isArray(v.unmatched) || v.unmatched.length > MAX_ROWS) throw new Error('bad');
  for (const r of Object.values(v.records)) {
    if (!object(r) || !exact(r, 'area,lastCompleted,lastPlanned,accessNote') || !text(r.area, 500) || !r.area || !isoOrNull(r.lastCompleted) || !isoOrNull(r.lastPlanned) || !text(r.accessNote, 500)) throw new Error('bad');
  }
  for (const u of v.unmatched) {
    if (!object(u) || !exact(u, 'row,property,area,lastCompleted,lastPlanned,accessNote,reason') || !count(u.row) ||
        !['property', 'area', 'lastCompleted', 'lastPlanned', 'accessNote', 'reason'].every(k => text(u[k], 500))) throw new Error('bad');
  }
  const last = v.lastImport;
  if (!(last === null || (object(last) && exact(last, 'at,matched,unmatched') && count(last.at) && count(last.matched) && count(last.unmatched)))) throw new Error('bad');
  return v as unknown as InspectionHistoryState;
}

export function createInspectionHistoryStore(options: { file?: string; now?: () => number } = {}) {
  const file = options.file ?? join(DATA_DIR, 'inspection-history.json');
  const now = options.now ?? Date.now;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(work: () => Promise<T>): Promise<T> => { const next = queue.then(work, work); queue = next.catch(() => {}); return next; };
  const recovery = (): never => fail('Saved inspection history needs recovery. Its file has been kept.', 503);
  const validate = (value: unknown) => { try { return readInspectionHistory(value); } catch { return recovery(); } };
  const load = async (): Promise<InspectionHistoryState> => {
    let raw: unknown;
    try { raw = await readPrivateJson(file, MAX_BYTES); } catch { return recovery(); }
    return raw === undefined ? { version: 1, purpose: 'inspection-history', revision: 0, updatedAt: null, records: {}, unmatched: [], lastImport: null } : validate(raw);
  };
  return {
    read: () => serial(load),
    /** Matched rows replace that property's record; this import's unmatched rows replace the held list. */
    importCsv: (input: { csv: unknown; properties: HistoryProperty[]; expectedRevision: unknown }) => serial(async () => {
      if (typeof input.csv !== 'string' || !input.csv.trim()) fail('Choose an inspection history CSV file.', 400);
      if (!count(input.expectedRevision)) fail('Reload inspection history before importing.', 400);
      const { records, unmatched } = matchHistoryCsv(input.csv as string, input.properties);
      const state = await load();
      if (state.revision !== input.expectedRevision) fail('Inspection history changed since you opened it. Reload and try again.', 409);
      const at = Math.max(0, now());
      Object.assign(state, { records: { ...state.records, ...records }, unmatched, revision: state.revision + 1, updatedAt: at,
        lastImport: { at, matched: Object.keys(records).length, unmatched: unmatched.length } });
      await writePrivateJson(file, state, { maxBytes: MAX_BYTES, validate });
      return structuredClone(state);
    }),
  };
}
export type InspectionHistoryStore = ReturnType<typeof createInspectionHistoryStore>;
