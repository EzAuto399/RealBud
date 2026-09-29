import { afterEach, describe, expect, it, vi } from "vitest";
import { createBudStatusMonitor, createSharedBudStatusMonitor, type BudStatusRefresh } from "./bud-status-monitor";

afterEach(() => vi.useRealTimers());

function fixture(onRefresh = vi.fn<BudStatusRefresh>().mockResolvedValue(undefined)) {
  vi.useFakeTimers();
  let visible = true;
  const monitor = createBudStatusMonitor({ onRefresh, visible: () => visible });
  monitor.setEnabled(true);
  return { monitor, onRefresh, hide: () => { visible = false; monitor.wake(); }, show: () => { visible = true; monitor.wake(); } };
}

describe("Bud status observation", () => {
  it("checks on activation and every 15 seconds while visible, stopping while hidden", async () => {
    const f = fixture();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onRefresh).toHaveBeenCalledTimes(1);
    expect(f.monitor.getSnapshot()).toEqual({ pending: false, error: null, lastCheckedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.onRefresh).toHaveBeenCalledTimes(2);
    f.hide();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.onRefresh).toHaveBeenCalledTimes(2);
    f.show();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onRefresh).toHaveBeenCalledTimes(3);
    f.monitor.setEnabled(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("serializes manual and automatic reads and schedules from completion", async () => {
    let finish!: () => void;
    const f = fixture(vi.fn(() => new Promise<void>(resolve => { finish = resolve; })));
    const first = f.monitor.refresh();
    expect(f.monitor.refresh()).toBe(first);
    await vi.advanceTimersByTimeAsync(90_000);
    f.monitor.wake();
    expect(f.onRefresh).toHaveBeenCalledTimes(1);
    expect(f.monitor.getSnapshot().pending).toBe(true);
    finish(); await first;
    await vi.advanceTimersByTimeAsync(14_999);
    expect(f.onRefresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.onRefresh).toHaveBeenCalledTimes(2);
    f.monitor.setEnabled(false); finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("backs off failed reads, surfaces an error and lets a manual retry recover", async () => {
    const f = fixture(vi.fn<BudStatusRefresh>().mockRejectedValue(new Error("fixture unavailable")));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.monitor.getSnapshot()).toMatchObject({ pending: false, error: expect.stringContaining("could not be checked"), lastCheckedAt: null });
    for (const [index, delay] of [15_000, 30_000, 60_000, 60_000].entries()) {
      f.monitor.wake(); f.monitor.wake();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(f.onRefresh).toHaveBeenCalledTimes(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.onRefresh).toHaveBeenCalledTimes(index + 2);
    }
    f.onRefresh.mockResolvedValue(undefined);
    await f.monitor.refresh();
    expect(f.monitor.getSnapshot()).toEqual({ pending: false, error: null, lastCheckedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.onRefresh).toHaveBeenCalledTimes(7);
    f.monitor.setEnabled(false);
  });

  it("invalidates late publication on close and does not restart stopped timers", async () => {
    let finish!: () => void;
    const published = vi.fn();
    const f = fixture(vi.fn(async isCurrent => {
      await new Promise<void>(resolve => { finish = resolve; });
      if (isCurrent()) published();
    }));
    await vi.advanceTimersByTimeAsync(0);
    f.monitor.setEnabled(false);
    finish();
    await vi.advanceTimersByTimeAsync(90_000);
    expect(published).not.toHaveBeenCalled();
    expect(f.onRefresh).toHaveBeenCalledTimes(1);
    expect(f.monitor.getSnapshot()).toEqual({ pending: false, error: null, lastCheckedAt: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a failed check visible until the pending retry actually succeeds", async () => {
    let finish!: () => void;
    const onRefresh = vi.fn<BudStatusRefresh>()
      .mockRejectedValueOnce(new Error("fixture unavailable"))
      .mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const f = fixture(onRefresh);
    await vi.advanceTimersByTimeAsync(0);
    const error = f.monitor.getSnapshot().error;
    const retry = f.monitor.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.monitor.getSnapshot()).toMatchObject({ pending: true, error });
    expect(error).not.toBeNull();
    finish(); await retry;
    expect(f.monitor.getSnapshot()).toMatchObject({ pending: false, error: null });
    f.monitor.setEnabled(false);
  });

  it("waits for an old generation before refreshing a reopened panel", async () => {
    const finishes: Array<() => void> = [];
    const published = vi.fn();
    const f = fixture(vi.fn(async isCurrent => {
      await new Promise<void>(resolve => { finishes.push(resolve); });
      if (isCurrent()) published();
    }));
    await vi.advanceTimersByTimeAsync(0);
    f.monitor.setEnabled(false); f.monitor.setEnabled(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.onRefresh).toHaveBeenCalledTimes(1);
    finishes[0]();
    await vi.advanceTimersByTimeAsync(0);
    expect(published).not.toHaveBeenCalled();
    expect(f.onRefresh).toHaveBeenCalledTimes(2);
    finishes[1]();
    await vi.advanceTimersByTimeAsync(0);
    expect(published).toHaveBeenCalledTimes(1);
    f.monitor.setEnabled(false);
  });

  it("does not start in a hidden view or after disabling before the first read", async () => {
    const f = fixture();
    f.hide();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.onRefresh).not.toHaveBeenCalled();
    f.show();
    f.monitor.setEnabled(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.onRefresh).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("shared Bud status observation", () => {
  it("shares one timer and read across Ask and the panel until the last view closes", async () => {
    vi.useFakeTimers();
    const stopListening = vi.fn(), listen = vi.fn(() => stopListening);
    const monitor = createSharedBudStatusMonitor({ visible: () => true, listen });
    expect(monitor.hasObservers()).toBe(false);
    expect(monitor.observerRevision()).toBe(0);
    const ask = vi.fn<BudStatusRefresh>().mockResolvedValue(undefined);
    const panel = vi.fn<BudStatusRefresh>().mockResolvedValue(undefined);
    const leaveAsk = monitor.register(ask);
    const leavePanel = monitor.register(panel);
    expect(monitor.hasObservers()).toBe(true);
    expect(monitor.observerRevision()).toBe(2);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).not.toHaveBeenCalled();
    expect(panel).toHaveBeenCalledTimes(1);
    leavePanel();
    expect(monitor.hasObservers()).toBe(true);
    expect(monitor.observerRevision()).toBe(3);
    expect(stopListening).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(ask).toHaveBeenCalledTimes(1);
    leaveAsk();
    expect(monitor.hasObservers()).toBe(false);
    expect(monitor.observerRevision()).toBe(4);
    leaveAsk();
    expect(monitor.observerRevision()).toBe(4);
    expect(stopListening).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards the closing view's late reply before another view refreshes", async () => {
    vi.useFakeTimers();
    const monitor = createSharedBudStatusMonitor({ visible: () => true });
    const ask = vi.fn<BudStatusRefresh>().mockResolvedValue(undefined), published = vi.fn();
    let finish!: () => void;
    const leaveAsk = monitor.register(ask);
    const leavePanel = monitor.register(async isCurrent => {
      await new Promise<void>(resolve => { finish = resolve; });
      if (isCurrent()) published();
    });
    await vi.advanceTimersByTimeAsync(0);
    leavePanel();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ask).not.toHaveBeenCalled();
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(published).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalledTimes(1);
    leaveAsk();
    expect(vi.getTimerCount()).toBe(0);
  });
});
