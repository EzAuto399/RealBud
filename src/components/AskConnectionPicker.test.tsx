import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ASK_CONNECTION_OPTIONS } from "@shared/ask-connections";
import { AskConnectionPicker } from "./AskConnectionPicker";

describe("Ask connection picker", () => {
  it("renders common office sources first and keeps Composio in more setup", () => {
    const html = renderToStaticMarkup(
      <AskConnectionPicker options={[...ASK_CONNECTION_OPTIONS]} onChoose={() => {}} />,
    );
    expect(html).toContain("Common for this office");
    expect(html).toContain("More setup");
    expect(html.indexOf("Property book / PMS")).toBeLessThan(html.indexOf("Your Composio account"));
    expect(html).toContain("Approved API or MCP");
    expect(html).not.toMatch(/marketplace|9000/i);
  });
});
