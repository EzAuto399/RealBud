import { afterEach, describe, expect, it, vi } from "vitest";

import { SHOW_DESK_EVENT, notifyBody, shouldNotifyMiss, shouldNotifyNeedsYou, showDesk, shownArea } from "./notify-desktop";
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
    expect(notifyBody(miss)).toBe("This morning's check didn't run. Open Desk.");
  });

  it("notifies once when the miss headline appears", () => {
    expect(shouldNotifyMiss(null, miss, "granted")).toBe(true);
    expect(shouldNotifyMiss(miss.headline, miss, "granted")).toBe(false);
  });
});

describe("notice clicks", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("bring the window forward on the work area or Schedule a notice names, and on Tasks otherwise", () => {
    const win = Object.assign(new EventTarget(), { focus: vi.fn() });
    vi.stubGlobal("window", win);
    const opened: unknown[] = [];
    win.addEventListener(SHOW_DESK_EVENT, (event) => opened.push(shownArea(event)));
    showDesk("bills");
    showDesk("schedule");
    showDesk();
    expect(opened).toEqual(["bills", "schedule", null]);
    expect(win.focus).toHaveBeenCalledTimes(3);
  });

  it("read anything else as Tasks", () => {
    expect(shownArea(new CustomEvent(SHOW_DESK_EVENT, { detail: { area: "fictional" } }))).toBeNull();
    expect(shownArea(new CustomEvent(SHOW_DESK_EVENT, { detail: null }))).toBeNull();
    expect(shownArea(new Event(SHOW_DESK_EVENT))).toBeNull();
  });
});
