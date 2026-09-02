import { describe, expect, it } from "vitest";

import { jobBuildProgress, jobRunProgress, recheckProgress } from "./task-progress";

describe("long task progress copy", () => {
  it("moves through honest Recheck stages without inventing a percentage", () => {
    expect(recheckProgress(0).label).toMatch(/current book/i);
    expect(recheckProgress(7).label).toMatch(/connected source/i);
    expect(recheckProgress(20).label).toMatch(/safeguards/i);
    expect(JSON.stringify(recheckProgress(20))).not.toMatch(/%|percent/i);
  });

  it("keeps job build and run authority explicit", () => {
    expect(jobBuildProgress(12).reassurance).toMatch(/exact plan/i);
    expect(jobRunProgress(20, true).reassurance).toMatch(/receipt/i);
    expect(jobRunProgress(0, true).label).toMatch(/rehearsal/i);
  });
});
