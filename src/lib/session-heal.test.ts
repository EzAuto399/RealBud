import { describe, expect, it } from "vitest";

import {
  SESSION_HEAL_RETRY_MS,
  describeSessionHeal,
  isRetryableApiFailure,
  runWithTransportRetry,
} from "./session-heal";

describe("session heal", () => {
  it("names a dropped harness without repeating Failed to fetch", () => {
    const copy = describeSessionHeal(new TypeError("Failed to fetch"));
    expect(copy.kind).toBe("transport");
    expect(copy.title).toBe("RealBud dropped");
    expect(copy.detail).toContain("Retry");
    expect(copy.detail).not.toMatch(/Failed to fetch/i);
  });

  it("keeps a refused origin as a window problem, not a dead card", () => {
    const copy = describeSessionHeal(new Error("refused origin"));
    expect(copy.kind).toBe("origin");
    expect(copy.detail).toContain("UI port");
  });

  it("does not retry a rejected Notion key", () => {
    expect(isRetryableApiFailure(Object.assign(new Error("Notion did not accept this API key."), { status: 400 }))).toBe(false);
  });

  it("retries a dropped fetch then returns the healed result", async () => {
    const delays: number[] = [];
    let hits = 0;
    const value = await runWithTransportRetry(async () => {
      hits += 1;
      if (hits < 3) throw new TypeError("Failed to fetch");
      return "ok";
    }, async (ms) => {
      delays.push(ms);
    });
    expect(value).toBe("ok");
    expect(hits).toBe(3);
    expect(delays).toEqual([...SESSION_HEAL_RETRY_MS.slice(0, 2)]);
  });
});
