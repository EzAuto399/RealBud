import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: vi.fn() }), api: vi.fn() }));

import { WebsiteLinkCard, WebsiteLinkCardView, modelAccessState, readBrowserLinkView, savedBrowserRequest, type BrowserLinkPhase } from "./WebsiteLinkCard";
import type { OfficeLinkStatus } from "../../../server/office-link";

const approvalUrl = `https://realbud.app/link/${"A".repeat(43)}`;
const request = { approvalUrl, displayCode: "ABCD-EFGH", expiresAt: "2026-09-23T10:00:00.000Z" };
const unlinked: OfficeLinkStatus = { state: "unlinked" };
const noop = () => {};
const view = (phase: BrowserLinkPhase, status: OfficeLinkStatus | null = unlinked, label = "Reception Mac") => renderToStaticMarkup(createElement(WebsiteLinkCardView, {
  status, phase, label, code: "", busy: false, error: "", confirm: false,
  onLabel: noop, onCode: noop, onStart: noop, onOpenAgain: noop, onCancel: noop, onRetry: noop,
  onLinkCode: noop, onReport: noop, onDisconnect: noop, onConfirm: noop, onRefresh: noop,
}));
const liveRegion = (html: string) => /<p role="status" aria-live="polite" class="sr-only">([^<]*)<\/p>/.exec(html)?.[1];

describe("website account card", () => {
  it("leads with the browser approval and keeps the pasted code behind a disclosure", () => {
    const html = view({ kind: "idle" });
    expect(html).toMatch(/<button type="button" class="pm-decision[^"]*">Link with your RealBud account<\/button>/);
    expect(html).toContain("Computer name");
    expect(html).toContain("<summary");
    expect(html).toContain("Have a link code instead?");
    expect(html).toContain("Link this computer</button>");
    expect(html).not.toContain("<details open");
    expect(html).not.toContain("Optional.");
    // The live region is present before anything changes.
    expect(liveRegion(html)).toBe("");
  });

  it("will not start without a computer name", () => {
    expect(view({ kind: "idle" }, unlinked, " ")).toMatch(/<button type="button" class="pm-decision[^"]*" disabled="">Link with your RealBud account/);
    expect(view({ kind: "idle" }, null)).toMatch(/disabled="">Link with your RealBud account/);
  });

  it("waits with the display code, a way back to the page, and cancel", () => {
    const html = view({ kind: "waiting", request });
    expect(liveRegion(html)).toBe("Approve this computer in your browser. The page shows code ABCD-EFGH.");
    expect(html).toContain("Waiting…");
    expect(html).toContain(">Open the page again</button>");
    expect(html).toContain(">Cancel</button>");
    // No second start and no pasted-code path while an approval is waiting.
    expect(html).not.toContain("Link with your RealBud account</button>");
    expect(html).not.toContain("Have a link code instead?");
    const cancelling = view({ kind: "cancelling", request });
    expect(cancelling).toMatch(/disabled="" aria-busy="true">Cancelling…/);
  });

  it("offers a retry when the website cannot be reached", () => {
    const polling = view({ kind: "unreachable", message: "The website could not be reached. Check this computer’s internet connection, then try again.", request });
    expect(polling).toContain('role="alert"');
    expect(polling).toContain(">Try again</button>");
    expect(polling).toContain(">Cancel</button>");
    const starting = view({ kind: "unreachable", message: "The website could not be reached." });
    expect(starting).toMatch(/class="pm-decision[^"]*">Try again<\/button>/);
  });

  it("shows a failure the service also recorded only once", () => {
    const message = "The website could not be reached. Check this computer’s internet connection, then try again.";
    const html = view({ kind: "unreachable", message }, { state: "unlinked", error: message });
    expect(html.split(message)).toHaveLength(2);
    expect(view({ kind: "idle" }, { state: "unlinked", error: "The website link could not be updated." })).toContain("The website link could not be updated. <button");
  });

  it("says declined and expired plainly and offers to start again", () => {
    const declined = view({ kind: "declined" });
    expect(liveRegion(declined)).toBe("This computer was declined in your browser. Nothing was linked.");
    expect(declined).toMatch(/class="pm-decision[^"]*">Start again<\/button>/);
    const expired = view({ kind: "expired" });
    expect(liveRegion(expired)).toBe("The approval page expired before this computer was approved. Nothing was linked.");
    expect(expired).toContain(">Start again</button>");
    expect(expired).toContain("Have a link code instead?");
  });

  it("names the office it joined, offers a one-click way out, then shows the linked computer", () => {
    const joined: BrowserLinkPhase = { kind: "linked", agencyLabel: "Synthetic Office" };
    const html = view(joined, { state: "linked", agencyLabel: "Synthetic Office", label: "Reception Mac", provisioned: false });
    expect(liveRegion(html)).toBe("Linked to Synthetic Office. Setting up Bud’s model access…");
    expect(html).toContain('<p class="font-medium text-ink">Linked to Synthetic Office.</p>');
    expect(html).toContain('aria-busy="true">Setting up Bud’s model access…</p>');
    // One click, no confirmation step: a leaked approval page may have joined another office.
    expect(html).toContain('<button type="button" class="pm-control rounded border border-line px-3 py-2">Not your office? Disconnect</button>');
    expect(html).toContain("<strong>Synthetic Office</strong> · Reception Mac");
    expect(html).toContain(">Disconnect website</button>");
    expect(html).not.toContain("Link with your RealBud account</button>");
    const ready = view(joined, { state: "linked", agencyLabel: "Synthetic Office", label: "Reception Mac", provisioned: true, lastReportedAt: "2026-09-23T10:00:00.000Z" });
    expect(liveRegion(ready)).toBe("Linked to Synthetic Office. Bud’s model access is set up.");
    expect(ready).toContain("Not your office? Disconnect");
    // Before the service confirms the link, the office is still named with the way out.
    expect(view(joined, { state: "pending" })).toContain("Not your office? Disconnect");
    // Returning later shows the ordinary linked view only.
    expect(view({ kind: "idle" }, { state: "linked", agencyLabel: "Synthetic Office", label: "Reception Mac" })).not.toContain("Not your office?");
  });

  it("reads model access from the service and never guesses it is set up", () => {
    const linked: OfficeLinkStatus = { state: "linked", agencyLabel: "Synthetic Office" };
    expect(modelAccessState(linked)).toBe("setting-up");
    expect(modelAccessState({ ...linked, provisioned: true })).toBe("ready");
    expect(modelAccessState({ ...linked, provisioned: false, lastReportedAt: "2026-09-23T10:00:00.000Z" })).toBe("not-yet");
    expect(modelAccessState({ ...linked, error: "The website did not accept the latest status. Your local work can continue." })).toBe("failed");
    expect(modelAccessState({ ...linked, serviceWithdrawn: true })).toBeNull();
    expect(modelAccessState({ state: "pending" })).toBeNull();
    expect(modelAccessState(null)).toBeNull();
  });

  it("keeps saved model-access progress and failure guidance when the linked card is reopened", () => {
    const linked: OfficeLinkStatus = { state: "linked", agencyLabel: "Synthetic Office" };
    for (const [status, text] of [
      [linked, "Setting up Bud’s model access…"],
      [{ ...linked, lastReportedAt: "2026-09-23T10:00:00.000Z" }, "Bud’s model access has not arrived from your account yet."],
      [{ ...linked, error: "Fictional status check failed." }, "Use Update status to try again."],
      [{ ...linked, provisioned: true }, "Bud’s model access is set up."],
    ] as const) {
      const html = view({ kind: "idle" }, status);
      expect(html).toContain(text);
      expect(liveRegion(html)).toContain(text);
      expect(html).not.toContain("Not your office?");
    }
    expect(view({ kind: "idle" }, { ...linked, serviceWithdrawn: true })).not.toContain("Setting up Bud’s model access");
  });

  it("keeps an interrupted pasted-code link on its own safe retry path", () => {
    const html = view({ kind: "idle" }, { state: "pending", label: "Reception Mac" });
    expect(html).toContain("Linking with a code was interrupted. Paste the same code to retry safely.");
    expect(html).toContain("<details open=\"\"");
    expect(html).not.toContain("Link with your RealBud account</button>");
  });

  it("renders the live card with nothing started", () => {
    expect(renderToStaticMarkup(createElement(WebsiteLinkCard))).toContain("Link with your RealBud account");
  });
});

