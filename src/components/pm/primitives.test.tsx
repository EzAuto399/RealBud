import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CaseQueueRow, DecisionBar, EvidenceRail, SourceStamp } from "./primitives";

describe("PM surface primitives", () => {
  it("keeps the exact approval boundary beside the decision controls", () => {
    const html = renderToStaticMarkup(
      <DecisionBar onAllow={() => undefined} onEdit={() => undefined} onDeny={() => undefined} />,
    );

    expect(html).toContain("Allow wording once");
    expect(html).toContain("Allow applies to this exact version once");
    expect(html).toContain("it still needs Allow");
    expect(html).not.toContain("Always approve");
    expect(html).not.toContain(">Send<");
    expect(html).not.toContain(">Pay<");
  });

  it("names source freshness and authority in PM language", () => {
    const html = renderToStaticMarkup(
      <SourceStamp label="PMS CSV export" authority="Current PMS export" observedAt={1_787_780_400_000} />,
    );

    expect(html).toContain("PMS CSV export");
    expect(html).toContain("Current PMS export");
    expect(html).toContain("Current");
    expect(html).toContain("Observed");
  });

  it("marks a queue address as the shared case-open element", () => {
    const html = renderToStaticMarkup(
      <CaseQueueRow title="12 Oak St" meta="Money · Courtesy" action="Allow wording" shareAddress />,
    );

    expect(html).toContain("desk-shared-address");
    expect(html).toContain("12 Oak St");
  });

  it("exposes the selected queue row without relying on colour", () => {
    const html = renderToStaticMarkup(
      <CaseQueueRow title="12 Oak St" meta="Money · Courtesy" action="Allow wording" selected />,
    );

    expect(html).toContain('role="option"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("Allow wording");
  });

  it("translates internal evidence state into PM language", () => {
    const html = renderToStaticMarkup(<EvidenceRail state="empty">Choose a case.</EvidenceRail>);

    expect(html).toContain("No case selected");
    expect(html).not.toContain(">empty<");
  });
});
