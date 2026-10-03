import { describe, expect, it, vi } from 'vitest';
import { runMorningMailWorkflow } from './morning-mail-workflow.ts';
import type { JobRun, LoopRun, Recipe } from '../shared/contracts.ts';
import type { MailScanReceipt, MailWorkspaceMetadata } from '../shared/mail-ingestion.ts';
const clock = { id: 'clock-1', manual: false, scheduledFor: 1 } as LoopRun;
const recipe = { id: 'recipe-mail', revision: 4, status: 'active', planApprovedAt: 1, approvedRevision: 4 } as Recipe;
function fixture(count: number, partial = false) {
  let remaining = count;
  const scan = { id: 'source-1', accountId: 'mail-a', bindingRevision: 'binding-a', status: partial ? 'partial' : 'complete', threadCount: count } as MailScanReceipt;
  const state = { version: 2, revision: 1, latestScan: scan, latestReview: null, nextSnoozeAt: null,
    counts: { total: count, open: count, waiting: 0, reference: 0, done: 0, snoozed: 0, highPriority: 0, needsReview: count } } satisfies MailWorkspaceMetadata;
  const deps = { recipe: () => recipe, admitPack: vi.fn(async () => {}), collect: vi.fn(async () => state),
    prepareInput: vi.fn(async () => remaining ? { ...scan,batchThreadCount:Math.min(20,remaining) } : null),
    applyReview: vi.fn(async () => { remaining-=Math.min(20,remaining); return state; }),
    execute: vi.fn(async () => ({run:{id:`job-${remaining}`,status:'awaiting-approval',detail:'Prepared'} as JobRun})) };
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
});
