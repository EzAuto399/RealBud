import { describe, expect, it } from "vitest";

import { CANONICAL_BUD_ID, isCanonicalBud, productDenied } from "./product-mode.ts";
import { hostAllowed, originAllowed, needsSession } from "./session-auth.ts";
import { readyForLivePortal } from "./pilot-contract.ts";
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
    expect(needsSession("/api/loops")).toBe(true);
    expect(needsSession("/api/artifacts/art-1")).toBe(true);
    expect(needsSession("/api/events")).toBe(true);
    expect(needsSession("/api/health")).toBe(false);
    expect(needsSession("/api/session")).toBe(false);
    expect(needsSession("/api/bots")).toBe(false);
  });

  it("accepts only loopback Host/Origin", () => {
    expect(hostAllowed("127.0.0.1:8799", 8799)).toBe(true);
    expect(hostAllowed("evil.example", 8799)).toBe(false);
    expect(originAllowed("http://127.0.0.1:5199", 8799)).toBe(true);
    expect(originAllowed("https://evil.example", 8799)).toBe(false);
  });
});

describe("pilot and source gates", () => {
  it("does not claim a live portal without agency, vendor account, and macOS Cua", () => {
    expect(readyForLivePortal({ realAgencyNamed: false, vendorTestAccount: true, cuaHostSupported: true })).toBe(false);
    expect(readyForLivePortal({ realAgencyNamed: true, vendorTestAccount: true, cuaHostSupported: true })).toBe(true);
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
