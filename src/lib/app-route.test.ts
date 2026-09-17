import { describe, expect, it } from "vitest";
import { doorHashToWrite, hashForView, viewFromHash } from "./app-route";

describe("app route", () => {
  it("maps the four doors in both directions", () => {
    for (const view of ["desk", "ask", "schedule", "you"] as const) {
      expect(hashForView(view)).toBe(`#/${view}`);
      expect(viewFromHash(`#/${view}`)).toBe(view);
    }
  });

  it("leaves the chat fallback without a route", () => {
    expect(hashForView("chat")).toBeNull();
  });

  it("does not treat the You deep links as door routes", () => {
    // These are the pre-existing root-level settings anchors and must keep
    // resolving through youHashTarget instead.
    for (const hash of ["#you-recovery", "#you-worker", "#connected-apps", "#attach-model", ""]) {
      expect(viewFromHash(hash)).toBeNull();
    }
  });

  it("ignores unknown routes and tolerates a missing slash", () => {
    expect(viewFromHash("#/nope")).toBeNull();
    expect(viewFromHash("#desk")).toBe("desk");
  });

  it("never overwrites a You deep link when mirroring the You door", () => {
    expect(doorHashToWrite("#you-recovery", "you")).toBeNull();
    expect(doorHashToWrite("#connected-apps", "you")).toBeNull();
    expect(doorHashToWrite("#you-phone", "you")).toBeNull();
    expect(doorHashToWrite("#/you", "you")).toBeNull();
    expect(doorHashToWrite("", "you")).toBe("#/you");
    expect(doorHashToWrite("#/desk", "ask")).toBe("#/ask");
    // Leaving a You deep link for another door must update the address bar.
    expect(doorHashToWrite("#you-recovery", "ask")).toBe("#/ask");
    expect(doorHashToWrite("#you-recovery", "desk")).toBe("#/desk");
  });
});
