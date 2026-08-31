import { describe, expect, it } from "vitest";

import { shouldNotifyNeedsYou } from "./notify-desktop";

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
