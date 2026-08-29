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
  it("leads Gmail with a two-step wizard and keeps other methods collapsed", () => {
    const html = renderCard("Gmail");
    expect(html).toContain("1 of 2");
    expect(html).toContain("Link Composio");
    expect(html).toContain("Sign in to Composio");
    expect(html).toContain("Login");
    expect(html).toContain("Connect key");
    expect(html).not.toContain("2 of 2");
    expect(html).not.toContain("Sign in this account");
    expect(html).not.toContain("Replace Connect key");
    expect(html).toContain("Other methods");
    expect(html).toContain("Direct API");
    expect(html).toContain("Restricted Composio");
    expect(html).toContain("Approved MCP");
    expect(html).toContain("Attach an export");
    expect(html).toContain("Current standard");
    expect(html).toContain("Not in this build");
    expect(html).toContain('value="restricted-composio"');
    expect(html).toMatch(/checked="" value="restricted-composio"/);
    expect(html).not.toMatch(/checked="" value="direct-api"/);
    expect(html).not.toMatch(/checked="" value="approved-mcp"/);
    expect(html).not.toMatch(/command line|isolated CLI/i);
    expect(html).toMatch(/No send or marketplace/);
    expect(html).not.toMatch(/9000/);
  });

  it("leads a named app with Direct API so a pasted key can connect", () => {
    const html = renderCard("Notion");
    expect(html).toContain("Paste the Notion API key");
    expect(html).toContain("API key");
    expect(html).toContain("Connect");
    expect(html).toMatch(/checked="" value="direct-api"/);
    expect(html).not.toMatch(/checked="" value="restricted-composio"/);
    expect(html).toContain("Other methods");
  });

  it("selects Attach an export as the current standard for Incoming mail", () => {
    const html = renderCard("Incoming mail");
    expect(html).toContain("Attach an export in Ask");
    expect(html).toContain("Other methods");
    expect(html).toContain("Current standard");
    expect(html).toMatch(/checked="" value="isolated-cli"/);
    expect(html).not.toMatch(/checked="" value="restricted-composio"/);
    expect(html).not.toMatch(/command line|isolated CLI/i);
  });
});
