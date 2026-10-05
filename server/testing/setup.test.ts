import { describe, expect, it, vi } from "vitest";

describe("test setup", () => {
  it("gives vi.waitFor a load-tolerant default budget and keeps a caller's own timeout", async () => {
    const started = Date.now();
    let ready = false;
    setTimeout(() => { ready = true; }, 1_200);
    await vi.waitFor(() => expect(ready).toBe(true));
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_100);

    await expect(vi.waitFor(() => expect(false).toBe(true), { timeout: 100 })).rejects.toThrow();
    await expect(vi.waitFor(() => expect(false).toBe(true), 100)).rejects.toThrow();
  });
});
