import { describe, expect, it } from "vitest";

import { acquirePortalLease, ALLOWED_TOOLS, buildManifest, CUA_PIN, FORBIDDEN_TOOLS, originAllowed, pinSupported, revokePortalLease, toolAllowed } from "./cua-bounded.ts";
import { computerLease } from "./computer-lease.ts";

describe("bounded Cua contract", () => {
  const manifest = buildManifest({
    profile: "/tmp/realbud-chrome",
    origins: ["http://127.0.0.1:9"],
    workItemId: "work-1",
    recipeId: "fake-building-portal",
    recipeVersion: 1,
    now: 1_000,
  });

  it("pins 0.19.3 and mounts only typed browser tools", () => {
    expect(manifest.version).toBe("0.19.3");
    expect(CUA_PIN).toBe("0.19.3");
    expect(manifest.mode).toBe("bounded");
    expect(manifest.tools).toEqual(ALLOWED_TOOLS);
    expect(manifest.forbidden).toEqual(FORBIDDEN_TOOLS);
    expect(pinSupported("0.19.3")).toBe(true);
    expect(pinSupported("0.20.0")).toBe(false);
  });

  it("forbids desktop, coordinates, Enter, JS, and shell", () => {
    for (const tool of FORBIDDEN_TOOLS) expect(toolAllowed(manifest, tool)).toBe(false);
    expect(toolAllowed(manifest, "click_semantic")).toBe(true);
    expect(originAllowed(manifest, "http://127.0.0.1:9/ledger")).toBe(true);
    expect(originAllowed(manifest, "https://evil.example/")).toBe(false);
  });

  it("requires an exact scheme, host, and port match for portal origins", () => {
    expect(originAllowed(manifest, "http://127.0.0.1:9.evil.example/ledger")).toBe(false);
    expect(originAllowed(manifest, "http://127.0.0.1:90/ledger")).toBe(false);
    expect(originAllowed(manifest, "https://127.0.0.1:9/ledger")).toBe(false);
    expect(originAllowed({ ...manifest, origins: ["not a URL"] }, "http://127.0.0.1:9/ledger")).toBe(false);
    expect(originAllowed({ ...manifest, origins: ["file:///tmp/portal"] }, "data:text/plain,portal")).toBe(false);
    expect(originAllowed(manifest, "http://user:pass@127.0.0.1:9/ledger")).toBe(false);
  });

  it("holds one shared computer lease", () => {
    acquirePortalLease("work-1", 2_000);
    expect(() => computerLease.hold("ask", 2_000, 1_000)).toThrow(/lease/);
    revokePortalLease();
    expect(() => computerLease.hold("ask", 2_000, 1_000)).not.toThrow();
    computerLease.release("ask");
  });
});
