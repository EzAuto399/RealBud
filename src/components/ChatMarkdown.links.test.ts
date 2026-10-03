import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown";
import { BankFeedConnect } from "./ConnectedAppsCard";

const render = (text: string) => renderToStaticMarkup(createElement(ChatMarkdown, { text }));
const anchors = (html: string) => html.match(/<a\b[^>]*>/g) ?? [];

describe("links in chat", () => {
  it("renders the bank feed link as an inline connect action, not a link to Workspace", () => {
    const html = render("Redbark is RealBud's bank feed.\n\n[Connect bank feed](#connect-bank-feed)");
    expect(anchors(html)).toEqual([]);
    expect(html).toContain("Checking the bank feed…");
    const noop = async () => {};
    const view = (status: "not_connected" | "connected", canManage: boolean) => renderToStaticMarkup(createElement(BankFeedConnect, { controls: {
      view: { state: { version: 1, connector: "redbark", status, account: status === "connected" ? { label: "Office account", verifiedAt: 1 } : null, generation: 1, reason: null, canManage }, loading: false, readError: null, busy: null, notice: null },
      connect: noop, check: noop, refresh: noop,
    } }));
    expect(view("not_connected", true)).toMatch(/<button[^>]*>Connect bank feed<\/button>/);
    expect(view("not_connected", false)).not.toContain("<button");
    expect(view("not_connected", false)).toContain("Only the office owner or an administrator can connect the bank feed.");
    expect(view("connected", true)).toContain("Bank feed connected (Office account).");
  });

  it("keeps plain https links clickable in a new window", () => {
    const html = render("Open [the portal](https://realbud.app/account) or https://example.com/notice.");
    expect(anchors(html)).toEqual([
      expect.stringContaining('href="https://realbud.app/account" target="_blank" rel="noreferrer"'),
      expect.stringContaining('href="https://example.com/notice" target="_blank" rel="noreferrer"'),
    ]);
  });

  it("shows other links as copyable text with their address", () => {
    const cases: Array<[string, string]> = [
      ["[the owner portal](http://portal.example/login)", "the owner portal<span class=\"break-all text-ink-secondary\"> (http://portal.example/login)</span>"],
      ["[call the tenant](tel:+61400000000)", "call the tenant<span class=\"break-all text-ink-secondary\"> (tel:+61400000000)</span>"],
      ["[the lease](file:///Users/office/lease.pdf)", "the lease<span class=\"break-all text-ink-secondary\"> (file:///Users/office/lease.pdf)</span>"],
      ["[shared drive](smb://fileserver/leases)", "shared drive<span class=\"break-all text-ink-secondary\"> (smb://fileserver/leases)</span>"],
      ["[sign in](https://user:secret@example.com/)", "sign in<span class=\"break-all text-ink-secondary\"> (https://user:secret@example.com/)</span>"],
      ["[notes](/api/notes)", "notes<span class=\"break-all text-ink-secondary\"> (/api/notes)</span>"],
    ];
    for (const [markdown, expected] of cases) {
      const html = render(markdown);
      expect(anchors(html), markdown).toEqual([]);
      expect(html, markdown).toContain(expected);
    }
  });

  it("does not repeat an address the words already show", () => {
    const html = render("Write to tenant@example.com or see www.example.com.");
    expect(anchors(html)).toEqual([]);
    expect(html).toContain('<span class="break-words">tenant@example.com</span>');
    expect(html).toContain('<span class="break-words">www.example.com</span>');
    expect(html).not.toContain("mailto:");
    expect(html).not.toContain("http://www.example.com");
  });

  it("never puts a script address in a link and shows it only as inert text", () => {
    const html = render("[click me](javascript:alert(1)) ![pic](javascript:alert(2))");
    expect(anchors(html)).toEqual([]);
    expect(html).not.toMatch(/(href|src)="javascript:alert/);
    expect(html).toContain("click me<span class=\"break-all text-ink-secondary\"> (javascript:alert(1))</span>");
  });

  it("keeps footnote links on the page", () => {
    const html = render("Check the notice[^1].\n\n[^1]: Served on 1 October.");
    const [reference, back] = anchors(html);
    expect(reference).toContain('href="#user-content-fn-1"');
    expect(reference).toContain('id="user-content-fnref-1"');
    expect(back).toContain('href="#user-content-fnref-1"');
    expect(back).toContain('aria-label="Back to reference 1"');
    expect(html).not.toMatch(/href="#[^"]*" target=/);
  });

  it("leaves an empty link as its words", () => {
    const html = render("[nothing here]()");
    expect(anchors(html)).toEqual([]);
    expect(html).toContain('<span class="break-words">nothing here</span>');
  });
});
