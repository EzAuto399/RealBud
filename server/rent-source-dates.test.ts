import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findBorrowedExtractObservations, type PropertySourceDates } from "../shared/rent-source-dates.ts";
import { RENT_EVIDENCE_REVIEW_RULES } from "../shared/rent-workflow.ts";
import { productBudSystemPrompt } from "./ask-book.ts";

const corpus: PropertySourceDates[] = [
  { propertyId: "prop-oak", labels: ["Oak", "12 Oak", "T-OAK"], extractObservationAt: "8 Sept 10:00" },
  { propertyId: "prop-harbour", labels: ["Harbour", "T-HARBOUR"], extractObservationAt: null },
  { propertyId: "prop-pine", labels: ["Pine", "8 Pine", "T-PINE"], extractObservationAt: null },
  { propertyId: "prop-king", labels: ["King", "T-KING"], extractObservationAt: null },
  { propertyId: "prop-birch", labels: ["Birch", "3 Birch", "T-BIRCH"], extractObservationAt: "8 Sept 10:00" },
  { propertyId: "prop-flora", labels: ["Flora", "T-FLORA"], extractObservationAt: null },
];

describe("rent source-date attribution", () => {
  it("flags Pine when prose borrows the Oak/Birch extract clock", () => {
    const bad =
      "Bank slice used: 8 Sept 10:00 for Oak, Birch and Pine. Transaction dates for Pine remain 5 Sept and 6 Sept.";
    const issues = findBorrowedExtractObservations(bad, corpus);
    expect(issues.map((row) => row.propertyId)).toEqual(["prop-pine"]);
    expect(issues[0]?.borrowedObservation).toMatch(/8 Sept 10:00/i);
  });

  it("accepts the corrected source-limits paragraph for the six-property corpus", () => {
    const corrected = readFileSync(
      join(process.cwd(), "outputs/rent-workflow-rehearsal-2026-09-08-verified/source-limits-correction.md"),
      "utf8",
    );
    expect(findBorrowedExtractObservations(corrected, corpus)).toEqual([]);
  });

  it("does not treat transaction dates without a clock time as extract observation times", () => {
    const text =
      "Pine: B3 $580 SETTLED 5 Sept; B4 full reversal 6 Sept. Extract as-of time unknown. Oak bank extract 8 Sept 10:00.";
    expect(findBorrowedExtractObservations(text, corpus)).toEqual([]);
  });

  it("keeps the attribution rule in the product prompt and evidence rules", () => {
    expect(RENT_EVIDENCE_REVIEW_RULES).toMatch(/Never borrow a bank or PMS extract as-of time/i);
    expect(productBudSystemPrompt()).toMatch(/extract time is unknown/i);
  });
});
