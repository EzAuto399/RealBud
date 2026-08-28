import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PocketPilotRequirements } from "./PocketConnectionCard";
import { VerifiedConnectionCard } from "./VerifiedConnectionCard";

describe("Pocket connection setup", () => {
  it("explains the WhatsApp pilot gate without exposing a credential or fake connect control", () => {
    const html = renderToStaticMarkup(<PocketPilotRequirements channel="whatsapp-business" />);

    expect(html).toContain('role="region"');
    expect(html).toContain("Before WhatsApp Business can connect");
    expect(html).toContain("real agency and the PM");
    expect(html).toContain("official Business Cloud");
    expect(html).toContain("Ask never stores them in the transcript");
    expect(html).not.toContain('type="password"');
    expect(html).not.toContain(">Connect<");
  });

  it("keeps the requirements disclosure keyboard and screen-reader visible", () => {
    const html = renderToStaticMarkup(
      <VerifiedConnectionCard
        icon={<span aria-hidden="true">P</span>}
        title="WhatsApp Business"
        description="Private PM messages."
        state="off"
        status="Pilot-gated"
        action={{
          label: "View requirements",
          onClick: () => undefined,
          expanded: false,
          controls: "whatsapp-business-pilot-requirements",
        }}
      />,
    );

    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="whatsapp-business-pilot-requirements"');
    expect(html).toContain("View requirements");
  });
});
