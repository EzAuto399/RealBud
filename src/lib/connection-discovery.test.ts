import { describe, expect, it } from "vitest";

import {
  CONNECTION_DISCOVERY_ITEMS,
  categoryForYouFocus,
  connectionSearchRequestsMethods,
  filterConnectionDiscovery,
} from "./connection-discovery";

describe("connection discovery", () => {
  it("opens the filter that actually contains a You focus target", () => {
    expect(filterConnectionDiscovery("", categoryForYouFocus("desktop-reminders")).map((item) => item.id)).toContain("desktop-reminders");
    expect(filterConnectionDiscovery("", categoryForYouFocus("computer-use")).map((item) => item.id)).toContain("computer-use");
    expect(filterConnectionDiscovery("", categoryForYouFocus("connections")).map((item) => item.id)).toEqual([
      "property-book",
      "inbound-mail-calendar",
      "computer-use",
    ]);
  });

  it("returns the closed approved catalog by default", () => {
    expect(filterConnectionDiscovery("", "all")).toEqual(CONNECTION_DISCOVERY_ITEMS);
  });

  it("filters by PM-language category", () => {
    expect(filterConnectionDiscovery("", "common").map((item) => item.id)).toEqual([
      "property-book",
      "inbound-mail-calendar",
      "computer-use",
    ]);
    expect(filterConnectionDiscovery("", "desktop").map((item) => item.id)).toEqual([
      "advanced-work",
      "computer-use",
      "desktop-reminders",
    ]);
    expect(filterConnectionDiscovery("", "pocket").map((item) => item.id)).toEqual([
      "telegram",
      "whatsapp-business",
    ]);
  });

  it("searches labels, capabilities and approved implementation terms", () => {
    expect(filterConnectionDiscovery("structured export", "all").map((item) => item.id)).toEqual(["property-book"]);
    expect(filterConnectionDiscovery("direct api", "all").map((item) => item.id)).toEqual(["property-book"]);
    expect(filterConnectionDiscovery("bank payment", "all").map((item) => item.id)).toEqual(["property-book"]);
    expect(filterConnectionDiscovery("Excel screenshot", "all").map((item) => item.id)).toEqual(["property-book"]);
    expect(filterConnectionDiscovery("composio", "all").map((item) => item.id)).toEqual([
      "inbound-mail-calendar",
      "advanced-work",
    ]);
    expect(filterConnectionDiscovery("approved browser", "all").map((item) => item.id)).toEqual(["computer-use"]);
    expect(filterConnectionDiscovery("cloud history", "all").map((item) => item.id)).toEqual(["advanced-work"]);
  });

  it("opens implementation details only for explicit method searches", () => {
    expect(connectionSearchRequestsMethods("Composio")).toBe(true);
    expect(connectionSearchRequestsMethods("direct API")).toBe(true);
    expect(connectionSearchRequestsMethods("approved MCP server")).toBe(true);
    expect(connectionSearchRequestsMethods("bank browser")).toBe(true);
    expect(connectionSearchRequestsMethods("cloud CLI history")).toBe(true);
    expect(connectionSearchRequestsMethods("import a spreadsheet")).toBe(true);
    expect(connectionSearchRequestsMethods("paste properties")).toBe(true);
    expect(connectionSearchRequestsMethods("inbox calendar")).toBe(false);
  });

  it("combines category and query without widening the catalog", () => {
    expect(filterConnectionDiscovery("phone", "pocket").map((item) => item.id)).toEqual([
      "telegram",
      "whatsapp-business",
    ]);
    expect(filterConnectionDiscovery("composio", "desktop").map((item) => item.id)).toEqual(["advanced-work"]);
    expect(filterConnectionDiscovery("unknown raw tool", "all")).toEqual([]);
  });
});
