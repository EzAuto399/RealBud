import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesStatus } from "@/state/store";
import type { OfficeLinkStatus } from "../../server/office-link";
import { ManagedBudStatus } from "./ManagedBudStatus";

const monitor = vi.hoisted(() => ({ pending: false, error: "", refresh: vi.fn(), lastCheckedAt: null }));
const office = vi.hoisted(() => ({ status: { state: "unlinked" } as OfficeLinkStatus, error: "" }));
vi.mock("@/lib/bud-status-monitor", () => ({ useBudStatusMonitor: vi.fn(() => monitor) }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: {}, dispatch: vi.fn() }), api: vi.fn() }));
vi.mock("./you/browser-link", async importOriginal => ({
  ...(await importOriginal<typeof import("./you/browser-link")>()),
  useBrowserLink: () => ({ ...office, phase: { kind: "idle" }, refresh: vi.fn(), setError: vi.fn(), start: vi.fn(),
    linkCode: vi.fn(), cancel: vi.fn(), retry: vi.fn() }),
}));
const ready: HermesStatus = {
  pin: { product: "fixture", tag: "fixture", commit: "fixture", profile: "property" },
  cli: { installed: true, versionText: "fixture", matchesPin: true, probeState: "ok" },
  pack: { installed: true, approvalsManual: true, workroomReady: true },
  model: { attached: true, provider: "fixture", model: "fixture" },
  ready: true, detail: "", homeDir: "/fixture", profileDir: "/fixture", installCommand: null, signInCommand: "",
};
function render(status: HermesStatus | null, options: { connected?: boolean; recovering?: boolean } = {}) {
  return renderToStaticMarkup(createElement(ManagedBudStatus, { id: "fixture", status, connected: true,
    onRefresh: async () => {}, onShowAsk: () => {}, ...options }));
}
beforeEach(() => { monitor.pending = false; monitor.error = ""; office.status = { state: "unlinked" }; office.error = ""; });