describe("browser link answers", () => {
  it("accepts each well-formed answer and nothing else", () => {
    expect(readBrowserLinkView({ state: "pending", ...request })).toEqual({ state: "pending", ...request });
    expect(readBrowserLinkView({ state: "linked", agencyLabel: "Synthetic Office" })).toEqual({ state: "linked", agencyLabel: "Synthetic Office" });
    for (const state of ["none", "expired", "declined"]) expect(readBrowserLinkView({ state })).toEqual({ state });
    for (const bad of [null, [], { state: "approved" }, { state: "linked" }, { state: "pending", ...request, approvalUrl: "javascript:alert(1)" },
      { state: "pending", ...request, approvalUrl: `http://evil.test/link/${"A".repeat(43)}` }, { state: "pending", ...request, displayCode: "0000-0000" }]) {
      expect(readBrowserLinkView(bad)).toBeNull();
    }
  });

  it("resumes only a well-formed saved approval", () => {
    expect(savedBrowserRequest({ state: "pending", browser: request })).toEqual(request);
    expect(savedBrowserRequest({ state: "pending" })).toBeNull();
    expect(savedBrowserRequest({ state: "linked", browser: request })).toBeNull();
    expect(savedBrowserRequest({ state: "pending", browser: { ...request, approvalUrl: "https://realbud.app/account" } })).toBeNull();
  });
});
