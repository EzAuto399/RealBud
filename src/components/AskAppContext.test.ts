import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@/state/store";
import type { ConnectedAppsStatus } from "@shared/office-sources";
import { deriveAskAppContext } from "@/lib/ask-app-context";
import { AskAppContextPanel, AskAppContextToggle, useAskAppContext } from "./AskAppContext";

const view = vi.hoisted(() => ({ snapshot: null as ConnectedAppsStatus | null, loading: false, error: "", pendingService: null as string | null }));
vi.mock("@/lib/connected-apps-refresh", () => ({ useOfficeSources: () => view, officeSources: { refresh: vi.fn() } }));
const request = (text: string): Message => ({ id: "request-1", at: 1, role: "user", kind: "text", text });
const activity = (): Message => ({ id: "activity-1", at: 2, role: "bot", kind: "activity", tool: { name: "GMAIL_FETCH_EMAILS" } });
const access = (): ConnectedAppsStatus => ({ configured: true, checkedAt: new Date().toISOString(), services: {
  gmail: { connected: true, status: "ACTIVE", accounts: [{ id: "mail", status: "ACTIVE" }], accountSelectionRequired: false },
  googledrive: { connected: true, status: "ACTIVE", accounts: [{ id: "drive", status: "ACTIVE" }], accountSelectionRequired: false },
}, tools: { available: true, names: ["read_mail", "read_file"] } });
function render(messages: Message[], enabled = true) {
  function Fixture() {
    const context = useAskAppContext({ threadId: "test-context", messages, enabled });
    return createElement("div", null,
      createElement(AskAppContextToggle, { context }),
      createElement(AskAppContextPanel, { context, onManage: vi.fn() }));
  }
  return renderToStaticMarkup(createElement(Fixture));
}
beforeEach(() => {
  vi.unstubAllGlobals();
  Object.assign(view, { snapshot: access(), loading: false, error: "", pendingService: null });
});

describe("app context presentation", () => {
  it("stays out of view for a request with no app context", () => {
    const html = render([request("Review this document")]);
    expect(html).toContain('aria-label="App context" aria-expanded="false"');
    expect(html).not.toContain('role="region"');
    expect(html).not.toContain("Gmail");
  });

  it.each(["Review the Gmail replies", "Create a local reminder. Do not use Gmail or any external account."])("keeps mention-only context closed: %s", text => {
    const html = render([request(text)]);
    expect(html).toContain('aria-label="App context" aria-expanded="false"');
    expect(html).toContain('aria-label="1 relevant app"');
    expect(html).not.toContain('role="region"');
  });

  it("surfaces observed app activity even when the app was also mentioned", () => {
    const html = render([request("Review the Gmail replies"), activity()]);
    expect(html).toContain('role="region" aria-label="Connected apps context"');
    expect(html).toContain("Gmail");
    expect(html).toContain("Mentioned in this request");
    expect(html).toContain("View all apps");
    expect(html).not.toContain("Google Drive");
    expect(html).toContain('aria-label="Hide app context"');
  });

  it("respects a saved dismissal for this same request and app", () => {
    const messages = [request("Review Gmail replies"), activity()];
    const { contextKey } = deriveAskAppContext({ messages, snapshot: view.snapshot });
    vi.stubGlobal("sessionStorage", { getItem: () => contextKey });
    expect(render(messages)).not.toContain('role="region"');
    vi.stubGlobal("sessionStorage", { getItem: () => JSON.stringify(["request-1", ["gmail", "googledrive"]]) });
    expect(render(messages)).not.toContain('role="region"');
    expect(render([{ ...messages[0], id: "request-2" }, activity()])).toContain('role="region"');
  });

  it("does not describe failed connections as available in the rail", () => {
    view.snapshot!.tools = { available: false, names: [] };
    const html = render([request("Review Gmail replies"), activity()]);
    expect(html).toContain("Needs attention");
    expect(html).toContain('aria-label="Review Gmail connection"');
    expect(html).not.toContain("Available to your requests");
    expect(html).not.toContain("ask-app-context-ready");
  });

  it("can surface a pending app before the first connection snapshot", () => {
    view.snapshot = null;
    view.pendingService = "gmail";
    expect(render([])).toContain("Finish sign-in");
    expect(render([])).toContain("Gmail");
  });

  it("stays disabled outside the product Ask surface", () => {
    expect(render([request("Review Gmail"), activity()], false)).not.toContain('role="region"');
  });
});
