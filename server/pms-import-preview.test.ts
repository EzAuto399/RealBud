import { describe, expect, it } from "vitest";

import { NEVER_ACTIONS, type Property } from "../shared/contracts.ts";
import { createPmsImportPreview, MAX_PMS_CSV_BYTES } from "./pms-import-preview.ts";

function property(id: string, address: string, propertyCode: string): Property {
  return {
    id,
    address,
    propertyCode,
    tenantName: `Tenant ${id}`,
    tenantPhone: "0400 000 000",
    weeklyRentCents: 60_000,
    options: {
      rentSource: "csv",
      graceDays: 3,
      courtesyUntilDay: 7,
      levyFromRent: null,
      notifyChannel: "email",
      never: [...NEVER_ACTIONS],
    },
  };
}

const properties = [
  property("prop-oak", "12 Oak St, Dickson ACT", "OAK-12"),
  property("prop-harbour", "4/22 Harbour Rd, Kingston ACT", "HARBOUR-4"),
  property("prop-pine", "8 Pine Ave, Braddon ACT", "PINE-8"),
];

describe("PMS import preview", () => {
  it("shows canonical mappings and aggregate match/hold counts without exposing source rows", () => {
    const csv = [
      "property address,days overdue,rent received,levy_paid,amount_paid_cents",
      '"12 Oak Street, Dickson ACT",4,false,false,0',
      '"4/22 Harbour Road, Kingston ACT",2,true,true,62000',
      '"4/22 Harbour Rd, Kingston ACT",3,false,true,0',
      '"99 Ghost St, Acton ACT",5,false,false,0',
    ].join("\n");
    const preview = createPmsImportPreview({
      csv,
      observedAt: 1_000,
      desk: { revision: 12, properties },
    });

    expect(preview).toMatchObject({
      kind: "realbud.pms-import-preview.v1",
      deskRevision: 12,
      totalRows: 4,
      identityKind: "address",
      matchedProperties: 1,
      rowsNeedingLink: 1,
      conflictingProperties: 1,
      duplicateRows: 2,
      missingProperties: 1,
      willVerifyLiveBook: true,
    });
    expect(preview.columns).toEqual([
      expect.objectContaining({ label: "Property identity", sourceHeader: "property address", required: true }),
      expect.objectContaining({ label: "Days since due", sourceHeader: "days overdue", required: true }),
      expect.objectContaining({ label: "Rent received", sourceHeader: "rent received", required: true }),
      expect.objectContaining({ label: "Levy paid", sourceHeader: "levy_paid", required: true }),
      expect.objectContaining({ label: "Amount received", sourceHeader: "amount_paid_cents", required: false }),
    ]);
    expect(preview.warnings).toHaveLength(3);
    const encoded = JSON.stringify(preview);
    expect(encoded).not.toMatch(/Oak Street|Harbour Road|Ghost St|Tenant prop/i);
  });

  it("keeps a zero-match export visibly held instead of claiming it can verify the live book", () => {
    const preview = createPmsImportPreview({
      csv: "propertyCode,daysSinceDue,rentLanded,levyPaid\nUNKNOWN-1,4,false,false\n",
      observedAt: 2_000,
      desk: { revision: 4, properties },
    });

    expect(preview.matchedProperties).toBe(0);
    expect(preview.rowsNeedingLink).toBe(1);
    expect(preview.missingProperties).toBe(3);
    expect(preview.willVerifyLiveBook).toBe(false);
    expect(preview.warnings[0]).toMatch(/will not verify live balances/i);
  });

  it("rejects an oversized export before parsing", () => {
    const csv = `propertyId,daysSinceDue,rentLanded,levyPaid\n${"x".repeat(MAX_PMS_CSV_BYTES)}`;
    expect(() => createPmsImportPreview({
      csv,
      observedAt: 3_000,
      desk: { revision: 1, properties },
    })).toThrow(/450 KB maximum/i);
  });

  it("names the missing export field in PM language", () => {
    expect(() => createPmsImportPreview({
      csv: "property address,days overdue,levy paid\n12 Oak St,4,false\n",
      observedAt: 3_000,
      desk: { revision: 1, properties },
    })).toThrow(/rent received or rent paid column/i);
  });
});
