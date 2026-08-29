import { describe, expect, it } from "vitest";

import { agencyIsNamed, goLiveComplete, goLiveRows } from "./go-live";

describe("go-live checklist", () => {
  it("starts as three actions on the demo book", () => {
    const rows = goLiveRows({ mode: "demo", agencyName: "Demo agency", workerReady: false });
    expect(rows.map((row) => row.state)).toEqual(["action", "action", "action"]);
    expect(goLiveComplete(rows)).toBe(false);
  });

  it("goes green only when export, worker, and a real agency name are set", () => {
    expect(agencyIsNamed("Demo agency")).toBe(false);
    expect(agencyIsNamed("")).toBe(false);
    expect(agencyIsNamed("Harbour PM")).toBe(true);
    const rows = goLiveRows({ mode: "live", agencyName: "Harbour PM", workerReady: true });
    expect(goLiveComplete(rows)).toBe(true);
  });
});
