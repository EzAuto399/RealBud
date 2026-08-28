import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { PropertyIntakeRoutePicker } from "./PropertyIntakeRoutePicker";

describe("PropertyIntakeRoutePicker", () => {
  it("shows every supported intake route without claiming a pilot connection is available", () => {
    const html = renderToStaticMarkup(
      <PropertyIntakeRoutePicker
        onChoosePmsExport={vi.fn()}
        onChooseFiles={vi.fn()}
        onChoosePaste={vi.fn()}
        onOpenConnections={vi.fn()}
      />,
    );

    expect(html).toContain("Current PMS export");
    expect(html).toContain("Files, screenshots or photos");
    expect(html).toContain("Paste or add a few");
    expect(html).toContain("Read-only PMS connection");
    expect(html).toContain("Pilot-gated");
    expect(html).toContain("Only a matched current PMS export can verify live balances");
    expect(html).not.toContain("Connect now");
    expect(html).not.toContain("Connected");
  });
});
