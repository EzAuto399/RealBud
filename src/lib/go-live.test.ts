import { describe, expect, it } from "vitest";

import { agencyIsNamed, goLiveActionCount, goLiveComplete, goLiveRows } from "./go-live";

describe("go-live checklist", () => {
  it("starts as three actions on the demo book", () => {
    const rows = goLiveRows({ mode: "demo", agencyName: "RealBud Demo Book", workerReady: false });
    expect(rows.map((row) => row.state)).toEqual(["action", "action", "action"]);
    expect(goLiveComplete(rows)).toBe(false);
    expect(goLiveActionCount(rows)).toBe(3);
    expect(rows.find((row) => row.id === "worker")).toMatchObject({
      title: "Set up Bud",
      detail: expect.stringMatching(/private readiness check/),
    });
  });

  it("goes green only when export, worker, and a real agency name are set", () => {
    expect(agencyIsNamed("Demo agency")).toBe(false);
    expect(agencyIsNamed("RealBud Demo Book")).toBe(false);
    expect(agencyIsNamed("")).toBe(false);
    expect(agencyIsNamed("Harbour PM")).toBe(true);
    const rows = goLiveRows({ mode: "live", agencyName: "Harbour PM", workerReady: true });
    expect(goLiveComplete(rows)).toBe(true);
    expect(rows.find((row) => row.id === "worker")?.detail).toMatch(/Bud passed the readiness check/);
  });
});
