import type { JobRun, LoopRun } from "@shared/contracts";

export type WorkActivity =
  | { kind: "job"; id: string; at: number; run: JobRun }
  | { kind: "routine"; id: string; at: number; run: LoopRun };

/** A taught job's clock receipt is hidden in the merged feed, but still owns
 * its review acknowledgement and any Desk cases produced by that run. */
export function routineRunsForActivity(activity: WorkActivity, loopRuns: ReadonlyArray<LoopRun>): LoopRun[] {
  return activity.kind === "routine"
    ? [activity.run]
    : loopRuns.filter((run) => run.jobRunId === activity.run.id);
}

/** One chronological activity trail. A taught job produces both a clock run
 * and a durable JobRun; the JobRun is richer, so suppress its linked clock
 * wrapper rather than showing the PM the same work twice. Preserve the
 * source status, including a prepared result still awaiting the PM. */
export function buildWorkActivity(jobRuns: ReadonlyArray<JobRun>, loopRuns: ReadonlyArray<LoopRun>): WorkActivity[] {
  const jobIds = new Set(jobRuns.map((run) => run.id));
  const jobs: WorkActivity[] = jobRuns.map((run) => ({
    kind: "job",
    id: `job:${run.id}`,
    at: run.startedAt ?? run.createdAt,
    run,
  }));
  const routines: WorkActivity[] = loopRuns
    .filter((run) => !run.jobRunId || !jobIds.has(run.jobRunId))
    .map((run) => ({
      kind: "routine",
      id: `routine:${run.id}`,
      at: run.startedAt ?? run.createdAt ?? run.scheduledFor,
      run,
    }));
  return [...jobs, ...routines].sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
}
