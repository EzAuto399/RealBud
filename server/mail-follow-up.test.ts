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
import { validMailWorkItem } from './mail-workspace-integrity.ts';
import type { MailScanResult, MailThread } from '../shared/mail-ingestion.ts';
import type { InboxReview } from '../shared/accounts-review.ts';
import type { JobRun, LoopRun, Recipe } from '../shared/contracts.ts';

vi.mock('./recipes.ts', () => ({ getRecipe: (id: string) => ({ id, capabilities: ['read-files'] }) }));
const resources: Array<{ root: string; database: WorkflowDatabase; services: ReturnType<typeof createMailIngestionService>[] }> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const resource of resources.splice(0)) {
    for (const service of resource.services) await service.close();
    resource.database.close();
    await rm(resource.root, { recursive: true, force: true });
  }
});
const day = 86_400_000;
const initialTime = Date.parse('2026-09-21T00:00:00Z');
async function fixture(start = initialTime) {
  const root = await mkdtemp(join(realpathSync(tmpdir()), 'rb-follow-up-'));
  const database = new WorkflowDatabase({ dir: root, key: Buffer.alloc(32, 7) });
  const resource = { root, database, services: [] as ReturnType<typeof createMailIngestionService>[] }; resources.push(resource);
  let time = start;
  const authority: MailAuthority = { accountId: 'mail-a', bindingRevision: 'a'.repeat(64), settingsRevision: 1,
    settings: { ...defaultAgencySettings(), workflowPackId: 'austin-office', agencyName: 'Fictional office', timeZone: 'Australia/Brisbane', gmailAccountId: 'mail-a',
      selectedWorkflows: ['morning-priorities'], mailScope: { historyDays: 7, includeSent: true, maxMessages: 100, attachments: 'metadata-only' } } };
  const thread: MailThread = { id: 'abc', historyComplete: true, messages: [{ id: 'aa', threadId: 'abc', at: start - 1000,
    direction: 'outgoing', from: 'office@example.test', to: 'contact@example.test', subject: 'Fictional request', body: 'Please confirm the fictional appointment.', bodyTruncated: false, attachments: [] }] };
  const data: Pick<MailScanResult, 'threads' | 'pages' | 'paginationComplete' | 'gaps'> = { threads: [thread], pages: 1, paginationComplete: true, gaps: [] };
  const scan = vi.fn(async (current: MailAuthority, request: Parameters<Parameters<typeof createMailIngestionService>[0]['scan']>[1]): Promise<MailScanResult> =>
    ({ ...structuredClone(data), accountId: current.accountId, windowStartAt: request.windowStartAt, windowEndAt: request.windowEndAt }));
  const options = { database, directory: root, workspaceId: 'fictional-follow-up-office', key: Buffer.alloc(32, 7), workroomDirectory: join(root, 'workroom'),
    authorize: async () => structuredClone(authority), scan, now: () => time };
  const open = () => { const service = createMailIngestionService(options); resource.services.push(service); return service; };
  let service = open();
  const recipe = { id: MORNING_MAIL_RECIPE, revision: 1, status: 'active', planApprovedAt: 1, approvedRevision: 1 } as Recipe;
  async function output(disposition: InboxReview['threads'][number]['disposition'] = 'waiting'): Promise<JobRun> {
    const input = JSON.parse(await readFile(join(options.workroomDirectory, 'workflow-inputs/accounts-inbox.json'), 'utf8'));
    const result: InboxReview = { version: 1, kind: 'accounts-inbox-triage', skillSource: 'email-inbox-triage@0.1.0', sourceReference: input.sourceReference,
      status: input.coverage.complete ? 'complete' : 'partial', coverageComplete: input.coverage.complete, actionsPerformed: [],
      holds: input.coverage.complete ? [] : [{ itemId: 'coverage', reason: 'Source coverage is incomplete.' }],
      threads: input.threads.map((t: { threadId: string; messages: { messageId: string }[] }) => ({ threadId: t.threadId, disposition, owner: 'accounts-reviewer', priority: 'normal',
        sourceMessageIds: t.messages.map(m => m.messageId), reason: 'Review the unanswered fictional request.', nextAction: 'Check the source before following up.', missingFacts: [] })) };
    return { id: randomUUID(), jobId: recipe.id, status: 'awaiting-approval', evidence: [{ kind: 'output', note: JSON.stringify(result) }] } as JobRun;
  }
  const execute = vi.fn(async () => ({ run: await output() }));
  const morning = () => runMorningMailWorkflow({ id: randomUUID(), manual: false, scheduledFor: time } as LoopRun, {
    collect: () => service.collect(), prepareInput: () => service.prepareInput(), applyReview: run => service.applyReview(run),
    recipe: () => recipe, admitPack: async () => {}, execute,
  });
  return { get service() { return service; }, authority, thread, data, scan, execute, morning, output,
    advance: (ms: number) => { time += ms; }, setTime: (at: number) => { time = at; },
    restart: async () => { await service.close(); resource.services.splice(resource.services.indexOf(service), 1); service = open(); },
    item: async () => (await service.page({ group: 'all' })).items[0], workspaceId: options.workspaceId };
}

