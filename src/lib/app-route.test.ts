import { describe, expect, it } from "vitest";
import { doorHashToWrite, hashForView, scheduleHashTarget, viewFromHash, workspaceViewFromHash, workspaceViewHash } from "./app-route";

describe("app route", () => {
  it('deep links only declarative saved-view ids and keeps the manager reachable', () => {
    expect(workspaceViewFromHash('#/views')).toEqual({ id: null });
    expect(workspaceViewFromHash('#/views/view-accounts')).toEqual({ id: 'view-accounts' });
    expect(workspaceViewHash('view-accounts')).toBe('#/views/view-accounts');
    expect(workspaceViewHash(null)).toBe('#/views');
    for (const hash of ['#/views/../../secret', '#/views/https://example.com', '#/views/view-a?script=x']) expect(workspaceViewFromHash(hash)).toBeNull();
  });
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

  it("leaves a Schedule deep link for the lazily mounted Schedule screen to consume", () => {
    // Desk's setup card and Ask both set a section or job hash before opening
    // Schedule; the door mirror used to replace it with #/schedule before the
    // screen had mounted, so nothing ever scrolled.
    expect(scheduleHashTarget("#schedule-packs")).toBe("schedule-packs");
    expect(scheduleHashTarget("#job-wf-office-core-inbox-triage")).toBe("job-wf-office-core-inbox-triage");
    expect(scheduleHashTarget("#bud-job-builder")).toBe("bud-job-builder");
    expect(scheduleHashTarget("#/schedule")).toBeNull();
    expect(scheduleHashTarget("#you-recovery")).toBeNull();
    expect(doorHashToWrite("#schedule-packs", "schedule")).toBeNull();
    expect(doorHashToWrite("#job-abc", "schedule")).toBeNull();
    expect(doorHashToWrite("#/desk", "schedule")).toBe("#/schedule");
    // A Schedule deep link is not a You deep link, and leaving Schedule still writes the new door.
    expect(doorHashToWrite("#schedule-packs", "you")).toBe("#/you");
    expect(doorHashToWrite("#schedule-packs", "desk")).toBe("#/desk");
  });
});
