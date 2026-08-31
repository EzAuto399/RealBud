import { describe, expect, it } from "vitest";

import { askNextActions } from "./ask-next";

describe("ask next actions", () => {
  it("keeps suggestions after a miss and offers setup when the worker is not ready", () => {
    const next = askNextActions({ miss: true, needsYou: 0, workerReady: false });
    expect(next.map((row) => row.id)).toEqual(["attach", "needs", "recheck", "desk", "hold", "draft"]);
    expect(next.find((row) => row.id === "attach")?.label).toBe("Set up Bud");
  });

  it("offers a Bud check after a miss even when hands already pinged", () => {
    const next = askNextActions({ miss: true, needsYou: 0, workerReady: true });
    expect(next.find((row) => row.id === "attach")?.label).toBe("Check Bud");
  });

  it("offers the final check when the workroom is already set up", () => {
    const next = askNextActions({ miss: false, needsYou: 0, workerReady: false, workerSetupComplete: true });
    expect(next.find((row) => row.id === "attach")?.label).toBe("Check Bud");
  });

  it("skips attach once hands are ready and Recheck did not miss", () => {
    const next = askNextActions({ miss: false, needsYou: 2, workerReady: true });
    expect(next.some((row) => row.kind === "you")).toBe(false);
    expect(next.some((row) => row.id === "desk")).toBe(true);
  });
});
