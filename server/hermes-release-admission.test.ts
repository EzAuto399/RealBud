// What a fresh office installs, and the guards that stop that answer moving.
//
// Packet 2 context: the recommended release used to be `HERMES_RELEASES[2]`, and
// several call sites defaulted to `HERMES_RELEASES[0]` — the 0.20.3
// compatibility floor. Reordering the catalog would have silently repointed what
// every new install received, and an omitted `release` argument installed the
// older build. These tests pin the intended roles.
import { describe, expect, it } from "vitest";

import { HERMES_COMPATIBLE_RELEASES, HERMES_PIN } from "./hermes-pin.ts";
import { HERMES_RECOMMENDED, HERMES_RECOMMENDED_VERSION, HERMES_RELEASES } from "./hermes-releases.ts";
import { bootstrapInvocation, bootstrapPlan } from "./worker-bootstrap.ts";

describe("what a fresh install receives", () => {
  it("recommends 0.21.2 by name, not by position in the catalog", () => {
    expect(HERMES_RECOMMENDED_VERSION).toBe("0.21.2");
    expect(HERMES_RECOMMENDED.product).toBe(HERMES_RECOMMENDED_VERSION);
    expect(HERMES_RECOMMENDED.tag).toBe("v2026.9.11");
    expect(HERMES_RECOMMENDED.commit).toBe("939e45c91d751fadd94dcd1b873ac3cb44846213");
  });

  it("never recommends the compatibility floor", () => {
    // 0.20.3 stays in the catalog so an existing office still reads as
    // supported. It must never be what a new install gets.
    expect(HERMES_RECOMMENDED.product).not.toBe(HERMES_PIN.product);
    expect(HERMES_RECOMMENDED.commit).not.toBe(HERMES_PIN.commit);
  });

  // Replaces "does not admit 0.21.3 anywhere". 0.21.3 is now admitted as an
  // installable, supported candidate so it can be staged and smoked, but it must
  // not yet be what a fresh office receives — the pin procedure still requires an
  // ACP smoke against the new worker. The guard moves from "absent" to
  // "present but never recommended", which is the invariant that actually matters.
  it("admits 0.21.3 as a candidate but never recommends or defaults to it", () => {
    const catalog: readonly { product: string; tag: string; commit: string }[] = HERMES_RELEASES;
    const compatible: readonly { product: string; calendar: string }[] = HERMES_COMPATIBLE_RELEASES;
    const candidate = catalog.find(release => release.product === "0.21.3");
    expect(candidate, "0.21.3 must be installable so it can be evaluated").toBeDefined();
    expect(candidate?.tag).toBe("v2026.9.14");
    // The v2026.9.14 TAG commit, not a main-branch head. This machine's personal
    // Hermes also says "v0.21.3 (2026.9.14)" but is built from upstream 6005aa1f,
    // 1653 commits ahead of the tag.
    expect(candidate?.commit).toBe("345cd2b057a452236de401d3534b8502a7465e8d");
    expect(compatible.some(release => release.product === "0.21.3" && release.calendar === "2026.9.14")).toBe(true);
    // The two things that would actually ship it to a new office:
    expect(HERMES_RECOMMENDED_VERSION).not.toBe("0.21.3");
    expect(HERMES_RECOMMENDED.product).not.toBe("0.21.3");
  });

  it("keeps the rollback/floor release installable rather than deleting it", () => {
    const floor = HERMES_RELEASES.find(release => release.commit === HERMES_PIN.commit);
    expect(floor).toBeDefined();
    expect(floor?.product).toBe("0.20.3");
  });

  it("keeps the catalog and the compatibility list in step", () => {
    // Two hand-maintained lists that nothing previously joined: a release could
    // be installable but read as unsupported, or supported but not installable.
    const catalog = new Set(HERMES_RELEASES.map(release => `${release.product} ${release.tag.slice(1)}`));
    const compatible = new Set(HERMES_COMPATIBLE_RELEASES.map(release => `${release.product} ${release.calendar}`));
    expect([...catalog].sort()).toEqual([...compatible].sort());
  });

  it("gives every catalog release immutable installer digests and a commit", () => {
    for (const release of HERMES_RELEASES) {
      expect(release.commit, release.product).toMatch(/^[a-f0-9]{40}$/);
      expect(release.installers.unix, release.product).toMatch(/^[a-f0-9]{64}$/);
      expect(release.installers.windows, release.product).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it("has no duplicate commits or products", () => {
    expect(new Set(HERMES_RELEASES.map(r => r.commit)).size).toBe(HERMES_RELEASES.length);
    expect(new Set(HERMES_RELEASES.map(r => r.product)).size).toBe(HERMES_RELEASES.length);
  });
});

describe("bootstrap plan defaults", () => {
  it("plans the recommended release when no release is supplied", () => {
    // This is the landmine: an omitted release used to fall through to
    // HERMES_RELEASES[0] = 0.20.3 in both the plan and its invocation.
    const spec = bootstrapPlan("darwin");
    expect(spec).not.toBeNull();
    expect(spec?.url).toContain(HERMES_RECOMMENDED.commit);
    expect(spec?.url).not.toContain(HERMES_PIN.commit);
    expect(spec?.sha256).toBe(HERMES_RECOMMENDED.installers.unix);
  });

  it("builds the invocation against the same release as the plan", () => {
    const spec = bootstrapPlan("darwin")!;
    const invocation = bootstrapInvocation("darwin", "/some path/setup", spec.stages[0]!, "/a home/with spaces");
    expect(invocation.args).toContain(HERMES_RECOMMENDED.commit);
    expect(invocation.args).not.toContain(HERMES_PIN.commit);
  });

  it("still honours an explicit release, so the floor remains installable", () => {
    const floor = HERMES_RELEASES.find(release => release.commit === HERMES_PIN.commit)!;
    const spec = bootstrapPlan("darwin", floor);
    expect(spec?.url).toContain(HERMES_PIN.commit);
    expect(spec?.sha256).toBe(floor.installers.unix);
  });

  it("selects the windows installer script on win32 and refuses other platforms", () => {
    expect(bootstrapPlan("win32")?.sha256).toBe(HERMES_RECOMMENDED.installers.windows);
    expect(bootstrapPlan("aix")).toBeNull();
  });
});
