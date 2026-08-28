import { describe, expect, it } from "vitest";

import { buildConnectionRoster, connectionRosterSummary, youConnectionsStatus } from "./connection-roster";

describe("connection roster", () => {
  it("shows common office sources as not connected on a practice book", () => {
    const rows = buildConnectionRoster({ deskMode: "demo" });
    expect(rows.filter((row) => row.common).map((row) => row.id)).toEqual([
      "property-book",
      "inbound-mail-calendar",
      "computer-use",
    ]);
    expect(rows.find((row) => row.id === "property-book")).toMatchObject({
      status: "Practice · not live",
      tone: "off",
    });
    expect(youConnectionsStatus(rows)).toBe("Practice book");
    expect(connectionRosterSummary(rows.filter((row) => row.common))).toEqual({
      connected: 0,
      attention: 0,
      notYet: 3,
    });
  });

  it("marks a live book connected and quotes the office source label", () => {
    const rows = buildConnectionRoster({
      deskMode: "live",
      sourceLabels: [{ kind: "csv", label: "Friday PMS export" }],
      computerUseAvailable: true,
    });
    expect(rows.find((row) => row.id === "property-book")).toMatchObject({
      status: "Connected · Friday PMS export",
      tone: "ready",
    });
    expect(youConnectionsStatus(rows)).toBe("2 of 3 common");
    expect(JSON.stringify(rows)).not.toMatch(/composio|propertyme/i);
  });
});
