import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SupportEvidencePanel } from "./SupportEvidencePanel";

describe("SupportEvidencePanel", () => {
  it("keeps source, installed and named-office proof visibly separate", () => {
    const html = renderToStaticMarkup(
      <SupportEvidencePanel release={{
        app: {
          version: "0.1.17",
          buildId: null,
          distribution: "source",
          platform: "darwin",
          architecture: "arm64",
          nodeMajor: 24,
          productMode: true,
          productionMode: false,
        },
        evidence: {
          source: "not-recorded",
          installed: "requires-installed-proof",
          namedOffice: "pilot-gated",
        },
      }} />,
    );
    expect(html).toContain("Unlabelled working tree");
    expect(html).toContain("Run separately · not embedded");
    expect(html).toContain("Installed proof required");
    expect(html).toContain("Pilot details required");
    expect(html).toContain("Download support report");
  });
});
