import { describe, expect, it, vi } from "vitest";

import { SingleFlight } from "./single-flight.ts";

describe("SingleFlight", () => {
  it("runs overlapping callers once and shares the settled value", async () => {
    let resolve!: (value: number) => void;
    const promise = new Promise<number>((done) => {
      resolve = done;
    });
    const start = vi.fn(() => promise);
    const flight = new SingleFlight<number>();

    const first = flight.run(start);
    const second = flight.run(start);
    await Promise.resolve();
    expect(start).toHaveBeenCalledTimes(1);
    expect(flight.running()).toBe(true);

    resolve(7);
    await expect(Promise.all([first, second])).resolves.toEqual([7, 7]);
    expect(flight.running()).toBe(false);
  });

  it("reopens after failure so a retry can make progress", async () => {
    const start = vi.fn()
      .mockRejectedValueOnce(new Error("worker missed"))
      .mockResolvedValueOnce(9);
    const flight = new SingleFlight<number>();

    await expect(flight.run(start)).rejects.toThrow("worker missed");
    await expect(flight.run(start)).resolves.toBe(9);
    expect(start).toHaveBeenCalledTimes(2);
  });
});
