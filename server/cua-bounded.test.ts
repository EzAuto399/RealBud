import { describe, expect, it } from "vitest";

import { acquirePortalLease, ALLOWED_TOOLS, buildManifest, CUA_NEVER_TOOLS, CUA_PIN, FORBIDDEN_TOOLS, originAllowed, pinSupported, revokePortalLease, toolAllowed } from "./cua-bounded.ts";
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

  it("pins 0.34.0 and mounts only typed browser tools", () => {
    expect(manifest.version).toBe("0.34.0");
    expect(CUA_PIN).toBe("0.34.0");
    expect(manifest.mode).toBe("bounded");
    expect(manifest.tools).toEqual(ALLOWED_TOOLS);
    expect(manifest.forbidden).toEqual(FORBIDDEN_TOOLS);
    expect(pinSupported("0.34.0")).toBe(true);
    expect(pinSupported("0.19.3")).toBe(false);
  });

  it("forbids desktop, coordinates, Enter, JS, shell and the AGPL perception extension", () => {
    for (const tool of FORBIDDEN_TOOLS) expect(toolAllowed(manifest, tool)).toBe(false);
    for (const tool of ["install_extension", "parse_visual_regions"]) expect(FORBIDDEN_TOOLS).toContain(tool);
    // 0.34.0 tools that install, persist config or reach out for an update.
    for (const tool of ["install_ffmpeg", "set_config", "check_for_update"]) {
      expect(CUA_NEVER_TOOLS).toContain(tool);
      expect(FORBIDDEN_TOOLS).toContain(tool);
      expect(toolAllowed(manifest, tool)).toBe(false);
    }
    expect(toolAllowed(manifest, "click_semantic")).toBe(true);
    expect(originAllowed(manifest, "http://127.0.0.1:9/ledger")).toBe(true);
    expect(originAllowed(manifest, "https://evil.example/")).toBe(false);
    expect(originAllowed(manifest, "http://127.0.0.1:9.evil.example/ledger")).toBe(false);
    expect(originAllowed(manifest, "http://127.0.0.1:90/ledger")).toBe(false);
    expect(originAllowed(manifest, "https://127.0.0.1:9/ledger")).toBe(false);
  });

  it("rejects prefix lookalikes, scheme changes, and port changes on https origins", () => {
    const httpsManifest = buildManifest({
      profile: "/tmp/realbud-chrome",
      origins: ["https://portal.example.com"],
      workItemId: "work-1",
      recipeId: "fake-building-portal",
      recipeVersion: 1,
      now: 1_000,
    });
    expect(originAllowed(httpsManifest, "https://portal.example.com/ledger")).toBe(true);
    expect(originAllowed(httpsManifest, "https://portal.example.com.evil.com/x")).toBe(false);
    expect(originAllowed(httpsManifest, "http://portal.example.com/ledger")).toBe(false);
    expect(originAllowed(httpsManifest, "https://portal.example.com:443/x")).toBe(true);
    expect(originAllowed(httpsManifest, "https://evil-portal.example.com/x")).toBe(false);
    expect(pinSupported("0.34.00")).toBe(false);
    expect(pinSupported("0.34.0-rc")).toBe(false);
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
    const portal = acquirePortalLease("work-1", 2_000, 1);
    expect(() => computerLease.hold("ask", 2_000, 1_000, "ask-1", 1)).toThrow(/lease/);
    revokePortalLease(portal);
    const ask = computerLease.hold("ask", 2_000, 1_000, "ask-1", 1);
    computerLease.release(ask);
  });
});
