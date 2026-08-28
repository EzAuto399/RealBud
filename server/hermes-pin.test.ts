import { describe, expect, it } from "vitest";

import { HERMES_PIN, hermesInstallCommand, hermesMatchesPin, parseHermesVersion } from "./hermes-pin.ts";

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
  it("accepts the pinned product or calendar stamp", () => {
    expect(hermesMatchesPin("Hermes Agent v0.20.3 (2026.8.16.2)")).toBe(true);
    expect(hermesMatchesPin("Hermes Agent v0.20.0 (2026.8.3)")).toBe(false);
  });
});

describe("hermesInstallCommand", () => {
  it("pins the checkout on POSIX and skips a Windows curl|bash lie", () => {
    const cmd = hermesInstallCommand("darwin");
    expect(cmd).toContain(`raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_PIN.commit}/scripts/install.sh`);
    expect(cmd).toContain(HERMES_PIN.commit);
    expect(cmd).toContain("--force-commit");
    expect(cmd).toContain("--skip-setup");
    expect(cmd).toContain("--skip-browser");
    expect(cmd).toContain("--skip-computer-use");
    expect(cmd).toContain("--no-skills");
    expect(hermesInstallCommand("linux")).toBe(cmd);
    expect(hermesInstallCommand("win32")).toBeNull();
  });
});
