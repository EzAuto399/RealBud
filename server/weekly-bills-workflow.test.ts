import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { WorkflowDatabase } from './workflow-database.ts';
import { BillReviewDraftStore } from './bill-review-drafts.ts';
import { createBillProposals, readBillProposal } from './bill-proposals.ts';
import { runWeeklyBillsWorkflow } from './weekly-bills-workflow.ts';
import { latestRoutineResult } from './routine-results.ts';
import { defaultAgencySettings } from './agency-setup.ts';
import { validatePrivateLogicalRecord } from './private-workspace-backup.ts';
import { removeFixture } from './testing/private-fixture.ts';
import type { JobRun, LoopRun, Recipe } from '../shared/contracts.ts';
import type { BillRecurrenceSeries, SourceBillsSnapshot } from '../shared/source-bills.ts';
import type { MailScanReceipt, MailScanResult } from '../shared/mail-ingestion.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
function fixture(count = 2) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'rb-weekly-bills-'));
  let db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 8) });
  let drafts = new BillReviewDraftStore(db, { workspaceId: 'fictional-workspace' });
  cleanup.push(async () => { db.close(); await removeFixture(dir); });
  let now = Date.parse('2026-10-02T00:00:00Z');
  const accountId = 'fictional-mail';
  const receipt: MailScanReceipt = { id: randomUUID(), accountId, bindingRevision: 'a'.repeat(64), startedAt: now, completedAt: now,
    windowStartAt: now - 14 * 86400000, windowEndAt: now, status: 'complete', messageCount: count, threadCount: count, pages: 1, gaps: [], inputDigest: 'b'.repeat(64) };
  const data: MailScanResult = { accountId, windowStartAt: receipt.windowStartAt, windowEndAt: now, pages: 1, gaps: [], paginationComplete: true,
    threads: Array.from({ length: count }, (_, i) => ({ id: (256 + i).toString(16), historyComplete: true,
      messages: [{ id: (512 + i).toString(16), threadId: (256 + i).toString(16), at: now - 1000, direction: 'incoming',
        from: 'fictional@example.test', to: 'office@example.test', subject: `Fictional invoice ${i}`, body: `Invoice ${i}: amount and property need review.`, bodyTruncated: false, attachments: [] }] })) };
  const recipe = { id: 'wf-office-core-invoice-review', revision: 1, approvedRevision: 1, status: 'active', planApprovedAt: 1 } as Recipe;
  const settings = { ...defaultAgencySettings(), workflowPackId: 'office-core' as const, agencyName: 'Fictional office', gmailAccountId: accountId, timeZone: 'Australia/Brisbane' };
  const runs: JobRun[] = [];
  const execute = vi.fn(async (plan: Recipe, key: string, input: () => Promise<void>) => {
    const run: JobRun = { id: randomUUID(), jobId: plan.id, jobRevision: plan.revision, jobTitle: 'Fictional invoice review', idempotencyKey: key,
      status: 'running', mode: 'prepare', trigger: 'manual', scheduledFor: now, createdAt: now, attempt: 1, detail: '', approvalRequests: [], evidence: [],
      spec: { title: 'Fictional invoice review', description: 'Prepare selected source', steps: [], allowedOrigins: [], capabilities: ['analyse'], evidence: 'Source-bound review', limits: { maxRuntimeMinutes: 5, maxTurns: 10 } } };
    runs.push(run); await input();
    const packet = JSON.parse(readFileSync(join(dir, 'workroom/workflow-inputs/accounts-invoices.json'), 'utf8'));
    const doc = packet.documents[0];
    run.status = 'awaiting-approval'; run.finishedAt = now;
    run.evidence = [{ kind: 'output', at: now, note: JSON.stringify({ version: 1, kind: 'accounts-invoice-entry-review', sourceReference: packet.sourceReference,
      status: 'partial', coverageComplete: false, actionsPerformed: [], holds: [{ itemId: doc.documentId, reason: 'Review original invoice.' }],
      documents: [{ documentId: doc.documentId, decision: 'hold', duplicateOf: null, conflictGroup: null,
        proposedEntry: { supplierId: null, invoiceId: null, propertyId: null, amount: null, currency: null, dueDate: null, costType: null }, sourceIds: [doc.sourceId], reason: 'Review original invoice.' }] }) }];
    return { run };
  });
  const propose = createBillProposals({ database: () => db, workroom: join(dir, 'workroom'), epoch: () => 'fictional-stable',
    authorize: async () => ({ settings, recipe, evidenceDigest: 'b'.repeat(64), packBinding: 'c'.repeat(64) }),
    source: async (_itemId, id) => { const thread = data.threads.find(t => t.messages.some(m => m.id === id))!;
      return { accountId, receiptId: receipt.id, threadId: thread.id, message: thread.messages.find(m => m.id === id)! }; },
    execute, runs: () => runs });
  const snapshot: SourceBillsSnapshot = { version: 1, revision: 1, occurrences: [], series: [], calendar: [] };
  // Threads hidden from collection still resolve as saved sources (aged out or regrouped).
  const hidden = new Set<string>();
  const deps = { database: () => db, drafts: () => drafts, workspaceId: 'fictional-workspace', now: () => now,
    collect: vi.fn(async () => ({ receipt: structuredClone(receipt), data: { ...structuredClone(data), threads: structuredClone(data.threads.filter(t => !hidden.has(t.id))) }, settings })),
    authorize: vi.fn(async () => {}), proposal: propose,
    readProposal: (id: string) => readBillProposal({ database: () => db, runs: () => runs }, id), bills: () => snapshot };
  const run = () => runWeeklyBillsWorkflow({ id: randomUUID(), scheduledFor: now, manual: true } as LoopRun, deps);
  return { deps, run, receipt, data, snapshot, execute, hidden, get db() { return db; }, get drafts() { return drafts; },
    next: (days = 1) => { now += days * 86400000; receipt.windowStartAt = now - 14 * 86400000; receipt.windowEndAt = now; receipt.id = randomUUID(); },
    restart: () => { db.close(); db = new WorkflowDatabase({ dir, key: Buffer.alloc(32, 8) }); drafts = new BillReviewDraftStore(db, { workspaceId: 'fictional-workspace' }); } };
}

