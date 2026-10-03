import { createHash } from 'node:crypto';
import type { LoopRun } from '../shared/contracts.ts';
import type { BillMailSource, SourceBillsSnapshot } from '../shared/source-bills.ts';
import { mailScanWindowCovered, type MailScanReceipt, type MailScanResult } from '../shared/mail-ingestion.ts';
import type { BillProposalHistory } from '../shared/bill-proposals.ts';
import type { RoutineFinding, RoutineResult } from '../shared/routine-result.ts';
import type { BillReviewDraftStore } from './bill-review-drafts.ts';
import type { BillReviewDraft } from '../shared/bill-review-drafts.ts';
import { previewBillSource } from './source-bills.ts';
import { billDateInZone, addBillDays } from '../shared/bill-dates.ts';
import type { WorkflowDatabase } from './workflow-database.ts';
import { latestRoutineResult, saveRoutineResult } from './routine-results.ts';
import type { LoopExecuteResult } from './routines.ts';
import { nextBillCoverage, uncoveredBillDates, weeklyBillBacklog, weeklyBillDraftId } from './bill-backlog.ts';

const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export interface WeeklyBillsDependencies {
  database: () => WorkflowDatabase; workspaceId: string; drafts: () => BillReviewDraftStore;
  collect: () => Promise<{ receipt: MailScanReceipt; data: MailScanResult; settings: { timeZone: string } }>;
  authorize: () => Promise<void>;
  proposal: (request: { requestId: string; itemId: string; messageId: string; expectedSourceDigest: string }) => Promise<unknown>;
  readProposal: (requestId: string) => BillProposalHistory;
  bills: (range: { from: string; to: string }) => SourceBillsSnapshot;
  now?: () => number;
}

/** A conservative intake filter. Its exclusions cannot prove invoice absence:
 * arrival findings always retain a source-review hold when mail is unreviewed. */
export function potentialBill(message: MailScanResult['threads'][number]['messages'][number]): boolean {
  return message.direction !== 'outgoing' && (message.attachments.length > 0 || message.bodyTruncated ||
    /\b(invoice|bill|rates|levy|levies|amount due|payment due|statement|remittance)\b/i.test(`${message.subject}\n${message.body}`));
}

