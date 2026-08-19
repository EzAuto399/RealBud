import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";

import { SERVER_ROOT, SPAWNED_PROXIES, resolveProxy } from "./proxy-paths.ts";

describe("proxy-paths", () => {
  it("anchors at the server root, not a nested driver folder", () => {
    expect(basename(SERVER_ROOT)).toBe("server");
    expect(dirname(SPAWNED_PROXIES.computer)).toBe(SERVER_ROOT);
    expect(dirname(SPAWNED_PROXIES.permission)).toBe(SERVER_ROOT);
    expect(dirname(SPAWNED_PROXIES.containerMcp)).toBe(SERVER_ROOT);
  });

  it("resolves every spawned proxy that exists in this tree", () => {
    for (const path of Object.values(SPAWNED_PROXIES)) {
      expect(path.endsWith(".ts") || path.endsWith(".js")).toBe(true);
    }
    expect(resolveProxy("computer-proxy")).toBe(SPAWNED_PROXIES.computer);
  });
});
