import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createMailIngestionService, MORNING_MAIL_RECIPE, type MailAuthority } from './mail-ingestion.ts';
import { defaultAgencySettings } from './agency-setup.ts';
import { WorkflowDatabase } from './workflow-database.ts';
import { runMorningMailWorkflow } from './morning-mail-workflow.ts';
import { LoopManager } from './routines.ts';
import { austinCustomerPack } from './customer-pack-definition.ts';
import { prepareJobPrompt } from './job-executor.ts';
import type { InboxReview } from '../shared/accounts-review.ts';
import type { JobRun, LoopRun, Recipe } from '../shared/contracts.ts';
import type { MailScanResult, MailThread } from '../shared/mail-ingestion.ts';

// These are scripted contract/recovery scenarios, never model-interpretation
// evidence. All sources are fictional and no connector or model is called.
vi.mock('./recipes.ts', () => ({ getRecipe: (id: string) => ({ id, capabilities: ['read-files'] }) }));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const asOf = Date.parse('2026-09-30T22:00:00Z'); // 1 October, 08:00 Brisbane.
const day = 86_400_000;

async function fixture() {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'rb-w3-readiness-'));
  let now = asOf;
  const authority: MailAuthority = { accountId: 'fictional-kevin-mail', bindingRevision: 'a'.repeat(64), settingsRevision: 1,
    settings: { ...defaultAgencySettings(), agencyName: 'Fictional W3 office', workflowPackId: 'austin-office',
      timeZone: 'Australia/Brisbane', gmailAccountId: 'fictional-kevin-mail', selectedWorkflows: ['morning-priorities'],
      mailScope: { historyDays: 7, includeSent: true, maxMessages: 100, attachments: 'metadata-only' } } };
  const categories = ['urgent-review', 'waiting', 'reference'] as const;
  const threads: MailThread[] = Array.from({ length: 21 }, (_, i) => {
    const id = (0xa00 + i).toString(16), category = categories[i % 3];
    return { id, historyComplete: true, messages: [{ id: (0xb00 + i).toString(16), threadId: id, at: asOf - 60_000 - i,
      direction: category === 'waiting' ? 'outgoing' : 'incoming', from: 'fictional@example.test', to: 'office@example.test',
      subject: `Fictional W3 ${category} ${i + 1}`, body: category === 'urgent-review' ? 'Review this fictional urgent property issue.'
        : category === 'waiting' ? 'Please confirm this fictional appointment.' : 'For reference: fictional office information.',
      bodyTruncated: false, attachments: [] }] };
  });
  const data: Pick<MailScanResult, 'threads' | 'pages' | 'paginationComplete' | 'gaps'> = { threads, pages: 2, paginationComplete: true, gaps: [] };
  const scan = vi.fn(async (current: MailAuthority, request: { windowStartAt: number; windowEndAt: number }): Promise<MailScanResult> =>
    ({ ...structuredClone(data), accountId: current.accountId, windowStartAt: request.windowStartAt, windowEndAt: request.windowEndAt }));
  let database = new WorkflowDatabase({ dir: root, key: Buffer.alloc(32, 7) });
  const open = () => createMailIngestionService({ database, directory: root, workroomDirectory: join(root, 'workroom'),
    workspaceId: 'fictional-w3-office', key: Buffer.alloc(32, 7), authorize: async () => structuredClone(authority), scan, now: () => now });
  let service = open();
  cleanup.push(async () => { await service.close(); database.close(); await rm(root, { recursive: true, force: true }); });
  const recipe = { id: MORNING_MAIL_RECIPE, revision: 1, status: 'active', planApprovedAt: 1, approvedRevision: 1 } as Recipe;
  const batches: Array<{ requestId: string; source: string; threads: string[] }> = [];
  const execute = vi.fn(async (_recipe: Recipe, request: { idempotencyKey: string }) => {
    const input = JSON.parse(await readFile(join(root, 'workroom/workflow-inputs/accounts-inbox.json'), 'utf8'));
    batches.push({ requestId: request.idempotencyKey, source: input.sourceReference, threads: input.threads.map((t: { threadId: string }) => t.threadId) });
    const result: InboxReview = { version: 1, kind: 'accounts-inbox-triage', skillSource: 'email-inbox-triage@0.1.0', sourceReference: input.sourceReference,
      status: input.coverage.complete ? 'complete' : 'partial', coverageComplete: input.coverage.complete,
      actionsPerformed: [], holds: input.coverage.complete ? [] : [{ itemId: 'coverage', reason: 'Fictional second page is missing.' }],
      threads: input.threads.map((t: { threadId: string; messages: { messageId: string }[] }) => {
        const category = categories[(parseInt(t.threadId, 16) - 0xa00) % 3];
        return { threadId: t.threadId, disposition: category, owner: 'accounts-reviewer', priority: category === 'urgent-review' ? 'high' : 'normal',
          sourceMessageIds: t.messages.map(m => m.messageId), reason: 'Scripted fixture classification, not model interpretation.',
          nextAction: category === 'reference' ? 'Keep as reference.' : 'Kevin reviews the source; no send is authorized.', missingFacts: [] };
      }) };
    return { run: { id: randomUUID(), jobId: recipe.id, status: 'awaiting-approval', evidence: [{ kind: 'output', note: JSON.stringify(result) }] } as JobRun };
  });
  const morning = () => runMorningMailWorkflow({ id: randomUUID(), scheduledFor: now, manual: true } as LoopRun,
    { collect: () => service.collect(), prepareInput: () => service.prepareInput(), applyReview: run => service.applyReview(run), recipe: () => recipe,
      admitPack: async () => {}, execute });
  const items = async () => (await service.page({ group: 'all', limit: 100 })).items;
  return { get service() { return service; }, data, threads, batches, execute, scan, morning, items,
    advance: (ms = 1000) => { now += ms; },
    restart: async () => { await service.close(); database.close(); database = new WorkflowDatabase({ dir: root, key: Buffer.alloc(32, 7) }); service = open(); } };
}

