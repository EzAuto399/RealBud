import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { HermiosConnectionState } from "@shared/hermios-connection";
import type { HermiosConnectionView } from "@/lib/hermios-connection-api";

vi.mock("@/state/store", () => ({ api: vi.fn() }));

import {
  COVERS_HERMIOS,
  HERMIOS_CONNECT_LINE,
  HERMIOS_SEPARATE,
  HERMIOS_SIGN_IN_URL,
  HermiosConnectionStrip,
  HermiosTab,
  followPlaceholder,
  hermiosCovered,
  visibleRect,
  type PlacementEnv,
} from "./HermiosTab";

const text = (html: string) => html.replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

function fakeBridge(): HermiosViewBridge {
  return {
    show: vi.fn(async () => true),
    hide: vi.fn(async () => true),
    back: vi.fn(async () => true),
    reload: vi.fn(async () => true),
    signOut: vi.fn(async () => true),
    openExternal: vi.fn(async () => true),
  };
}

describe("Hermios tab", () => {
  it("in the desktop app shows the header, Bud's connection strip and the controls, with no fallback link", () => {
    const html = text(renderToStaticMarkup(createElement(HermiosTab, { bridge: fakeBridge() })));
    expect(html).toContain('aria-labelledby="hermios-title"');
    expect(html).toMatch(/<img src="\/brand\/hermios-icon.svg" alt="" aria-hidden="true"[^>]*>.*<h2 id="hermios-title"/);
    expect(html).toContain(">Hermios</h2>");
    expect(html).toContain("Your own Hermios sign-in");
    // Before the first read settles, the strip claims nothing.
    expect(html).toContain('role="group" aria-label="Bud\'s Hermios connection"');
    expect(html).toContain("Checking Bud's Hermios connection…");
    expect(html).toContain(HERMIOS_SEPARATE);
    expect(html).not.toContain("Bud is connected");
    expect(html).toContain('role="group" aria-label="Hermios page"');
    expect(html).toContain('Back<span class="sr-only"> in Hermios</span>');
    expect(html).toContain('Reload<span class="sr-only"> Hermios</span>');
    expect(html).toContain("Open in browser");
    expect(html).toMatch(/aria-expanded="false" aria-controls="hermios-sign-out"[^>]*>.*Sign out here/);
    // Every control meets the 44px target.
    expect(html.match(/<button /g)).toHaveLength(4);
    expect(html.match(/<button [^>]*class="pm-control /g)).toHaveLength(4);
    // The sign-out confirmation appears only after asking.
    expect(html).not.toContain("Confirm Hermios sign-out");
    expect(html).toContain("Hermios shows here. If it stays blank, use Reload or Open in browser.");
    expect(html).not.toContain(`href="${HERMIOS_SIGN_IN_URL}"`);
  });

  it("outside the desktop app explains why and links to Hermios sign-in instead", () => {
    const html = text(renderToStaticMarkup(createElement(HermiosTab, { bridge: null })));
    expect(html).toContain(">Hermios</h2>");
    expect(html).toContain(HERMIOS_SEPARATE);
    expect(html).toContain("Hermios opens inside the RealBud desktop app.");
    expect(html).toContain(`href="${HERMIOS_SIGN_IN_URL}"`);
    expect(HERMIOS_SIGN_IN_URL).toBe("https://app.hermios.app/");
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toMatch(/<a [^>]*class="pm-control [^"]*"[^>]*>.*Open Hermios<\/a>/);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Sign out here");
  });

  it("falls back to the link when no desktop bridge is present", () => {
    const html = renderToStaticMarkup(createElement(HermiosTab));
    expect(html).toContain("Open Hermios");
    expect(html).not.toContain('aria-label="Hermios page"');
  });

  it("never names the engine or tool plumbing", () => {
    for (const bridge of [fakeBridge(), null]) {
      const html = renderToStaticMarkup(createElement(HermiosTab, { bridge }));
      expect(html).not.toMatch(/\bHermes\b|\bMCP\b|\bbroker\b/i);
      expect(html).not.toMatch(/#[0-9a-f]{3,6}\b/i);
    }
  });
});

describe("Bud's Hermios connection strip", () => {
  const account = { displayName: "Alex Example", workspaceLabel: "Example Realty", workspaceId: "ws-fixture", profileId: "profile-fixture", verifiedAt: 1_780_000_000_000 };
  const state = (status: HermiosConnectionState["status"], extra: Partial<HermiosConnectionState> = {}): HermiosConnectionState =>
    ({ version: 1, status, account: status === "connected" ? account : null, generation: 3, reason: null, ...extra });
  const strip = (view: Partial<HermiosConnectionView>) => {
    const controls = {
      view: { state: null, loading: false, readError: null, busy: null, notice: null, ...view },
      connect: vi.fn(async () => {}), check: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), refresh: vi.fn(async () => {}),
    };
    return text(renderToStaticMarkup(createElement(HermiosConnectionStrip, { controls })));
  };
  const buttons = (html: string) => [...html.matchAll(/<button [^>]*>(.*?)<\/button>/g)].map((match) => match[1].replace(/<[^>]+>/g, ""));

  it("offers to connect, honestly, when Bud isn't connected", () => {
    const html = strip({ state: state("not_connected") });
    expect(html).toContain(HERMIOS_CONNECT_LINE);
    expect(HERMIOS_CONNECT_LINE).not.toMatch(/\bcan (now )?read\b/i);
    expect(html).toContain(HERMIOS_SEPARATE);
    expect(buttons(html)).toEqual(["Connect Bud to your Hermios"]);
    expect(html).toMatch(/<button [^>]*class="pm-control [^"]*bg-agency/);
  });

  it("asks the person to finish signing in while connecting", () => {
    const html = strip({ state: state("connecting") });
    expect(html).toContain("Finish signing in to Hermios in your browser.");
    expect(buttons(html)).toEqual(["Check again"]);
  });

  it("names the verified account and workspace when connected, with a check and a guarded disconnect", () => {
    const html = strip({ state: state("connected") });
    expect(html).toContain("Bud is connected as Alex Example · Example Realty");
    expect(buttons(html)).toEqual(["Check Bud's Hermios connection", "Disconnect Bud from Hermios"]);
    expect(html).toContain('aria-expanded="false" aria-controls="hermios-disconnect"');
    expect(html).not.toContain("Confirm disconnecting Bud from Hermios");
    expect(html).not.toContain("profile-fixture");
    expect(html).not.toContain("ws-fixture");
  });

  it.each([
    ["needs_reconnect", "Your Hermios sign-in for Bud expired."],
    ["unavailable", "Hermios couldn't be reached."],
  ] as const)("shows the reason and offers to connect again when %s", (status, reason) => {
    const html = strip({ state: state(status, { reason }) });
    expect(html).toContain(reason);
    expect(buttons(html)).toEqual(["Connect again"]);
  });

  it("falls back to a fixed sentence when no reason is given", () => {
    expect(strip({ state: state("needs_reconnect") })).toContain("Bud's Hermios connection needs you to sign in again.");
    expect(strip({ state: state("unavailable") })).toContain("Bud's Hermios connection isn't available right now.");
  });

  it("claims nothing until the state is read, and offers a retry when it can't be", () => {
    expect(buttons(strip({ loading: true }))).toEqual([]);
    const failed = strip({ readError: "Bud's Hermios connection couldn't be checked. Try again." });
    expect(failed).toContain("Bud's Hermios connection couldn't be checked. Try again.");
    expect(buttons(failed)).toEqual(["Check again"]);
    expect(failed).not.toContain("Bud is connected");
  });

  it("keeps the last good state when a later read fails, and disables actions while one is running", () => {
    const html = strip({ state: state("connected"), readError: "Bud's Hermios connection couldn't be checked. Try again.", busy: "check" });
    expect(html).toContain("Bud is connected as Alex Example");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Checking…");
    expect(html.match(/<button [^>]*disabled=""/g)).toHaveLength(2);
  });

  it("uses only tokens and 44px controls, and never names the engine", () => {
    for (const status of ["not_connected", "connecting", "connected", "needs_reconnect", "unavailable"] as const) {
      const html = strip({ state: state(status), notice: { text: "RealBud couldn't confirm whether that finished.", problem: true } });
      expect(html).not.toMatch(/\bHermes\b|\bMCP\b|\bbroker\b/i);
      expect(html).not.toMatch(/#[0-9a-f]{3,6}\b/i);
      for (const button of html.match(/<button [^>]*>/g) ?? []) expect(button).toContain('class="pm-control ');
    }
  });
});

describe("what covers the Hermios view", () => {
  const doc = (match: (selector: string) => boolean, visibilityState: DocumentVisibilityState = "visible") => ({
    visibilityState,
    querySelector: (selector: string) => (match(selector) ? ({} as Element) : null),
  });

  it("treats open dialogs, modal sheets, the More menu, popovers and the error notice as covering", () => {
    for (const part of ['dialog[open]', '[aria-modal="true"]', "details.desk-more[open]", ".workspace-notice"]) {
      expect(COVERS_HERMIOS).toContain(part);
    }
    expect(hermiosCovered(doc((selector) => selector === COVERS_HERMIOS))).toBe(true);
    expect(hermiosCovered(doc((selector) => selector === ":popover-open"))).toBe(true);
    expect(hermiosCovered(doc(() => false))).toBe(false);
    expect(hermiosCovered(doc(() => false, "hidden"))).toBe(true);
  });

  it("survives an engine without popover support", () => {
    const old = {
      visibilityState: "visible" as const,
      querySelector: (selector: string) => {
        if (selector === ":popover-open") throw new SyntaxError("unknown pseudo-class");
        return null;
      },
    };
    expect(hermiosCovered(old)).toBe(false);
  });

  it("measures only the on-screen part of the placeholder", () => {
    const viewport = { width: 1200, height: 800 };
    expect(visibleRect({ left: 240, top: 180, right: 1200, bottom: 800 }, viewport)).toEqual({ x: 240, y: 180, width: 960, height: 620 });
    expect(visibleRect({ left: -20, top: 100, right: 1300, bottom: 900 }, viewport)).toEqual({ x: 0, y: 100, width: 1200, height: 700 });
    expect(visibleRect({ left: 240, top: 800, right: 1200, bottom: 1000 }, viewport)).toBeNull();
    expect(visibleRect({ left: 240, top: 180, right: 240.5, bottom: 800 }, viewport)).toBeNull();
    expect(visibleRect({ left: Number.NaN, top: 0, right: 10, bottom: 10 }, viewport)).toBeNull();
  });
});

describe("placing the Hermios view", () => {
  function harness(rect = { left: 240, top: 180, right: 1200, bottom: 800 }) {
    const listeners = new Map<string, Set<() => void>>();
    const on = (type: string, fn: () => void) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(fn); };
    const off = (type: string, fn: () => void) => { listeners.get(type)?.delete(fn); };
    const fire = (type: string) => { for (const fn of [...(listeners.get(type) ?? [])]) fn(); };
    const frames = new Map<number, () => void>();
    let nextFrame = 1;
    const observers: { kind: string; callback: () => void; disconnected: boolean }[] = [];
    const observer = (kind: string) => class {
      record: { kind: string; callback: () => void; disconnected: boolean };
      constructor(callback: () => void) { this.record = { kind, callback, disconnected: false }; observers.push(this.record); }
      observe() {}
      disconnect() { this.record.disconnected = true; }
    };
    let covered = false;
    const state = { rect };
    const env = {
      document: {
        visibilityState: "visible",
        body: {},
        querySelector: (selector: string) => (covered && selector === COVERS_HERMIOS ? {} : null),
        addEventListener: on,
        removeEventListener: off,
      },
      window: {
        innerWidth: 1200,
        innerHeight: 800,
        addEventListener: on,
        removeEventListener: off,
        requestAnimationFrame: (fn: () => void) => { const id = nextFrame++; frames.set(id, fn); return id; },
        cancelAnimationFrame: (id: number) => { frames.delete(id); },
      },
      ResizeObserver: observer("resize"),
      MutationObserver: observer("mutation"),
    } as unknown as PlacementEnv;
    const node = { getBoundingClientRect: () => state.rect } as unknown as Element;
    const flush = () => { const pending = [...frames.values()]; frames.clear(); for (const fn of pending) fn(); };
    const mutate = () => { for (const record of observers) if (record.kind === "mutation") record.callback(); };
    return { env, node, state, flush, fire, mutate, listeners, observers, frames, cover: (value: boolean) => { covered = value; } };
  }

  it("shows the view over the placeholder on the next frame and never resends the same rectangle", async () => {
    const bridge = fakeBridge();
    const h = harness();
    const placed = vi.fn();
    const stop = followPlaceholder(bridge, h.node, placed, h.env);
    expect(bridge.show).not.toHaveBeenCalled();
    h.flush();
    expect(bridge.show).toHaveBeenCalledWith({ x: 240, y: 180, width: 960, height: 620 });
    await Promise.resolve();
    expect(placed).toHaveBeenCalledWith(true);
    h.fire("resize");
    h.flush();
    expect(bridge.show).toHaveBeenCalledTimes(1);
    h.state.rect = { left: 240, top: 120, right: 1200, bottom: 800 };
    h.fire("resize");
    h.fire("resize");
    h.flush();
    expect(bridge.show).toHaveBeenCalledTimes(2);
    expect(bridge.show).toHaveBeenLastCalledWith({ x: 240, y: 120, width: 960, height: 680 });
    stop();
  });

  it("hides at once when a RealBud dialog opens, without waiting for a frame, and shows again after", () => {
    const bridge = fakeBridge();
    const h = harness();
    const stop = followPlaceholder(bridge, h.node, () => {}, h.env);
    h.flush();
    h.cover(true);
    h.fire("resize");
    h.mutate();
    expect(bridge.hide).toHaveBeenCalledTimes(1);
    expect(h.frames.size).toBe(0);
    h.cover(false);
    h.mutate();
    h.flush();
    expect(bridge.show).toHaveBeenCalledTimes(2);
    expect(bridge.show).toHaveBeenLastCalledWith({ x: 240, y: 180, width: 960, height: 620 });
    stop();
  });

  it("hides when the window is hidden or the placeholder leaves the screen", () => {
    const bridge = fakeBridge();
    const h = harness();
    const stop = followPlaceholder(bridge, h.node, () => {}, h.env);
    h.flush();
    (h.env.document as { visibilityState: string }).visibilityState = "hidden";
    h.fire("visibilitychange");
    expect(bridge.hide).toHaveBeenCalledTimes(1);
    (h.env.document as { visibilityState: string }).visibilityState = "visible";
    h.fire("visibilitychange");
    h.flush();
    expect(bridge.show).toHaveBeenCalledTimes(2);
    h.state.rect = { left: 240, top: 900, right: 1200, bottom: 1200 };
    h.fire("resize");
    h.flush();
    expect(bridge.hide).toHaveBeenCalledTimes(2);
    expect(bridge.show).toHaveBeenCalledTimes(2);
    stop();
  });

  it("reports a failed show and stops following on cleanup", async () => {
    const bridge = fakeBridge();
    vi.mocked(bridge.show).mockResolvedValueOnce(false);
    const h = harness();
    const placed = vi.fn();
    const stop = followPlaceholder(bridge, h.node, placed, h.env);
    h.flush();
    await Promise.resolve();
    expect(placed).toHaveBeenCalledWith(false);
    stop();
    expect(bridge.hide).toHaveBeenCalledTimes(1);
    expect(h.observers.every((record) => record.disconnected)).toBe(true);
    expect([...h.listeners.values()].every((set) => set.size === 0)).toBe(true);
    h.mutate();
    h.flush();
    expect(bridge.show).toHaveBeenCalledTimes(1);
  });
});
