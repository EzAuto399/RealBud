import { describe, expect, it } from "vitest";

import { fixtureBook } from "./desk-evaluate.ts";
import { composeOwnerLetter, ownerLetterWeekStart } from "./owner-letter.ts";

const book = fixtureBook();
const oak = book.properties.find((p) => p.id === "prop-oak")!;
const factsFor = (id: string) => book.ledger.find((r) => r.propertyId === id)!;
const now = new Date(2026, 7, 21, 16, 0, 0).getTime(); // Friday

describe("composeOwnerLetter", () => {
  it("states the rent fact without inventing balances", () => {
    const landed = composeOwnerLetter(oak, { ...factsFor("prop-oak"), rentLanded: true, daysSinceDue: 2 }, "", now);
    expect(landed.body).toMatch(/Rent is on the ledger/);
    expect(landed.body).not.toMatch(/\$[\d,]+\.\d\d.*rent/i);

    const late = composeOwnerLetter(oak, { ...factsFor("prop-oak"), rentLanded: false, daysSinceDue: 5 }, "", now);
    expect(late.body).toMatch(/5 days ago\).*not on the ledger yet/);
  });

  it("mentions a reversed payment instead of a rent line", () => {
    const draft = composeOwnerLetter(oak, { ...factsFor("prop-oak"), reversed: true }, "", now);
    expect(draft.body).toMatch(/reversed on the ledger/);
    expect(draft.body).not.toMatch(/not on the ledger/);
  });

  it("adds a levy line only when the property takes levies from rent", () => {
    const withLevy = { ...oak, options: { ...oak.options, levyFromRent: { amountCents: 300_00, cadence: "quarterly" as const } } };
    const unpaid = composeOwnerLetter(withLevy, factsFor("prop-oak"), "", now);
    expect(unpaid.body).toMatch(/\$300\.00 levy taken from rent does not show as paid/);
    const paid = composeOwnerLetter(withLevy, { ...factsFor("prop-oak"), levyPaid: true }, "", now);
    expect(paid.body).toMatch(/shows as paid for this period/);
    const plain = composeOwnerLetter(oak, factsFor("prop-oak"), "", now);
    expect(plain.body).not.toMatch(/[Ll]evy/);
  });

  it("includes Notes verbatim under their own heading and skips empty ones", () => {
    const withNote = composeOwnerLetter(oak, factsFor("prop-oak"), "Roof inspection booked 28 Aug.", now);
    expect(withNote.body).toMatch(/Also worth knowing:\nRoof inspection booked 28 Aug\./);
    const noNote = composeOwnerLetter(oak, factsFor("prop-oak"), "   \n", now);
    expect(noNote.body).not.toMatch(/Also worth knowing/);
  });

  it("always carries the Copy-only line and never claims to have sent anything", () => {
    const draft = composeOwnerLetter(oak, factsFor("prop-oak"), "", now);
    expect(draft.body).toMatch(/reviews and edits this before it goes anywhere/);
    expect(draft).toMatchObject({ kind: "owner-letter", status: "pending", channel: "desk" });
  });
});

describe("ownerLetterWeekStart", () => {
  it("returns the Monday of the week, so one letter per property per week", () => {
    const friday = new Date(2026, 7, 21, 16, 0, 0).getTime(); // Fri 21 Aug 2026
    const monday = new Date(2026, 7, 17, 0, 0, 0).getTime();
    expect(ownerLetterWeekStart(friday)).toBe(monday);
    expect(ownerLetterWeekStart(monday + 3_600_000)).toBe(monday);
    expect(ownerLetterWeekStart(friday)).toBe(ownerLetterWeekStart(monday));
  });
});
