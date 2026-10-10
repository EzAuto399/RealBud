import { isDeskAreaId, type DeskAreaId } from './desk-areas.ts';

/** Needs you: what needs a person across the office's workflows, projected on
 * each read from every workflow's own store. Read-only; decisions stay in the
 * area that owns the item. `schedule` holds job problems that belong to no area. */
export type NeedsYouArea = DeskAreaId | 'schedule';
export type NeedsYouLevel = 'problem' | 'review';
export type NeedsYouItem = {
  /** `<source>:<id>`, stable across reads: `mail:<itemId>`, `bill:<followUpId>`, `bank:<runId>`, `loop:<runId>`. */
  key: string;
  area: NeedsYouArea;
  /** problem: a check didn't run, access expired or a run is held. review: something was found for a person to decide. */
  level: NeedsYouLevel;
  /** What was found, in the office's words. */
  title: string;
  /** Why it needs a person. */
  reason: string;
  /** The next step, verb first. */
  next: string;
  /** When it was first found (ISO); null when the source keeps no time. */
  foundAt: string | null;
};
export type NeedsYouCounts = { problem: number; review: number };
export type NeedsYouSnapshot = {
  checkedAt: string;
  /** Problems first, then review; newest first within each; at most NEEDS_YOU_AREA_LIMIT per area. */
  items: NeedsYouItem[];
  /** Full counts per area, including items beyond the limit. Areas with nothing are absent. */
  counts: Partial<Record<NeedsYouArea, NeedsYouCounts>>;
  /** Sources that could not be read. A missing source is never reported as "nothing needs you". */
  unavailable: { area: NeedsYouArea; reason: string }[];
};
export const NEEDS_YOU_AREA_LIMIT = 20;

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const area = (value: unknown): value is NeedsYouArea => value === 'schedule' || isDeskAreaId(value);
const count = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const iso = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value));
const fail = (): never => { throw new Error('Needs you could not be checked. Refresh to try again.'); };

/** Strict: a malformed snapshot is an error, never an empty list. */
export function parseNeedsYouSnapshot(value: unknown): NeedsYouSnapshot {
  if (!object(value) || !iso(value.checkedAt) || !Array.isArray(value.items) || !object(value.counts) || !Array.isArray(value.unavailable)) return fail();
  const keys = new Set<string>();
  const items = value.items.map((raw): NeedsYouItem => {
    if (!object(raw) || !text(raw.key, 200) || keys.has(raw.key) || !area(raw.area) || (raw.level !== 'problem' && raw.level !== 'review') ||
      !text(raw.title, 300) || !text(raw.reason, 600) || !text(raw.next, 200) || !(raw.foundAt === null || iso(raw.foundAt))) return fail();
    keys.add(raw.key);
    return { key: raw.key, area: raw.area, level: raw.level, title: raw.title, reason: raw.reason, next: raw.next, foundAt: raw.foundAt as string | null };
  });
  const counts: NeedsYouSnapshot['counts'] = {};
  for (const [key, raw] of Object.entries(value.counts)) {
    if (!area(key) || !object(raw) || !count(raw.problem) || !count(raw.review)) return fail();
    counts[key] = { problem: Number(raw.problem), review: Number(raw.review) };
  }
  const unavailable = value.unavailable.map(raw => object(raw) && area(raw.area) && text(raw.reason, 600) ? { area: raw.area, reason: raw.reason } : fail());
  return { checkedAt: value.checkedAt as string, items, counts, unavailable };
}