describe('W3 composed fictional morning acceptance', () => {
  it('keeps W2, manual and history collection outside an active W3 source scope, then releases on failure', async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    const working = f.service.withWorkflow(async () => {
      await f.service.collect(); entered(); await hold;
      throw new Error('Fictional worker stopped');
    });
    await ready;
    await expect(f.service.collect('bills-calendar')).rejects.toThrow(/mail workflow/);
    await expect(f.service.collectHistory()).rejects.toThrow(/mail workflow/);
    await expect(f.service.withWorkflow(() => f.service.collect())).rejects.toThrow(/already running/);
    await expect(f.service.prepareInput()).rejects.toThrow(/mail workflow/);
    const stopped = expect(working).rejects.toThrow('Fictional worker stopped'); release(); await stopped;
    await expect(f.service.collect()).resolves.toMatchObject({ latestScan: { status: 'complete' } });
  });

  it('rejects a replaced receipt even when the replacement has no pending model input', async () => {
    const f = await fixture();
    const first = (await f.service.collect()).latestScan!;
    f.data.threads = []; f.advance(); await f.service.collect();
    await expect(f.service.prepareInput(first)).rejects.toThrow(/Gmail source changed/);
  });
  it('constructs a bounded W3 prompt separating accountable owner, workflow destination, action handoff and urgency', () => {
    const definition = austinCustomerPack().recipes.find(r => r.id === MORNING_MAIL_RECIPE)!;
    const recipe = { ...definition, revision: 1, status: 'active', planApprovedAt: 1, approvedRevision: 1 } as Recipe;
    const prompt = prepareJobPrompt(recipe);
    expect(definition.description.length).toBeLessThanOrEqual(4000);
    expect(prompt).toContain('Route invoices to invoice-review in nextAction; owner remains accounts-reviewer.');
    expect(prompt).toContain('A bank-export-available message is action-review/accounts-reviewer');
    expect(prompt).toContain('Funding shortfalls, unrecovered company advances and hardship requests are urgent-review/high/accounts-reviewer');
    expect(prompt).toContain('reference/low/accounts-reviewer with missingFacts=[] and no new task');
    expect(prompt).toContain('owner: accounts-reviewer|property-manager|source-owner|unassigned');
    expect(recipe.capabilities).toEqual(['read-files', 'analyse', 'draft']);
    expect(recipe.allowedOrigins).toEqual([]);
  });

  it.each(['workflow-as-owner', 'decorated-priority'] as const)('holds %s output without adopting a partial queue and accepts a fresh valid preparation', async defect => {
    const f = await fixture(), normal = f.execute.getMockImplementation()!;
    f.execute.mockImplementationOnce(async (...args) => {
      const result = await normal(...args);
      const output = JSON.parse(result.run.evidence[0].note!);
      if (defect === 'workflow-as-owner') output.threads[0].owner = 'invoice-review';
      else output.threads[0].priority = 'high (for visibility)';
      result.run.evidence[0].note = JSON.stringify(output);
      return result;
    });
    expect(await f.morning()).toMatchObject({ ok: false, status: 'failed' });
    expect((await f.items()).every(item => item.disposition === 'hold')).toBe(true);
    expect((await f.service.get()).latestReview).toBeNull();
    expect(await f.morning()).toMatchObject({ ok: true });
    expect((await f.items()).every(item => item.disposition !== 'hold')).toBe(true);
  });

  it('saves urgent, waiting and FYI in 20+1 batches, retains decisions across disk restart, and reopens the same issue on substantive mail', async () => {
    const f = await fixture();
    expect(await f.morning()).toMatchObject({ ok: true, status: 'awaiting-approval' });
    expect(f.batches.map(b => b.threads.length)).toEqual([20, 1]);
    expect(new Set(f.batches.map(b => b.requestId)).size).toBe(2);
    const initial = await f.items();
    expect(initial).toHaveLength(21);
    for (const disposition of ['urgent-review', 'waiting', 'reference']) expect(initial.filter(i => i.disposition === disposition)).toHaveLength(7);
    const urgent = initial.find(i => i.threadId === 'a00')!, waiting = initial.find(i => i.threadId === 'a01')!;
    await f.service.update(urgent.id, { expectedRevision: urgent.revision, status: 'done', priority: 'low', owner: 'Fictional Kevin', note: 'Reviewed urgent item.' });
    await f.service.update(waiting.id, { expectedRevision: waiting.revision, status: 'snoozed', snoozedUntil: asOf + day, note: 'Waiting for appointment confirmation.' });
    const decisions = await f.items();
    await f.restart(); f.advance();
    await f.morning();
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(await f.items()).toEqual(decisions);
    // A reply changes this existing business task, without undoing manual fields.
    f.threads[0].messages.push({ ...f.threads[0].messages[0], id: 'c00', at: asOf + 500, body: 'New fictional issue details require further review.' });
    f.advance(); await f.morning();
    const reopened = (await f.items()).find(i => i.id === urgent.id)!;
    expect(reopened).toMatchObject({ status: 'open', newEvidence: true, priority: 'low', owner: 'Fictional Kevin', note: 'Reviewed urgent item.' });
    expect(reopened.sourceMessageIds).toEqual(['b00', 'c00']);
    expect((await f.items()).find(i => i.id === waiting.id)).toEqual(decisions.find(i => i.id === waiting.id));
    expect(new Set((await f.items()).map(i => i.id)).size).toBe(21);
    // Changed human-reviewed work is prepared once for fresh attention; a rerun stays quiet.
    expect(f.execute).toHaveBeenCalledTimes(3);
    expect((await f.service.page({ group: 'open', limit: 100 })).items).toContainEqual(expect.objectContaining({ id: urgent.id, priority: 'low', owner: 'Fictional Kevin', preparedDigest: reopened.sourceDigest }));
    f.advance(); await f.morning(); expect(f.execute).toHaveBeenCalledTimes(3);
  });

  it('retains completed batches after worker failure, resumes only pending evidence, and keeps a later empty partial scan visibly partial', async () => {
    const f = await fixture(), normal = f.execute.getMockImplementation()!;
    f.execute.mockImplementationOnce(normal).mockImplementationOnce(async () => ({ run: { id: 'fictional-failed-batch', status: 'failed', detail: 'Fictional provider failure' } as JobRun }));
    expect(await f.morning()).toMatchObject({ ok: false, status: 'partial' });
    const first = await f.items();
    expect(first.filter(i => i.disposition !== 'hold')).toHaveLength(20);
    expect(first.filter(i => i.disposition === 'hold')).toHaveLength(1);
    await f.restart(); f.advance();
    expect(await f.morning()).toMatchObject({ ok: true });
    expect(f.batches.map(b => b.threads.length)).toEqual([20, 1]);
    expect(f.execute).toHaveBeenCalledTimes(3);
    const saved = await f.items();
    expect(saved.every(i => i.disposition !== 'hold')).toBe(true);
    f.data.threads = []; f.data.paginationComplete = false; f.data.pages = 0; f.data.gaps = ['Fictional mailbox page unavailable.']; f.advance();
    expect(await f.morning()).toMatchObject({ ok: true, status: 'partial' });
    expect(await f.items()).toEqual(saved);
    expect((await f.service.get()).latestScan).toMatchObject({ status: 'partial', threadCount: 0, gaps: ['Fictional mailbox page unavailable.'] });
    expect(f.execute).toHaveBeenCalledTimes(3);
  });

  it('records a missed Brisbane morning after long downtime without collecting mail or silently catching up', async () => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), 'rb-w3-missed-'));
    let now = asOf - 60_000;
    const execute = vi.fn(async () => ({ ok: true, detail: 'Must not run for a missed slot.' }));
    const manager = new LoopManager({ file: join(root, 'loops.json'), now: () => now, hostTimezone: 'America/New_York', execute });
    cleanup.push(async () => { manager.close(); await rm(root, { recursive: true, force: true }); });
    manager.setEnabled('morning-arrears', false); manager.setEnabled('owner-letter', false);
    manager.patchClock('inbound-triage', { enabled: true, time: '08:00', weekdays: [4], timezone: 'Australia/Brisbane' });
    now = asOf + 13 * 60 * 60_000;
    await manager.tick(); await manager.tick();
    const missed = manager.listRuns().filter(r => r.loopId === 'inbound-triage');
    expect(missed).toHaveLength(1);
    expect(missed[0]).toMatchObject({ status: 'missed', manual: false, scheduledFor: asOf });
    expect(execute).not.toHaveBeenCalled();
  });
});
