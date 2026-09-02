import { describe, expect, it } from "vitest";

import { notifyBody, shouldNotifyMiss, shouldNotifyNeedsYou } from "./notify-desktop";
import type { MorningBrief } from "./morning-brief";

describe("shouldNotifyNeedsYou", () => {
  it("notifies when the needs-you count goes up", () => {
    expect(shouldNotifyNeedsYou(0, 2, "granted")).toBe(true);
    expect(shouldNotifyNeedsYou(1, 2, "granted")).toBe(true);
    expect(shouldNotifyNeedsYou(null, 2, "granted")).toBe(true);
  });

  it("stays quiet when the count is the same or lower", () => {
    expect(shouldNotifyNeedsYou(2, 2, "granted")).toBe(false);
    expect(shouldNotifyNeedsYou(2, 1, "granted")).toBe(false);
    expect(shouldNotifyNeedsYou(null, 0, "granted")).toBe(false);
  });

  it("never notifies when permission is denied or unavailable", () => {
    expect(shouldNotifyNeedsYou(1, 2, "denied")).toBe(false);
    expect(shouldNotifyNeedsYou(1, 2, "unavailable")).toBe(false);
  });
});

describe("notify miss vocabulary", () => {
  const miss = {
    headline: "Recheck missed. Bud did not return live facts.",
    checkedCount: 0,
    needsYou: 0,
    licensee: 0,
  } as MorningBrief;

  it("uses Recheck-missed body copy", () => {
    expect(notifyBody(miss)).toBe("Recheck missed — facts held. Open Desk.");
  });

  it("notifies once when the miss headline appears", () => {
    expect(shouldNotifyMiss(null, miss, "granted")).toBe(true);
    expect(shouldNotifyMiss(miss.headline, miss, "granted")).toBe(false);
  });
});
