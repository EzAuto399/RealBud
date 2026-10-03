import type { RoutineFinding } from './routine-result.ts';

/** Internal follow-up work for a weekly arrival finding. Never a payment or invoice fact. */
export type BillFollowUpStatus = 'open' | 'resolved';
export type BillFollowUpFilter = 'open' | 'resolved' | 'all';
export interface BillFollowUpDecision {
  at: number; action: 'planned' | 'resolved' | 'reopened' | 'recurred'; note: string;
}
export interface BillFollowUp {
  id: string; revision: number;
  /** Latest evidence from the weekly result that raised it. */
  propertyId: string; label: string; state: RoutineFinding['state']; from: string; to: string; reason: string;
  evidenceKey: string; active: boolean; firstSeenAt: number;
  status: BillFollowUpStatus; owner: string; followUpOn: string; history: BillFollowUpDecision[];
}
export interface BillFollowUpPage {
  version: 1; filter: BillFollowUpFilter; items: BillFollowUp[]; total: number;
  counts: { open: number; resolved: number }; nextCursor: string | null;
}
export type BillFollowUpChange =
  | { id: string; expectedRevision: number; action: 'plan'; owner: string; followUpOn: string }
  | { id: string; expectedRevision: number; action: 'resolve' | 'reopen'; note: string };
export const BILL_FOLLOWUP_HISTORY_MAX = 20;

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) &&
  new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);
export const validFollowUpDate = (v: unknown): v is string => v === '' || date(v);
export const validFollowUpOwner = (v: unknown): v is string => text(v, 100) && v.trim() === v;
export const validFollowUpNote = (v: unknown): v is string => text(v, 500);

/** Throws on anything unexpected; damaged saved work is never silently repaired. */
export function readBillFollowUp(v: unknown): BillFollowUp {
  const bad = (): never => { throw new Error('A saved bill follow-up needs recovery. Its evidence has been kept.'); };
  if (!object(v) || !exact(v, 'id,revision,propertyId,label,state,from,to,reason,evidenceKey,active,firstSeenAt,status,owner,followUpOn,history') ||
      !text(v.id, 250) || !v.id || !count(v.revision) || v.revision < 1 || !text(v.propertyId, 200) || !text(v.label, 300) || !text(v.reason, 500) ||
      !['missing-review', 'coverage-hold', 'review-hold'].includes(String(v.state)) || !date(v.from) || !date(v.to) || v.to < v.from ||
      !text(v.evidenceKey, 64) || !/^[a-f0-9]{64}$/.test(v.evidenceKey) || typeof v.active !== 'boolean' || !count(v.firstSeenAt) ||
      !['open', 'resolved'].includes(String(v.status)) || !validFollowUpOwner(v.owner) || !validFollowUpDate(v.followUpOn) ||
      !Array.isArray(v.history) || v.history.length > BILL_FOLLOWUP_HISTORY_MAX) return bad();
  for (const h of v.history) if (!object(h) || !exact(h, 'at,action,note') || !count(h.at) ||
      !['planned', 'resolved', 'reopened', 'recurred'].includes(String(h.action)) || !validFollowUpNote(h.note)) return bad();
  return structuredClone(v) as unknown as BillFollowUp;
}
export function readBillFollowUpPage(v: unknown): BillFollowUpPage {
  const bad = (): never => { throw new Error('The bill follow-ups could not be read. Refresh to try again.'); };
  if (!object(v) || !exact(v, 'version,filter,items,total,counts,nextCursor') || v.version !== 1 ||
      !['open', 'resolved', 'all'].includes(String(v.filter)) || !Array.isArray(v.items) || v.items.length > 100 || !count(v.total) ||
      !object(v.counts) || !exact(v.counts, 'open,resolved') || !count(v.counts.open) || !count(v.counts.resolved) ||
      !(v.nextCursor === null || text(v.nextCursor, 4096) && /^[A-Za-z0-9_-]+$/.test(v.nextCursor))) return bad();
  return { ...(v as unknown as BillFollowUpPage), items: v.items.map(readBillFollowUp) };
}
