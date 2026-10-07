import { describe, expect, it, vi } from "vitest";
import { openWindowWhileServiceStarts, showWhenDecided } from "./launch-window.mjs";

const WAITING = "data:text/html,waiting";

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// The same wiring main.mjs uses: every window waits on the decision it was given
// and shows the outcome itself.
function launch({ start, outcome = "http://127.0.0.1:8799" }) {
  const windows = [];
  const createWindow = vi.fn((decided) => {
    let destroyed = false;
    const win = { loadURL: vi.fn(async () => {}), isDestroyed: () => destroyed, destroy: () => { destroyed = true; } };
    windows.push(win);
    win.shown = showWhenDecided(win, { waitingUrl: WAITING, decided, show: () => win.loadURL(outcome) });
    return win;
  });
  return { windows, createWindow, ...openWindowWhileServiceStarts({ createWindow, start }) };
}

describe("launch window before the office service", () => {
  it("creates the window and shows the waiting page before the service decision resolves", async () => {
    const service = deferred();
    const start = vi.fn(() => service.promise);
    const { windows, win } = launch({ start });
    expect(windows).toEqual([win]);
    expect(win.loadURL.mock.calls).toEqual([[WAITING]]);
    // The decision starts only after the window exists, and exactly once.
    expect(start).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);

    service.resolve(true);
    await win.shown;
    expect(windows).toHaveLength(1);
    expect(win.loadURL.mock.calls).toEqual([[WAITING], ["http://127.0.0.1:8799"]]);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("replaces the waiting page in the same window when the start fails", async () => {
    for (const fail of [(d) => d.resolve(false), (d) => d.reject(Object.assign(new Error("fictional"), { code: "ENOSPC" }))]) {
      const service = deferred();
      const { windows, win, decided } = launch({ start: () => service.promise, outcome: "data:text/html,problem" });
      fail(service);
      await decided.catch(() => {});
      await win.shown;
      expect(windows).toHaveLength(1);
      expect(win.loadURL.mock.calls).toEqual([[WAITING], ["data:text/html,problem"]]);
    }
  });

  it("finishes the waiting page's load before showing the outcome", async () => {
    const waitingLoad = deferred();
    const win = { loadURL: vi.fn((url) => (url === WAITING ? waitingLoad.promise : undefined)), isDestroyed: () => false };
    const show = vi.fn();
    const shown = showWhenDecided(win, { waitingUrl: WAITING, decided: Promise.resolve(true), show });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(show).not.toHaveBeenCalled();
    waitingLoad.resolve();
    await shown;
    expect(show).toHaveBeenCalledTimes(1);
  });

  it("leaves a window closed during the wait closed, and survives a waiting page that fails to load", async () => {
    const service = deferred();
    const { windows, win } = launch({ start: () => service.promise });
    win.destroy();
    service.resolve(true);
    await win.shown;
    expect(windows).toHaveLength(1);
    expect(win.loadURL.mock.calls).toEqual([[WAITING]]);

    const broken = { loadURL: vi.fn(() => { throw new Error("fictional load failure"); }), isDestroyed: () => false };
    const show = vi.fn();
    await showWhenDecided(broken, { waitingUrl: WAITING, decided: Promise.resolve(true), show });
    expect(show).toHaveBeenCalledTimes(1);
  });
});

// main.mjs's own wiring cannot run without Electron, so its launch order is
// checked in the source: a Dock click during the wait must find a handler, and a
// quit during the wait must start nothing more.
describe("main.mjs launch order", () => {
  it("registers activate before the wait, stops after a quit, and tells the live window about updates", async () => {
    const { readFileSync } = await import("node:fs");
    const main = readFileSync(new URL("./main.mjs", import.meta.url), "utf8");
    const activate = main.indexOf('app.on("activate"');
    const wait = main.indexOf("await launch.decided;");
    expect(activate).toBeGreaterThan(0);
    expect(wait).toBeGreaterThan(activate);
    expect(main.indexOf('app.on("activate"', activate + 1)).toBe(-1);
    expect(main.slice(wait, wait + 200)).toMatch(/if \(appQuitting\(\)\) return;/);
    expect(main).not.toMatch(/win \?\?= createWindow\(\)/);
    expect(main).toMatch(/startUpdater\(\(\) =>/);
  });
});
