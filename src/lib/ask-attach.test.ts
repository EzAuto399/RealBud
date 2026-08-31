import { describe, expect, it } from "vitest";

import { isAskAttachName, safeAskAttachName } from "./ask-attach";

describe("ask attach names", () => {
  it("allows office files and sanitizes a path", () => {
    expect(isAskAttachName("arrears.pdf")).toBe(true);
    expect(isAskAttachName("photo.JPEG")).toBe(true);
    expect(isAskAttachName("payload.exe")).toBe(false);
    expect(safeAskAttachName("../../lease plan.pdf")).toBe("lease plan.pdf");
  });
});
