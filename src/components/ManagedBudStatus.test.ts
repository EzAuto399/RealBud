import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesStatus } from "@/state/store";
import type { OfficeLinkStatus } from "../../server/office-link";
import { budServiceAction, ManagedBudStatus, RESTART_BUSY, RESTART_FAILED, RESTART_HELP, RESTART_NOT_OWNED } from "./ManagedBudStatus";
import { SUPPORT_SAVED } from "./you/SupportCard";

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
    expect(html).toContain("Setting up Bud");
    expect(html).toContain("Step 1 of 4: downloading. Usually about 10 minutes. Nothing to do; keep RealBud open.");
    expect(html.match(/<button/g)).toHaveLength(1);
    expect(html).toMatch(/<button[^>]*class="pm-decision[^"]*"[^>]*>Back to Work<\/button>/);
    expect(html).not.toContain("Check again</button>");
    expect(html).toMatch(/Download Bud<\/dt><dd[^>]*>In progress/);
    expect(html).toMatch(/Test Bud<\/dt><dd[^>]*>Waiting/);
    expect(html).not.toContain("service administrator");
    expect(html).not.toContain("Service administration");
    expect(html).not.toContain("Last readiness check");
  });
  it("never shows the administrator dead end on a linked office, whether a check is running or not", () => {
    const managed = { managed: true, withdrawn: false, attached: true, detail: "managed" };
    const running = render({ ...ready, ready: false, cli: { ...ready.cli, compatible: false }, modelAccess: managed,
      autoSetup: { state: "verifying", code: "checking", step: 0, total: 4, detail: "Checking Bud on this computer" } });
    expect(running).toContain("Checking this computer. Usually about 10 minutes.");
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
    expect(html).toContain("Connect with this code</button>");
    expect(html).toContain("I’m the office owner: approve in my browser");
    expect(html).toContain("Paste the link code your office owner sent you. RealBud then sets up Bud automatically.");
    // Nothing has failed before the link exists: the first step waits for it.
    expect(html).toMatch(/Download Bud<\/dt><dd[^>]*>Starts after you connect/);
    expect(html).not.toContain("Needs attention");
    expect(html).not.toContain("readiness check");
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
    expect(html).not.toContain("Starts after you connect");
    expect(html).toContain("Setting up Bud’s model access…");
    expect(html).toContain("Bud must finish setting up and pass its test before work can start.");
    expect(html).not.toContain("Connect with this code</button>");
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
  it("shows a failed installer stage as stopped, never as in progress", () => {
    const html = render({ ...ready, ready: false, cli: { ...ready.cli, installed: false, probeState: "missing" },
      lastPing: { at: 1, ok: false, kind: "ping", detail: "Bud setup changed. Its private readiness check is still needed." },
      autoSetup: { state: "held", code: "held_failed", step: 1, total: 4, detail: "Downloading Bud" } });
    expect(html).toContain("Bud setup stopped");
    expect(html).not.toContain("Last readiness check");
    expect(html).toContain("Bud’s setup stopped while installing Bud. Nothing was lost. Press Try setup again; if it stops twice, tell your office owner.");
    expect(html).toContain("Try setup again</button>");
    expect(html).not.toMatch(/In progress|Setting up Bud|Usually about/);
  });
  it("says plainly when automatic setup is waiting to retry", () => {
    const html = render({ ...ready, ready: false, cli: { ...ready.cli, installed: false, probeState: "missing" },
      autoSetup: { state: "waiting_retry", step: 1, total: 4, nextRetryAt: Date.now() + 5 * 60_000, detail: "busy" } });
    expect(html).toContain("will try again in about 5 minutes");
    expect(html).toContain("Nothing to do; keep RealBud open.");
    expect(html).toMatch(/Download Bud<\/dt><dd[^>]*>Will retry/);
    expect(html).not.toContain(">In progress</dd>");
  });
  it("names the incomplete safeguard, preserves configured model facts and holds readiness", () => {
    const html = render({ ...ready, pack: { ...ready.pack, workroomReady: false },
      modelAccess: { managed: true, withdrawn: false, attached: true, detail: "managed" } });
    expect(html).toContain("Service setup needed");
    expect(html).toContain("private workroom is not ready");
    expect(html).toMatch(/Turn on approvals<\/dt><dd[^>]*>Needs attention/);
    expect(html).toMatch(/Connect your office’s AI<\/dt><dd[^>]*>Configured/);
    expect(html).toMatch(/Test Bud<\/dt><dd[^>]*>Waiting/);
    expect(html).not.toContain("Your service administrator needs");
    expect(html).toContain("Back to Work");
    expect(html).not.toContain("Finish Bud setup");
  });
  it("names the screen it returns to", () => {
    const html = renderToStaticMarkup(createElement(ManagedBudStatus, { id: "fixture", status: ready, connected: true,
      onRefresh: async () => {}, onShowAsk: () => {}, backLabel: "Back to Desk" }));
    expect(html).toContain(">Back to Desk</button>");
    expect(html).not.toContain("Back to Work");
  });
  it("offers return to work once every prerequisite is ready", () => {
    const html = render(ready);
    expect(html).toContain("Bud ready");
    expect((html.match(/>Ready<\/dd>/g) || [])).toHaveLength(4);
    expect(html).toContain("Back to Work");
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
      expect(html).toContain("Back to Work");
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
    expect(withdrawn).not.toContain("Connect with this code</button>");
  });
  it("keeps the worker's withdrawal on an unlinked computer instead of a link prompt", () => {
    const html = render({ ...ready, ready: false, model: { ...ready.model!, attached: false },
      modelAccess: { managed: true, withdrawn: true, attached: false, detail: "Model access was withdrawn for this fictional computer." } });
    expect(html).toContain("Model access withdrawn");
    expect(html).toContain("withdrawn for this fictional computer");
    expect(html).not.toMatch(/Connect to your office|Connect with this code<\/button>/);
  });
});

