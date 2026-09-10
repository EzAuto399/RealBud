import { describe, expect, it } from "vitest";

import { HERMES_PIN, hermesInstallCommand, hermesMatchesPin, hermesIsCompatible, parseHermesVersion } from "./hermes-pin.ts";

describe("HERMES_PIN", () => {
  it("names a full commit, not main or latest", () => {
    expect(HERMES_PIN.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(HERMES_PIN.tag).toBe("v2026.8.16.2");
    expect(HERMES_PIN.product).toBe("0.20.3");
    expect(HERMES_PIN.profile).toBe("property");
  });
});

describe("parseHermesVersion", () => {
  it("reads the official --version line", () => {
    expect(parseHermesVersion("Hermes Agent v0.20.3 (2026.8.16.2)")).toEqual({
      product: "0.20.3",
      calendar: "2026.8.16.2",
    });
  });
});

describe("hermesMatchesPin", () => {
  it("requires the pinned product and calendar stamp together", () => {
    expect(hermesMatchesPin("Hermes Agent v0.20.3 (2026.8.16.2)")).toBe(true);
    expect(hermesMatchesPin("Hermes Agent v0.20.0 (2026.8.3)")).toBe(false);
    expect(hermesMatchesPin("Hermes Agent v0.99.0 (2026.8.16.2)")).toBe(false);
    expect(hermesMatchesPin("Hermes Agent v0.20.3 (2026.9.4)")).toBe(false);
  });
});

describe("Hermes adapter compatibility", () => {
  it("accepts the verified 0.21 release without pretending it is the rollback pin", () => {
    const version = "Hermes Agent v0.21.0 (2026.8.31)";
    expect(hermesIsCompatible(version)).toBe(true);
    expect(hermesMatchesPin(version)).toBe(false);
    expect(hermesIsCompatible("Hermes Agent v0.20.3 (2026.8.16.2)")).toBe(true);
  });
  it("fails closed for unknown releases and incomplete version output", () => {
    for (const text of ["Hermes Agent v0.22.0 (2026.8.31)", "Hermes Agent v0.21.0 (2026.9.2)", "v0.21.0", "2026.8.31", ""]) expect(hermesIsCompatible(text)).toBe(false);
  });
});

describe("hermesInstallCommand", () => {
  it("pins the checkout on POSIX and skips a Windows curl|bash lie", () => {
    const cmd = hermesInstallCommand("darwin");
    expect(cmd).toContain(HERMES_PIN.commit);
    expect(cmd).toContain("--force-commit");
    expect(hermesInstallCommand("linux")).toBe(cmd);
    expect(hermesInstallCommand("win32")).toBeNull();
  });
});
