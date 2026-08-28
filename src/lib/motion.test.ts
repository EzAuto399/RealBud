import { afterEach, describe, expect, it, vi } from "vitest";

import { prefersReducedMotion, staggerMs, withViewTransition } from "./motion";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("operational motion", () => {
  it("treats a missing matchMedia as motion-ok", () => {
    expect(prefersReducedMotion()).toBe(false);
  });

  it("skips view transitions when the user prefers reduced motion", () => {
    const update = vi.fn();
    const start = vi.fn();
    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    vi.stubGlobal("document", { startViewTransition: start });
    withViewTransition(update);
    expect(update).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it("staggers 40ms and caps at 700ms", () => {
    expect(staggerMs(0)).toBe(0);
    expect(staggerMs(2)).toBe(80);
    expect(staggerMs(20)).toBe(700);
  });

  it("runs the update inside startViewTransition when motion is allowed", () => {
    const update = vi.fn();
    const start = vi.fn((callback: () => void) => {
      callback();
      return {
        finished: Promise.resolve(),
        ready: Promise.resolve(),
        updateCallbackDone: Promise.resolve(),
        skipTransition() {},
      };
    });
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    vi.stubGlobal("document", { startViewTransition: start });
    withViewTransition(update);
    expect(start).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
