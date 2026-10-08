import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesStatus } from "@/state/store";
import { AskReadiness } from "./AskReadiness";

const fakes = vi.hoisted(() => ({
  effects: [] as Array<() => unknown>, restore: vi.fn(), readiness: vi.fn(), run: vi.fn(), dispatch: vi.fn(),
  monitor: { pending: false, error: "", lastCheckedAt: null, refresh: vi.fn() },
  state: { hermes: null as HermesStatus | null, connected: true, desk: null, config: null, serviceAdmin: undefined as undefined | { managed: boolean; authenticated?: boolean } },
}));
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(), useEffect: (effect: () => unknown) => { fakes.effects.push(effect); } }));
vi.mock("@/lib/boot-heal", () => ({ autoRestoreBudPin: fakes.restore, autoRunBudReadiness: fakes.readiness }));
vi.mock("@/lib/bud-readiness", () => ({ budReadinessCheck: { subscribe: () => () => {}, isRunning: () => false, run: fakes.run } }));
vi.mock("@/lib/bud-status-monitor", () => ({ useBudStatusMonitor: () => fakes.monitor }));
vi.mock("@/state/store", () => ({ useStore: () => ({ state: fakes.state, dispatch: fakes.dispatch }), api: vi.fn() }));
const ready: HermesStatus = {
  pin: { product: "fixture", tag: "fixture", commit: "fixture", profile: "property" },
  cli: { installed: true, versionText: "fixture", matchesPin: true, probeState: "ok" },
  pack: { installed: true, approvalsManual: true, workroomReady: true },
  model: { attached: true, provider: "fixture", model: "fixture" },
  ready: false, detail: "", homeDir: "/fixture", profileDir: "/fixture", installCommand: null, signInCommand: "",
};
function render() { return renderToStaticMarkup(createElement(AskReadiness, { onSetup: () => {} })); }
beforeEach(() => {
  fakes.effects.length = 0;
  fakes.restore.mockReset().mockResolvedValue({ ran: false });
  fakes.readiness.mockReset().mockResolvedValue({ ran: false });
  fakes.run.mockReset();
  fakes.state.hermes = ready; fakes.state.connected = true; fakes.state.serviceAdmin = { managed: true, authenticated: false };
  fakes.monitor.error = ""; fakes.monitor.pending = false;
});

describe("Ask readiness permission and status", () => {
  it("never attempts automatic administrative checks for staff or a shared authenticated flag", async () => {
    for (const authenticated of [false, true]) {
      fakes.state.serviceAdmin = { managed: true, authenticated };
      for (const matchesPin of [false, true]) {
        fakes.state.hermes = { ...ready, cli: { ...ready.cli, matchesPin } };
        fakes.effects.length = 0;
        const html = render();
        for (const effect of fakes.effects) effect();
        await Promise.resolve();
        expect(html).toContain("View Bud status");
        expect(html).not.toContain("Checking Bud’s connection");
      }
    }
    expect(fakes.restore).not.toHaveBeenCalled();
    expect(fakes.readiness).not.toHaveBeenCalled();
    expect(fakes.run).not.toHaveBeenCalled();
  });
  it("retains the existing automatic check for a permitted administrator", async () => {
    fakes.state.serviceAdmin = { managed: false };
    render();
    for (const effect of fakes.effects) effect();
    await Promise.resolve();
    expect(fakes.readiness).toHaveBeenCalledTimes(1);
    expect(fakes.restore).not.toHaveBeenCalled();
  });
  it("shows a failed check to staff without a forbidden retry", () => {
    fakes.state.hermes = { ...ready, lastPing: { kind: "ping", at: 1, ok: false, detail: "The model connection has expired." } };
    const html = render();
    expect(html).toContain("model connection has expired");
    expect(html).toContain("View Bud status");
    expect(html).not.toContain("Try check again");
  });
  it("lets the current setup hold beat an old failed check", () => {
    fakes.state.hermes = { ...ready, lastPing: { kind: "ping", at: 1, ok: false, detail: "The model connection has expired." } };
    const html = renderToStaticMarkup(createElement(AskReadiness, { onSetup: () => {}, hold: { on: false, reason: "Connect this computer to your office first." } }));
    expect(html).toBe("");
  });
  it("never blames an old timed-out check on a computer that isn't linked", () => {
    fakes.state.hermes = { ...ready, model: { attached: false, provider: null, model: null },
      lastPing: { kind: "ping", at: 1, ok: false, detail: "Bud took too long to answer. Review AI usage on your linked website before checking again." } };
    const html = renderToStaticMarkup(createElement(AskReadiness, { onSetup: () => {}, officeLink: "not-linked" }));
    expect(html).toContain("Connect this computer to your office first");
    expect(html).not.toMatch(/usage|Connection needs another look/i);
  });
  it("keeps a manual administrator check when the automatic guard has already run", () => {
    fakes.state.serviceAdmin = { managed: false };
    expect(render()).toContain("Test Bud");
    expect(render()).not.toContain("Checking Bud’s connection");
  });
  it("keeps an explicit status warning over a previous ready receipt", () => {
    fakes.state.hermes = { ...ready, ready: true };
    fakes.monitor.error = "Status read failed";
    expect(render()).toContain("Status unavailable");
    expect(render()).toContain("Check again");
  });
  it("shows the actual download phase while keeping preparation available and staff checks gated", async () => {
    fakes.state.hermes = { ...ready, modelAccess: { managed: true, withdrawn: false, attached: true, detail: "managed" },
      autoSetup: { state: "installing", code: "installing", step: 1, total: 4, detail: "Downloading Bud" } };
    const html = render();
    for (const effect of fakes.effects) effect();
    await Promise.resolve();
    expect(html).toContain("Setting up Bud");
    expect(html).toContain("Step 1 of 4: downloading. Usually about 10 minutes.");
    expect(html).toContain("Nothing to do; keep RealBud open.");
    expect(html).not.toMatch(/Test Bud|Try check again|Finish Bud setup/);
    expect(fakes.run).not.toHaveBeenCalled();
    expect(fakes.readiness).not.toHaveBeenCalled();
    expect(fakes.restore).not.toHaveBeenCalled();
  });
});
