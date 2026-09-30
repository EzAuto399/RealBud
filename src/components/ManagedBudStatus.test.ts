import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesStatus } from "@/state/store";
import { ManagedBudStatus } from "./ManagedBudStatus";

const monitor = vi.hoisted(() => ({ pending: false, error: "", refresh: vi.fn(), lastCheckedAt: null }));
vi.mock("@/lib/bud-status-monitor", () => ({ useBudStatusMonitor: vi.fn(() => monitor) }));
vi.mock("@/state/store", () => ({ useStore: () => ({ dispatch: vi.fn() }) }));
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
beforeEach(() => { monitor.pending = false; monitor.error = ""; });

describe("managed Bud status", () => {
  it("shows automatic setup progress to a non-administrator, with no administrator dead end", () => {
    const html = render({ ...ready, ready: false, cli: { ...ready.cli, compatible: false, probeState: "timeout" },
      modelAccess: { managed: true, withdrawn: false, attached: true, detail: "managed" },
      lastPing: { at: 1, ok: false, detail: "Bud setup changed. Its private readiness check is still needed.", kind: "ping" },
      autoSetup: { state: "installing", step: 1, total: 4, detail: "Downloading Bud" } });
    expect(html).toContain("Setting up Bud on this computer… step 1 of 4. Keep RealBud open.");
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
    expect(running).toContain("Setting up Bud");
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
  it("keeps the administrator text for a computer with no office link", () => {
    const html = render({ ...ready, ready: false, autoSetup: { state: "idle", step: 0, total: 4, detail: "" } });
    expect(html).toContain("Your service administrator needs to complete the remaining check");
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
    expect(html).toContain("nothing is needed from you");
  });
  it("names the incomplete safeguard, preserves configured model facts and holds readiness", () => {
    const html = render({ ...ready, pack: { ...ready.pack, workroomReady: false } });
    expect(html).toContain("Service setup needed");
    expect(html).toContain("private workroom is not ready");
    expect(html).toMatch(/Property safeguards<\/dt><dd[^>]*>Needs attention/);
    expect(html).toMatch(/Model connection<\/dt><dd[^>]*>Configured/);
    expect(html).toMatch(/Private readiness check<\/dt><dd[^>]*>Waiting/);
    expect(html).toContain("Your service administrator needs");
    expect(html).toContain("Return to Ask");
    expect(html).not.toContain("Finish Bud setup");
  });
  it("offers return to work once every prerequisite is ready", () => {
    const html = render(ready);
    expect(html).toContain("Bud ready");
    expect((html.match(/>Ready<\/dd>/g) || [])).toHaveLength(4);
    expect(html).toContain("Return to Ask");
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
  it("renders unknown and offline checks without an administrator setup demand", () => {
    for (const html of [render(null), render(ready, { connected: false })]) {
      expect(html).not.toMatch(/>Ready<\/dd>/);
      expect(html).not.toContain("Your service administrator needs");
      expect(html).toContain("Return to Ask");
    }
  });
  it("offers book recovery, keeping service setup out of the way", () => {
    const html = render(ready, { recovering: true });
    expect(html).toContain("Unlock book");
    expect(html).not.toContain("Service administration");
    expect(html).not.toContain("Bud ready");
  });
});
