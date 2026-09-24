import { describe, expect, it, vi } from "vitest";
import { createServiceWindowRecovery } from "./service-window-recovery.mjs";
import { createServiceWatchdog } from "./service-watchdog.mjs";

function fixture() {
  let url = "data:text/html,wait-ended";
  let stopped = false;
  let destroyed = false;
  const window = { isDestroyed: () => destroyed, webContents: { getURL: () => url }, loadURL: vi.fn(async next => { url = next; }) };
  const beforeLoad = vi.fn();
  const loadFailed = vi.fn();
  const recover = createServiceWindowRecovery({ window, fallbackUrls: ["data:text/html,waiting", "data:text/html,wait-ended"], blocked: () => stopped,
    beforeLoad, loadFailed });
  return { window, beforeLoad, loadFailed, recover, setUrl: value => { url = value; }, stop: () => { stopped = true; }, destroy: () => { destroyed = true; } };
}

describe("fallback window recovery", () => {
  it("recovers an exhausted window when the watchdog sees healthy on the same port without restart or adoption", async () => {
    const f = fixture();
    const startOrAdopt = vi.fn();
    const adopt = vi.fn();
    const watchdog = createServiceWatchdog({ observe: async () => {
      f.recover(8799);
      return { quitting: false, stopRequested: false, startInFlight: false, answeringPort: 8799, currentPort: 8799, recorded: true };
    }, startOrAdopt, adopt });
    expect(await watchdog.tick()).toMatchObject({ action: "none", reason: "healthy" });
    expect(f.window.loadURL).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:8799");
    expect(f.beforeLoad).toHaveBeenCalledExactlyOnceWith(8799);
    await watchdog.tick();
    expect(f.window.loadURL).toHaveBeenCalledTimes(1);
    expect(startOrAdopt).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
  });

  it("leaves a normal desk, deliberate Stop, and closed window untouched", () => {
    for (const change of [f => f.setUrl("http://127.0.0.1:8799/desk"), f => f.stop(), f => f.destroy()]) {
      const f = fixture(); change(f);
      expect(f.recover(8799)).toBe(false);
      expect(f.window.loadURL).not.toHaveBeenCalled();
      expect(f.beforeLoad).not.toHaveBeenCalled();
    }
  });

  it("does not issue duplicate navigation while the previous recovery is pending", async () => {
    const f = fixture();
    let reject;
    f.window.loadURL.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    expect(f.recover(8799)).toBe(true);
    expect(f.recover(8799)).toBe(false);
    reject(new Error("fictional navigation failure"));
    await vi.waitFor(() => expect(f.loadFailed).toHaveBeenCalledTimes(1));
    expect(f.recover(8799)).toBe(true);
    reject(new Error("fictional repeated failure"));
  });
});