describe("managed Bud status", () => {
  it("shows automatic setup progress to a non-administrator, with no administrator dead end", () => {
    const html = render({ ...ready, ready: false, cli: { ...ready.cli, compatible: false, probeState: "timeout" },
      modelAccess: { managed: true, withdrawn: false, attached: true, detail: "managed" },
      lastPing: { at: 1, ok: false, detail: "Bud setup changed. Its private readiness check is still needed.", kind: "ping" },
      autoSetup: { state: "installing", step: 1, total: 4, detail: "Downloading Bud" } });
    expect(html).toContain("Downloading Bud");
    expect(html).toContain("Step 1 of 4. Keep RealBud open.");
    expect(html).toContain("Keep preparing</button>");
    expect(html).not.toContain("Check again</button>");
    expect(html).toMatch(/Bud installed<\/dt><dd[^>]*>In progress/);
    expect(html).toMatch(/Private readiness check<\/dt><dd[^>]*>Waiting/);
    expect(html).not.toContain("service administrator");
    expect(html).not.toContain("Service administration");
    expect(html).not.toContain("Last readiness check");
  });
  it("never shows the administrator dead end on a linked office, whether a check is running or not", () => {
    const managed = { managed: true, withdrawn: false, attached: true, detail: "managed" };
    const running = render({ ...ready, ready: false, cli: { ...ready.cli, compatible: false }, modelAccess: managed,
      autoSetup: { state: "verifying", code: "checking", step: 0, total: 4, detail: "Checking Bud on this computer" } });
    expect(running).toContain("Checking Bud on this computer");
    expect(running).not.toContain("Try setup again");
    for (const autoSetup of [
      { state: "idle" as const, step: 0, total: 4, detail: "" },
      { state: "ready" as const, code: "ready" as const, step: 4, total: 4, detail: "Bud is ready." },
    ]) {
      const html = render({ ...ready, ready: false, cli: { ...ready.cli, compatible: false }, modelAccess: managed, autoSetup });
      expect(html).toContain("Bud needs a check");
      expect(html).toContain("Try setup again");
      expect(html).not.toContain("nothing is needed from you");
      expect(html).not.toContain("Bud update blocked");
      expect(html).not.toContain("service administrator");
      expect(html).not.toContain("Service administration");
    }
  });
  it("offers office linking before the worker is installed instead of an administrator dead end", () => {
    const html = render({ ...ready, ready: false, cli: { ...ready.cli, installed: false, probeState: "missing" },
      pack: { installed: false, approvalsManual: false, workroomReady: false }, model: { attached: false, provider: null, model: null },
      autoSetup: { state: "idle", step: 0, total: 4, detail: "" } });
    expect(html).toContain("Connect to your office</button>");
    expect(html).toContain("RealBud will then set up Bud and your office’s app connection service automatically.");
    expect(html).toContain("Accounts that need your sign-in will still ask you to connect.");
    expect(html).not.toContain("Service setup needed");
    expect(html).not.toContain("service administrator");
    expect(html).not.toContain("Service administration");
    expect(html).not.toContain("Bud ready");
  });
  it("shows linked provisioning in progress without claiming Bud is ready or asking staff to configure it", () => {
    office.status = { state: "linked", agencyLabel: "Fictional Harbour Agency", provisioned: false };
    const html = render({ ...ready, ready: false, cli: { ...ready.cli, installed: false, probeState: "missing" },
      model: { attached: false, provider: null, model: null }, autoSetup: { state: "idle", step: 0, total: 4, detail: "" } });
    expect(html).toContain("Connected to Fictional Harbour Agency");
    expect(html).toContain("Setting up Bud’s model access…");
    expect(html).toContain("private readiness check before work can start");
    expect(html).not.toContain("Connect to your office</button>");
    expect(html).not.toContain("service administrator");
    expect(html).not.toContain("Bud ready");
    expect(html).not.toContain("Try setup again");
  });
  it("shows the specific service action when a linked office is waiting for access", () => {
    office.status = { state: "linked", agencyLabel: "Fictional Harbour Agency", provisioned: false,
      provisioningSkipped: "service_not_entitled", lastReportedAt: "2026-10-03T00:00:00.000Z" };
    const html = render({ ...ready, ready: false, model: { attached: false, provider: null, model: null } });
    expect(html).toContain("Office service setup needed");
    expect(html).toContain("AI isn’t turned on for your office yet");
    expect(html).not.toContain("Your service administrator needs");
    expect(html).not.toContain("Try setup again");
  });
  it("shows a linked local recovery error rather than a nonexistent Update status action", () => {
    office.status = { state: "linked", agencyLabel: "Fictional Harbour Agency", provisioned: false,
      error: "Saved settings need recovery. The original file has been kept; restore or repair it before saving changes." };
    const html = render({ ...ready, ready: false, model: { attached: false, provider: null, model: null } });
    expect(html).toContain("Office service setup needed");
    expect(html).toContain("Saved settings on this computer need recovery");
    expect(html).not.toMatch(/Update status|next update|Try setup again|service administrator/);
  });
  it("uses the new office link while an old worker withdrawal snapshot catches up", () => {
    office.status = { state: "linked", agencyLabel: "New Fictional Agency", provisioned: false,
      error: "This computer’s service setup needs local storage recovery. Existing settings are kept." };
    const html = render({ ...ready, ready: false,
      modelAccess: { managed: true, withdrawn: true, attached: false, detail: "The previous installation was withdrawn." },
      autoSetup: { state: "held", code: "held_failed", step: 1, total: 4, detail: "Old setup stopped." } });
    expect(html).toContain("Connected to New Fictional Agency");
    expect(html).toContain("local storage recovery");
    expect(html).not.toMatch(/Model access withdrawn|Old setup stopped|Try setup again|Bud ready/);
  });
  it("offers Try again after automatic setup gave up, with fixed copy", () => {
    const html = render({ ...ready, ready: false, cli: { ...ready.cli, installed: false, probeState: "missing" },
      autoSetup: { state: "held", code: "held_exhausted", step: 1, total: 4, detail: "Bud couldn’t finish setting up on this computer. RealBud support has the details; try again later." } });
    expect(html).toContain("RealBud support has the details");
    expect(html).toContain("Try setup again");
    expect(html).not.toContain("service administrator");
  });
  it("says plainly when automatic setup is waiting to retry", () => {
    const html = render({ ...ready, ready: false, cli: { ...ready.cli, installed: false, probeState: "missing" },
      autoSetup: { state: "waiting_retry", step: 1, total: 4, nextRetryAt: Date.now() + 5 * 60_000, detail: "busy" } });
    expect(html).toContain("will try again in about 5 minutes");
    expect(html).toContain("You can draft a request or prepare plans");
    expect(html).toMatch(/Bud installed<\/dt><dd[^>]*>Will retry/);
    expect(html).not.toContain(">In progress</dd>");
  });
  it("names the incomplete safeguard, preserves configured model facts and holds readiness", () => {
    const html = render({ ...ready, pack: { ...ready.pack, workroomReady: false },
      modelAccess: { managed: true, withdrawn: false, attached: true, detail: "managed" } });
    expect(html).toContain("Service setup needed");
    expect(html).toContain("private workroom is not ready");
    expect(html).toMatch(/Property safeguards<\/dt><dd[^>]*>Needs attention/);
    expect(html).toMatch(/Model connection<\/dt><dd[^>]*>Configured/);
    expect(html).toMatch(/Private readiness check<\/dt><dd[^>]*>Waiting/);
    expect(html).not.toContain("Your service administrator needs");
    expect(html).toContain("Return to Work");
    expect(html).not.toContain("Finish Bud setup");
  });
  it("offers return to work once every prerequisite is ready", () => {
    const html = render(ready);
    expect(html).toContain("Bud ready");
    expect((html.match(/>Ready<\/dd>/g) || [])).toHaveLength(4);
    expect(html).toContain("Return to Work");
    expect(html).not.toContain("Service administration");
  });
  it("does not leave stale green checks after a refresh failure or during retry", () => {
    monitor.error = "Could not refresh Bud’s status.";
    monitor.pending = true;
    const html = render(ready);
    expect(html).toContain("Status unavailable");
    expect(html).not.toContain("Bud ready");
    expect(html).not.toMatch(/>Ready<\/dd>/);
    expect(html).toContain("Your draft and saved plans are kept");
  });
  it("keeps Check again focusable while it checks, so keyboard focus stays in Bud status", () => {
    monitor.pending = true;
    const tag = /<button[^>]*>Checking…<\/button>/.exec(render(ready))?.[0] ?? "";
    expect(tag).toContain('aria-disabled="true"');
    expect(tag).not.toContain('disabled=""');
  });
  it("renders unknown and offline checks without an administrator setup demand", () => {
    for (const html of [render(null), render(ready, { connected: false })]) {
      expect(html).not.toMatch(/>Ready<\/dd>/);
      expect(html).not.toContain("Your service administrator needs");
      expect(html).toContain("Return to Work");
    }
  });
  it("offers book recovery, keeping service setup out of the way", () => {
    const html = render(ready, { recovering: true });
    expect(html).toContain("Unlock book");
    expect(html).not.toContain("Service administration");
    expect(html).not.toContain("Bud ready");
  });
  it("does not offer setup retry while recovery or withdrawn office access holds work", () => {
    const held: HermesStatus = { ...ready, ready: false,
      modelAccess: { managed: true, withdrawn: false, attached: true, detail: "Office access is held." },
      autoSetup: { state: "held", code: "held_failed", step: 1, total: 4, detail: "Setup stopped." } };
    expect(render(held, { recovering: true })).not.toContain("Try setup again");
    office.status = { state: "linked", serviceWithdrawn: true };
    const withdrawn = render({ ...held, modelAccess: { ...held.modelAccess!, withdrawn: true } });
    expect(withdrawn).toContain("Model access withdrawn");
    expect(withdrawn).not.toContain("Try setup again");
    expect(withdrawn).not.toContain("Connect to your office</button>");
  });
});
