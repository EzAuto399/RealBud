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

  it("still rejects a missing schema or an empty file", () => {
    expect(() => parseLedgerCsv("propertyId,daysSinceDue\nprop-oak,3", 1)).toThrow(/missing column/);
    expect(() => parseLedgerCsv("propertyId,daysSinceDue,rentLanded,levyPaid\n", 1)).toThrow(/empty/);
  });
});

describe("PMS vendor headers and mapping", () => {
  it("parses a PropertyMe-flavoured header set", () => {
    const csv = `Property,Days in arrears,Rent received,Levy\n"12 Oak St, Dickson ACT",3,paid,unpaid\n`;
    const batch = parsePmsExport(csv, 1);
    expect(batch.headers).toEqual(["Property", "Days in arrears", "Rent received", "Levy"]);
    expect(batch.detected).toEqual({
      identity: "Property",
      daysSinceDue: "Days in arrears",
      rentLanded: "Rent received",
      levyPaid: "Levy",
    });
    expect(batch.rows[0]).toMatchObject({
      identity: { kind: "address", value: "12 Oak St, Dickson ACT" },
      daysSinceDue: 3,
      rentLanded: true,
      levyPaid: false,
    });
    expect(batch.rejected).toEqual([]);
  });

  it("accepts common PMS boolean cells", () => {
    const csv = "propertyId,daysSinceDue,rentLanded,levyPaid\nprop-oak,3,Y,unpaid\nprop-fir,1,landed,0\n";
    const batch = parsePmsExport(csv, 1);
    expect(batch.rows[0]).toMatchObject({ rentLanded: true, levyPaid: false });
    expect(batch.rows[1]).toMatchObject({ rentLanded: true, levyPaid: false });
    expect(batch.rejected).toEqual([]);
  });

  it("lets an explicit mapping win over aliases", () => {
    const csv = "Name,Late,In,Out\nprop-oak,3,true,false\n";
    expect(() => parsePmsExport(csv, 1)).toThrow(/missing column/);
    const batch = parsePmsExport(csv, 1, "src-csv", {
      identity: "Name",
      daysSinceDue: "Late",
      rentLanded: "In",
      levyPaid: "Out",
    });
    expect(batch.rows[0]?.identity).toEqual({ kind: "address", value: "prop-oak" });
    expect(batch.rows[0]).toMatchObject({ daysSinceDue: 3, rentLanded: true, levyPaid: false });
    expect(batch.detected).toEqual({
      identity: "Name",
      daysSinceDue: "Late",
      rentLanded: "In",
      levyPaid: "Out",
    });
  });

  it("keeps good rows when one row is ragged or unparsable", () => {
    const csv = [
      "propertyId,daysSinceDue,rentLanded,levyPaid",
      "prop-oak,3,false,false",
      "prop-fir,x,false,false",
      "prop-pine,1,true,true",
      "prop-birch,2,false",
    ].join("\n");
    const batch = parsePmsExport(csv, 1);
    expect(batch.rows.map((row) => row.identity.value)).toEqual(["prop-oak", "prop-pine"]);
    expect(batch.rejected).toEqual([
      { row: 2, reason: expect.stringMatching(/daysSinceDue/) },
      { row: 4, reason: "csv row 4 is incomplete" },
    ]);
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
  });

  it("matches a property code to the Desk id", () => {
    const csv = "propertyCode,daysSinceDue,rentLanded,levyPaid\nprop-oak,3,false,false\n";
    const batch = parsePmsExport(csv, 1);
    const hit = matchExportRow(book, batch.rows[0]!);
    expect(hit).toEqual({ ok: true, propertyId: "prop-oak" });
  });

  it("matches a property code to the office's own PMS code", () => {
    const csv = "propertyCode,daysSinceDue,rentLanded,levyPaid\nA-1042,3,false,false\n";
    const batch = parsePmsExport(csv, 1);
    const hit = matchExportRow([{ id: "prop-x", address: "7 Banksia Pl, Bruce ACT", propertyCode: "a-1042" }], batch.rows[0]!);
    expect(hit).toEqual({ ok: true, propertyId: "prop-x" });
  });

  it("marks an unknown address unmatched without touching other ids", () => {
    const csv = `address,daysLate,rentLanded,levyPaid\n"99 Ghost St, Acton ACT",4,false,false\n`;
    const batch = parsePmsExport(csv, 1);
    const resolved = resolveExportRows(book, batch.rows);
    expect(resolved.matched).toEqual([]);
    expect(resolved.unmatched).toHaveLength(1);
  });

  it("holds an ambiguous row without rejecting its neighbours", () => {
    const twins = [
      { id: "prop-a", address: "12 Oak St, Dickson ACT" },
      { id: "prop-b", address: "12 Oak Street, Dickson ACT" },
      { id: "prop-fir", address: "3 Fir Cl, Braddon ACT" },
    ];
    const csv =
      `address,daysLate,rentLanded,levyPaid\n` +
      `"12 Oak St, Dickson ACT",3,false,false\n` +
      `"3 Fir Close, Braddon ACT",1,true,true\n`;
    const batch = parsePmsExport(csv, 1);
    const resolved = resolveExportRows(twins, batch.rows);
    expect(resolved.matched).toHaveLength(1);
    expect(resolved.matched[0]).toMatchObject({ propertyId: "prop-fir" });
    expect(resolved.unmatched).toEqual([]);
    expect(resolved.ambiguous).toHaveLength(1);
    expect(resolved.ambiguous[0]?.ids.slice().sort()).toEqual(["prop-a", "prop-b"]);
    expect(resolved.ambiguous[0]?.row.identity.value).toBe("12 Oak St, Dickson ACT");
  });
});
