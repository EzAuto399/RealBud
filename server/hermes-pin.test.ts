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
  it("reads the release identity when upstream adds install diagnostics", () => {
    expect(parseHermesVersion("Hermes Agent v0.21.2 (2026.9.11) · upstream b6b53c69 · local 939e45c9\nInstall method: git\nPython: 3.11.14")).toEqual({
      product: "0.21.2",
      calendar: "2026.9.11",
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
  it("accepts the verified latest stable by its exact product and calendar pair", () => {
    expect(hermesIsCompatible("Hermes Agent v0.21.2 (2026.9.11) · local 939e45c9")).toBe(true);
    expect(hermesIsCompatible("Hermes Agent v0.21.2 (2026.9.12)")).toBe(false);
  });
  it("does not admit 0.21.3 under any calendar stamp", () => {
    // The real upstream line for 0.21.3. An earlier assertion only used the
    // 0.21.2 calendar, so it passed for the wrong reason: the calendar alone
    // already made it false, which would have hidden a 0.21.3 product entry
    // being added to the compatibility list.
    expect(hermesIsCompatible("Hermes Agent v0.21.3 (2026.9.14)")).toBe(false);
    expect(hermesIsCompatible("Hermes Agent v0.21.3 (2026.9.11)")).toBe(false);
    expect(hermesIsCompatible("Hermes Agent v0.21.3")).toBe(false);
  });
  it("keeps the compatibility floor admitted so an existing 0.20.3 office is not treated as foreign", () => {
    expect(hermesIsCompatible("Hermes Agent v0.20.3 (2026.8.16.2)")).toBe(true);
  });
  it("fails closed for unknown releases and incomplete version output", () => {
    for (const text of ["Hermes Agent v0.22.0 (2026.8.31)", "Hermes Agent v0.21.0 (2026.9.2)", "v0.21.0", "2026.8.31", ""]) expect(hermesIsCompatible(text)).toBe(false);
  });
});

describe("hermesInstallCommand", () => {
  it("keeps installation in the verified in-app flow on every platform", () => {
    expect(hermesInstallCommand("darwin")).toBeNull();
    expect(hermesInstallCommand("linux")).toBeNull();
    expect(hermesInstallCommand("win32")).toBeNull();
  });
});
