import { describe, expect, it } from "vitest";
import { parseConnectedStatusIntent } from "./connected-status-intent.ts";

describe("parseConnectedStatusIntent", () => {
  it("catches service inventory questions", () => {
    expect(parseConnectedStatusIntent("what services are we connected to")).toBe(true);
    expect(parseConnectedStatusIntent("which apps are connected?")).toBe(true);
    expect(parseConnectedStatusIntent("show connected apps")).toBe(true);
  });

  it("leaves connect instructions alone", () => {
    expect(parseConnectedStatusIntent("connect Gmail")).toBe(false);
    expect(parseConnectedStatusIntent("link Outlook")).toBe(false);
  });

  it("formats a refreshed inventory without You redirects", async () => {
    const { formatConnectedAppsReply } = await import("./connected-status-intent.ts");
    const text = formatConnectedAppsReply({
      configured: true,
      services: {
        gmail: { connected: true, status: "ACTIVE", accounts: [{ id: "1", label: "pm@office.com", status: "active" }] },
        outlook: { connected: false, status: "unknown", accounts: [] },
      },
      tools: { available: true, names: ["COMPOSIO_SEARCH_TOOLS", "COMPOSIO_MULTI_EXECUTE_TOOL"] },
    });
    expect(text).toMatch(/Gmail/);
    expect(text).toMatch(/Add/);
    expect(text).not.toMatch(/You\s*→/i);
  });

  it.each([
    "are you connected to composio?", "Are you connected?", "are you connected to Gmail", "what apps are connected",
    "connected apps?", "is my gmail connected?", "is Gmail connected", "what are you connected to?", "which apps do you have connected",
    "show my connections", "is my outlook account connected",
  ])("catches connection status question: %s", (text) => {
    expect(parseConnectedStatusIntent(text)).toBe(true);
  });

  it.each([
    "connect to REI and check payments", "are you connected to REI and can you check payments?", "is the water connected at 14 Sample Street?",
    "is the tenant connected with the plumber", "check the connected apps then draft a reply", "connect Gmail",
    "are you connected to gmail, and what did the owner say",
  ])("keeps real work an ordinary turn: %s", (text) => {
    expect(parseConnectedStatusIntent(text)).toBe(false);
  });

  it("names a not-connected app and the in-Ask action that connects it", async () => {
    const { formatConnectedAppsReply } = await import("./connected-status-intent.ts");
    const text = formatConnectedAppsReply({
      configured: true,
      services: { gmail: { connected: false, status: "NOT_CONNECTED", accounts: [] } },
      tools: { available: false, names: [] },
    });
    expect(text).toContain("**Gmail** — not connected yet");
    expect(text).toContain("Ask **Connect Gmail** here");
    expect(text).toContain("you finish it there");
    expect(text).not.toMatch(/composio|You\s*→/i);
  });
});