describe('weekly Gmail bills orchestration (fictional sources)', () => {
  it('retains durable review drafts and typed proposal receipts without accepting invoice or calendar facts', async () => {
    const f = fixture(); expect(await f.run()).toMatchObject({ ok: true, status: 'awaiting-approval', quiet: false });
    expect(f.execute).toHaveBeenCalledTimes(2);
    const result = latestRoutineResult(f.db, 'weekly-bills')!;
    expect(result.counts).toMatchObject({ collected: 2, candidates: 2, prepared: 2, held: 0, pending: 0 });
    expect(f.db.count('bill-occurrence')).toBe(0); expect(f.db.count('bill-series')).toBe(0);
    for (const id of result.draftIds) expect(f.drafts.get(id)).toMatchObject({ state: 'saved', billState: 'hold', fields: { amount: '', propertyId: '' } });
    for (const row of f.db.list('routine-result')) expect(() => validatePrivateLogicalRecord({ ...row, kind: 'routine-result' })).not.toThrow();
  });
  it('survives restart and unchanged rescans without extra worker calls, duplicate drafts or repeated attention', async () => {
    const f = fixture(); await f.run(); const first = latestRoutineResult(f.db, 'weekly-bills')!;
    f.restart(); f.next();
    expect(await f.run()).toMatchObject({ ok: true, quiet: true });
    expect(f.execute).toHaveBeenCalledTimes(2); expect(f.db.count('bill-review-draft')).toBe(2);
    expect(latestRoutineResult(f.db, 'weekly-bills')?.draftIds).toEqual(first.draftIds);
  });
  it('keeps reviewer edits and discarded decisions; substantive changed evidence gets a separate source-bound review', async () => {
    const f = fixture(1); await f.run();
    const old = f.drafts.get(latestRoutineResult(f.db, 'weekly-bills')!.draftIds[0]);
    const { version: _v, id: _i, revision: _r, createdAt: _c, updatedAt: _u, ...value } = old;
    f.drafts.update(old.id, old.revision, { ...value, state: 'discarded', reason: 'Fictional reviewer: already handled.' });
    f.next(); await f.run(); expect(f.execute).toHaveBeenCalledTimes(1);
    f.data.threads[0].messages[0].body += ' Corrected invoice version.'; f.next(); await f.run();
    expect(f.execute).toHaveBeenCalledTimes(2); expect(f.db.count('bill-review-draft')).toBe(2);
    expect(f.drafts.get(old.id)).toMatchObject({ state: 'discarded', reason: 'Fictional reviewer: already handled.' });
  });
  it('bounds model work to twenty candidates and resumes only the remaining sources', async () => {
    const f = fixture(23); expect(await f.run()).toMatchObject({ status: 'partial' });
    expect(latestRoutineResult(f.db, 'weekly-bills')?.counts).toMatchObject({ prepared: 20, pending: 3 });
    f.restart(); f.next(); await f.run(); expect(f.execute).toHaveBeenCalledTimes(23);
    expect(latestRoutineResult(f.db, 'weekly-bills')?.counts).toMatchObject({ prepared: 23, pending: 0 });
  });
  it('reconciles a saved proposal after a lost response without dispatching twice', async () => {
    const f = fixture(1), normal = f.deps.proposal;
    f.deps.proposal = async request => { await normal(request); throw new Error('Fictional lost response'); };
    expect(await f.run()).toMatchObject({ status: 'awaiting-approval' });
    expect(latestRoutineResult(f.db, 'weekly-bills')?.counts).toMatchObject({ prepared: 1, held: 0 });
    f.restart(); f.next(); expect(await f.run()).toMatchObject({ status: 'awaiting-approval' });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it('keeps unread candidates and incomplete windows as holds and never fabricates a payable bill', async () => {
    const f = fixture(1);
    f.snapshot.series = [{ id: 'fictional-series', accountId: f.receipt.accountId }] as BillRecurrenceSeries[];
    f.snapshot.calendar = [{ id: 'fictional-arrival', type: 'expected-arrival', date: '2026-09-25', endDate: '2026-09-27', propertyId: 'fictional-property', kind: 'Water', vendor: 'Fictional utility', seriesId: 'fictional-series', billId: null, state: 'predicted', basis: 'approved-arrival-pattern' }];
    await f.run(); expect(latestRoutineResult(f.db, 'weekly-bills')?.findings[0].state).toBe('review-hold');
    f.receipt.status = 'partial'; f.receipt.gaps = ['Fictional missing page']; f.next(); await f.run();
    expect(latestRoutineResult(f.db, 'weekly-bills')?.findings[0].state).toBe('coverage-hold');
    expect(f.db.count('bill-occurrence')).toBe(0);
  });
  it('makes delayed/offline coverage gaps explicit and keeps them until a fully read window covers them', async () => {
    const hole = 'Gmail from 2026-10-02 to 2026-10-18 has not been fully checked for bills. Review the missing interval before accepting arrival findings.';
    const f = fixture(0); await f.run(); f.next(30); expect(await f.run()).toMatchObject({ status: 'partial' });
    expect(latestRoutineResult(f.db, 'weekly-bills')?.gaps).toEqual([hole]);
    // An overlapping on-time run no longer differs from its previous result, yet the hole stays.
    f.restart(); f.next(); expect(await f.run()).toMatchObject({ status: 'partial' });
    expect(latestRoutineResult(f.db, 'weekly-bills')?.gaps).toEqual([hole]);
    // A partially read window joins the uncovered set; a later fully read window that includes it clears only that part.
    f.next(); f.data.paginationComplete = false; await f.run();
    expect(latestRoutineResult(f.db, 'weekly-bills')?.coverage?.uncovered).toHaveLength(2);
    f.data.paginationComplete = true; f.next(); await f.run();
    expect(latestRoutineResult(f.db, 'weekly-bills')?.gaps).toEqual([hole, hole.replace('2026-10-02 to 2026-10-18', '2026-10-20 to 2026-10-21')]);
    // A wider fully read window covers the hole.
    f.next(); f.receipt.windowStartAt = Date.parse('2026-09-30T00:00:00Z'); expect(await f.run()).toMatchObject({ status: 'completed' });
    expect(latestRoutineResult(f.db, 'weekly-bills')?.coverage).toMatchObject({ uncovered: [] });
  });
  it('holds an arrival finding only when its window meets unchecked mail', async () => {
    const f = fixture(0);
    f.snapshot.series = [{ id: 'fictional-series', accountId: f.receipt.accountId }] as BillRecurrenceSeries[];
    f.snapshot.calendar = [{ id: 'fictional-arrival', type: 'expected-arrival', date: '2026-10-25', endDate: '2026-10-27', propertyId: 'fictional-property', kind: 'Water', vendor: 'Fictional utility', seriesId: 'fictional-series', billId: null, state: 'predicted', basis: 'approved-arrival-pattern' }];
    await f.run(); f.next(30); await f.run();
    // The hole is 2 to 18 October; this later arrival window was read, so it is a missing-arrival review.
    expect(latestRoutineResult(f.db, 'weekly-bills')?.findings[0].state).toBe('missing-review');
    f.snapshot.calendar[0] = { ...f.snapshot.calendar[0], date: '2026-10-10', endDate: '2026-10-12' };
    f.next(); await f.run();
    expect(latestRoutineResult(f.db, 'weekly-bills')?.findings[0].state).toBe('coverage-hold');
  });
  it('prepares more than twenty candidates over successive runs after they age out or are regrouped', async () => {
    const f = fixture(45); await f.run();
    expect(latestRoutineResult(f.db, 'weekly-bills')?.counts).toMatchObject({ candidates: 45, prepared: 20, pending: 25 });
    // Every unprepared thread leaves the collection; the saved queue still carries the exact requests.
    for (const thread of f.data.threads.slice(20)) f.hidden.add(thread.id);
    f.restart(); f.next(); await f.run();
    expect(latestRoutineResult(f.db, 'weekly-bills')?.counts).toMatchObject({ candidates: 45, prepared: 40, pending: 5 });
    f.next(); await f.run();
    expect(latestRoutineResult(f.db, 'weekly-bills')?.counts).toMatchObject({ candidates: 45, prepared: 45, pending: 0 });
    expect(f.execute).toHaveBeenCalledTimes(45); expect(f.db.count('bill-review-draft')).toBe(45);
    f.next(); await f.run(); expect(f.execute).toHaveBeenCalledTimes(45);
  });
  it('retries an unrecorded backlog request only under its exact saved identity', async () => {
    const f = fixture(21), normal = f.deps.proposal;
    await f.run(); const pendingThread = f.data.threads[20]; f.hidden.add(pendingThread.id);
    f.deps.proposal = async () => { throw new Error('Fictional transport failure'); };
    f.next(); expect(await f.run()).toMatchObject({ status: 'partial' });
    f.deps.proposal = normal; f.restart(); f.next(); await f.run();
    expect(f.execute).toHaveBeenCalledTimes(21);
  });
});
