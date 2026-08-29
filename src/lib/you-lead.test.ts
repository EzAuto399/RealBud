import { describe, expect, it } from "vitest";

import { youLeadCopy, youShowsConnections, youShowsVerifyHero } from "./you-lead";

describe("You first paint", () => {
  it("does not lead a practice book with Verify the live book", () => {
    expect(youShowsVerifyHero({
      workerReady: true,
      recoveryAttention: false,
      deskMode: "demo",
      propertyCount: 6,
    })).toBe(false);
    expect(youLeadCopy({
      workerReady: true,
      recoveryAttention: false,
      deskMode: "demo",
      propertyCount: 6,
    })).toContain("Practice book is on Desk");
    expect(youLeadCopy({
      workerReady: true,
      recoveryAttention: false,
      deskMode: "demo",
      propertyCount: 6,
    })).not.toMatch(/Verify the live book/i);
  });

  it("still shows Verify when the book is empty or Bud is not ready", () => {
    expect(youShowsVerifyHero({
      workerReady: true,
      recoveryAttention: false,
      deskMode: "demo",
      propertyCount: 0,
    })).toBe(true);
    expect(youShowsVerifyHero({
      workerReady: false,
      recoveryAttention: false,
      deskMode: "demo",
      propertyCount: 6,
    })).toBe(true);
  });

  it("opens Connections on a practice book so Ask connect has a home", () => {
    expect(youShowsConnections({
      essentialsReady: false,
      linkedReady: 0,
      peek: null,
      workerReady: true,
      recoveryAttention: false,
      propertyCount: 6,
    })).toBe(true);
  });
});
