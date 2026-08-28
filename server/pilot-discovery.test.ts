import { describe, expect, it } from "vitest";

import { PILOT_CONTRACT, pilotContractComplete, pocketPilotReady } from "./pilot-contract.ts";
import { pilotDiscoveryProjection } from "./pilot-discovery.ts";

describe("pilotDiscoveryProjection", () => {
  it("keeps the Demo projection agency-neutral without satisfying an operational gate", () => {
    const projection = pilotDiscoveryProjection(PILOT_CONTRACT, Date.UTC(2026, 7, 28));

    expect(projection).toMatchObject({
      kind: "realbud.pilot-discovery.v1",
      office: { agency: null, state: "unconfigured" },
      readiness: { confirmedFields: 0, requiredFields: 8, contractComplete: false, evidence: "pilot-gated" },
      boundaries: {
        externalResearchGrantsAuthority: false,
        manualAllow: true,
        humanSubmit: true,
        sendAvailable: false,
        paymentAvailable: false,
      },
    });
    expect(projection.fields).toHaveLength(8);
    expect(projection.fields[0]).toMatchObject({ id: "agency-pm", state: "unconfirmed", value: null });
    expect(JSON.stringify(projection)).not.toMatch(/Auston|public candidate/i);
    expect(pilotContractComplete()).toBe(false);
    expect(pocketPilotReady()).toBe(false);
  });

  it("covers the portable Australian agency system families without claiming a connector", () => {
    const projection = pilotDiscoveryProjection(PILOT_CONTRACT, 0);

    expect(projection.systemFamilies.map((family) => family.id)).toEqual([
      "pms-rent-roll",
      "bank-evidence",
      "inbox-calendar",
      "leasing-inspections",
      "maintenance-compliance",
      "listing-leads",
      "mobile-pocket",
    ]);
    expect(projection.systemFamilies.find((family) => family.id === "pms-rent-roll")?.recognisedExamples).toEqual([
      "PropertyMe",
      "MRI Property Tree",
      "Reapit PM",
      "Managed",
      "Other named PMS",
    ]);
    const encoded = JSON.stringify(projection);
    expect(encoded).not.toMatch(/accessToken|apiKey|password|cookie|accountNumber|rawTools/i);
    expect(encoded).not.toMatch(/"state":"(?:connected|live-ready|production-ready)"/i);
    expect(encoded).not.toMatch(/"(?:connected|liveReady|productionReady)":true/i);
  });

  it("treats a complete contract as unproved until installed shadow evidence exists", () => {
    const complete = {
      ...PILOT_CONTRACT,
      agency: "Pilot Agency",
      pmUser: "Named PM",
      pmsBrand: "Named PMS",
      namedExporter: "Named principal",
      exportCadenceHours: 8,
      exportIdentityColumn: "property-code" as const,
      officeOs: "darwin" as const,
      confirmedJurisdictions: ["QLD"],
      vendorTestAccount: true,
      demo: false,
    };

    const projection = pilotDiscoveryProjection(complete, 0);
    expect(projection.readiness).toMatchObject({
      confirmedFields: 8,
      contractComplete: true,
      evidence: "contract-complete-unproved",
    });
    expect(projection.office).toMatchObject({
      agency: "Pilot Agency",
      state: "contract-complete",
    });
    expect(projection.fields.every((item) => item.state === "confirmed")).toBe(true);
    expect(projection.readiness.detail).toMatch(/still have to be proved/i);
  });

  it("keeps an invalid or stale export cadence unconfirmed", () => {
    const projection = pilotDiscoveryProjection({
      ...PILOT_CONTRACT,
      exportCadenceHours: 24,
      freshnessSlaHours: 12,
    }, 0);
    expect(projection.fields.find((item) => item.id === "export-cadence")).toMatchObject({
      state: "unconfirmed",
      value: null,
    });
  });

  it("uses a partially named contract office without pretending the PM is confirmed", () => {
    const projection = pilotDiscoveryProjection({
      ...PILOT_CONTRACT,
      agency: "Another Agency",
      pmUser: null,
      demo: false,
    }, 0);

    expect(projection.office).toMatchObject({
      agency: "Another Agency",
      state: "partial",
    });
    expect(projection.fields[0]).toMatchObject({
      state: "partial",
      value: "Another Agency · PM not confirmed",
    });
    expect(projection.readiness.contractComplete).toBe(false);
    expect(projection.readiness.detail).toMatch(/incomplete contract fields/i);
    expect(projection.readiness.detail).not.toMatch(/public discovery/i);
    expect(JSON.stringify(projection)).not.toMatch(/Auston|public candidate/i);
  });
});
