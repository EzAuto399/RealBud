import type { JobRun, Loop, LoopRun, ScheduleRecovery } from "@shared/contracts";

const MAX_RUNS = 2_000;
type RunProgress = { status: string; finishedAt?: number; seenAt?: number };
const progress = (run: RunProgress): number => run.status === "queued" ? 0 : run.status === "running" ? 1 : 2;

/** HTTP snapshots can arrive after a newer SSE receipt. One immutable run
 * never goes back from settled to active, or from running to queued. */
function mergeRun<T extends RunProgress>(current: T | undefined, incoming: T): T {
  if (!current) return { ...incoming };
  const currentProgress = progress(current);
  const incomingProgress = progress(incoming);
  const keepCurrent = currentProgress > incomingProgress ||
    (currentProgress === 2 && incomingProgress === 2 && (current.finishedAt ?? 0) > (incoming.finishedAt ?? 0));
  const selected = keepCurrent ? current : incoming;
  const seenAt = Math.max(current.seenAt ?? 0, incoming.seenAt ?? 0);
  return { ...selected, ...(seenAt > 0 ? { seenAt } : {}) };
}

/** Preserve receipts missing from a delayed snapshot, while bounding the
 * client to the same newest-2,000 history window as the scheduler. */
export function mergeLoopRuns(current: readonly LoopRun[], incoming: readonly LoopRun[]): LoopRun[] {
  const byId = new Map<string, LoopRun>();
  for (const run of [...current, ...incoming]) byId.set(run.id, mergeRun(byId.get(run.id), run));
  return [...byId.values()]
    .sort((a, b) => b.scheduledFor - a.scheduledFor || b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    .slice(0, MAX_RUNS);
}

/** Preserve the complete selected job receipt, including draft output and
 * held approvals, when a delayed read still describes its earlier work. */
export function mergeJobRuns(current: readonly JobRun[], incoming: readonly JobRun[]): JobRun[] {
  const byId = new Map<string, JobRun>();
  for (const run of [...current, ...incoming]) byId.set(run.id, mergeRun(byId.get(run.id), run));
  return [...byId.values()]
    .sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, 200);
}

/** An older read cannot undo a newer pause, retune, or approved plan. Equal
 * revisions may still carry a fresh next-run time, so incoming wins ties. */
export function mergeLoopClock(current: Loop | undefined, incoming: Loop): Loop {
  const selected = current && current.revision > incoming.revision ? current : incoming;
  return { ...selected, schedule: { ...selected.schedule, weekdays: [...selected.schedule.weekdays] } };
}

/** A complete catalog response owns membership, including deleted jobs. */
export function mergeLoopClocks(current: readonly Loop[], incoming: readonly Loop[]): Loop[] {
  const byId = new Map(current.map((loop) => [loop.id, loop]));
  return incoming.map((loop) => mergeLoopClock(byId.get(loop.id), loop));
}

/** A live process cannot recover merely because an earlier GET said it was
 * healthy. Only a different server generation can clear its recovery hold. */
export function mergeScheduleRecovery(current: ScheduleRecovery, incoming: ScheduleRecovery): ScheduleRecovery {
  const newGeneration = Boolean(incoming.generation && incoming.generation !== current.generation);
  return current.active && !incoming.active && !newGeneration ? { ...current } : { ...incoming };
}
