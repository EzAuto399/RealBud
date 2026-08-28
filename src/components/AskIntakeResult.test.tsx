import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AskIntakeResult } from "./AskIntakeResult";

describe("Ask intake result", () => {
  it("offers a direct, non-executing handoff to the staged Desk work", () => {
    const html = renderToStaticMarkup(
      <AskIntakeResult
        result={{ created: 1, skipped: 1, unparsed: ["Incomplete row"] }}
        onReview={() => undefined}
      />,
    );

    expect(html).toContain('role="status"');
    expect(html).toContain("1 property staged on Desk.");
    expect(html).toContain("1 duplicate or incomplete row skipped.");
    expect(html).toContain("Check: Incomplete row");
    expect(html).toContain("Review on Desk");
    expect(html).not.toContain(">Allow<");
  });

  it("does not offer a review jump when nothing was staged", () => {
    const html = renderToStaticMarkup(
      <AskIntakeResult result={{ created: 0, skipped: 1, unparsed: [] }} onReview={() => undefined} />,
    );

    expect(html).toContain("No properties were staged.");
    expect(html).not.toContain("Review on Desk");
  });
});
