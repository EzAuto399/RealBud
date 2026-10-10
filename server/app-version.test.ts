import { afterEach, describe, expect, it, vi } from "vitest";

const manifest = { name: "realbud", version: "0.1.48" };
vi.mock("node:fs", async (original) => ({
  ...await original<typeof import("node:fs")>(),
  readFileSync: vi.fn(() => JSON.stringify(manifest)),
}));

afterEach(() => { manifest.version = "0.1.48"; });

describe("appVersion", () => {
  it("keeps the version this process started with after the files are replaced", async () => {
    const { appVersion } = await import("./app-version.ts");
    expect(appVersion()).toBe("0.1.48");
    // A manual install swaps the manifest under the running service.
    manifest.version = "0.1.49";
    expect(appVersion()).toBe("0.1.48");
  });
});
