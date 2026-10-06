import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficeLinkStatus } from "../../server/office-link";

const link = vi.hoisted(() => ({
  status: null as OfficeLinkStatus | null, phase: { kind: "idle" } as { kind: string },
  start: vi.fn(), linkCode: vi.fn(), setError: vi.fn(), cancel: vi.fn(), retry: vi.fn(), refresh: vi.fn(),
}));
// Hooks run as plain calls so the wiring can be exercised without a DOM.
vi.mock("react", async importOriginal => ({ ...(await importOriginal<typeof import("react")>()), useState: <T,>(initial: T) => [initial, vi.fn()] }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: { config: { profile: { name: "Fictional Person" } } }, dispatch: vi.fn() }), api: vi.fn() }));
vi.mock("./you/browser-link", async importOriginal => ({
  ...(await importOriginal<typeof import("./you/browser-link")>()),
  useBrowserLink: () => ({ ...link, error: "", setPhase: vi.fn(), changed: vi.fn() }),
}));

import { ConnectOffice, ConnectOfficeView, useConnectOffice, type ConnectOfficeViewProps } from "./ConnectOffice";
import { defaultComputerName } from "./you/browser-link";

const request = { approvalUrl: `https://realbud.app/link/${"A".repeat(43)}`, displayCode: "ABCD-EFGH", expiresAt: "2026-09-30T10:00:00.000Z" };
const noop = () => {};
const view = (status: OfficeLinkStatus | null, phase: ConnectOfficeViewProps["phase"] = { kind: "idle" }, extra: Partial<ConnectOfficeViewProps> = {}) =>
  renderToStaticMarkup(createElement(ConnectOfficeView, { status, phase, error: "", code: "", codeBusy: false,
    onStart: noop, onOpenAgain: noop, onCancel: noop, onRetry: noop, onCode: noop, onLinkCode: noop, onRefresh: noop, ...extra }));
const live = (html: string) => /<p role="status" aria-live="polite" class="sr-only">([^<]*)<\/p>/.exec(html)?.[1];

beforeEach(() => { vi.clearAllMocks(); link.status = { state: "unlinked" }; link.phase = { kind: "idle" }; });

