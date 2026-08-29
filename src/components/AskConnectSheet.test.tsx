import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StoreProvider } from "@/state/store";
import { AskConnectSheet } from "./AskConnectSheet";

describe("Ask connect sheet", () => {
  it("opens Notion as a ledger dialog with the reserved pop-in motion", () => {
    const html = renderToStaticMarkup(
      <StoreProvider>
        <AskConnectSheet
          request={{ target: "connections", service: "Notion" }}
          canBack={false}
          onClose={() => undefined}
        />
      </StoreProvider>,
    );
    expect(html).toContain("role=\"dialog\"");
    expect(html).toContain("Connect Notion");
    expect(html).toContain("ask-connect-veil");
    expect(html).toContain("animate-pop-in");
    expect(html).toContain("Paste the Notion API key");
    expect(html).toContain("Close connection card");
    expect(html).not.toContain("plugin marketplace");
  });
});
