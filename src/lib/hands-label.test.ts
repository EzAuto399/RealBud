import { describe, expect, it } from "vitest";

import { handsChip, handsFactSource } from "./hands-label";

describe("hands labels", () => {
  it("keeps Hermes out of user chrome", () => {
    expect(handsChip("hermes")).toBe("Worker live");
    expect(handsChip("csv")).toBe("CSV live");
    expect(handsChip("held")).toBe("Held");
    expect(handsChip("demo")).toBe("Demo");
    expect(handsFactSource("hermes")).toBe("from worker");
    expect(`${handsChip("hermes")} ${handsFactSource("hermes")}`).not.toMatch(/Hermes/i);
  });
});
