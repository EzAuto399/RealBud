import { describe, expect, it } from "vitest";

import type { DeskSnapshot } from "../shared/contracts.ts";
import { PILOT_CONTRACT } from "./pilot-contract.ts";
import { sourceConnectionCatalog } from "./source-connections.ts";

function desk(
  overrides: Partial<Pick<DeskSnapshot, "mode" | "hands" | "handsDetail">> = {},
): Pick<DeskSnapshot, "mode" | "recovery" | "hands" | "handsDetail" | "properties" | "sources" | "results"> {
  return {
    mode: "demo" as const,
    recovery: { active: false, reason: null, quarantined: [] },
    hands: "demo" as const,
    handsDetail: null,
    properties: [{ id: "p1" }, { id: "p2" }] as DeskSnapshot["properties"],
    sources: [],
    results: [],
    ...overrides,
  };
}

describe("sourceConnectionCatalog", () => {
  it("reports current local source truth without exposing a generic connector contract", () => {
    const current = desk({
      mode: "live",
      hands: "csv",
      handsDetail: "PMS export covered 2 of 2 properties.",
    });
    current.sources = [{
      id: "src-pms",
      kind: "csv",
      label: "PMS export",
      stableKey: "pms:book",
      observedAt: 1_000,
      staleAt: 20_000,
      coverage: "complete",
    }];
    const connections = sourceConnectionCatalog(current, PILOT_CONTRACT, {
      now: 10_000,
      aliases: { "property-book": "Oak Agency book" },
    });
    expect(connections[0]).toMatchObject({
      id: "property-book",
      state: "ready",
      status: "Live source matched",
      alias: "Oak Agency book",
    });
    expect(connections[0].methods.find((method) => method.id === "local-export")?.state).toBe("active");
    expect(connections[0].methods.find((method) => method.id === "selected-evidence")?.state).toBe("active");
    expect(connections[0].methods.find((method) => method.id === "paste-manual")?.state).toBe("active");
    expect(connections[0].methods.find((method) => method.id === "private-pms-browser")?.state).toBe("pilot-gated");
    expect(connections[0].methods.find((method) => method.id === "read-only-bank-browser")?.state).toBe("pilot-gated");
    expect(connections[1]).toMatchObject({ id: "inbound-mail-calendar", state: "pilot-gated" });

    const encoded = JSON.stringify(connections);
    expect(encoded).not.toMatch(/apiKey|accessToken|secret|credentialValue|endpoint|rawTools|authorizeUrl/i);
    expect(encoded).not.toMatch(/"action"|"execute"|"connect"/i);
  });

  it("labels a Demo bank observation as practice rather than a live connection", () => {
    const connections = sourceConnectionCatalog({
      ...desk({ mode: "live", hands: "csv" }),
      sources: [{
        id: "src-bank",
        kind: "portal",
        label: "Read-only bank activity",
        stableKey: `bank:${"a".repeat(64)}`,
        observedAt: 9_000,
        staleAt: 20_000,
        coverage: "unknown",
      }],
    }, PILOT_CONTRACT, { now: 10_000, bankAdapterConfigured: true });
    expect(connections[0].methods.find((method) => method.id === "read-only-bank-browser")).toMatchObject({
      state: "practice",
    });
  });

  it("reports a current named-pilot bank observation active only with the configured adapter", () => {
    const contract = {
      ...PILOT_CONTRACT,
      agency: "Pilot Agency",
      pmUser: "Named PM",
      pmsBrand: "Named PMS",
      namedExporter: "Principal",
      exportCadenceHours: 4,
      exportIdentityColumn: "property-code" as const,
      officeOs: "darwin" as const,
      confirmedJurisdictions: ["ACT"],
      vendorTestAccount: true,
      demo: false,
    };
    const input = {
      ...desk({ mode: "live", hands: "csv" }),
      sources: [{
        id: "src-bank",
        kind: "portal" as const,
        label: "Read-only bank activity",
        stableKey: `bank:${"b".repeat(64)}`,
        observedAt: 9_000,
        staleAt: 20_000,
        coverage: "unknown" as const,
      }],
    };
    expect(sourceConnectionCatalog(input, contract, { now: 10_000, bankAdapterConfigured: false })[0]
      .methods.find((method) => method.id === "read-only-bank-browser")?.state).toBe("practice");
    expect(sourceConnectionCatalog(input, contract, { now: 10_000, bankAdapterConfigured: true })[0]
      .methods.find((method) => method.id === "read-only-bank-browser")?.state).toBe("active");
  });

  it("does not keep stale source evidence ready forever", () => {
    const input = desk({ mode: "live", hands: "csv" });
    input.sources = [{
      id: "src-pms",
      kind: "csv",
      label: "PMS export",
      stableKey: "pms:book",
      observedAt: 1_000,
      staleAt: 9_000,
      coverage: "complete",
    }];
    expect(sourceConnectionCatalog(input, PILOT_CONTRACT, { now: 10_000 })[0]).toMatchObject({
      state: "attention",
      status: "PMS source is stale",
    });
  });

  it("shows direct API, restricted Composio and approved MCP only as non-executable candidate methods", () => {
    const mail = sourceConnectionCatalog(desk()).find((connection) => connection.id === "inbound-mail-calendar")!;
    expect(mail.methods.map((method) => method.id)).toEqual(["direct-api", "restricted-composio", "approved-mcp"]);
    expect(mail.methods.every((method) => method.state === "pilot-gated")).toBe(true);
  });

  it("can name the exercised Demo case flow without claiming a provider connection", () => {
    const mail = sourceConnectionCatalog({
      ...desk(),
      sources: [{ id: "src-demo-inbox", kind: "mail", label: "Demo read-only inbox", stableKey: "demo:read-only-inbox" }],
    }).find((connection) => connection.id === "inbound-mail-calendar")!;
    expect(mail).toMatchObject({ state: "pilot-gated", status: "Demo flow tested · live adapter gated" });
    expect(mail.description).toMatch(/No provider account is connected/i);
  });

  it("remains not-built after a complete contract instead of claiming a connection exists", () => {
    const contract = {
      ...PILOT_CONTRACT,
      agency: "Pilot Agency",
      pmUser: "Named PM",
      pmsBrand: "Named PMS",
      namedExporter: "Principal",
      exportCadenceHours: 4,
      exportIdentityColumn: "property-code" as const,
      officeOs: "darwin" as const,
      confirmedJurisdictions: ["ACT"],
      vendorTestAccount: true,
      demo: false,
    };
    const mail = sourceConnectionCatalog(desk(), contract).find((connection) => connection.id === "inbound-mail-calendar")!;
    expect(mail.state).toBe("attention");
    expect(mail.status).toBe("Adapter not built");
    expect(mail.methods.every((method) => method.state === "not-built")).toBe(true);
  });

  it("fails visibly into attention while Desk recovery owns the book", () => {
    const connections = sourceConnectionCatalog({
      ...desk({ mode: "live", hands: "csv" }),
      recovery: { active: true, reason: "protected", quarantined: ["desk.json"] },
    });
    expect(connections[0]).toMatchObject({ state: "attention", status: "Recovery paused" });
  });
});
