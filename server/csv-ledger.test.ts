import { describe, expect, it } from "vitest";

import { fixtureBook } from "./desk-evaluate.ts";
import { matchExportRow, normalizeAddress, parseLedgerCsv, parsePmsExport, resolveExportRows } from "./csv-ledger.ts";

const header = "propertyId,daysSinceDue,rentLanded,levyPaid,daysSinceCourtesy";

describe("parseLedgerCsv", () => {
  it("accepts a complete boolean batch", () => {
    const batch = parseLedgerCsv(`${header}\nprop-oak,3,false,false,`, 1_000);
    expect(batch.rows).toEqual([
      {
        propertyId: "prop-oak",
        daysSinceDue: 3,
        rentLanded: false,
        levyPaid: false,
        daysSinceCourtesy: null,
        amountPaidCents: null,
        reversed: false,
      },
    ]);
    expect(batch.observedAt).toBe(1_000);
  });

  it("decodes the string false as false rather than truthy", () => {
    const batch = parseLedgerCsv(`${header}\nprop-oak,3,false,false,`, 1);
    expect(batch.rows[0]?.rentLanded).toBe(false);
  });

  it("rejects an incomplete row and does not emit a partial batch", () => {
    expect(() => parseLedgerCsv(`${header}\nprop-oak,3,false`, 1)).toThrow(/incomplete/);
    expect(() => parseLedgerCsv(`${header}\n,3,false,false,`, 1)).toThrow(/propertyId/);
    expect(() => parseLedgerCsv(`${header}\nprop-oak,,false,false,`, 1)).toThrow(/daysSinceDue/);
    expect(() => parseLedgerCsv("propertyId,daysSinceDue\nprop-oak,3", 1)).toThrow(/missing column/);
    expect(() => parseLedgerCsv("propertyId,daysSinceDue,rentLanded,levyPaid\n", 1)).toThrow(/empty/);
  });
});

describe("PMS export address/code match", () => {
  const book = fixtureBook().properties;

  it("normalises street vs st", () => {
    expect(normalizeAddress("12 Oak St, Dickson ACT")).toBe(normalizeAddress("12 Oak Street, Dickson ACT"));
  });

  it("parses an address-keyed quoted CSV", () => {
    const csv = `address,daysLate,rentLanded,levyPaid\n"12 Oak St, Dickson ACT",3,false,false\n`;
    const batch = parsePmsExport(csv, 50);
    expect(batch.rows).toHaveLength(1);
    expect(batch.rows[0]?.identity).toEqual({ kind: "address", value: "12 Oak St, Dickson ACT" });
    const resolved = resolveExportRows(book, batch.rows);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.matched).toEqual([
        {
          propertyId: "prop-oak",
          daysSinceDue: 3,
          rentLanded: false,
          levyPaid: false,
          daysSinceCourtesy: null,
          amountPaidCents: null,
          reversed: false,
        },
      ]);
      expect(resolved.unmatched).toEqual([]);
    }
  });

  it("matches a property code to the Desk id", () => {
    const csv = "propertyCode,daysSinceDue,rentLanded,levyPaid\nprop-oak,3,false,false\n";
    const batch = parsePmsExport(csv, 1);
    const hit = matchExportRow(book, batch.rows[0]!);
    expect(hit).toEqual({ ok: true, propertyId: "prop-oak" });
  });

  it("marks an unknown address unmatched without touching other ids", () => {
    const csv = `address,daysLate,rentLanded,levyPaid\n"99 Ghost St, Acton ACT",4,false,false\n`;
    const batch = parsePmsExport(csv, 1);
    const resolved = resolveExportRows(book, batch.rows);
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.matched).toEqual([]);
      expect(resolved.unmatched).toHaveLength(1);
    }
  });

  it("rejects the whole batch when one row matches two properties equally", () => {
    const twins = [
      { id: "prop-a", address: "12 Oak St, Dickson ACT" },
      { id: "prop-b", address: "12 Oak Street, Dickson ACT" },
    ];
    const csv = `address,daysLate,rentLanded,levyPaid\n"12 Oak St, Dickson ACT",3,false,false\n`;
    const batch = parsePmsExport(csv, 1);
    const resolved = resolveExportRows(twins, batch.rows);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.message).toMatch(/2 properties/);
  });
});
