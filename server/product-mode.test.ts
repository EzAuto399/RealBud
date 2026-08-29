import { describe, expect, it } from "vitest";

import { CANONICAL_BUD_ID, isCanonicalBud, productDenied } from "./product-mode.ts";
import { hostAllowed, originAllowed, needsSession } from "./session-auth.ts";
import { PILOT_CONTRACT, pilotContractComplete, pilotContractMissingFields, pocketPilotReady, readyForLivePortal } from "./pilot-contract.ts";
import { sourceReady } from "./source-gate.ts";
import { evaluatorForLoop } from "./workflow-catalog.ts";

describe("product mode denials", () => {
  it("denies extra bots, rooms, connectors, and raw computer routes", () => {
    expect(productDenied("POST", "/api/bots")).toMatch(/Bud thread/);
    expect(productDenied("POST", "/api/groups")).toMatch(/Bud thread|Rooms/);
    expect(productDenied("POST", "/api/groups/x/messages")).toMatch(/Rooms/);
    expect(productDenied("GET", "/api/connectors")).toMatch(/Bud thread|Connectors/);
    expect(productDenied("POST", "/api/connectors/x")).toMatch(/Ask connection card|connector catalog/i);
    expect(productDenied("POST", "/api/connectors/gmail/authorize")).toMatch(/Ask connection card|connector catalog/i);
    expect(productDenied("GET", "/api/office-sources")).toBeNull();
    expect(productDenied("POST", "/api/office-sources/gmail/authorize")).toBeNull();
    expect(productDenied("PUT", "/api/office-sources/notion")).toBeNull();
    expect(productDenied("DELETE", "/api/office-sources/notion")).toBeNull();
    expect(productDenied("POST", "/api/ask-attachments")).toBeNull();
    expect(productDenied("GET", "/api/source-connections")).toBeNull();
    expect(productDenied("GET", "/api/pilot-discovery")).toBeNull();
    expect(productDenied("POST", "/api/pilot-discovery")).toMatch(/code-owned and read-only/);
    expect(productDenied("GET", "/api/execution-adapters")).toBeNull();
    expect(productDenied("POST", "/api/execution-adapters")).toMatch(/code-owned and read-only/);
    expect(productDenied("POST", "/api/work-routing")).toMatch(/code-owned and read-only/);
    expect(productDenied("GET", "/api/work-routing")).toBeNull();
    expect(productDenied("PATCH", "/api/work-routing/preference")).toBeNull();
    expect(productDenied("PATCH", "/api/work-routing/authority")).toMatch(/code-owned and read-only/);
    expect(productDenied("POST", "/api/local-computer/screenshot")).toMatch(/screenshots/);
    expect(productDenied("GET", "/api/local-computer")).toMatch(/playground/);
    expect(productDenied("POST", "/api/local-computer/run")).toMatch(/playground/);
    expect(productDenied("POST", "/api/instances/openai/setup")).toMatch(/You/);
    expect(productDenied("POST", "/api/bots/bud/computer")).toMatch(/Cloud computers/);
    expect(productDenied("DELETE", "/api/bots/bud")).toMatch(/one Bud thread/);
    expect(productDenied("DELETE", "/api/desk/properties/prop-oak")).toBeNull();
    expect(isCanonicalBud(CANONICAL_BUD_ID)).toBe(true);
  });

  it("requires a session for Desk, loops, artifacts, and events", () => {
    expect(needsSession("/api/desk")).toBe(true);
    expect(needsSession("/api/loops")).toBe(true);
    expect(needsSession("/api/source-connections")).toBe(true);
    expect(needsSession("/api/office-sources")).toBe(true);
    expect(needsSession("/api/ask-attachments")).toBe(true);
    expect(needsSession("/api/pilot-discovery")).toBe(true);
    expect(needsSession("/api/execution-adapters")).toBe(true);
    expect(needsSession("/api/work-routing")).toBe(true);
    expect(needsSession("/api/config")).toBe(true);
    expect(needsSession("/api/profile")).toBe(true);
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
    expect(originAllowed("http://127.0.0.1:5201", 18902)).toBe(true);
    expect(originAllowed("https://evil.example", 8799)).toBe(false);
  });
});

describe("pilot and source gates", () => {
  it("does not claim a live portal without agency, vendor account, and macOS Cua", () => {
    expect(readyForLivePortal({ realAgencyNamed: false, vendorTestAccount: true, cuaHostSupported: true })).toBe(false);
    expect(readyForLivePortal({ realAgencyNamed: true, vendorTestAccount: true, cuaHostSupported: true })).toBe(true);
  });

  it("keeps distributable-release readiness blocked until all eight office fields are real", () => {
    expect(pilotContractComplete()).toBe(false);
    expect(pocketPilotReady()).toBe(false);
    expect(pilotContractMissingFields()).toEqual([
      "agency + named PM user",
      "PMS brand",
      "named exporter",
      "export cadence within the freshness SLA",
      "export identity column",
      "office OS",
      "confirmed book jurisdiction(s)",
      "vendor test account",
    ]);
    expect(pilotContractComplete({
      ...PILOT_CONTRACT,
      agency: "Example Realty",
      pmUser: "Named PM",
      pmsBrand: "Example PMS",
      namedExporter: "Named principal",
      exportCadenceHours: 8,
      exportIdentityColumn: "property-code",
      officeOs: "darwin",
      confirmedJurisdictions: ["ACT"],
      vendorTestAccount: true,
      demo: false,
    })).toBe(true);
    expect(pocketPilotReady({
      ...PILOT_CONTRACT,
      agency: "Example Realty",
      pmUser: "Named PM",
      demo: false,
    })).toBe(true);
  });

  it("holds stale or unidentified sources", () => {
    expect(sourceReady({ sourceId: "", stableKey: "x", observedAt: 1, staleAfterMs: 10, now: 2 }).ok).toBe(false);
    expect(sourceReady({ sourceId: "csv", stableKey: "csv:1", observedAt: 1, staleAfterMs: 10, now: 20 }).reason).toBe(
      "source is stale",
    );
    expect(sourceReady({ sourceId: "csv", stableKey: "csv:1", observedAt: 1, staleAfterMs: 10, now: 5 }).ok).toBe(true);
    expect(sourceReady({ sourceId: "csv", stableKey: "csv:1", observedAt: 6, staleAfterMs: 10, now: 5 }).ok).toBe(false);
  });

  it("keeps the scheduled evaluator from launching Cua", () => {
    expect(evaluatorForLoop("morning-arrears")).toMatchObject({ mayLaunchCua: false, id: "morning-money" });
  });
});