export async function runWeeklyBillsWorkflow(run: LoopRun, deps: WeeklyBillsDependencies): Promise<LoopExecuteResult> {
  const now = deps.now ?? Date.now, started = now();
  await deps.authorize();
  const { receipt, data, settings } = await deps.collect();
  if (!['complete', 'partial'].includes(receipt.status)) return { ok: false, detail: 'Bill collection did not produce a usable source receipt. Check Gmail access and retry.' };
  const previous = latestRoutineResult(deps.database(), 'weekly-bills');
  const sameAccount = previous?.accountId === receipt.accountId && previous.bindingRevision === receipt.bindingRevision;
  const coverage = nextBillCoverage(previous, receipt, mailScanWindowCovered(data));
  const holes = uncoveredBillDates(coverage, settings.timeZone);
  const gaps = [...receipt.gaps, ...holes.map(h => `Gmail from ${h.from} to ${h.to} has not been fully checked for bills. Review the missing interval before accepting arrival findings.`)];
  const today = billDateInZone(receipt.windowEndAt, settings.timeZone);
  const range = { from: addBillDays(today, -90), to: today };
  const byId = new Map<string, BillReviewDraft>();
  let prepared = 0, held = 0, pending = 0, changed = 0, modelCalls = 0, attempts = 0, newDrafts = 0;
  let jobRunId: string | undefined;
  for (const thread of data.threads) for (const message of thread.messages) {
    if (!potentialBill(message)) continue;
    const source: BillMailSource = { accountId: receipt.accountId, receiptId: receipt.id, threadId: thread.id, message };
    const evidence = previewBillSource(source);
    const itemId = hash([deps.workspaceId, receipt.accountId, thread.id]);
    const draftId = weeklyBillDraftId(deps.workspaceId, evidence.digest);
    if (byId.has(draftId)) continue;
    const request = { requestId: draftId, itemId, messageId: message.id, expectedSourceDigest: evidence.digest };
    let draft: BillReviewDraft;
    try { draft = deps.drafts().get(draftId); }
    catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      draft = deps.drafts().create(draftId, null, { workspaceId: deps.workspaceId, state: 'saved',
        billId: null, billRevision: null, itemId, messageId: message.id, sourceDigest: evidence.digest,
        fields: { propertyId: '', kind: '', vendor: '', amount: '', invoiceDate: '', dueDate: '', note: '' },
        billState: 'hold', reason: '', seriesId: '', arrivalDate: '', proposalRequest: request });
      newDrafts++;
    }
    byId.set(draftId, draft);
  }
  // Saved candidates outside this collection (aged out, or regrouped by morning
  // triage) stay in the queue. Oldest first, so new mail cannot starve them.
  for (const draft of weeklyBillBacklog(deps.drafts(), deps.workspaceId, new Set(byId.keys()))) byId.set(draft.id, draft);
  const drafts = [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
  for (const draft of drafts) {
    if (draft.state === 'accepted' || draft.state === 'discarded') continue;
    // Dispatch only the exact saved tuple; never a request rebuilt from newer mail.
    const request = draft.proposalRequest;
    if (!request) { held++; continue; }
    const existing = deps.readProposal(request.requestId);
    if (existing.state === 'run-recorded' && existing.run && ['completed', 'awaiting-approval'].includes(existing.run.status)) { prepared++; continue; }
    // A durable intent/failed request is inspected, never automatically retried
    // as a second model job after an unknown outcome or a service restart.
    if (existing.state !== 'not-recorded') { held++; continue; }
    // ponytail: rejected-before-intent requests (source changed) retry each run, capped by attempts.
    if (modelCalls >= 20 || attempts >= 40) { pending++; continue; }
    await deps.authorize();
    attempts++;
    // A lost response is reconciled against the saved receipt below. The saved
    // draft and exact request remain available in Bills; one unreadable
    // attachment cannot discard other completed preparations.
    try { await deps.proposal(request); } catch { /* reconciled below */ }
    const saved = deps.readProposal(request.requestId);
    if (saved.state !== 'not-recorded') modelCalls++;
    if (saved.run) jobRunId = saved.run.id;
    if (saved.run && ['completed', 'awaiting-approval'].includes(saved.run.status)) { prepared++; changed++; }
    else held++;
  }
  await deps.authorize();
  const bills = deps.bills(range);
  const pendingReviews = drafts.filter(d => !['accepted', 'discarded'].includes(d.state)).length;
  const sourceReviewIncomplete = data.threads.some(t => !t.historyComplete || t.messages.some(m =>
    m.direction !== 'outgoing' && (!potentialBill(m) || m.direction === 'unknown' || m.bodyTruncated)));
  const findings: RoutineFinding[] = bills.calendar.filter(entry => entry.type === 'expected-arrival' && entry.endDate < today &&
    bills.series.some(series => series.id === entry.seriesId && series.accountId === receipt.accountId)).map(entry => {
      const scopeCovers = receipt.status === 'complete' && receipt.gaps.length === 0 &&
        billDateInZone(coverage.startAt, settings.timeZone) < entry.date && !holes.some(h => h.from <= entry.endDate && h.to >= entry.date);
      const state = !scopeCovers ? 'coverage-hold' : pendingReviews || sourceReviewIncomplete ? 'review-hold' : 'missing-review';
      return { id: entry.id, propertyId: entry.propertyId, label: `${entry.kind} · ${entry.vendor}`.slice(0, 300),
        state, from: entry.date, to: entry.endDate,
        reason: state === 'coverage-hold' ? 'The checked Gmail interval does not fully cover this arrival window. Review coverage before following up.'
          : state === 'review-hold' ? 'Saved messages or bill candidates still need review and may explain this arrival. Review them before marking it missing.'
            : 'No received bill is linked to this approved arrival in the checked interval. Review the original sources before following up; no payable invoice was created.' };
    });
  const resultKey = hash([receipt.accountId, receipt.bindingRevision, drafts.map(d => [d.id, d.revision, d.state]), findings, gaps, held, pending]);
  const meaningfulChange = !sameAccount || previous?.resultKey !== resultKey;
  const status = receipt.status === 'partial' || gaps.length || held || pending ? 'partial' : pendingReviews || findings.length ? 'awaiting-approval' : 'completed';
  const detail = `${receipt.messageCount} messages checked; ${drafts.length} bill candidates, ${prepared} prepared, ${held} held, ${pending} pending. ${findings.length} arrival follow-ups. ${meaningfulChange ? 'Open Bills to review the saved results.' : 'No changed results; saved decisions were kept.'}`;
  const result: RoutineResult = { version: 1, workflow: 'weekly-bills', runId: run.id, accountId: receipt.accountId, bindingRevision: receipt.bindingRevision,
    sourceReceiptId: receipt.id, windowStartAt: receipt.windowStartAt, windowEndAt: receipt.windowEndAt, finishedAt: now(), status,
    counts: { collected: receipt.messageCount, candidates: drafts.length, prepared, held, pending, changed: meaningfulChange ? Math.max(1, newDrafts + changed) : 0 },
    findings, draftIds: drafts.slice(-500).map(d => d.id), gaps: gaps.slice(0, 200), resultKey, detail, metrics: { elapsedMs: Math.max(0, now() - started), modelCalls }, coverage };
  saveRoutineResult(deps.database(), result);
  return { ok: true, status, detail, quiet: !meaningfulChange, ...(jobRunId ? { jobRunId } : {}) };
}
