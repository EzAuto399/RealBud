import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StoreProvider } from "@/state/store";
import { AskIntakeBar } from "./ChatView";

describe("Ask book intake", () => {
  it("is a quiet composer control, not a header product chip", () => {
    const html = renderToStaticMarkup(
      <StoreProvider>
        <AskIntakeBar />
      </StoreProvider>,
    );
    expect(html).toContain("Add book");
    expect(html).not.toContain("border-line");
    expect(html).not.toContain("pm-tactile");
    expect(html).not.toContain("Import options");
  });
});
