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
  it("offers one 44 px primary action and keeps the pasted code behind a closed disclosure", () => {
    const html = view({ state: "unlinked" });
    expect(html.match(/pm-decision/g)).toHaveLength(1);
    expect(html).toMatch(/<button type="button" class="pm-decision[^"]*"><svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg>Connect to your office<\/button>/);
    expect(html).toMatch(/<details class="[^"]*"><summary class="pm-control[^"]*"><svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg>Use a link code instead<\/summary>/);
    expect(html).toContain(">Connect with this code</button>");
    expect(live(html)).toBe("");
    expect(html).not.toMatch(/Hermes|MCP|broker|grant|installation/i);
  });

  it("holds the action until the saved link has been read, with a retry when it could not be", () => {
    expect(view(null)).toMatch(/disabled="">.*Connect to your office<\/button>/);
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
    expect(html).not.toContain("Connect to your office</button>");
    expect(html).not.toContain("Use a link code instead");
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
    expect(html).not.toContain("Connect to your office</button>");
    expect(html).not.toContain("Use a link code instead");
  });

  it("opens an interrupted pasted-code link so it can be finished", () => {
    const html = view({ state: "pending" });
    expect(html).toContain("<details open=\"\"");
    expect(html).not.toContain("Connect to your office</button>");
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
    expect(renderToStaticMarkup(createElement(ConnectOffice))).toContain("Connect to your office</button>");
  });

  it("always yields a name the local service accepts", () => {
    expect(defaultComputerName("")).toBe("Office computer");
    expect(defaultComputerName("  Fictional\u0007 Person ")).toBe("Fictional Person’s computer");
    expect(defaultComputerName("x".repeat(200)).length).toBeLessThanOrEqual(80);
  });
});
