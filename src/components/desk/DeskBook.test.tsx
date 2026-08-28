import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { NEVER_ACTIONS, type DeskSnapshot } from "@shared/contracts";
import { DeskBook } from "./DeskBook";

function portfolio(): DeskSnapshot {
  return {
    version: 2,
    revision: 1,
    mode: "live",
    recovery: { active: false, reason: null, quarantined: [] },
    timezone: "Australia/Brisbane",
    retentionDays: 30,
    properties: Array.from({ length: 30 }, (_, index) => ({
      id: `prop-${index}`,
      address: `${index} Scale St, Brisbane QLD`,
      propertyCode: `RB-${String(index).padStart(3, "0")}`,
      tenantName: `Tenant ${index}`,
      tenantPhone: `0400 000 ${String(index).padStart(3, "0")}`,
      weeklyRentCents: 50_000,
      options: {
        rentSource: "csv",
        graceDays: 3,
        courtesyUntilDay: 7,
        levyFromRent: null,
        notifyChannel: "email",
        never: [...NEVER_ACTIONS],
      },
    })),
    ledger: [], drafts: [], escalations: [], workItems: [], lastRunAt: null, results: [],
    hands: "csv", handsDetail: "Current source", sources: [], demo: false,
    book: {
      bookProposals: [],
      agency: { name: "Scale office", timezone: "Australia/Brisbane", jurisdictions: ["QLD"] },
      tenancies: [], contacts: [], archivedProperties: [], importIssues: [], cases: [], decisions: [],
    },
  };
}

describe("DeskBook portfolio navigation", () => {
  it("renders a bounded first page with property-code search and no unopened Notes", () => {
    const snapshot = portfolio();
    const html = renderToStaticMarkup(
      <DeskBook
        snap={snapshot}
        busy={null}
        onAdd={vi.fn()}
        onSave={vi.fn()}
        onNotes={vi.fn()}
        onDelete={vi.fn()}
        onReset={vi.fn()}
        onImport={vi.fn()}
        onOpenAsk={vi.fn()}
        onAllowBookProposal={vi.fn()}
        onDenyBookProposal={vi.fn()}
        onAllowAllBookProposals={vi.fn()}
        propertyDetails={{}}
        onLoadProperty={vi.fn()}
        onResolveImport={vi.fn()}
      />,
    );
    expect(html).toContain("Address, property code, tenant or phone");
    expect(html).toContain("1–24 of 30");
    expect(html).toContain("Page 1 of 2");
    expect(html).toContain("RB-023");
    expect(html).not.toContain("RB-024");
    expect(html).toContain('aria-label="Properties"');
    expect(html).toContain("Loaded only for this selected property");
    expect(html.match(/Loaded only for this selected property/g)?.length).toBe(1);
    expect(html).not.toContain("Open property");
    expect(html).toContain("Bring in or refresh the portfolio");
    expect(html).toContain("Use another format in Ask");
  });
});
