import { describe, expect, it } from "vitest";
import { parseScheduleIntent, scheduleIntentReply } from "./schedule-intent.ts";

describe("parseScheduleIntent", () => {
  it("catches weekday payment-check scheduling asks", () => {
    expect(parseScheduleIntent("add a schedule for creating a payment check every Wednesday for our tenant, bulu")).toEqual({
      kind: "weekday-check",
      weekdayHint: "Wednesday",
    });
    expect(parseScheduleIntent("can you help me set up a weekly rent check?")).toEqual({
      kind: "weekday-check",
      weekdayHint: "week",
    });
  });

  it("routes whole-book / morning money language to the built loop", () => {
    expect(parseScheduleIntent("schedule morning money every Wednesday")).toEqual({
      kind: "morning-money",
      weekdayHint: "Wednesday",
    });
  });

  it("leaves portal, connect, and book FAQ alone", () => {
    expect(parseScheduleIntent("login to the portal and finish the weekly check")).toBeNull();
    expect(parseScheduleIntent("connect Gmail")).toBeNull();
    expect(parseScheduleIntent("What needs me?")).toBeNull();
    expect(parseScheduleIntent("check the rent for Oak")).toBeNull();
  });
});

describe("scheduleIntentReply", () => {
  it("points at Schedule in one short reply without You → Bud's jobs", () => {
    const reply = scheduleIntentReply(
      "Hello bud, can you help me add a schedule for creating a payment check every Wednesday for our tenant, bulu?",
    );
    expect(reply).toContain("**Schedule work**");
    expect(reply).toContain("Wednesdays");
    expect(reply).toContain("Nothing is scheduled yet");
    expect(reply).not.toMatch(/You\s*→\s*Bud/i);
    expect(reply).not.toMatch(/clock|timer|projection|5-step/i);
    expect(reply!.split(/\s+/).length).toBeLessThan(70);
  });
});
