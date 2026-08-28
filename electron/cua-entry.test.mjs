import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getPath: () => "/tmp/realbud-cua-entry-test",
  },
  ipcMain: { handle: vi.fn() },
}));

describe("CUA Electron entrypoint", () => {
  it("resolves its checkout-owned runtime from ESM without relying on a global __dirname", async () => {
    const cua = await import("./cua.mjs");

    expect(() => cua.cuaRuntimeStatus()).not.toThrow();
    expect(["development", "none"]).toContain(cua.cuaRuntimeStatus());
  });
});
