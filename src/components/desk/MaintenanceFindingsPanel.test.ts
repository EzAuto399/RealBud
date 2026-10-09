import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ api: vi.fn(), useStore: () => ({ state: {}, dispatch: vi.fn() }) }));

import { findingHeading, supplierImportMessage } from "./MaintenanceFindingsPanel";

// FICTIONAL import results; no supplier data.
const result = (suppliers: number, withoutEmail: number, conflicts: number, rejected: number) => ({
  directory: { suppliers: Array.from({ length: suppliers }, (_, i) => ({ emails: i < withoutEmail ? [] : ["fictional@supplier.example.invalid"] })) },
  conflicts: Array.from({ length: conflicts }, () => ({})), rejected: Array.from({ length: rejected }, () => ({})),
});

describe("supplier import message", () => {
  it("says one supplier, not one suppliers", () => {
    expect(supplierImportMessage(result(1, 0, 0, 0))).toBe("Imported 1 supplier · 0 without email · 0 conflicts.");
    expect(supplierImportMessage(result(1, 1, 1, 1))).toBe("Imported 1 supplier · 1 without email · 1 conflict · 1 row or email skipped.");
  });
  it("keeps the plural for many", () => {
    expect(supplierImportMessage(result(12, 0, 0, 0))).toBe("Imported 12 suppliers · 0 without email · 0 conflicts.");
    expect(supplierImportMessage(result(3, 2, 2, 4))).toBe("Imported 3 suppliers · 2 without email · 2 conflicts · 4 rows or emails skipped.");
  });
});

describe("finding heading", () => {
  const sender = (reasons: string[]) => ({ id: "f", kind: "sender-verification" as const, propertyId: "p", supplierRef: "FIC-PLUMB", senderEmail: "office@fictional-agency.example.invalid", reasons, invoices: [], notes: [] });
  it("names a forwarded copy whose original sender was not checked, never as a possible forgery", () => {
    expect(findingHeading({ finding: sender(["unverified-sender"]), forwardedCopy: true })).toBe("Forwarded copy · original sender not checked");
    expect(findingHeading({ finding: sender(["unverified-sender"]) })).toBe("Sender not verified");
  });
  it("keeps the other sender reasons ahead of the forwarded wording", () => {
    expect(findingHeading({ finding: sender(["supplier-unresolved", "unverified-sender"]), forwardedCopy: true })).toBe("Sender needs checking");
    expect(findingHeading({ finding: sender(["classification-needed", "unverified-sender"]), forwardedCopy: true })).toBe("Maintenance classification needed");
  });
});
