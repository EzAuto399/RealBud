import { describe, expect, it, vi } from 'vitest';
import { knownMailSenders, NOISE_THRESHOLD, runMorningMailWorkflow, screenMailNoise } from './morning-mail-workflow.ts';
import type { JevFailure, JevRequest, JevResult } from './jev-client.ts';
import type { JobRun, LoopRun, Recipe } from '../shared/contracts.ts';
import type { MailMessage, MailScanReceipt, MailThread, MailWorkspaceMetadata } from '../shared/mail-ingestion.ts';
import type { SupplierDirectory } from '../shared/supplier-directory.ts';
const clock = { id: 'clock-1', manual: false, scheduledFor: 1 } as LoopRun;
const recipe = { id: 'recipe-mail', revision: 4, status: 'active', planApprovedAt: 1, approvedRevision: 4 } as Recipe;
function fixture(count: number, partial = false, noise = 0) {
  let remaining = count;
  const scan = { id: 'source-1', accountId: 'mail-a', bindingRevision: 'binding-a', status: partial ? 'partial' : 'complete', threadCount: count } as MailScanReceipt;
  const state = { version: 2, revision: 1, latestScan: scan, latestReview: null, nextSnoozeAt: null,
    counts: { total: count, open: count, waiting: 0, reference: 0, done: 0, snoozed: 0, highPriority: 0, needsReview: count } } satisfies MailWorkspaceMetadata;
  const deps = { recipe: () => recipe, admitPack: vi.fn(async () => {}), collect: vi.fn(async () => state),
    prepareInput: vi.fn(async () => remaining ? { ...scan,batchThreadCount:Math.min(20,remaining) } : null),
    applyReview: vi.fn(async () => { remaining-=Math.min(20,remaining); return state; }),
    execute: vi.fn(async () => ({run:{id:`job-${remaining}`,status:'awaiting-approval',detail:'Prepared'} as JobRun})),
    screen: vi.fn(async () => { remaining -= noise; }) };
  return deps;
}
describe('morning mail workflow orchestration', () => {
  it('prepares a busy inbox in distinct bounded jobs under the same clock receipt', async () => {
    const deps=fixture(65); const result=await runMorningMailWorkflow(clock,deps);
    expect(result).toMatchObject({ok:true,status:'awaiting-approval'}); expect(result.detail).toContain('65 prepared');
    expect(deps.execute).toHaveBeenCalledTimes(4); expect(deps.applyReview).toHaveBeenCalledTimes(4);
    const requests=deps.execute.mock.calls as unknown as Array<[Recipe,{idempotencyKey:string;loopRunId:string}]>;
    expect(new Set(requests.map(c=>c[1].idempotencyKey)).size).toBe(4); expect(requests.every(c=>c[1].loopRunId===clock.id)).toBe(true);
  });
  it('retains partial source coverage after successful classification', async () => {
    expect(await runMorningMailWorkflow(clock,fixture(3,true))).toMatchObject({ok:true,status:'partial'});
  });
  it('does not collect or call a model for an unapproved plan', async () => {
    const deps=fixture(2); deps.recipe=()=>({...recipe,approvedRevision:3});
    expect((await runMorningMailWorkflow(clock,deps)).ok).toBe(false); expect(deps.collect).not.toHaveBeenCalled(); expect(deps.execute).not.toHaveBeenCalled();
  });
  it('keeps completed batches and stops paid work when the plan changes', async () => {
    const deps=fixture(25); let reads=0; deps.recipe=()=>({...recipe,revision:++reads>2?5:4,approvedRevision:reads>2?5:4});
    expect(await runMorningMailWorkflow(clock,deps)).toMatchObject({ok:false,status:'partial'}); expect(deps.execute).toHaveBeenCalledTimes(1);
  });
  it.each(['id', 'accountId', 'bindingRevision'] as const)('holds a changed source %s before spending a model call', async field => {
    const deps = fixture(25), prepare = deps.prepareInput.getMockImplementation()!;
    deps.prepareInput = vi.fn(async () => ({ ...(await prepare())!, [field]: 'replacement-source' }));

    const result = await runMorningMailWorkflow(clock, deps);

    expect(result).toMatchObject({ ok: false, status: 'failed' });
    expect(result.detail).toContain('Gmail source changed');
    expect(result).not.toHaveProperty('jobRunId');
    expect(deps.execute).not.toHaveBeenCalled();
    expect(deps.applyReview).not.toHaveBeenCalled();
  });
  it.each(['id', 'accountId', 'bindingRevision'] as const)('keeps the first saved batch when the source %s changes before the next batch', async field => {
    const deps = fixture(25), prepare = deps.prepareInput.getMockImplementation()!;
    let calls = 0;
    deps.prepareInput = vi.fn(async () => {
      const source = (await prepare())!;
      return ++calls === 1 ? source : { ...source, [field]: 'replacement-source', status: 'partial' as const };
    });

    const result = await runMorningMailWorkflow(clock, deps);

    expect(result).toMatchObject({ ok: false, status: 'partial', jobRunId: 'job-25' });
    expect(result.detail).toContain('completed review batches were kept');
    expect(deps.execute).toHaveBeenCalledTimes(1);
    expect(deps.applyReview).toHaveBeenCalledTimes(1);
    expect(deps.prepareInput).toHaveBeenCalledTimes(2);
  });
  it('preserves failure and never applies failed worker output', async () => {
    const deps=fixture(4); deps.execute=vi.fn(async()=>({run:{id:'failed-job',status:'failed',detail:'Provider unavailable'} as JobRun}));
    expect(await runMorningMailWorkflow(clock,deps)).toMatchObject({ok:false,status:'failed',jobRunId:'failed-job'}); expect(deps.applyReview).not.toHaveBeenCalled();
  });
  it('does not spend a model call on an empty or already reviewed scan', async () => {
    const deps=fixture(0); expect(await runMorningMailWorkflow(clock,deps)).toMatchObject({ok:true,status:'completed'}); expect(deps.execute).not.toHaveBeenCalled();
  });
  it('finishes an empty morning when retained history contains only completed tasks', async () => {
    const deps = fixture(0), state = await deps.collect();
    state.counts = { ...state.counts, total: 3_000, done: 3_000 };
    expect(await runMorningMailWorkflow(clock, deps)).toMatchObject({ ok: true, status: 'completed' });
    expect(deps.execute).not.toHaveBeenCalled();
    expect(state).not.toHaveProperty('items');
  });
  it('keeps outstanding retained work visible even when the new scan needs no model batch', async () => {
    const deps = fixture(0), state = await deps.collect();
    state.counts = { ...state.counts, total: 3_001, done: 3_000, waiting: 1 };
    expect(await runMorningMailWorkflow(clock, deps)).toMatchObject({ ok: true, status: 'awaiting-approval' });
    expect(deps.execute).not.toHaveBeenCalled();
  });
  it('runs fewer batches when the screen saves noise', async () => {
    const plain = fixture(40), screened = fixture(40, false, 20);
    await runMorningMailWorkflow(clock, plain); await runMorningMailWorkflow(clock, screened);
    expect(plain.execute).toHaveBeenCalledTimes(2); expect(screened.execute).toHaveBeenCalledTimes(1);
  });
  it('screens before batching, and a failed screen leaves every thread in the batches', async () => {
    const deps = fixture(25); deps.screen.mockRejectedValueOnce(new Error('Fictional Jev outage'));
    expect(await runMorningMailWorkflow(clock, deps)).toMatchObject({ ok: true, status: 'awaiting-approval' });
    expect(deps.screen).toHaveBeenCalledTimes(1);
    expect(deps.screen.mock.invocationCallOrder[0]).toBeLessThan(deps.prepareInput.mock.invocationCallOrder[0]!);
    expect(deps.execute).toHaveBeenCalledTimes(2);
  });
});

