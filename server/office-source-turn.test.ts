import { describe, expect, it } from "vitest";
import { officeAppsForTurn, officeSourceTurnContext } from "./office-source-turn.ts";
import { allowedOfficeAppCall } from "./connected-apps-broker.ts";
import type { ConnectedAppsStatus } from "../shared/office-sources.ts";

const access = (): ConnectedAppsStatus => ({ configured: true, checkedAt: new Date().toISOString(), tools: { available: true, names: ["GMAIL_LIST_THREADS"] }, services: {
  gmail: { connected: true, status: "ACTIVE", accountSelectionRequired: false, accounts: [{ id: "fixture", status: "ACTIVE" }] },
} });

describe("contextual mail and source exclusion", () => {
  it.each(["Chase the repair quote for 14 Sample Street", "Has the tenant replied?", "Prepare the owner update"])("makes mail available for an ordinary job: %s", () => {
    expect(officeAppsForTurn(access())).toEqual(["gmail"]);
    expect(officeSourceTurnContext(["gmail"])).toContain("without requiring the PM to say 'check email'");
  });
  it("never mounts apps for internal jobs, removed sources or failed discovery", () => {
    expect(officeAppsForTurn(access(), true)).toEqual([]);
    expect(officeAppsForTurn({ ...access(), excludedApps: ["gmail"] })).toEqual([]);
    expect(officeAppsForTurn({ ...access(), tools: { available: false, names: [] } })).toEqual([]);
    expect(officeSourceTurnContext([])).toContain("Do not claim live messages");
  });
  it("denies removed sources inside mixed batches and direct calls", () => {
    expect(allowedOfficeAppCall({ name: "GMAIL_LIST_THREADS" }, ["gmail"])).toBe(true);
    expect(allowedOfficeAppCall({ name: "GMAIL_LIST_THREADS" }, ["outlook"])).toBe(false);
    expect(allowedOfficeAppCall({ name: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: { tools: [{ tool_slug: "OUTLOOK_LIST_MESSAGES" }, { tool_slug: "GMAIL_SEND_EMAIL" }] } }, ["outlook"])).toBe(false);
    expect(allowedOfficeAppCall({ name: "COMPOSIO_MANAGE_CONNECTIONS", arguments: { toolkits: [{ name: "gmail", action: "list" }] } }, [])).toBe(false);
  });
  it("names offered-but-unconnected apps and the in-Ask connect action", () => {
    const offered: ConnectedAppsStatus = { ...access(), tools: { available: false, names: [] }, services: {
      gmail: { connected: false, status: "NOT_CONNECTED", accountSelectionRequired: false, accounts: [] },
    } };
    expect(officeAppsForTurn(offered)).toEqual([]);
    const context = officeSourceTurnContext([], offered);
    expect(context).toContain("Gmail is offered for this office but not connected yet");
    expect(context).toContain("**Connect Gmail** here in Ask");
    expect(context).toContain("Never start sign-in for them");
    expect(context).not.toMatch(/composio|You\s*→/i);
    // A failed or unconfigured read says nothing about which apps are missing.
    expect(officeSourceTurnContext([], { ...offered, error: "unreachable" })).not.toContain("Connect Gmail");
    expect(officeSourceTurnContext([], null)).toContain("offer Add here in Ask");
  });
});
