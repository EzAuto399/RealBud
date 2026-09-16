import { describe, expect, it } from "vitest";
import { ComputerLeaseManager } from "./computer-lease.ts";

describe("bounded adapter ownership", () => {
  it("refuses overlapping work and revisions even with the same owner label", () => {
    const manager = new ComputerLeaseManager();
    const first = manager.hold("portal", 1_000, 100, "work-a", 1);
    for (const [id, revision] of [["work-b", 1], ["work-a", 2], ["work-a", 1]] as const) {
      expect(() => manager.hold("portal", 1_010, 100, id, revision)).toThrow(/lease held/);
    }
    expect(manager.current()).toBe(first);
  });

  it("an expired operation cannot act or silently free the computer", () => {
    const manager = new ComputerLeaseManager();
    const first = manager.hold("portal", 1_000, 100, "work-a", 1);
    manager.assertHeld(first, 1_099);
    expect(() => manager.assertHeld(first, 1_100)).toThrow(/expired/);
    expect(() => manager.hold("portal", 1_101, 100, "work-b", 1)).toThrow(/lease held/);
    manager.release(first);
    expect(manager.current()).toBeNull();
  });

  it("late releases and stale operations cannot affect a replacement acquisition", () => {
    const manager = new ComputerLeaseManager();
    const first = manager.hold("portal", 1_000, 100, "work-a", 1);
    manager.release(first);
    const next = manager.hold("portal", 1_020, 100, "work-a", 2);
    manager.release(first);
    expect(manager.current()).toBe(next);
    expect(() => manager.assertHeld(first, 1_030)).toThrow(/stale/);
    manager.assertHeld(next, 1_030);
    expect(Object.isFrozen(next)).toBe(true);
  });

  it("rejects incomplete bindings and invalid deadlines", () => {
    const manager = new ComputerLeaseManager();
    expect(() => manager.hold("portal", 1_000, 100, "", 1)).toThrow(/invalid/);
    expect(() => manager.hold("portal", 1_000, 100, "work-a", 0)).toThrow(/invalid/);
    for (const ttl of [0, -1, NaN, Infinity, 900_001]) {
      expect(() => manager.hold("portal", 1_000, ttl, "work-a", 1)).toThrow(/invalid/);
    }
    expect(manager.current()).toBeNull();
  });
});