describe("holds staff clear themselves", () => {
  afterEach(() => vi.unstubAllGlobals());
  const held = (code: "held_restart" | "held_recovery" | "held_unavailable"): HermesStatus => ({ ...ready, ready: false,
    cli: { ...ready.cli, compatible: false }, modelAccess: { managed: true, withdrawn: false, attached: true, detail: "managed" },
    autoSetup: { state: "held", code, step: 1, total: 4, detail: "fixture" } });
  const service = (patch: Record<string, unknown> = {}) => ({
    serviceStatus: vi.fn(async () => ({ running: true, manageable: true })),
    serviceStop: vi.fn(async () => ({ ok: true, status: { running: false } })),
    serviceStart: vi.fn(async () => ({ ok: true, status: { running: true } })),
    saveSupportFile: vi.fn(async () => ({ ok: true, officeReport: true })), ...patch });

  it("offers a service restart, with what it does, when a Bud update waits for one", () => {
    vi.stubGlobal("window", { ogb: service() });
    for (const status of [held("held_restart"), { ...ready, ready: false, cli: { ...ready.cli, compatible: false }, restartRequired: true }]) {
      const html = render(status);
      expect(html).toMatch(/<button[^>]*class="pm-decision[^"]*"[^>]*>Restart RealBud’s service<\/button>/);
      expect(html).toContain(RESTART_HELP);
      expect(html).not.toContain("Try setup again");
    }
    expect(render(ready)).not.toContain("Restart RealBud’s service");
    expect(render(held("held_restart"), { recovering: true })).not.toContain("Restart RealBud’s service");
  });
  it("says where to restart when this window has no desktop service controls", () => {
    const html = render(held("held_restart"));
    expect(html).not.toContain("Restart RealBud’s service</button>");
    expect(html).toContain("Open the RealBud desktop app to restart its service.");
  });
  it("offers a support file for a damaged setup record, and names a usable computer when setup is unavailable here", () => {
    vi.stubGlobal("window", { ogb: service() });
    const recovery = render(held("held_recovery"));
    expect(recovery).toContain("Save a support file and send it to RealBud support.");
    expect(recovery).toContain(">Save a support file</button>");
    expect(recovery).not.toMatch(/Try setup again|Restart RealBud’s service/);
    const unavailable = render(held("held_unavailable"));
    expect(unavailable).toContain("Use RealBud on a Mac or Windows computer for Bud’s work");
    expect(unavailable).not.toMatch(/Try setup again|Save a support file<\/button>|Restart RealBud’s service/);
  });
  it("restarts once for a double press, only through the owned stop and start", async () => {
    const bridge = service();
    const [first, second] = [budServiceAction("restart", bridge), budServiceAction("restart", bridge)];
    expect(await first).toEqual({ ok: true, text: "RealBud’s service restarted." });
    expect(await second).toEqual(await first);
    expect(bridge.serviceStop).toHaveBeenCalledTimes(1);
    expect(bridge.serviceStart).toHaveBeenCalledTimes(1);
    expect(bridge.serviceStop.mock.invocationCallOrder[0]).toBeLessThan(bridge.serviceStart.mock.invocationCallOrder[0]!);
  });
  it("never stops a service this installation does not own, and keeps the failure copy fixed", async () => {
    const external = service({ serviceStatus: vi.fn(async () => ({ running: true, manageable: false })) });
    expect(await budServiceAction("restart", external)).toEqual({ ok: false, text: RESTART_NOT_OWNED });
    expect(external.serviceStop).not.toHaveBeenCalled();
    expect(RESTART_NOT_OWNED).not.toMatch(/Start it from/);
    const failed = service({ serviceStart: vi.fn(async () => ({ ok: false, status: { running: false } })) });
    expect(await budServiceAction("restart", failed)).toEqual({ ok: false, text: RESTART_FAILED });
    expect(RESTART_FAILED).not.toMatch(/backup|restore/i);
  });
  it("never cuts off Bud's work: the stop asks the service to refuse while busy", async () => {
    const busy = service({ serviceStop: vi.fn(async () => ({ ok: false, busy: true, status: { running: true } })) });
    expect(await budServiceAction("restart", busy)).toEqual({ ok: false, text: RESTART_BUSY });
    expect(busy.serviceStop).toHaveBeenCalledWith({ ifIdle: true });
    expect(busy.serviceStart).not.toHaveBeenCalled();
    const idle = service();
    expect(await budServiceAction("restart", idle)).toEqual({ ok: true, text: "RealBud’s service restarted." });
    expect(idle.serviceStop).toHaveBeenCalledWith({ ifIdle: true });
  });
  it("a restart pressed while a support file is saving waits for it, then restarts", async () => {
    let release!: () => void;
    const slow = service({ saveSupportFile: vi.fn(() => new Promise(resolve => { release = () => resolve({ ok: true, officeReport: true }); })) });
    const saving = budServiceAction("support", slow);
    const restarting = budServiceAction("restart", slow);
    await vi.waitFor(() => expect(slow.saveSupportFile).toHaveBeenCalled());
    expect(slow.serviceStop).not.toHaveBeenCalled();
    release();
    expect(await saving).toEqual({ ok: true, text: SUPPORT_SAVED });
    expect(await restarting).toEqual({ ok: true, text: "RealBud’s service restarted." });
    expect(slow.serviceStart).toHaveBeenCalledTimes(1);
  });
  it("reports a saved, cancelled or failed support file in fixed words", async () => {
    expect(await budServiceAction("support", service())).toEqual({ ok: true, text: SUPPORT_SAVED });
    expect(await budServiceAction("support", service({ saveSupportFile: vi.fn(async () => ({ ok: false, canceled: true })) }))).toBeNull();
    expect((await budServiceAction("support", service({ saveSupportFile: vi.fn(async () => { throw new Error("/private/path"); }) })))?.text).not.toContain("private");
  });
});
