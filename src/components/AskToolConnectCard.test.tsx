import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StoreProvider } from "@/state/store";
import { AskToolConnectCard } from "./AskToolConnectCard";

function renderCard(service: string) {
  return renderToStaticMarkup(
    <StoreProvider>
      <AskToolConnectCard service={service} onAttachInAsk={() => {}} />
    </StoreProvider>,
  );
}

describe("Ask tool connect card", () => {
  it("shows the professional method ladder and fills Restricted Composio for Gmail", () => {
    const html = renderCard("Gmail");
    expect(html.indexOf("Direct API")).toBeGreaterThan(-1);
    expect(html.indexOf("Restricted Composio")).toBeGreaterThan(-1);
    expect(html.indexOf("Approved MCP")).toBeGreaterThan(-1);
    expect(html.indexOf("Attach an export")).toBeGreaterThan(-1);
    expect(html.indexOf("Direct API")).toBeLessThan(html.indexOf("Restricted Composio"));
    expect(html.indexOf("Restricted Composio")).toBeLessThan(html.indexOf("Approved MCP"));
    expect(html).toContain("Current standard");
    expect(html).toContain("Not in this build");
    expect(html).toContain("Sign in to Composio");
    expect(html).toContain("Then paste the Connect key");
    expect(html).toContain('value="restricted-composio"');
    expect(html).toMatch(/checked="" value="restricted-composio"/);
    expect(html).not.toMatch(/checked="" value="direct-api"/);
    expect(html).not.toMatch(/checked="" value="approved-mcp"/);
    expect(html).not.toMatch(/command line|isolated CLI/i);
    expect(html).toMatch(/No send or marketplace/);
    expect(html).not.toMatch(/9000/);
  });

  it("selects Attach an export as the current standard for Incoming mail", () => {
    const html = renderCard("Incoming mail");
    expect(html).toContain("Current standard");
    expect(html).toContain("Attach an export in Ask");
    expect(html).toMatch(/checked="" value="isolated-cli"/);
    expect(html).not.toMatch(/checked="" value="restricted-composio"/);
    expect(html).not.toMatch(/command line|isolated CLI/i);
  });
});
