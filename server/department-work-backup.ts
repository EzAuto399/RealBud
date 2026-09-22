/** Historical links only. No restored record grants company or worker authority. */
import { isDeepStrictEqual } from 'node:util';
import type { JobRun } from '../shared/contracts.ts';
import type { ExecutionReceipt, ExecutionRequestReceipt } from '../shared/execution-history.ts';
import type { ExecutionGraphReader } from './execution-history-backup.ts';
import { executionDigest, executionStream } from './execution-history.ts';
import { DEPARTMENT_WORK_KIND, validateSavedDepartmentWork } from './department-work.ts';
import { departmentWorkDigest } from './department-work-plan.ts';

function invalid(): never { throw Object.assign(new Error('Department preparation history does not match its workspace or execution receipts.'), { status: 400 }); }

/** Call after the ordinary execution graph validator has checked receipt integrity. */
export function validateDepartmentWorkGraph(reader: ExecutionGraphReader, workspaceId: string): void {
  const executions = new Set<string>(), stream = executionStream('job', 'job-runs.json');
  for (const row of reader.iterate(DEPARTMENT_WORK_KIND)) {
    validateSavedDepartmentWork(row.id, row.value);
    const saved = row.value;
    if (executions.has(saved.executionId) || executions.size >= 1000) invalid();
    executions.add(saved.executionId);
    if (saved.grant && (saved.grant.spec.executor.workspaceId !== workspaceId ||
        saved.grant.digest !== departmentWorkDigest(saved.grant.spec) ||
        saved.grant.spec.sourceDigest !== departmentWorkDigest(saved.grant.source))) invalid();
    const request = reader.get('execution-request', `request:${stream}:${executionDigest(saved.jobKey)}`)?.value as ExecutionRequestReceipt | undefined;
    if (!request) {
      // A request saved before enqueue and an explicitly recorded failure to
      // start are valid history. Neither invents a missing factual job run.
      if (saved.runId !== null || saved.delivery && (saved.delivery.runId !== `not-started:${saved.executionId}` || saved.delivery.outcome !== 'interrupted')) invalid();
      continue;
    }
    const receipt = reader.get('execution-job', `${stream}:${executionDigest(request.runId)}`)?.value as ExecutionReceipt<JobRun> | undefined;
    if (!saved.grant || !receipt || request.key !== saved.jobKey || request.binding !== receipt.binding ||
        saved.runId !== null && saved.runId !== request.runId) invalid();
    const run = receipt.run, review = saved.recipe.review;
    if (!review) invalid();
    const { siteNotes: _siteNotes, ...plan } = review.plan;
    if (run.id !== request.runId || run.idempotencyKey !== saved.jobKey || run.jobId !== saved.recipe.id ||
        run.jobRevision !== saved.recipe.revision || run.mode !== 'prepare' || run.trigger !== 'manual' ||
        !isDeepStrictEqual(run.spec, plan)) invalid();
    if (saved.delivery) {
      const outcome = run.status === 'interrupted' ? 'interrupted' : ['completed', 'awaiting-approval', 'partial'].includes(run.status) ? 'prepared' : 'failed';
      if (saved.runId !== run.id || saved.delivery.runId !== run.id || ['queued', 'running'].includes(run.status) || saved.delivery.outcome !== outcome) invalid();
    }
  }
}
