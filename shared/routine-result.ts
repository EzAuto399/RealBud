import { validMailIntervals, type MailInterval } from './mail-ingestion.ts';
/** Saved internal review results. These never establish financial status. */
export interface RoutineFinding {
  id: string; propertyId: string; label: string;
  state: 'missing-review' | 'coverage-hold' | 'review-hold';
  from: string; to: string; reason: string;
}
export interface RoutineResult {
  version: 1; workflow: 'weekly-bills' | 'inbound-triage'; runId: string;
  accountId: string; bindingRevision: string; sourceReceiptId: string;
  windowStartAt: number; windowEndAt: number; finishedAt: number;
  status: 'completed' | 'partial' | 'awaiting-approval';
  counts: { collected: number; candidates: number; prepared: number; held: number; pending: number; changed: number };
  findings: RoutineFinding[]; draftIds: string[]; gaps: string[];
  resultKey: string; detail: string;
  metrics: { elapsedMs: number; modelCalls: number };
  /** Cumulative Gmail interval bookkeeping since startAt for this account and
   * binding. Uncovered intervals persist until a later window checks them. */
  coverage?: RoutineCoverage;
  /** Jev's pre-screen of morning mail, when it answered: conversations saved as noise and its model id. */
  screen?: { screened: number; model: string };
}
export interface RoutineCoverage { startAt: number; endAt: number; uncovered: MailInterval[] }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v: Record<string, unknown>, keys: string) => Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v);
const count = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
export function readRoutineResult(v: unknown): RoutineResult {
  const bad = (): never => { throw new Error('The saved routine result needs recovery. Its evidence has been kept.'); };
  const keys = 'version,workflow,runId,accountId,bindingRevision,sourceReceiptId,windowStartAt,windowEndAt,finishedAt,status,counts,findings,draftIds,gaps,resultKey,detail,metrics';
  if (!object(v) || !exact(v, [keys, ...['coverage', 'screen'].filter(k => Object.hasOwn(v, k))].join(',')) ||
      v.version !== 1 || !['weekly-bills', 'inbound-triage'].includes(String(v.workflow)) ||
      !text(v.runId, 100) || !/^[\w-]+$/.test(v.runId) || !text(v.accountId, 200) || !v.accountId ||
      !text(v.sourceReceiptId, 100) || !v.sourceReceiptId || !text(v.bindingRevision, 200) || !v.bindingRevision ||
      !text(v.resultKey, 64) || !/^[a-f0-9]{64}$/.test(v.resultKey) || !text(v.detail, 500) ||
      !count(v.windowStartAt) || !count(v.windowEndAt) || v.windowEndAt <= v.windowStartAt || !count(v.finishedAt) ||
      !['completed', 'partial', 'awaiting-approval'].includes(String(v.status)) ||
      !object(v.counts) || !exact(v.counts, 'collected,candidates,prepared,held,pending,changed') || !Object.values(v.counts).every(count) ||
      !object(v.metrics) || !exact(v.metrics, 'elapsedMs,modelCalls') || !Object.values(v.metrics).every(count) ||
      !Array.isArray(v.gaps) || v.gaps.length > 200 || !v.gaps.every(g => text(g, 500)) ||
      !Array.isArray(v.draftIds) || v.draftIds.length > 500 || !v.draftIds.every(id => text(id, 36) && /^[a-f0-9-]{36}$/.test(id)) ||
      !Array.isArray(v.findings) || v.findings.length > 2000) return bad();
  if (Object.hasOwn(v, 'coverage')) {
    const c = v.coverage;
    if (!object(c) || !exact(c, 'startAt,endAt,uncovered') || !count(c.startAt) || !count(c.endAt) || c.endAt <= c.startAt ||
        !validMailIntervals(c.uncovered) || c.uncovered.some(i => i.startAt < Number(c.startAt) || i.endAt > Number(c.endAt))) return bad();
  }
  if (Object.hasOwn(v, 'screen') && (!object(v.screen) || !exact(v.screen, 'screened,model') || !count(v.screen.screened) ||
      !text(v.screen.model, 100) || !/^[\w.:/-]+$/.test(v.screen.model))) return bad();
  for (const f of v.findings) if (!object(f) || !exact(f, 'id,propertyId,label,state,from,to,reason') ||
      !text(f.id, 250) || !text(f.propertyId, 200) || !text(f.label, 300) || !text(f.reason, 500) ||
      !['missing-review', 'coverage-hold', 'review-hold'].includes(String(f.state)) ||
      !text(f.from, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(f.from) || !text(f.to, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(f.to) || f.to < f.from) return bad();
  return structuredClone(v) as unknown as RoutineResult;
}
