import { describe, expect, it } from "vitest";
import type { BatchItem, WorkBatch } from "../../shared/batches";
import { filterBatchResults, repeatBatchDraft } from "./batch-review";

const item = (id: string, status: BatchItem["status"], reviewedAt?: number): BatchItem => ({
  propertyId: id, address: `${id} Oak Street`, source: "Old private source", status, attempt: 1,
  output: "Old result", detail: "", gaps: [], ...(reviewedAt ? { reviewedAt } : {}),
});
const items = [item("1", "ready"), item("2", "needs-review"), item("3", "failed"), item("4", "interrupted"), item("5", "queued"), item("6", "running"), item("7", "ready", 123)];

describe("batch review navigation", () => {
  it("separates usable drafts, unresolved exceptions, reviewed results and active work", () => {
    expect(filterBatchResults(items, "unreviewed").map(i => i.propertyId)).toEqual(["1", "2"]);
    expect(filterBatchResults(items, "attention").map(i => i.propertyId)).toEqual(["2", "3", "4"]);
    expect(filterBatchResults(items, "reviewed").map(i => i.propertyId)).toEqual(["7"]);
    expect(filterBatchResults(items, "all")).toHaveLength(7);
    expect(filterBatchResults(items, "unreviewed", " 2 OAK ").map(i => i.propertyId)).toEqual(["2"]);
    expect(filterBatchResults(items, "attention", "missing")).toEqual([]);
  });

  it("advances within the active filter without returning a reviewed result", () => {
    const updated = items.map(i => i.propertyId === "2" ? { ...i, reviewedAt: 456 } : i);
    expect(filterBatchResults(updated, "attention").map(i => i.propertyId)).toEqual(["3", "4"]);
    expect(filterBatchResults(updated, "unreviewed", "2")).toEqual([]);
  });
});

describe("repeat batch with current book", () => {
  const batch = { task: "owner-update", instruction: "Keep it concise", autoContinue: true, items, requestKey: "old-request", sourceRevision: 8 } as WorkBatch;

  it("copies exact surviving membership and instructions, excluding old authority and facts", () => {
    const result = repeatBatchDraft(batch, ["1", "2", "7", "new-unit"]);
    expect(result.selection).toEqual({ ids: ["1", "2", "7"], task: "owner-update", instruction: "Keep it concise", autoContinue: true });
    expect(result.missing).toEqual(["3 Oak Street", "4 Oak Street", "5 Oak Street", "6 Oak Street"]);
    expect(JSON.stringify(result)).not.toMatch(/Old private|Old result|old-request|sourceRevision|reviewedAt/);
    expect(batch.items).toEqual(items);
  });

  it("handles an empty book, duplicate membership and old continuation defaults", () => {
    expect(repeatBatchDraft(batch, []).selection.ids).toEqual([]);
    expect(repeatBatchDraft({ ...batch, autoContinue: undefined, items: [items[0], items[0]] }, ["1"]).selection)
      .toEqual({ ids: ["1"], task: "owner-update", instruction: "Keep it concise", autoContinue: false });
  });

  it("keeps 200 property selections stable without adding new units", () => {
    const large = Array.from({ length: 200 }, (_, n) => item(String(n), "ready"));
    const ids = large.map(i => i.propertyId);
    expect(repeatBatchDraft({ ...batch, items: large }, [...ids, "extra"]).selection.ids).toEqual(ids);
  });
});
