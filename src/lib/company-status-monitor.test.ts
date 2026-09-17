import { afterEach, describe, expect, it, vi } from "vitest";
import { monitorCompanyStatus } from "./company-status-monitor";

afterEach(() => vi.useRealTimers());
function fixture(check = vi.fn<() => Promise<boolean | undefined>>().mockResolvedValue(true)) {
  vi.useFakeTimers();
  const events = new EventTarget();
  const visibilityEvents = new EventTarget();
  let visible = true;
  const stop = monitorCompanyStatus({ check, events, visibilityEvents, visible: () => visible });
  return { check, events, visibilityEvents, stop, hide: () => { visible = false; }, show: () => { visible = true; } };
}

describe("company connection observation", () => {
  it("checks while visible, waits while hidden, and checks when returning", async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.check).toHaveBeenCalledTimes(1);
    f.hide();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.check).toHaveBeenCalledTimes(1);
    f.show(); f.visibilityEvents.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.check).toHaveBeenCalledTimes(2);
    f.stop(); expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off failed checks and resumes normal checks after recovery", async () => {
    const f = fixture(vi.fn<() => Promise<boolean | undefined>>().mockResolvedValue(false));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.check).toHaveBeenCalledTimes(1);
    for (const [index, delay] of [5_000, 15_000, 30_000, 60_000, 60_000].entries()) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(f.check).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.check).toHaveBeenCalledTimes(index + 2);
    }
    f.check.mockResolvedValue(true);
    f.events.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(0);
    const count = f.check.mock.calls.length;
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.check).toHaveBeenCalledTimes(count);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.check).toHaveBeenCalledTimes(count + 1);
    f.stop();
  });

  it("never overlaps checks, and a late result cannot restart a stopped monitor", async () => {
    let finish!: (ok: boolean) => void;
    const f = fixture(vi.fn(() => new Promise<boolean>(resolve => { finish = resolve; })));
    f.events.dispatchEvent(new Event("focus"));
    f.events.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(90_000);
    expect(f.check).toHaveBeenCalledTimes(1);
    f.stop(); finish(true);
    await vi.advanceTimersByTimeAsync(90_000);
    f.events.dispatchEvent(new Event("focus"));
    expect(f.check).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not busy-loop when the screen is performing a mutation or a check throws", async () => {
    const f = fixture(vi.fn<() => Promise<boolean | undefined>>().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("offline")).mockResolvedValue(true));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(f.check).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(f.check).toHaveBeenCalledTimes(3);
    f.stop();
  });
});
