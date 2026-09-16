import { BATCH_LIMIT, type BatchItem, type WorkBatch } from "../../shared/batches";

export type BatchReviewFilter = "all" | "unreviewed" | "attention" | "reviewed";

export function batchResultReady(item: BatchItem): boolean {
  return item.status === "ready" || item.status === "needs-review";
}

export function filterBatchResults(items: readonly BatchItem[], filter: BatchReviewFilter, search = ""): BatchItem[] {
  const query = search.trim().toLocaleLowerCase();
  return items.filter(item => {
    if (!item.address.toLocaleLowerCase().includes(query)) return false;
    if (filter === "unreviewed") return batchResultReady(item) && !item.reviewedAt;
    if (filter === "reviewed") return Boolean(item.reviewedAt);
    if (filter === "attention") return !item.reviewedAt && ["needs-review", "failed", "interrupted"].includes(item.status);
    return true;
  });
}

/** Reuse the PM's task and exact property membership, never old facts or results.
 * Selection is staged for review; creating the batch captures a fresh snapshot. */
export function repeatBatchDraft(batch: WorkBatch, currentPropertyIds: readonly string[]) {
  const current = new Set(currentPropertyIds);
  const seen = new Set<string>();
  const ids: string[] = [];
  const missing: string[] = [];
  for (const item of batch.items) {
    if (seen.has(item.propertyId)) continue;
    seen.add(item.propertyId);
    if (!current.has(item.propertyId)) missing.push(item.address);
    else if (ids.length < BATCH_LIMIT) ids.push(item.propertyId);
  }
  return {
    selection: { ids, task: batch.task, instruction: batch.instruction, autoContinue: batch.autoContinue === true },
    missing,
  };
}
