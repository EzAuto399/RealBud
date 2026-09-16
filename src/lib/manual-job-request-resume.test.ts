import { describe, expect, it } from "vitest";
import { beginManualJobRequest, confirmManualJobReceipt, pendingManualJobRequest, resumeManualJobRequest } from "./manual-job-request";
import { manualJobRequestKey } from "../../shared/manual-job-request";

const firstId = "11111111-1111-4111-8111-111111111111";
const nextId = "22222222-2222-4222-8222-222222222222";
const scope = { id: "owner-job", revision: 1, mode: "prepare" } as const;
function storage() {
  const data = new Map<string, string>();
  let writes = 0;
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); writes += 1; },
    get writes() { return writes; },
  };
}

describe("checking an existing manual job across windows", () => {
  it("does not create work when another window confirmed and cleared the cached operation", () => {
    const saved = storage();
    beginManualJobRequest(scope, saved, () => firstId);
    const otherWindowRequest = pendingManualJobRequest(scope, saved)!;
    confirmManualJobReceipt(scope, firstId, {
      jobId: scope.id, jobRevision: scope.revision, mode: scope.mode, status: "completed",
      idempotencyKey: manualJobRequestKey(scope.id, scope.revision, scope.mode, firstId),
    }, saved);
    const writes = saved.writes;
    expect(resumeManualJobRequest(scope, otherWindowRequest, saved)).toEqual({ ready: false, pendingRequestId: null });
    expect(saved.writes).toBe(writes);
    expect(pendingManualJobRequest(scope, saved)).toBeNull();
    // Only a separate, explicit start may allocate a new operation.
    expect(beginManualJobRequest(scope, saved, () => nextId)).toBe(nextId);
  });

  it("does not substitute a newer operation for the stale check action", () => {
    const saved = storage();
    beginManualJobRequest(scope, saved, () => nextId);
    const writes = saved.writes;
    expect(resumeManualJobRequest(scope, firstId, saved)).toEqual({ ready: false, pendingRequestId: nextId });
    expect(saved.writes).toBe(writes);
    expect(resumeManualJobRequest(scope, nextId, saved)).toEqual({ ready: true, requestId: nextId });
  });

  it("only resumes the same job, revision and mode with the exact hydrated ID", () => {
    const saved = storage();
    beginManualJobRequest(scope, saved, () => firstId);
    expect(resumeManualJobRequest(scope, firstId, saved)).toEqual({ ready: true, requestId: firstId });
    for (const otherScope of [{ ...scope, id: "another-job" }, { ...scope, revision: 2 }, { ...scope, mode: "shadow" as const }]) {
      expect(resumeManualJobRequest(otherScope, firstId, saved)).toEqual({ ready: false, pendingRequestId: null });
    }
    expect(() => resumeManualJobRequest(scope, "bad-id", saved)).toThrow(/could not be identified/);
  });
});
