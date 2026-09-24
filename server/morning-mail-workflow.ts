import type { JobRun, LoopRun, Recipe } from '../shared/contracts.ts';
import { recipeClockRunnable } from '../shared/contracts.ts';
import type { MailScanReceipt, MailWorkspaceMetadata } from '../shared/mail-ingestion.ts';
import type { LoopExecuteResult } from './routines.ts';

interface Dependencies {
  collect: () => Promise<MailWorkspaceMetadata>;
  prepareInput: () => Promise<(MailScanReceipt & { batchThreadCount: number }) | null>;
  applyReview: (run: JobRun) => Promise<MailWorkspaceMetadata>;
  recipe: () => Recipe | undefined | Promise<Recipe | undefined>;
  admitPack: (recipeId: string) => Promise<void>;
  execute: (recipe: Recipe, request: { mode: 'prepare'; trigger: 'manual' | 'schedule'; scheduledFor: number; loopRunId: string; idempotencyKey: string }) => Promise<{ run: JobRun }>;
}
/** Bounded batches keep a busy inbox inside the worker's established output
 * contract. Each batch has its own durable job receipt under one clock run. */
export async function runMorningMailWorkflow(run: LoopRun, deps: Dependencies): Promise<LoopExecuteResult> {
  const first = await deps.recipe();
  if (!first || !recipeClockRunnable(first)) return { ok: false, detail: 'Approve the current morning plan in Schedule before collecting and preparing mail.' };
  await deps.admitPack(first.id);
  const state = await deps.collect(), scan = state.latestScan;
  if (!scan || !['complete','partial'].includes(scan.status)) return { ok: false, detail: 'Mail collection did not produce a usable source receipt.' };
  let jobRunId: string | undefined, reviewed = 0;
  try {
  for (let batch = 0; batch < 5; batch++) {
    const source = await deps.prepareInput();
    if (!source) return { ok: true, status: scan.status === 'partial' ? 'partial' : state.counts.open + state.counts.waiting > 0 ? 'awaiting-approval' : 'completed',
      detail: `${scan.threadCount} conversations collected; ${reviewed} prepared for internal review. Existing staff decisions were kept.${scan.status === 'partial' ? ' Source coverage is partial; check the scan receipt.' : ''}`, ...(jobRunId ? { jobRunId } : {}) };
    const recipe = await deps.recipe();
    if (!recipe || recipe.id !== first.id || !recipeClockRunnable(recipe) || recipe.revision !== first.revision) return { ok: false, status: reviewed ? 'partial' : 'failed', detail: 'The morning plan changed during preparation. Saved sources and completed review batches were kept.', ...(jobRunId ? { jobRunId } : {}) };
    await deps.admitPack(recipe.id);
    const result = await deps.execute(recipe, { mode: 'prepare', trigger: run.manual ? 'manual' : 'schedule', scheduledFor: run.scheduledFor,
      loopRunId: run.id, idempotencyKey: `morning-mail:${run.id}:${source.id}:${batch}` });
    jobRunId = result.run.id;
    if (!['completed','awaiting-approval'].includes(result.run.status)) return { ok: false, status: reviewed ? 'partial' : 'failed', detail: result.run.detail, jobRunId };
    await deps.applyReview(result.run); reviewed += source.batchThreadCount;
  }
  // The collector admits at most 100 threads, at 20 per batch. Verify that no
  // input appeared concurrently instead of claiming all work was reviewed.
  if (await deps.prepareInput()) return { ok: false, status: 'partial', detail: 'Five bounded review batches finished. Additional evidence remains for the next review.', jobRunId };
  return { ok: true, status: scan.status === 'partial' ? 'partial' : 'awaiting-approval', detail: `${scan.threadCount} conversations collected; ${reviewed} prepared for internal review.${scan.status === 'partial' ? ' Source coverage is partial; check the scan receipt.' : ''}`, jobRunId };
  } catch {
    return { ok: false, status: reviewed ? 'partial' : 'failed', detail: reviewed
      ? `${reviewed} conversations were saved for review before a later batch was held. Check the source and current plan before continuing.`
      : 'Morning preparation could not be confirmed. Collected evidence and prior task decisions were kept; check the source and current plan.', ...(jobRunId ? { jobRunId } : {}) };
  }
}
