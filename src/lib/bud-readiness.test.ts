import { describe, expect, it, vi } from "vitest";
import { createReadinessCheck } from "./bud-readiness";

describe("readiness check across views", () => {
  it("shares one in-flight request and keeps it alive with no mounted view", async () => {
    let finish!: (value: { ok: boolean }) => void;
    const request = vi.fn(() => new Promise<{ ok: boolean }>((resolve) => { finish = resolve; }));
    const check = createReadinessCheck(request);
    const firstView = vi.fn();
    const unsubscribe = check.subscribe(firstView);
    const first = check.run();
    expect(check.isRunning()).toBe(true);
    unsubscribe();
    const secondView = vi.fn();
    check.subscribe(secondView);
    expect(check.run()).toBe(first);
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    finish({ ok: true });
    expect(await first).toEqual({ ok: true });
    expect(check.isRunning()).toBe(false);
    expect(firstView).toHaveBeenCalledTimes(1);
    expect(secondView).toHaveBeenCalledTimes(1);
  });

  it("releases a failed or thrown request for an explicit retry", async () => {
    const request = vi.fn()
      .mockRejectedValueOnce(new Error("Local service unavailable"))
      .mockImplementationOnce(() => { throw new Error("Connection interrupted"); })
      .mockResolvedValueOnce({ ok: false, detail: "No answer" })
      .mockResolvedValueOnce({ ok: true });
    const check = createReadinessCheck(request);
    await expect(check.run()).rejects.toThrow("Local service unavailable");
    expect(check.isRunning()).toBe(false);
    await expect(check.run()).rejects.toThrow("Connection interrupted");
    expect(check.isRunning()).toBe(false);
    expect(await check.run()).toEqual({ ok: false, detail: "No answer" });
    expect(await check.run()).toEqual({ ok: true });
    expect(request).toHaveBeenCalledTimes(4);
  });
});
