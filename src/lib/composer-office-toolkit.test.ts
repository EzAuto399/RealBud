import { describe, expect, it } from "vitest";
import { officeMailRow, officeToolkitMailApps, officeToolkitRows } from "./composer-office-toolkit";
import type { ConnectedAppsStatus } from "./connected-apps";

function snap(partial: Partial<ConnectedAppsStatus> = {}): ConnectedAppsStatus {
  return {
    configured: true,
    checkedAt: new Date().toISOString(),
    services: {
      gmail: {
        connected: true,
        status: "ACTIVE",
        accountSelectionRequired: false,
        accounts: [{ id: "acc-1", label: "pm@office.com", status: "active" }],
      },
    },
    tools: { available: true, names: ["GMAIL_FETCH_EMAILS"] },
    ...partial,
  };
}

describe("composer office toolkit", () => {
  it("hides Outlook in gmail-readonly mode", () => {
    expect(officeToolkitMailApps("gmail-readonly")).toEqual(["gmail"]);
    expect(officeToolkitMailApps("consumer")).toEqual(["gmail", "outlook"]);
  });

  it("marks connected Gmail ready to pin", () => {
    const row = officeMailRow("gmail", snap(), { mode: "consumer" });
    expect(row.state).toBe("connected");
    expect(row.accountId).toBe("acc-1");
  });

  it("asks for setup when the broker is not configured", () => {
    const rows = officeToolkitRows(snap({ configured: false, services: {} }), { mode: "consumer" });
    expect(rows[0]?.state).toBe("setup");
    expect(rows[0]?.detail).toMatch(/key/i);
    expect(rows[0]?.detail).not.toMatch(/You/i);
  });

  it("uses preview for Outlook when not connected", () => {
    const row = officeMailRow("outlook", snap({ services: { gmail: snap().services.gmail! } }), { mode: "consumer" });
    expect(row.state).toBe("preview");
  });
});