const MODEL = 'typesafe/jev-1.13-20260917';
function mail(id: string, patch: Partial<MailMessage> = {}, extra: Partial<MailThread> = {}): MailThread {
  return { id, historyComplete: true, ...extra, messages: [{ id: `${id}0`, threadId: id, at: 1, direction: 'incoming', from: `Fictional Sender <news@${id}.example.test>`,
    to: 'accounts@example.test', subject: `Fictional subject ${id}`, body: 'Fictional body text.', bodyTruncated: false, attachments: [], ...patch }] };
}
type State = Record<string, { senderDomain: string; subject: string; snippet: string }>;
/** Fake Jev: P(noise) from each thread's state. */
const answering = (noul: (thread: State[string]) => number) => vi.fn(async (request: JevRequest): Promise<JevResult> => ({ ok: true, model: MODEL, ms: 1,
  answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: 'noul' as const, noul: noul((request.state as State)[key]!) }])) }));
const nobody = () => false;
describe('Jev noise pre-screen', () => {
  it('screens noise and keeps real items', async () => {
    const decide = answering(t => t.subject.includes('newsletter') ? 0.99 : 0.02);
    const result = await screenMailNoise([mail('a1', { subject: 'Fictional weekly newsletter' }), mail('b2', { subject: 'Leaking tap at the fictional unit' })], { decide, known: nobody });
    expect(result).toEqual({ noise: ['a1'], model: MODEL });
  });
  it('sends a thread below the threshold to Bud', async () => {
    const decide = answering(t => t.subject.includes('edge') ? NOISE_THRESHOLD : 0.96);
    expect(await screenMailNoise([mail('a1'), mail('b2', { subject: 'Fictional edge case' })], { decide, known: nobody })).toEqual({ noise: ['b2'], model: MODEL });
  });
  it.each(['refused', 'budget', 'unavailable', 'timeout', 'invalid'] satisfies JevFailure[])('keeps answered batches after a %s answer; the failed batch stays unscreened', async reason => {
    const ok = answering(() => 0.99);
    const decide = vi.fn(async (request: JevRequest): Promise<JevResult> => decide.mock.calls.length === 2 ? { ok: false, reason } : ok(request));
    const threads = Array.from({ length: 20 }, (_, n) => mail((0xa0 + n).toString(16)));
    const ids = threads.map(t => t.id);
    expect(await screenMailNoise(threads, { decide, known: nobody })).toEqual({ noise: [...ids.slice(0, 8), ...ids.slice(16)], model: MODEL });
    expect(decide).toHaveBeenCalledTimes(3);
  });
  it('screens nothing when every call fails or throws', async () => {
    const threads = Array.from({ length: 20 }, (_, n) => mail((0xa0 + n).toString(16)));
    const refused = vi.fn(async (): Promise<JevResult> => ({ ok: false, reason: 'refused' }));
    expect(await screenMailNoise(threads, { decide: refused, known: nobody })).toBeNull();
    expect(refused).toHaveBeenCalledTimes(3);
    const throwing = vi.fn(async (): Promise<JevResult> => { throw new Error('fictional Jev failure'); });
    expect(await screenMailNoise(threads, { decide: throwing, known: nobody })).toBeNull();
    const ok = answering(() => 0.99);
    const mixed = vi.fn(async (request: JevRequest): Promise<JevResult> => { if (mixed.mock.calls.length === 1) throw new Error('fictional Jev failure'); return ok(request); });
    expect((await screenMailNoise(threads, { decide: mixed, known: nobody }))?.noise).toEqual(threads.slice(8).map(t => t.id));
  });
  it('keeps at most three calls in flight', async () => {
    const ok = answering(() => 0.99);
    let open = 0, most = 0;
    const decide = vi.fn(async (request: JevRequest): Promise<JevResult> => {
      most = Math.max(most, ++open);
      await new Promise(resolve => setTimeout(resolve, 5));
      open--; return ok(request);
    });
    const threads = Array.from({ length: 40 }, (_, n) => mail((0xa0 + n).toString(16)));
    expect((await screenMailNoise(threads, { decide, known: nobody }))?.noise).toEqual(threads.map(t => t.id));
    expect(decide).toHaveBeenCalledTimes(5);
    expect(most).toBe(3);
  });
  it('never sends or screens a thread from a known sender', async () => {
    const suppliers = { version: 1, purpose: 'supplier-directory', revision: 1, importedAt: 0, rejected: [],
      suppliers: [{ reference: 'FS-PLUMB', description: 'Fictional plumbing', emails: ['jobs@fictional-plumbing.example'] }],
      aliases: [{ reference: 'FS-PLUMB', email: 'billing@fictional-plumbing.example', addedAt: 0 }] } satisfies SupplierDirectory;
    const known = knownMailSenders(suppliers, [{ owner: { name: 'Fictional Owner', contact: 'Fictional Owner <owner@fictional-owner.example>' } }, {}]);
    const decide = answering(() => 0.99);
    const threads = [mail('a1', { from: 'jobs@fictional-plumbing.example' }), mail('b2', { from: 'Plumbing <BILLING@fictional-plumbing.example>' }),
      mail('c3', { from: 'owner@fictional-owner.example' }), mail('d4')];
    const later = mail('e5'); later.messages.unshift({ ...mail('e5', { from: 'jobs@fictional-plumbing.example' }).messages[0]!, id: 'e50a', at: 0 });
    expect(await screenMailNoise([...threads, later], { decide, known })).toEqual({ noise: ['d4'], model: MODEL });
    const sent = JSON.stringify(decide.mock.calls);
    expect(sent).not.toContain('fictional-plumbing'); expect(sent).not.toContain('fictional-owner');
    expect(await screenMailNoise(threads.slice(0, 3), { decide, known })).toBeNull();
    expect(decide).toHaveBeenCalledTimes(1);
  });
  it('sends only the sender domain, subject and a redacted 600-character snippet, never bodies or attachments', async () => {
    const decide = answering(() => 0.5);
    const body = `Fictional offer. password: fictional-pass-123456 ${'More fictional words. '.repeat(100)}TAIL-MARKER`;
    await screenMailNoise([
      mail('a1', { from: 'Fictional News <news-local@fictional-news.example>', body, bodyTruncated: true }),
      mail('b2', { attachments: [{ id: 'att-1', name: 'fictional-lease.pdf', mimeType: 'application/pdf', size: 10 }], body: 'ATTACHMENT-BODY' }),
      mail('c3', { direction: 'outgoing', body: 'OUTGOING-BODY' }), mail('d4', { body: 'PARTIAL-HISTORY' }, { historyComplete: false }),
      mail('e5', { from: 'One <a@one.example>, Two <b@two.example>', body: 'AMBIGUOUS-SENDER' }),
    ], { decide, known: nobody });
    expect(decide).toHaveBeenCalledTimes(1);
    const [request] = decide.mock.calls[0]!, state = request.state as State, sent = JSON.stringify(request);
    expect(Object.keys(request.questions)).toEqual(['t0']);
    expect(request.questions.t0).toMatchObject({ type: 'noul', criteria: { false: expect.stringContaining('property, tenant, owner, supplier, payment, maintenance') } });
    expect(Object.keys(state.t0!).sort()).toEqual(['senderDomain', 'snippet', 'subject']);
    expect(state.t0).toMatchObject({ senderDomain: 'fictional-news.example', subject: 'Fictional subject a1' });
    expect(state.t0!.snippet.length).toBeLessThanOrEqual(600); expect(state.t0!.snippet).toMatch(/^Fictional offer\. password: «redacted/);
    for (const hidden of ['TAIL-MARKER', 'fictional-pass-123456', 'news-local', 'accounts@example.test', 'fictional-lease', 'att-1', 'ATTACHMENT-BODY', 'OUTGOING-BODY', 'PARTIAL-HISTORY', 'AMBIGUOUS-SENDER'])
      expect(sent).not.toContain(hidden);
  });
  it('asks up to eight threads per call, keyed t0 to t7', async () => {
    const decide = answering(() => 0.99), threads = Array.from({ length: 10 }, (_, n) => mail((0xa0 + n).toString(16)));
    expect((await screenMailNoise(threads, { decide, known: nobody }))?.noise).toEqual(threads.map(t => t.id));
    expect(decide.mock.calls.map(([request]) => Object.keys(request.questions))).toEqual([['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'], ['t0', 't1']]);
  });
});
