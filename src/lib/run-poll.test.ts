import { afterEach, describe, expect, it, vi } from "vitest";
import { POLL_MAX_MS, startRunPoll } from "./run-poll";

afterEach(() => { vi.useRealTimers(); });

describe("run poll", () => {
  it("keeps polling through a service blip with bounded backoff, then reconciles with the server", async () => {
    vi.useFakeTimers();
    // Fictional: the service is down for three reads, then answers with no run.
    const answers = [false, false, false, true, true];
    let shown = "Waiting for you to sign in";
    const load = vi.fn(async () => { if (!answers.shift()) throw new Error("fetch failed"); shown = "no run"; });
    const stop = startRunPoll(load, 1000);
    await vi.advanceTimersByTimeAsync(1000); expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999); expect(load).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000); expect(load).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(POLL_MAX_MS); expect(load).toHaveBeenCalledTimes(4);
    expect(shown).toBe("no run");
    // Back to the normal interval once a read works.
    await vi.advanceTimersByTimeAsync(1000); expect(load).toHaveBeenCalledTimes(5);
    stop();
    await vi.advanceTimersByTimeAsync(60_000); expect(load).toHaveBeenCalledTimes(5);
  });

  it("never waits longer than the cap while the service stays down", async () => {
    vi.useFakeTimers();
    const load = vi.fn(async () => { throw new Error("down"); });
    const stop = startRunPoll(load, 1500);
    await vi.advanceTimersByTimeAsync(1500 + 3000); expect(load).toHaveBeenCalledTimes(2);
    for (let i = 3; i <= 6; i++) { await vi.advanceTimersByTimeAsync(POLL_MAX_MS); expect(load).toHaveBeenCalledTimes(i); }
    stop();
  });
});
