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
});