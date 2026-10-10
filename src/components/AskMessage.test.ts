import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AskMessage } from "./AskMessage";

vi.mock("@/state/store", () => ({ formatTime: () => "5:30 PM" }));
vi.mock("./Avatar", () => ({ MausAvatar: () => null }));
const copied = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/use-copy-text", () => ({ useCopyText: (text: string) => { copied.push(text); return { state: "idle", copy: async () => {} }; } }));

const render = (text: string, extra = {}) => renderToStaticMarkup(createElement(AskMessage, {
  text, at: 1757403000000, user: true, children: "Assistant content", onEdit: vi.fn(), ...extra,
}));

describe("Ask conversation clarity", () => {
  it("puts the sender and Telegram mark in the header, and only the request in the body", () => {
    const html = render("[Telegram · Yoda] Chase the repair quote.");
    expect(html).toContain('aria-label="Yoda · Telegram"');
    expect(html).toContain("via Telegram");
    expect(html).toContain('<circle cx="12" cy="12" r="12"');
    expect(html).not.toContain("[Telegram");
    expect(html.split('class="ask-request-body"')[1]).toContain("Chase the repair quote.");
    expect(html).toContain("Edit &amp; resend");
  });
  it("offers no empty copy or edit action for a stamp-only message", () => {
    const html = render("[Telegram · Yoda]");
    expect(html).toContain("No message text was saved.");
    expect(html).not.toContain("<button");
  });
  it("does not interpret channel text in Bud's response", () => {
    const html = render("[Telegram · Yoda] Example", { user: false });
    expect(html).not.toContain("via Telegram");
    expect(html).toContain("Assistant content");
  });
  it("escapes sender names and retains accessible expansion controls", () => {
    const html = render(`[Telegram · <script>alert(1)</script>] ${"A paragraph.\n".repeat(12)}`);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain('aria-controls=');
    expect(html).toContain('aria-expanded="false"');
  });
  it("exposes request versions and disables unavailable navigation", () => {
    const html = render("Revised request", { versions: { current: 2, total: 2, onPrevious: vi.fn() } });
    expect(html).toContain('aria-label="Request versions, 2 of 2"');
    expect(html).toContain("2 of 2");
    expect(html).toMatch(/aria-label="Next request version" disabled=""/);
    expect(html).not.toMatch(/aria-label="Previous request version" disabled/);
  });
  it("copies a reply's chart as readable lines, not its raw data block", () => {
    copied.length = 0;
    const reply = 'Collections improved.\n\n```chart\n{"type":"line","title":"Rent collected","unit":"AUD","x":["Jul","Aug","Sep"],"series":[{"name":"Collected","values":[41000,43500,44200]}]}\n```';
    render(reply, { user: false });
    expect(copied.at(-1)).toContain("Rent collected");
    expect(copied.at(-1)).toContain("Sep: $44,200");
    expect(copied.at(-1)).not.toMatch(/```|"type"/);
    render("```chart\n{not a chart}\n```");
    expect(copied.at(-1)).toContain("```chart");
  });
  it("handles unavailable timestamps", () => {
    expect(render("Request", { at: NaN })).toContain("Time unavailable");
  });
});
