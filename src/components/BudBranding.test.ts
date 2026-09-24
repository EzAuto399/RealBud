import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AgentUpdates } from "./AgentUpdates";

describe("Bud-facing engine copy", () => {
  it("names Bud in the update controls", () => {
    const html = renderToStaticMarkup(createElement(AgentUpdates, { onSettled: async () => {} }));
    expect(html).toContain("Bud updates");
    expect(html).toContain("Check Bud updates");
    expect(html).not.toMatch(/Hermes|\.hermes/i);
  });
});
