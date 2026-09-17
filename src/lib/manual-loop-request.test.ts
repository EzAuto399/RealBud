import { describe, expect, it } from "vitest";
import type { LoopRun } from "@shared/contracts";
import { beginLoopRequest, confirmLoopReceipt, pendingLoopRequest, rejectLoopRequest, resumeLoopRequest } from "./manual-loop-request";

const id = "65000000-0000-4000-8000-000000000001";
const other = "65000000-0000-4000-8000-000000000002";
function storage() {
  const data = new Map<string, string>();
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } };
}
function receipt(overrides: Partial<LoopRun> = {}): LoopRun {
  return { id: "receipt", loopId: "owner-letter", loopName: "Owner letter", loopRevision: 2, requestId: id,
    scheduledFor: 1, createdAt: 1, manual: true, status: "completed", ...overrides };
}

describe("manual routine recovery", () => {
  it("keeps one identity through lost responses, reloads and clock edits", () => {
    const s = storage();
    const first = beginLoopRequest("owner-letter", 2, s, () => id);
    expect(beginLoopRequest("owner-letter", 9, s, () => other)).toEqual(first);
    expect(pendingLoopRequest("owner-letter", s)).toEqual(first);
    expect(resumeLoopRequest("owner-letter", first, s)).toEqual(first);
  });
  it("keeps running work, clears only a matching terminal receipt, then permits an explicit new run", () => {
    const s = storage();
    const first = beginLoopRequest("owner-letter", 2, s, () => id);
    expect(confirmLoopReceipt("owner-letter", first, receipt({ status: "running" }), s)).toBe(false);
    expect(pendingLoopRequest("owner-letter", s)).toEqual(first);
    expect(confirmLoopReceipt("owner-letter", first, receipt({ status: "awaiting-approval" }), s)).toBe(true);
    expect(pendingLoopRequest("owner-letter", s)).toBeNull();
    expect(beginLoopRequest("owner-letter", 3, s, () => other).requestId).toBe(other);
  });
  it("a stale check button never allocates another request after another window confirms or replaces it", () => {
    const s = storage();
    const first = beginLoopRequest("owner-letter", 2, s, () => id);
    confirmLoopReceipt("owner-letter", first, receipt(), s);
    expect(resumeLoopRequest("owner-letter", first, s)).toBeNull();
    const next = beginLoopRequest("owner-letter", 3, s, () => other);
    expect(resumeLoopRequest("owner-letter", first, s)).toBeNull();
    confirmLoopReceipt("owner-letter", first, receipt(), s);
    expect(pendingLoopRequest("owner-letter", s)).toEqual(next);
  });
  it.each([
    { requestId: other }, { loopRevision: 3 }, { loopId: "morning-arrears" as const }, { manual: false },
  ])("rejects mismatched receipts without discarding recovery: %o", (override) => {
    const s = storage();
    const first = beginLoopRequest("owner-letter", 2, s, () => id);
    expect(() => confirmLoopReceipt("owner-letter", first, receipt(override), s)).toThrow(/did not match/);
    expect(pendingLoopRequest("owner-letter", s)).toEqual(first);
  });
  it("keeps identity on uncertain failures but releases authoritative unaccepted requests", () => {
    const s = storage();
    const first = beginLoopRequest("owner-letter", 2, s, () => id);
    for (const code of [undefined, 500, 503, 401, 403]) expect(rejectLoopRequest("owner-letter", first, code, s)).toBe(false);
    expect(pendingLoopRequest("owner-letter", s)).toEqual(first);
    expect(rejectLoopRequest("owner-letter", first, 409, s)).toBe(true);
    expect(pendingLoopRequest("owner-letter", s)).toBeNull();
  });
  it("storage failures and malformed history stop new requests without exposing stored data", () => {
    const s = storage();
    s.setItem("realbud.manual-loop-requests.v1", "secret malformed input");
    expect(() => beginLoopRequest("owner-letter", 2, s, () => id)).toThrow(/Run recovery could not be read/);
    expect(() => beginLoopRequest("owner-letter", 2, { getItem: () => null, setItem: () => { throw Error("disk"); } }, () => id)).toThrow(/could not be saved/);
  });
  it("rejects invalid revision/identity before writing", () => {
    const s = storage();
    expect(() => beginLoopRequest("owner-letter", 0, s, () => id)).toThrow();
    expect(() => beginLoopRequest("owner-letter", 2, s, () => "invalid")).toThrow();
    expect(s.data.size).toBe(0);
  });
});
