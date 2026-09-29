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
