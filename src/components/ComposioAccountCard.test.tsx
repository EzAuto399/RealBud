import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StoreProvider } from "@/state/store";
import { ComposioAccountCard } from "./ComposioAccountCard";

describe("Composio account card", () => {
  it("leads with sign-in and keeps the Connect key off the Ask transcript", () => {
    const html = renderToStaticMarkup(
      <StoreProvider>
        <ComposioAccountCard />
      </StoreProvider>,
    );
    expect(html).toContain("Sign in to Composio");
    expect(html).toContain("Then paste the Connect key");
    expect(html).not.toContain('href="https://platform.composio.dev"');
    expect(html).toMatch(/not a tool marketplace/);
    expect(html).not.toMatch(/9000/);
  });
});
