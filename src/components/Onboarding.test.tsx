import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StoreProvider } from "@/state/store";
import { Onboarding } from "./Onboarding";

describe("first-run welcome", () => {
  it("is one screen that starts the required setup wizard, with no practice skip", () => {
    const html = renderToStaticMarkup(
      <StoreProvider>
        <Onboarding onDone={() => undefined} />
      </StoreProvider>,
    );

    expect(html).toContain("Welcome to RealBud");
    expect(html).toContain("Your name");
    expect(html).toContain("Get started");
    expect(html).toContain("model and API key");
    expect(html).not.toContain("Use practice desk");
    expect(html).not.toContain("A practice desk is ready");
    expect(html).not.toContain("You stay in control");
    expect(html).not.toContain("Set up Bud");
    expect(html).not.toContain("Bud prepares.");
    expect(html).not.toContain("You approve.");
  });
});
