import { describe, expect, it } from "vitest";

import { CANONICAL_BUD_ID, PRODUCT_TURN_DEFAULTS, isCanonicalBud, productDenied, productRuntimeEventVisible } from "./product-mode.ts";
import { hostAllowed, originAllowed, needsSession } from "./session-auth.ts";
import { emptyOffice } from "../shared/office.ts";
import { pilotContractFromBook, readyForLivePortal, readyForLivePortalFromBook } from "./pilot-contract.ts";
import { sourceReady } from "./source-gate.ts";
import { evaluatorForLoop } from "./workflow-catalog.ts";

describe("product mode denials", () => {
  it("denies extra bots, rooms, connectors, and raw computer routes", () => {
    expect(productDenied("POST", "/api/bots")).toMatch(/Bud thread/);
    expect(productDenied("POST", "/api/groups")).toMatch(/Bud thread|Rooms/);
    expect(productDenied("POST", "/api/groups/x/messages")).toMatch(/Rooms/);
    expect(productDenied("GET", "/api/connectors")).toMatch(/Bud thread|Connectors/);
    expect(productDenied("POST", "/api/connectors/x")).toMatch(/Connectors/);
    expect(productDenied("POST", "/api/local-computer/screenshot")).toMatch(/screenshots/);
    expect(productDenied("POST", "/api/bots/bud/computer")).toMatch(/Cloud computers/);
    expect(productDenied("DELETE", "/api/bots/bud")).toMatch(/one Bud thread/);
    expect(productDenied("DELETE", "/api/desk/properties/prop-oak")).toBeNull();
    expect(isCanonicalBud(CANONICAL_BUD_ID)).toBe(true);
  });

  it("requires a session for Desk, loops, artifacts, and events", () => {
    expect(needsSession("/api/desk")).toBe(true);
    expect(needsSession("/api/channels")).toBe(true);
    expect(needsSession("/api/rules")).toBe(true);
    expect(needsSession("/api/law-watch")).toBe(true);
    expect(needsSession("/api/recipes")).toBe(true);
    expect(needsSession("/api/computer-history")).toBe(true);
    expect(needsSession("/api/portal-sessions")).toBe(true);
    expect(needsSession("/api/loops")).toBe(true);
    expect(needsSession("/api/artifacts/art-1")).toBe(true);
    expect(needsSession("/api/events")).toBe(true);
    expect(needsSession("/api/health")).toBe(false);
    expect(needsSession("/api/session")).toBe(false);
    expect(needsSession("/api/bots")).toBe(false);
  });

  it("accepts only loopback Host/Origin, including the configured UI port", () => {
    expect(hostAllowed("127.0.0.1:8799", 8799)).toBe(true);
    expect(hostAllowed("evil.example", 8799)).toBe(false);
    expect(originAllowed("http://127.0.0.1:5199", 8799)).toBe(true);
    expect(originAllowed("https://evil.example", 8799)).toBe(false);
    const previous = process.env.OMB_UI_PORT;
    process.env.OMB_UI_PORT = "5200";
    try {
      expect(originAllowed("http://127.0.0.1:5200", 8799)).toBe(true);
      expect(originAllowed("http://127.0.0.1:5201", 8799)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OMB_UI_PORT;
      else process.env.OMB_UI_PORT = previous;
    }
  });

  it("does not expose provider reasoning or raw runtime internals to the product client", () => {
    expect(productRuntimeEventVisible({ type: "content.delta", streamKind: "assistant_text" })).toBe(true);
    expect(productRuntimeEventVisible({ type: "turn.completed" })).toBe(true);
    expect(productRuntimeEventVisible({ type: "content.delta", streamKind: "reasoning_text" })).toBe(false);
    expect(productRuntimeEventVisible({ type: "item.started" })).toBe(false);
    expect(productRuntimeEventVisible({ type: "item.started", itemType: "tool" })).toBe(true);
    expect(productRuntimeEventVisible({ type: "runtime.error" })).toBe(false);
  });

  it("gives useful work a larger but still bounded product budget", () => {
    expect(PRODUCT_TURN_DEFAULTS).toEqual({ maxMs: 900_000, maxTools: 96, maxRepeatedTool: 5 });
    expect(PRODUCT_TURN_DEFAULTS.maxRepeatedTool).toBeLessThan(PRODUCT_TURN_DEFAULTS.maxTools);
  });
});

describe("pilot and source gates", () => {
  it("does not claim a live portal without agency, vendor account, and macOS Cua", () => {
    expect(readyForLivePortal({ realAgencyNamed: false, vendorTestAccount: true, cuaHostSupported: true })).toBe(false);
    expect(readyForLivePortal({ realAgencyNamed: true, vendorTestAccount: true, cuaHostSupported: true })).toBe(true);
    expect(
      pilotContractFromBook({
        agencyName: "Demo agency",
        jurisdictions: ["ACT"],
        office: emptyOffice(),
      }).demo,
    ).toBe(true);
    const named = {
      agencyName: "Harbour PM",
      jurisdictions: ["ACT"],
      office: {
        ...emptyOffice(),
        pmUser: "Alex",
        pmsBrand: "other" as const,
        namedExporter: "Principal",
        exportCadence: "daily" as const,
        exportIdentity: "address" as const,
        officeOs: "linux" as const,
        vendorTestAccount: "fake-building-portal",
      },
    };
    expect(pilotContractFromBook(named).demo).toBe(false);
    expect(readyForLivePortalFromBook({ ...named, cuaHostSupported: false })).toBe(false);
    expect(readyForLivePortalFromBook({ ...named, office: { ...named.office, officeOs: "macos" }, cuaHostSupported: true })).toBe(
      true,
    );
  });

  it("holds stale or unidentified sources", () => {
    expect(sourceReady({ sourceId: "", stableKey: "x", observedAt: 1, staleAfterMs: 10, now: 2 }).ok).toBe(false);
    expect(sourceReady({ sourceId: "csv", stableKey: "csv:1", observedAt: 1, staleAfterMs: 10, now: 20 }).reason).toBe(
      "source is stale",
    );
    expect(sourceReady({ sourceId: "csv", stableKey: "csv:1", observedAt: 1, staleAfterMs: 10, now: 5 }).ok).toBe(true);
  });

  it("keeps the scheduled evaluator from launching Cua", () => {
    expect(evaluatorForLoop("morning-arrears")).toMatchObject({ mayLaunchCua: false, id: "morning-money" });
  });
});
