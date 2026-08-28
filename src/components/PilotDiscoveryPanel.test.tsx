import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PILOT_CONTRACT } from "../../server/pilot-contract";
import { pilotDiscoveryProjection } from "../../server/pilot-discovery";
import { PilotDiscoveryCard } from "./PilotDiscoveryPanel";

describe("PilotDiscoveryCard", () => {
  it("shows agency-neutral operational questions and portable system families without a fake setup action", () => {
    const html = renderToStaticMarkup(
      <PilotDiscoveryCard discovery={pilotDiscoveryProjection(PILOT_CONTRACT, 0)} />,
    );

    expect(html).toContain("Agency systems");
    expect(html).toContain("No agency configured");
    expect(html).toContain("Discovery needed");
    expect(html).toContain("0 of 8");
    expect(html).toContain("Morning money");
    expect(html).toContain("Inbox and maintenance");
    expect(html).toContain("Tenancy dates");
    expect(html).toContain("PropertyMe");
    expect(html).toContain("MRI Property Tree");
    expect(html).toContain("Reapit PM");
    expect(html).toContain("Other named PMS");
    expect(html).toContain("Release stays pilot-gated");
    expect(html).toContain("Allow and human Submit remain locked");
    expect(html).not.toContain("Auston Realty");
    expect(html).not.toContain("Public candidate");
    expect(html).not.toContain(">Connect<");
    expect(html).not.toContain("Sherry Zhao");
    expect(html).not.toContain("Hermes");
  });
});
