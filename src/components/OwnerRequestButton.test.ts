import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OWNER_COMPUTERS_URL, OWNER_REQUEST, type OwnerRequestKind } from "@/lib/owner-request";
import { OwnerRequestButton } from "./OwnerRequestButton";

describe("Copy request for your owner", () => {
  it("is one keyboard-reachable 44 px button that copies and says so, and never sends", () => {
    const html = renderToStaticMarkup(createElement(OwnerRequestButton, { request: "linkCode" }));
    expect(html).toMatch(/^<span class="workspace-copy"><button type="button" class="pm-control [^"]*border-line[^"]*" aria-label="Copy request for your owner">/);
    expect(html).not.toContain('disabled=""');
    expect(html).toContain("Copy request for your owner</button>");
    // The live region that announces "Copied to clipboard" is present before the click.
    expect(html).toContain('<span role="status" class="sr-only"></span>');
    expect(html).not.toMatch(/<a |<form|mailto:/);
  });

  it("says what to do and where, in plain words", () => {
    for (const [kind, text] of Object.entries(OWNER_REQUEST) as [OwnerRequestKind, string][]) {
      expect(text).toMatch(/^Hi, /);
      expect(text).not.toMatch(/Hermes|MCP|broker|installation(?!s)/i);
      // The bank feed is connected in RealBud itself; every website step names its page.
      if (kind !== "bankFeed") expect(text).toContain(OWNER_COMPUTERS_URL);
    }
    expect(OWNER_REQUEST.bankFeed).toContain("Workspace → Connected apps → Bank feed");
    expect(OWNER_REQUEST.bankFeed).toContain("bank CSV");
  });
});
