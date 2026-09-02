import { describe, expect, it } from "vitest";

import { isObservedStale } from "./observed-stale";

const HOUR = 60 * 60 * 1000;

describe("isObservedStale", () => {
  it("is stale only after 12 hours", () => {
    const now = 1_700_000_000_000;
    expect(isObservedStale(undefined, now)).toBe(false);
    expect(isObservedStale(null, now)).toBe(false);
    expect(isObservedStale(now - 11 * HOUR, now)).toBe(false);
    expect(isObservedStale(now - 12 * HOUR, now)).toBe(false);
    expect(isObservedStale(now - 12 * HOUR - 1, now)).toBe(true);
  });
});
