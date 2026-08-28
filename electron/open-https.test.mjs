import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { isHttpsUrl, openHttpsExternal } = require("./open-https.cjs");

describe("packaged https open", () => {
  it("accepts only https", () => {
    expect(isHttpsUrl("https://platform.composio.dev/auth")).toBe(true);
    expect(isHttpsUrl("http://platform.composio.dev/auth")).toBe(false);
    expect(isHttpsUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpsUrl("file:///etc/passwd")).toBe(false);
  });

  it("opens through the OS shell and never claims success on a rejected URL", async () => {
    const openExternal = vi.fn(async () => undefined);
    expect(await openHttpsExternal({ openExternal }, "https://platform.composio.dev/auth")).toBe(true);
    expect(openExternal).toHaveBeenCalledWith("https://platform.composio.dev/auth");
    expect(await openHttpsExternal({ openExternal }, "http://evil.example")).toBe(false);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});