describe("connect this computer to your office", () => {
  it("leads with the link code box and one 44 px primary action, with browser approval as a quiet owner option", () => {
    const button = (html: string, label: string) => new RegExp(`<button[^>]*class="([^"]*)"[^>]*>(?:(?!</button>).)*${label}`).exec(html)?.[1] ?? "";
    const html = view({ state: "unlinked" }), pasted = view({ state: "unlinked" }, { kind: "idle" }, { code: "rb1_" + "a".repeat(64) });
    expect(html.match(/pm-decision/g)).toHaveLength(1);
    expect(html).not.toContain("<details");
    expect(html).toMatch(/<label[^>]*>Link code<input[^>]*placeholder="Paste the code here"/);
    // No browser "Please fill in this field" tooltip on hover; the disabled submit guards empty input.
    expect(html).toMatch(/<input required="" title=""/);
    expect(html).toMatch(/<button type="submit" class="pm-decision[^"]*bg-agency[^"]*" disabled="">Connect with this code<\/button>/);
    expect(button(pasted, "Connect with this code")).toContain("bg-agency");
    expect(pasted).not.toMatch(/type="submit"[^>]*disabled=""/);
    expect(button(html, "I’m the office owner: approve in my browser")).not.toContain("bg-agency");
    expect(html).toContain("Owners: realbud.app → Computers → Pair a new computer.");
    expect(live(html)).toBe("");
    expect(html).not.toMatch(/Hermes|MCP|broker|grant|installation/i);
  });

  it("holds the action until the saved link has been read, with a retry when it could not be", () => {
    expect(view(null)).toMatch(/disabled="">.*I’m the office owner: approve in my browser<\/button>/);
    expect(view(null, { kind: "idle" }, { code: "rb1_" + "a".repeat(64) })).toMatch(/disabled="">Connect with this code<\/button>/);
    const failed = view(null, { kind: "idle" }, { error: "Website link status could not be loaded. Try again." });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain(">Try again</button>");
  });

  it("waits with the matching code, a way back to the page and cancel", () => {
    const html = view({ state: "pending", browser: request }, { kind: "waiting", request });
    expect(html).toContain("Your browser opened realbud.app. Sign in with the email RealBud invited, check the page shows code ABCD-EFGH, then approve.");
    expect(live(html)).toBe("Approve this computer in your browser. The page shows code ABCD-EFGH.");
    expect(html).toContain("Waiting for your approval…");
    expect(html).toContain("Open the page again</button>");
    expect(html).toContain(">Cancel</button>");
    expect(html).not.toContain("approve in my browser</button>");
    expect(html).not.toContain("Connect with this code");
    expect(view({ state: "pending", browser: request }, { kind: "cancelling", request })).toMatch(/disabled="" aria-busy="true">Cancelling…/);
  });

  it("reuses the website card's copy for unreachable, declined and not-yet-entitled answers", () => {
    const unreachable = view({ state: "pending", browser: request }, { kind: "unreachable", message: "The website could not be reached.", request });
    expect(unreachable).toContain('role="alert" class="text-danger">The website could not be reached.');
    expect(unreachable).toContain(">Try again</button>");
    expect(view({ state: "unlinked" }, { kind: "declined" })).toContain("This computer was declined in your browser. Nothing was linked.");
    const skipped = view({ state: "linked", agencyLabel: "Fictional Harbour Agency", provisioningSkipped: "service_not_entitled", lastReportedAt: "2026-09-30T00:00:00.000Z" });
    expect(skipped).toContain("AI isn’t turned on for your office yet.");
  });

  it("names the office once linked and stops asking", () => {
    const html = view({ state: "linked", agencyLabel: "Fictional Harbour Agency", provisioned: true });
    expect(html).toContain("Connected to Fictional Harbour Agency");
    expect(live(html)).toBe("Connected to Fictional Harbour Agency. Bud’s model access is set up.");
    expect(html).not.toContain("approve in my browser</button>");
    expect(html).not.toContain("Connect with this code");
  });

  it("uses passive guidance when linked provisioning failed, without naming an absent Update status button", () => {
    const html = view({ state: "linked", agencyLabel: "Fictional Harbour Agency", provisioned: false, error: "The website could not be reached." });
    expect(html).toContain("Your office connection is saved");
    expect(html).toContain("Contact RealBud support if setup stays stopped");
    expect(html).not.toContain("Update status");
    expect(html).not.toContain("has not arrived after the next update");
  });

  it("shows fixed local-recovery guidance without echoing paths or credentials", () => {
    const html = view({ state: "linked", agencyLabel: "Fictional Harbour Agency", provisioned: false,
      error: "Saved settings need recovery. /private/customer/config.json token=fictional-secret" });
    expect(html).toContain("Saved settings on this computer need recovery");
    expect(html).toContain("Contact RealBud support before trying setup again");
    expect(html).not.toMatch(/Update status|next update|private\/customer|fictional-secret/);
    const storage = view({ state: "linked", provisioned: false, error: "This computer’s service setup needs local storage recovery. Existing settings are kept." });
    expect(storage).toContain("Bud’s service setup needs local storage recovery");
    const preflight = view({ state: "linked", provisioned: false,
      error: "This computer's saved settings or private service storage need recovery. Your work is kept. Repair the local storage before retrying office setup." });
    expect(preflight).toContain("This computer’s saved settings or private service storage need recovery");
    expect(preflight).toContain("Contact RealBud support before trying office setup again");
    expect(preflight).not.toMatch(/Update status|next update|Keep RealBud open/);
  });

  it("opens an interrupted pasted-code link so it can be finished", () => {
    const html = view({ state: "pending" });
    expect(html).toContain("Connecting with a code was interrupted. Paste the same code below to finish safely.");
    expect(html).toContain(">Connect with this code</button>");
    expect(html).not.toContain("approve in my browser</button>");
  });
});

describe("connect wiring", () => {
  it("starts the browser link named after the person, without asking for a computer name", () => {
    useConnectOffice("Fictional Person").view.onStart();
    expect(link.start).toHaveBeenCalledExactlyOnceWith("Fictional Person’s computer");
    link.status = { state: "pending", label: "Reception Mac" };
    useConnectOffice("Fictional Person").view.onStart();
    expect(link.start).toHaveBeenLastCalledWith("Reception Mac");
  });

  it("renders inline for Bud setup from the store's profile", () => {
    expect(renderToStaticMarkup(createElement(ConnectOffice))).toContain("Connect with this code</button>");
  });

  it("always yields a name the local service accepts", () => {
    expect(defaultComputerName("")).toBe("Office computer");
    expect(defaultComputerName("  Fictional\u0007 Person ")).toBe("Fictional Person’s computer");
    expect(defaultComputerName("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});
