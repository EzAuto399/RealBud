import { describe, expect, it } from "vitest";

import { NEVER_ACTIONS } from "../shared/contracts.ts";
import { emptyV2 } from "./desk-store.ts";
import { fixtureBook } from "./desk-evaluate.ts";
import { migrateV2ToV3 } from "./desk-v3-migrate.ts";
import {
  CASE_KINDS,
  CLOSED_HANDOFF_OPERATIONS,
  DESK_FILE_VERSION,
  FORBIDDEN_HANDOFF_ACTIONS,
  LEGACY_UNKNOWN_ACTOR,
  emptyV3,
  lockedNever,
  migratedEvidenceId,
  migratedRevisionId,
  propertyNotePath,
  tenantContactIdFromProperty,
  tenancyIdFromProperty,
} from "../shared/desk-v3.ts";

describe("Desk V3 contracts", () => {
  it("is version 3 and keeps never-rules code-owned", () => {
    expect(DESK_FILE_VERSION).toBe(3);
    expect(lockedNever()).toEqual(["statutory-send", "trust-pay"]);
    expect(lockedNever()).toEqual(NEVER_ACTIONS);
    expect(lockedNever()).not.toContain("always-allow");
  });

  it("derives deterministic tenancy, contact, note, revision and evidence ids", () => {
    expect(tenancyIdFromProperty("prop-oak")).toBe("ten-prop-oak");
    expect(tenantContactIdFromProperty("prop-oak")).toBe("ctc-tenant-prop-oak");
    expect(propertyNotePath("prop-oak")).toBe("vault/properties/prop-oak.md");
    expect(migratedRevisionId("draft-1")).toBe("rev-draft-1-0");
    expect(migratedEvidenceId("prop-oak")).toBe("ev-legacy-prop-oak");
    expect(tenancyIdFromProperty("prop-oak")).toBe(tenancyIdFromProperty("prop-oak"));
  });

  it("closes case kinds and handoff operations without send, pay or statutory work", () => {
    expect(CASE_KINDS).toEqual([
      "money-arrears",
      "owner-update",
      "inbound-triage",
      "maintenance-intake",
      "lease-review",
      "inspection-prep",
      "licensee-required",
    ]);
    expect(CLOSED_HANDOFF_OPERATIONS).toEqual(["prefill-courtesy"]);
    expect(FORBIDDEN_HANDOFF_ACTIONS).toEqual(["submit", "send", "pay"]);
    expect(CASE_KINDS.join(" ")).not.toMatch(/notice|statutory|trust|eft/i);
    expect(CLOSED_HANDOFF_OPERATIONS.join(" ")).not.toMatch(/send|pay|submit/i);
  });

  it("starts an empty book without inventing owners, lease dates or actors", () => {
    const book = emptyV3({
      name: "RealBud Demo Book",
      timezone: "Australia/Sydney",
      jurisdictions: ["ACT"],
    });
    expect(book.version).toBe(3);
    expect(book.properties).toEqual([]);
    expect(book.tenancies).toEqual([]);
    expect(book.contacts).toEqual([]);
    expect(book.evidence).toEqual([]);
    expect(book.decisions).toEqual([]);
    expect(book.office).toEqual({
      pmUser: "",
      pmsBrand: "",
      namedExporter: "",
      exportCadence: "",
      exportIdentity: "",
      officeOs: "",
      vendorTestAccount: "",
    });
    expect(LEGACY_UNKNOWN_ACTOR).toBe("legacy-unknown");
  });
});

