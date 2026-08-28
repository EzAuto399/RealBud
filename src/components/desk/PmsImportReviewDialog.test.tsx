import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { PmsImportPreview } from "@shared/contracts";
import { PmsImportReviewDialog } from "./PmsImportReviewDialog";

const preview: PmsImportPreview = {
  kind: "realbud.pms-import-preview.v1",
  deskRevision: 8,
  csvDigest: "a".repeat(64),
  observedAt: 1_000,
  bytes: 1_240,
  totalRows: 100,
  identityKind: "code",
  columns: [
    { field: "property-identity", label: "Property identity", sourceHeader: "property_code", required: true },
    { field: "days-since-due", label: "Days since due", sourceHeader: "days_overdue", required: true },
    { field: "rent-landed", label: "Rent received", sourceHeader: "rent_paid", required: true },
    { field: "levy-paid", label: "Levy paid", sourceHeader: "levy_paid", required: true },
  ],
  matchedProperties: 94,
  rowsNeedingLink: 2,
  conflictingProperties: 1,
  duplicateRows: 2,
  missingProperties: 3,
  willVerifyLiveBook: true,
  warnings: ["2 rows need a property link or rejection on Desk."],
};

describe("PMS import review dialog", () => {
  it("renders the detected mapping, aggregate impact and explicit commit action", () => {
    const html = renderToStaticMarkup(
      <PmsImportReviewDialog
        preview={preview}
        fileLabel="Current arrears export.csv"
        busy={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onReviewAgain={vi.fn()}
      />,
    );

    expect(html).toContain("Review PMS import");
    expect(html).toContain("Current arrears export.csv");
    expect(html).toContain("94");
    expect(html).toContain("properties matched");
    expect(html).toContain("rows need linking");
    expect(html).toContain("property_code");
    expect(html).toContain("Import 100 rows");
    expect(html).toContain("review changes nothing");
    expect(html).not.toContain("Send");
    expect(html).not.toContain("Pay");
  });

  it("makes a zero-match export visibly held", () => {
    const html = renderToStaticMarkup(
      <PmsImportReviewDialog
        preview={{ ...preview, matchedProperties: 0, willVerifyLiveBook: false }}
        fileLabel="Wrong export.csv"
        busy={false}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
        onReviewAgain={vi.fn()}
      />,
    );

    expect(html).toContain("cannot verify the live book yet");
    expect(html).toContain("held matching work");
  });
});

