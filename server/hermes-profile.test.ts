// Profile selection is the worker-isolation seam. These tests fix the contract
// that template-OS configuration relies on: one shipped base profile, optional
// member scoping, and no department names baked into code.
import { describe, expect, it } from "vitest";

import { hermesProfileFor, hermesProfilesFor } from "./hermes-profile.ts";

describe("worker profile selection", () => {
  it("uses the shipped base profile when no member is acting", () => {
    expect(hermesProfileFor("property")).toEqual({ profile: "property" });
    expect(hermesProfileFor("property", null)).toEqual({ profile: "property" });
    expect(hermesProfileFor("property", "")).toEqual({ profile: "property" });
  });

  it("keeps existing installs working: the base profile name is unchanged", () => {
    // Regression guard. Any change here silently orphans the profile on disk,
    // its memory and its signed-in model.
    expect(hermesProfileFor("property").profile).toBe("property");
  });

  it("gives each member a distinct profile so memory and sessions cannot mix", () => {
    const a = hermesProfileFor("property", "accounts");
    const b = hermesProfileFor("property", "property-management");
    expect(a.profile).toBe("property-accounts");
    expect(b.profile).toBe("property-property-management");
    expect(a.profile).not.toBe(b.profile);
  });

  it("is stable for the same member, so a seat keeps its memory across runs", () => {
    expect(hermesProfileFor("property", "accounts")).toEqual(hermesProfileFor("property", "accounts"));
  });

  it("derives the profile from a member identity, not a department label", () => {
    // The template rule: seat keys are supplied by the caller (a member id or a
    // configured key). Nothing in the resolver knows a department name, so the
    // same contract serves any office.
    const byId = hermesProfileFor("property", "0b0f7c1e-4a2b-4c3d-8e9f-1234567890ab");
    expect(byId.profile.startsWith("property-")).toBe(true);
    expect(byId.memberKey).toBe("0b0f7c1e-4a2b-4c3d-8e9f-1234567890ab");
  });

  it("sanitises keys into safe directory names without collisions from punctuation", () => {
    expect(hermesProfileFor("property", "Accounts Team").profile).toBe("property-accounts-team");
    expect(hermesProfileFor("property", "accounts-team").profile).toBe("property-accounts-team");
    expect(hermesProfileFor("property", "  ..//etc  ").profile).toBe("property-etc");
  });

  it("does not let a crafted key escape the profiles directory", () => {
    for (const hostile of ["../../secret", "a/../b", "..", "/", "\\..\\win"]) {
      const { profile } = hermesProfileFor("property", hostile);
      expect(profile).not.toContain("/");
      expect(profile).not.toContain("\\");
      expect(profile).not.toContain("..");
      expect(profile.startsWith("property")).toBe(true);
    }
  });

  it("treats keys that sanitise to nothing as no member supplied", () => {
    expect(hermesProfileFor("property", "!!!" )).toEqual({ profile: "property" });
  });

  it("bounds the constructed name", () => {
    const { profile } = hermesProfileFor("property", "x".repeat(200));
    expect(profile.length).toBeLessThanOrEqual(64);
    expect(profile.endsWith("-")).toBe(false);
  });

  it("refuses to build a profile without a base", () => {
    expect(() => hermesProfileFor("")).toThrow(/base Hermes profile/i);
    expect(() => hermesProfileFor("///")).toThrow(/base Hermes profile/i);
  });

  it("enumerates the base plus one profile per member, without duplicates", () => {
    expect(hermesProfilesFor("property")).toEqual(["property"]);
    expect(hermesProfilesFor("property", ["accounts", "accounts", ""])).toEqual(["property", "property-accounts"]);
  });
});
