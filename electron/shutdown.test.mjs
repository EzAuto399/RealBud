import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDesktopShutdown } from "./shutdown.mjs";

afterEach(() => vi.useRealTimers());
const event = () => ({ preventDefault: vi.fn() });
function fixture(overrides = {}) {
  const app = new EventEmitter();
  app.quit = vi.fn();
  app.exit = vi.fn();
  const cleanup = { stopServer: vi.fn(), stopSpeech: vi.fn(), closeControl: vi.fn(), stopComputer: vi.fn(), timeoutMs: 100, ...overrides };
  registerDesktopShutdown(app, cleanup);
  return { app, cleanup };
}

describe("desktop shutdown", () => {
  it("preserves the server and computer if a window cancels before final quit", () => {
    const { app, cleanup } = fixture();
    app.emit("before-quit", event());
    app.emit("will-prevent-unload", event());
    for (const stop of [cleanup.stopServer, cleanup.stopSpeech, cleanup.closeControl, cleanup.stopComputer]) expect(stop).not.toHaveBeenCalled();
    expect(app.quit).not.toHaveBeenCalled();
    expect(app.exit).not.toHaveBeenCalled();
  });

  it("cleans up once and permits the final quit without looping", async () => {
    vi.useFakeTimers();
    const { app, cleanup } = fixture();
    const first = event();
    app.emit("will-quit", first);
    app.emit("will-quit", event());
    await vi.runAllTimersAsync();
    expect(first.preventDefault).toHaveBeenCalledOnce();
    // Electron 43 ignores a second app.quit() once will-quit was prevented (the
    // 0.1.19 quit hang); completion must exit.
    for (const stop of [cleanup.stopServer, cleanup.stopSpeech, cleanup.closeControl, cleanup.stopComputer]) expect(stop).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(app.quit).not.toHaveBeenCalled();
    const last = event(); app.emit("will-quit", last);
    expect(last.preventDefault).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a hung helper cannot strand shutdown after its deadline", async () => {
    vi.useFakeTimers();
    const { app } = fixture({ stopComputer: () => new Promise(() => {}) });
    app.emit("will-quit", event());
    await vi.advanceTimersByTimeAsync(99);
    expect(app.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(app.quit).not.toHaveBeenCalled();
  });

  it("runs the remaining cleanup after a synchronous failure", async () => {
    vi.useFakeTimers();
    const { app, cleanup } = fixture({ stopSpeech: () => { throw new Error("fixture failure"); } });
    app.emit("will-quit", event());
    await vi.runAllTimersAsync();
    expect(cleanup.stopServer).toHaveBeenCalledOnce();
    expect(cleanup.stopComputer).toHaveBeenCalledOnce();
    expect(app.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(app.quit).not.toHaveBeenCalled();
  });
});
