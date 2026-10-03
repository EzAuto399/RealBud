import { createHash } from 'node:crypto';
import type { LoopRun } from '../shared/contracts.ts';
import type { MailWorkspaceMetadata } from '../shared/mail-ingestion.ts';
import type { LoopExecuteResult } from './routines.ts';
import type { WorkflowDatabase } from './workflow-database.ts';
import { latestRoutineResult, saveRoutineResult } from './routine-results.ts';

export function recordMorningResult(db: WorkflowDatabase, run: LoopRun, result: LoopExecuteResult,
  state: MailWorkspaceMetadata & { resultKey: string }, metrics: { elapsedMs: number; modelCalls: number }, now = Date.now()): LoopExecuteResult {
  const scan = state.latestScan;
  if (!result.ok || !scan || !['complete', 'partial'].includes(scan.status)) return result;
  const previous = latestRoutineResult(db, 'inbound-triage');
  const resultKey = createHash('sha256').update(JSON.stringify([scan.accountId, scan.bindingRevision, state.resultKey, scan.status, scan.gaps])).digest('hex');
  const changed = previous?.resultKey !== resultKey;
  const status = result.status === 'partial' ? 'partial' : state.counts.open + state.counts.waiting > 0 ? 'awaiting-approval' : 'completed';
  const detail = `${scan.threadCount} conversations checked; ${state.counts.open} open, ${state.counts.waiting} waiting, ${state.counts.highPriority} high priority. ${status === 'partial' ? 'Coverage is partial. ' : ''}${changed ? 'Review Morning priorities.' : 'No changed results; saved decisions were kept.'}`;
  saveRoutineResult(db, { version: 1, workflow: 'inbound-triage', runId: run.id, accountId: scan.accountId, bindingRevision: scan.bindingRevision,
    sourceReceiptId: scan.id, windowStartAt: scan.windowStartAt, windowEndAt: scan.windowEndAt, finishedAt: now, status,
    counts: { collected: scan.threadCount, candidates: state.counts.total, prepared: Math.max(0, state.counts.total - state.counts.needsReview), held: state.counts.needsReview, pending: 0, changed: changed ? 1 : 0 },
    findings: [], draftIds: [], gaps: scan.gaps, resultKey, detail, metrics });
  return { ...result, status, detail, quiet: !changed };
}
