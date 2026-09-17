import { describe, expect, it, vi } from "vitest";
import { beginManualJobRequest, confirmManualJobReceipt, pendingManualJobRequest } from "./manual-job-request";
import { manualJobRequestKey } from "../../shared/manual-job-request";

const firstId = "11111111-1111-4111-8111-111111111111";
const nextId = "22222222-2222-4222-8222-222222222222";
const scope = { id: "owner-job", revision: 1, mode: "prepare" } as const;
function storage() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
const receipt = (status: string) => ({
  jobId: scope.id, jobRevision: scope.revision, mode: scope.mode, status,
  idempotencyKey: manualJobRequestKey(scope.id, scope.revision, scope.mode, firstId),
});

describe("manual job request recovery", () => {
  it("reuses the persisted identity after a lost response or remount, then admits an explicit new run after a receipt", () => {
    const saved = storage();
    const create = vi.fn(() => firstId);
    expect(beginManualJobRequest(scope, saved, create)).toBe(firstId);
    expect(pendingManualJobRequest(scope, saved)).toBe(firstId);
    expect(beginManualJobRequest(scope, saved, () => nextId)).toBe(firstId);
    expect(confirmManualJobReceipt(scope, firstId, receipt("running"), saved)).toBe(false);
    expect(beginManualJobRequest(scope, saved, () => nextId)).toBe(firstId);
    expect(confirmManualJobReceipt(scope, firstId, receipt("completed"), saved)).toBe(true);
    expect(pendingManualJobRequest(scope, saved)).toBeNull();
    expect(beginManualJobRequest(scope, saved, () => nextId)).toBe(nextId);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("separates job, revision and mode while preventing an older response from clearing a newer request", () => {
    const saved = storage();
    beginManualJobRequest(scope, saved, () => firstId);
    expect(beginManualJobRequest({ ...scope, revision: 2 }, saved, () => nextId)).toBe(nextId);
    expect(beginManualJobRequest({ ...scope, mode: "shadow" }, saved, () => firstId)).toBe(firstId);
    expect(beginManualJobRequest({ ...scope, id: "other" }, saved, () => firstId)).toBe(firstId);
    confirmManualJobReceipt(scope, firstId, receipt("completed"), saved);
    expect(pendingManualJobRequest({ ...scope, revision: 2 }, saved)).toBe(nextId);
    expect(pendingManualJobRequest({ ...scope, mode: "shadow" }, saved)).toBe(firstId);
  });

  it.each(["failed", "partial", "awaiting-approval", "interrupted", "cancelled", "missed"])("allows deliberate new work after the %s receipt is confirmed", (status) => {
    const saved = storage();
    beginManualJobRequest(scope, saved, () => firstId);
    expect(confirmManualJobReceipt(scope, firstId, receipt(status), saved)).toBe(true);
    expect(beginManualJobRequest(scope, saved, () => nextId)).toBe(nextId);
  });

  it("keeps recovery identity when a response belongs to another job or revision", () => {
    const saved = storage();
    beginManualJobRequest(scope, saved, () => firstId);
    expect(() => confirmManualJobReceipt(scope, firstId, { ...receipt("completed"), jobRevision: 2 }, saved)).toThrow(/did not match/);
    expect(() => confirmManualJobReceipt(scope, firstId, { ...receipt("completed"), jobId: "other" }, saved)).toThrow(/did not match/);
    expect(pendingManualJobRequest(scope, saved)).toBe(firstId);
  });

  it("fails before sending if recovery cannot be saved and rejects corrupt recovery instead of inventing another run", () => {
    expect(() => beginManualJobRequest(scope, { getItem: () => null, setItem: () => { throw new Error("quota"); } }, () => firstId)).toThrow(/No work was started/);
    expect(() => beginManualJobRequest(scope, { getItem: () => "[]", setItem: () => {} }, () => firstId)).toThrow(/recovery data/);
    expect(() => beginManualJobRequest(scope, { getItem: () => '{"job":{"revision":1,"requestId":"invalid"}}', setItem: () => {} }, () => firstId)).toThrow(/recovery data/);
  });
});