describe('unanswered conversation calendar aging through the real mail workflow', () => {
  it('reviews unchanged waiting mail once when due, retains its source and survives restart', async () => {
    const f = await fixture();
    expect(await f.morning()).toMatchObject({ ok: true });
    const original = await f.item();
    expect(original).toMatchObject({ disposition: 'waiting', reviewed: false, newEvidence: false });
    expect(original.followUpReviewedKey).toBeUndefined();
    f.advance(2 * day); await f.morning(); expect(f.execute).toHaveBeenCalledTimes(1);
    await f.restart(); f.advance(day);
    expect(await f.morning()).toMatchObject({ ok: true, status: 'awaiting-approval' });
    const due = await f.item();
    expect(f.execute).toHaveBeenCalledTimes(2);
    expect(due.followUpReviewedKey).toMatch(/^[a-f0-9]{64}$/);
    expect(due.sourceDigest).toBe(original.sourceDigest);
    expect(due.sourceReceiptId).toBe(original.sourceReceiptId);
    expect(f.scan.mock.calls.at(-1)![1].carryThreadIds).toEqual(['abc']);
    await f.restart(); f.advance(day); await f.morning();
    expect(f.execute).toHaveBeenCalledTimes(2); expect(await f.item()).toEqual(due);
    f.thread.messages.push({ ...f.thread.messages[0], id: 'ab', at: initialTime + 4 * day - 1000 });
    await f.morning(); expect(f.execute).toHaveBeenCalledTimes(3);
    f.advance(3 * day); await f.morning(); expect(f.execute).toHaveBeenCalledTimes(4);
    expect((await f.item()).followUpReviewedKey).not.toBe(due.followUpReviewedKey);
  });

  it('counts an initial review already past due without immediately repeating the same batch', async () => {
    const f = await fixture(); f.thread.messages[0].at -= 4 * day;
    expect(await f.morning()).toMatchObject({ ok: true });
    expect(f.execute).toHaveBeenCalledTimes(1); expect((await f.item()).followUpReviewedKey).toMatch(/^[a-f0-9]{64}$/);
    expect(await f.service.prepareInput()).toBeNull();
  });

  it('keeps all staff task choices while recording one separate due review', async () => {
    const f = await fixture(); await f.morning(); const item = await f.item();
    await f.service.update(item.id, { expectedRevision: item.revision, priority: 'high', owner: 'Fictional manager', note: 'Do not change my choice.', nextAction: 'Call after reviewing the file.' });
    const staff = await f.item(); f.advance(3 * day);
    expect(await f.morning()).toMatchObject({ ok: true });
    const due = await f.item();
    expect(due).toEqual({ ...staff, revision: staff.revision + 1, updatedAt: initialTime + 3 * day, followUpReviewedKey: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(f.execute).toHaveBeenCalledTimes(2);
    f.advance(day); await f.morning(); expect(await f.item()).toEqual(due); expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it.each(['done', 'snoozed', 'reference', 'noise'] as const)('does not age a staff %s exclusion', async exclusion => {
    const f = await fixture(); await f.morning(); const item = await f.item();
    await f.service.update(item.id, { expectedRevision: item.revision,
      ...(['done', 'snoozed'].includes(exclusion) ? { status: exclusion, ...(exclusion === 'snoozed' ? { snoozedUntil: initialTime + 5 * day } : {}) } : { disposition: exclusion }) });
    const excluded = await f.item(); f.advance(3 * day); await f.morning();
    expect(f.execute).toHaveBeenCalledTimes(1); expect(await f.item()).toEqual(excluded);
    if (exclusion === 'snoozed') {
      f.advance(2 * day); await f.morning();
      expect(f.execute).toHaveBeenCalledTimes(2);
      expect(await f.item()).toMatchObject({ status: 'open', reviewed: true, snoozedUntil: null, followUpReviewedKey: expect.any(String) });
    }
  });

  it('does not call an answered conversation overdue and permits a later outgoing message its own interval', async () => {
    const f = await fixture(); await f.morning();
    const item = await f.item(); await f.service.update(item.id, { expectedRevision: item.revision, note: 'Retain staff ranking.' });
    f.advance(3 * day);
    f.thread.messages.push({ ...f.thread.messages[0], id: 'ab', at: initialTime + day, direction: 'incoming', body: 'The fictional appointment is confirmed.' });
    await f.morning(); expect(f.execute).toHaveBeenCalledTimes(1);
    expect(await f.item()).toMatchObject({ newEvidence: true, reviewed: true, note: 'Retain staff ranking.' });
    expect((await f.item()).followUpReviewedKey).toBeUndefined();
    f.thread.messages.push({ ...f.thread.messages[0], id: 'ac', at: initialTime + 3 * day - 1000, body: 'Please confirm the next fictional appointment.' });
    await f.morning(); expect(f.execute).toHaveBeenCalledTimes(1);
    f.advance(3 * day); await f.morning(); expect(f.execute).toHaveBeenCalledTimes(2);
    expect((await f.item()).followUpReviewedKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(['partial', 'missing', 'incomplete-history', 'failed'] as const)('requires a fresh complete current thread after a %s scan', async defect => {
    const f = await fixture(); await f.morning(); f.advance(3 * day);
    if (defect === 'partial') { f.data.paginationComplete = false; f.data.gaps = ['A page was unavailable.']; }
    if (defect === 'missing') f.data.threads = [];
    if (defect === 'incomplete-history') { f.thread.historyComplete = false; f.data.gaps = ['Thread history is incomplete.']; }
    if (defect === 'failed') f.scan.mockRejectedValueOnce(new Error('Synthetic provider failure'));
    if (defect === 'failed') await expect(f.morning()).rejects.toThrow('Synthetic provider failure'); else await f.morning();
    expect(f.execute).toHaveBeenCalledTimes(1); expect((await f.item()).followUpReviewedKey).toBeUndefined();
    f.data.paginationComplete = true; f.data.gaps = []; f.data.threads = [f.thread]; f.thread.historyComplete = true;
    await f.morning(); expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it.each(['unknown', 'tied', 'sent-excluded'] as const)('does not assert an unanswered interval with %s evidence', async defect => {
    const f = await fixture();
    if (defect === 'unknown') { f.thread.messages[0].direction = 'unknown'; f.data.gaps = ['Message direction is unknown.']; }
    if (defect === 'tied') f.thread.messages.unshift({ ...f.thread.messages[0], id: 'a0', direction: 'incoming' });
    if (defect === 'sent-excluded') f.authority.settings.mailScope.includeSent = false;
    await f.service.collect(); const item = await f.item();
    await f.service.update(item.id, { expectedRevision: item.revision, disposition: 'waiting' });
    f.advance(3 * day); await f.morning();
    expect(f.execute).not.toHaveBeenCalled(); expect((await f.item()).followUpReviewedKey).toBeUndefined();
  });

  it.each(['failed', 'invalid'] as const)('does not consume eligibility after a %s worker result', async defect => {
    const f = await fixture(); await f.morning(); f.advance(3 * day);
    f.execute.mockImplementationOnce(async () => {
      const run = await f.output();
      if (defect === 'failed') run.status = 'failed';
      else { const review = JSON.parse(run.evidence[0].note); review.threads[0].sourceMessageIds = ['ffff']; run.evidence[0].note = JSON.stringify(review); }
      return { run };
    });
    expect(await f.morning()).toMatchObject({ ok: false }); expect((await f.item()).followUpReviewedKey).toBeUndefined();
    await f.restart(); expect(await f.morning()).toMatchObject({ ok: true }); expect(f.execute).toHaveBeenCalledTimes(3);
    expect((await f.item()).followUpReviewedKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses a prepared follow-up after a newer scan finds a reply', async () => {
    const f = await fixture(); await f.morning(); f.advance(3 * day);
    await f.service.collect(); expect(await f.service.prepareInput()).not.toBeNull(); const stale = await f.output();
    f.thread.messages.push({ ...f.thread.messages[0], id: 'ab', direction: 'incoming', at: initialTime + 3 * day - 1000 });
    await f.service.collect();
    await expect(f.service.applyReview(stale)).rejects.toThrow('current mail evidence');
    expect((await f.item()).followUpReviewedKey).toBeUndefined();
  });

  it('retains a staff exclusion made during a pending follow-up and leaves the interval unconsumed', async () => {
    const f = await fixture(); await f.morning(); f.advance(3 * day);
    await f.service.collect(); expect(await f.service.prepareInput()).not.toBeNull(); const run = await f.output(), item = await f.item();
    await f.service.update(item.id, { expectedRevision: item.revision, status: 'done', note: 'Resolved while the review was running.' });
    const decided = await f.item(); await f.service.applyReview(run);
    expect(await f.item()).toEqual(decided); expect(decided.followUpReviewedKey).toBeUndefined();
  });

  it('uses office calendar dates across a DST change rather than elapsed 24-hour periods', async () => {
    const start = Date.parse('2026-10-03T15:05:00Z'); // Sydney October 4, before the DST jump.
    const f = await fixture(start); f.authority.settings.timeZone = 'Australia/Sydney'; f.authority.settings.morningReview.followUpAfterDays = 1;
    await f.morning(); f.setTime(Date.parse('2026-10-04T12:59:59Z')); await f.morning(); expect(f.execute).toHaveBeenCalledTimes(1);
    f.advance(1000); await f.morning(); // October 5 midnight, less than 22 hours after sending.
    expect(f.execute).toHaveBeenCalledTimes(2); expect((await f.item()).followUpReviewedKey).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires fresh evidence when confirmed follow-up settings change and rejects malformed markers', async () => {
    const f = await fixture(); await f.morning(); f.advance(3 * day); await f.morning(); const old = await f.item();
    f.authority.settings.morningReview.followUpAfterDays = 4; f.authority.settingsRevision++;
    await expect(f.service.prepareInput()).rejects.toThrow('Mail settings changed');
    f.advance(day); await f.morning(); const current = await f.item();
    expect(current.followUpReviewedKey).not.toBe(old.followUpReviewedKey); expect(f.execute).toHaveBeenCalledTimes(3);
    expect(validMailWorkItem(current, f.workspaceId)).toBe(true);
    const { followUpReviewedKey: _marker, ...legacy } = current;
    expect(validMailWorkItem(legacy, f.workspaceId)).toBe(true);
    for (const invalid of [null, 3, 'A'.repeat(64), 'bad', { key: current.followUpReviewedKey }])
      expect(validMailWorkItem({ ...current, followUpReviewedKey: invalid }, f.workspaceId)).toBe(false);
  });
});