describe("Desk V2 → V3 migrate (pure)", () => {
  const migratedAt = 1_700_000_000_000;

  it("preserves property ids and note paths, and does not invent owners", () => {
    const v2 = emptyV2(fixtureBook());
    const v3 = migrateV2ToV3(v2, migratedAt);
    expect(v3.properties.map((p) => p.id)).toEqual(v2.properties.map((p) => p.id));
    expect(v3.tenancies.map((t) => t.id)).toEqual(v2.properties.map((p) => tenancyIdFromProperty(p.id)));
    expect(v3.contacts.filter((c) => c.role === "owner")).toEqual([]);
    expect(v3.contacts).toHaveLength(v2.properties.length);
    expect(propertyNotePath("prop-oak")).toBe("vault/properties/prop-oak.md");
    for (const property of v3.properties) {
      expect(property.options.never).toEqual(["statutory-send", "trust-pay"]);
    }
  });

  it("marks migrated ledger evidence legacy-unverified and holds money positions", () => {
    const v2 = emptyV2(fixtureBook());
    const v3 = migrateV2ToV3(v2, migratedAt);
    expect(v3.evidence.every((row) => row.authority === "legacy-unverified")).toBe(true);
    expect(v3.moneyPositions.every((row) => row.status === "requires-recheck")).toBe(true);
    expect(v3.evidence.some((row) => row.observedAt == null)).toBe(true);
  });

  it("turns unmatched holds into ImportIssues, not placeholder properties", () => {
    const v2 = emptyV2(fixtureBook());
    v2.workItems.push({
      id: "work-unmatched-1",
      kind: "money-arrears",
      state: "held",
      propertyId: "prop-oak",
      occurrenceKey: "unmatched:row-1",
      periodDueAt: migratedAt,
      recipient: { name: "", phone: "" },
      sourceIds: ["src-demo"],
      observedAt: migratedAt,
      proposalHash: "none",
      createdAt: migratedAt,
      updatedAt: migratedAt,
      holdReason: "unmatched",
    });
    const before = v2.properties.length;
    const v3 = migrateV2ToV3(v2, migratedAt);
    expect(v3.importIssues).toEqual([
      expect.objectContaining({ id: "work-unmatched-1", kind: "unmatched", status: "open" }),
    ]);
    expect(v3.cases.find((item) => item.id === "work-unmatched-1")).toBeUndefined();
    expect(v3.properties).toHaveLength(before);
  });

  it("invalidates unused capabilities and never extends expiry", () => {
    const v2 = emptyV2(fixtureBook());
    v2.capabilities.push({
      id: "cap-1",
      workItemId: "work-1",
      revision: 1,
      proposalHash: "hash-1",
      propertyId: "prop-oak",
      recipeId: "fake-building-portal",
      recipeVersion: 1,
      operation: "prefill-courtesy",
      approver: "pm",
      expiresAt: migratedAt + 60_000,
    });
    const v3 = migrateV2ToV3(v2, migratedAt);
    expect(v3.handoffs).toEqual([
      expect.objectContaining({
        id: "cap-1",
        invalidatedAt: migratedAt,
        verification: "invalidated",
      }),
    ]);
    expect(v3.handoffs[0]?.authorization.expiresAt).toBe(migratedAt + 60_000);
    expect(v3.handoffs[0]?.authorization.operation).toBe("prefill-courtesy");
  });

  it("keeps draft ids as proposals and unknown actors as legacy-unknown", () => {
    const v2 = emptyV2(fixtureBook());
    v2.drafts.push({
      id: "draft-oak",
      propertyId: "prop-oak",
      kind: "courtesy-rent",
      status: "allowed",
      channel: "sms",
      to: "0400 111 222",
      body: "Please pay rent. This is not a formal notice and does not start any notice period.",
      periodDueAt: migratedAt,
      createdAt: migratedAt,
      decidedAt: migratedAt,
      workItemId: "work-oak",
    });
    const v3 = migrateV2ToV3(v2, migratedAt);
    expect(v3.proposals[0]?.id).toBe("draft-oak");
    expect(v3.proposalRevisions).toHaveLength(1);
    expect(v3.decisions[0]).toEqual(
      expect.objectContaining({ kind: "allow", actorId: "legacy-unknown", revisionId: migratedRevisionId("draft-oak") }),
    );
  });
});
