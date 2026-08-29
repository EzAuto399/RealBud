import { describe, expect, it } from "vitest";

import { isOfficeComposioSlug, isSafeToolkitSlug, parseOfficeSourceServices } from "./office-sources.ts";

describe("office source slugs", () => {
  it("keeps mail slugs distinct from any safe toolkit name", () => {
    expect(isOfficeComposioSlug("gmail")).toBe(true);
    expect(isOfficeComposioSlug("slack")).toBe(false);
    expect(isSafeToolkitSlug("gmail")).toBe(true);
    expect(isSafeToolkitSlug("notion")).toBe(true);
    expect(isSafeToolkitSlug("slack")).toBe(true);
    expect(isSafeToolkitSlug("../etc")).toBe(false);
    expect(parseOfficeSourceServices("gmail,slack,googlecalendar,gmail")).toEqual([
      "gmail",
      "slack",
      "googlecalendar",
    ]);
    expect(parseOfficeSourceServices("zapier,notion")).toEqual(["zapier", "notion"]);
  });
});
