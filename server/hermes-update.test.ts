import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { checkUpstreamRelease, restorePreviousRuntime, runtimeUpdateStatus, startRuntimeUpdate } from "./hermes-update.ts";
import { cancelBootstrapInstall, installStatus, waitForBootstrapStop } from "./hermes-bridge.ts";
import { HERMES_RECOMMENDED, HERMES_RELEASES } from "./hermes-releases.ts";
import { applyPropertyPack, propertyProfileDir } from "./hermes-pack.ts";
import { readRuntimeSelection, releaseHome, resetRuntimeSelectionForTests, saveRuntimeSelection, selectedHermesCli } from "./hermes-runtime-selection.ts";
import { runtimeCli } from "./hermes-paths.ts";
import { acquireWorkerSetupLock, bootstrapPlan, runWorkerBootstrap } from "./worker-bootstrap.ts";
import * as profileStorage from "./hermes-profile-storage.ts";

import { privateFixtureRoot, writePrivateFixtureFile } from "./testing/private-profile-fixture.ts";

let home: string;
const mkdtempSync = privateFixtureRoot;
// This file exercises repeated genuine Windows ACL subprocesses during setup.
if (process.platform === "win32") vi.setConfig({ testTimeout: 120_000 });
const version = `Hermes Agent v${HERMES_RECOMMENDED.product} (${HERMES_RECOMMENDED.tag.slice(1)})`;
const run: typeof runWorkerBootstrap = async opts => {
  const cli = runtimeCli(opts.home); mkdirSync(dirname(cli), { recursive: true }); writeFileSync(cli, "fixture");
  await opts.finalize?.();
};
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "realbud-update-test-"));
  vi.stubEnv("REALBUD_HERMES_HOME", home); vi.stubEnv("REALBUD_HERMES_CLI", "");
  resetRuntimeSelectionForTests();
});
afterEach(async () => { cancelBootstrapInstall(); await waitForBootstrapStop(); vi.restoreAllMocks(); vi.unstubAllEnvs(); resetRuntimeSelectionForTests(); rmSync(home, { recursive: true, force: true }); });
const start = (extra: Parameters<typeof startRuntimeUpdate>[0] = {}) => startRuntimeUpdate({ home, run, verify: async () => version, ...extra });

it("privately admits a previously absent home before launching first-install bootstrap", async () => {
  const absent = join(home, "new-owned-home");
  vi.stubEnv("REALBUD_HERMES_HOME", absent);
  const admit = vi.spyOn(profileStorage, "ensureProfileDirectory");
  const runner = vi.fn<typeof runWorkerBootstrap>(async options => {
    expect(admit).toHaveBeenCalledWith(absent);
    expect(existsSync(absent)).toBe(true);
    if (process.platform !== "win32") expect(statSync(absent).mode & 0o077).toBe(0);
    await run(options);
  });
  start({ home: absent, run: runner, firstInstall: true });
  await waitForBootstrapStop();
  expect(runner).toHaveBeenCalledOnce();
  expect(installStatus().state).toBe("done");
  expect(existsSync(join(propertyProfileDir(absent), "config.yaml"))).toBe(true);
});

it("refuses an existing unverified home before installer or verification work starts", () => {
  const before = installStatus(), contents = readdirSync(home);
  const runner = vi.fn<typeof runWorkerBootstrap>(), verify = vi.fn(async () => version);
  vi.spyOn(profileStorage, "ensureProfileDirectory").mockImplementation(() => {
    throw new Error("Private home needs recovery.");
  });
  expect(() => start({ run: runner, verify })).toThrow("Private home needs recovery.");
  expect(runner).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
  expect(installStatus()).toEqual(before); expect(readdirSync(home)).toEqual(contents);
});

it("stages an official runtime without changing the current executable or private profile", async () => {
  applyPropertyPack(home);
  const profile = propertyProfileDir(home);
  const config = readFileSync(join(profile, "config.yaml"), "utf8") + "\nupdates:\n  check: false\nmemory:\n  user_profile: keep\n";
  writeFileSync(join(profile, "config.yaml"), config);
  writePrivateFixtureFile(join(profile, ".env"), "TEST_KEY=keep-private");
  writeFileSync(join(profile, "MEMORY.md"), "User memory");
  expect(selectedHermesCli()).toBe("hermes");
  start(); await waitForBootstrapStop();
  expect(installStatus().state).toBe("done");
  expect(selectedHermesCli()).toBe("hermes");
  expect(runtimeUpdateStatus()).toMatchObject({ restartRequired: true, canRestorePrevious: true });
  expect(readFileSync(join(profile, "config.yaml"), "utf8")).toBe(config);
  expect(readFileSync(join(profile, ".env"), "utf8")).toBe("TEST_KEY=keep-private");
  expect(readFileSync(join(profile, "MEMORY.md"), "utf8")).toBe("User memory");
  resetRuntimeSelectionForTests();
  expect(selectedHermesCli()).toBe(runtimeCli(releaseHome(home, readRuntimeSelection(home).selected!)));
  expect(runtimeUpdateStatus().restartRequired).toBe(false);
});

it("makes a verified first install available without a restart or a false rollback option", async () => {
  expect(selectedHermesCli()).toBe("hermes");
  start({ firstInstall: true }); await waitForBootstrapStop();
  expect(installStatus().state).toBe("done");
  expect(selectedHermesCli()).toBe(runtimeCli(releaseHome(home, readRuntimeSelection(home).selected!)));
  expect(runtimeUpdateStatus()).toMatchObject({ restartRequired: false, canRestorePrevious: false });
  expect(() => restorePreviousRuntime()).toThrow(/No previous/);
});

it("restores the previous selection on the next launch without touching profile data", async () => {
  start(); await waitForBootstrapStop(); resetRuntimeSelectionForTests();
  const cli = selectedHermesCli();
  expect(restorePreviousRuntime()).toEqual({ restartRequired: true });
  expect(selectedHermesCli()).toBe(cli);
  expect(runtimeUpdateStatus().restartRequired).toBe(true);
  resetRuntimeSelectionForTests(); expect(selectedHermesCli()).toBe("hermes");
});

it("rejects concurrent installs and rollback while setup is active", async () => {
  start({ run: async opts => { await new Promise<void>(resolve => opts.signal.addEventListener("abort", () => resolve(), { once: true })); } });
  expect(() => start()).toThrow(/already running/);
  expect(() => restorePreviousRuntime()).toThrow(/Wait/);
  cancelBootstrapInstall(); await waitForBootstrapStop();
  expect(installStatus().state).toBe("failed");
  expect(readRuntimeSelection(home).selected).toBeNull();
});

it.each(["download", "verification", "mismatch"])("keeps the old selection when %s fails and allows retry", async failure => {
  start({ ...(failure === "download" ? { run: async () => { throw new Error("secret fixture path"); } } : { verify: async () => {
    if (failure === "verification") throw new Error("secret fixture path"); return "Hermes Agent v99.0.0 (2099.1.1)";
  } }) });
  await waitForBootstrapStop();
  expect(installStatus().state).toBe("failed"); expect(installStatus().error).not.toContain("secret fixture path");
  expect(readRuntimeSelection(home).selected).toBeNull();
  start(); await waitForBootstrapStop(); expect(installStatus().state).toBe("done");
});

it("does not promote a candidate after cancellation during verification", async () => {
  start({ verify: async () => { cancelBootstrapInstall(); return version; } });
  await waitForBootstrapStop(); expect(installStatus().state).toBe("failed"); expect(readRuntimeSelection(home).selected).toBeNull();
});

it("keeps a live legacy installer from overlapping a new release installation", () => {
  writeFileSync(join(home, ".realbud-bootstrap.json"), JSON.stringify({ version: 1, pending: true, childPid: process.pid }));
  expect(() => start()).toThrow(/earlier agent setup/);
  expect(readRuntimeSelection(home).selected).toBeNull();
});

it("promotes the verified runtime before releasing the cross-process installer lock", async () => {
  let lockedDuringVerification = false;
  start({
    run: async opts => {
      await runWorkerBootstrap({ ...opts, download: async () => Buffer.from("fixture"), execute: async () => {} });
      expect(readRuntimeSelection(home).selected).not.toBeNull();
    },
    verify: async () => {
      expect(() => acquireWorkerSetupLock(join(home, ".runtime-install"))).toThrow(/already running/);
      lockedDuringVerification = true;
      return version;
    },
  });
  await waitForBootstrapStop();
  expect(lockedDuringVerification).toBe(true);
  expect(installStatus().state).toBe("done");
});

it("blocks rollback while another process owns the installer lock or child", async () => {
  start(); await waitForBootstrapStop();
  const before = readRuntimeSelection(home);
  const lockHome = join(home, ".runtime-install");
  const release = acquireWorkerSetupLock(lockHome);
  try { expect(() => restorePreviousRuntime()).toThrow(/already running/); }
  finally { release(); }
  writeFileSync(join(lockHome, ".realbud-bootstrap.json"), JSON.stringify({ version: 1, pending: true, childPid: process.pid }));
  expect(() => restorePreviousRuntime()).toThrow(/earlier agent setup/);
  expect(readRuntimeSelection(home)).toEqual(before);
});

it("uses a fresh candidate folder when an attempt fails", async () => {
  const homes: string[] = [];
  const fail: typeof runWorkerBootstrap = async opts => { homes.push(opts.home); throw new Error("fixture failure"); };
  start({ run: fail }); await waitForBootstrapStop();
  start({ run: fail }); await waitForBootstrapStop();
  expect(homes).toHaveLength(2); expect(homes[0]).not.toBe(homes[1]);
  expect(readRuntimeSelection(home).selected).toBeNull();
});

it("does not overwrite a selection changed during setup", async () => {
  const another = "a".repeat(40);
  start({ verify: async () => { saveRuntimeSelection(home, { version: 1, selected: another, previous: null }); return version; } });
  await waitForBootstrapStop(); expect(installStatus().state).toBe("failed"); expect(readRuntimeSelection(home).selected).toBe(another);
});

it("refuses corrupt or escaping selectors without replacing them", () => {
  for (const content of ['broken', '{"version":1,"selected":"../../personal","previous":null}']) {
    writeFileSync(join(home, "realbud-runtime.json"), content);
    expect(() => start()).toThrow(/could not be read/);
    expect(readFileSync(join(home, "realbud-runtime.json"), "utf8")).toBe(content);
  }
});

it("keeps a custom CLI outside managed installation", () => {
  vi.stubEnv("REALBUD_HERMES_CLI", "/custom/hermes");
  expect(selectedHermesCli()).toBe("/custom/hermes");
  expect(() => start()).toThrow(/custom agent path/);
});

// The promotion procedure says smoke a candidate before recommending it, but staging
// used to be hardcoded to HERMES_RECOMMENDED and refused once that was selected — so
// staging a candidate required promoting it first, which is the thing the smoke gates.
// These pin that a catalog release can be staged without becoming recommended. The
// candidate is now the previous release, which keeps the invariant testable after
// 0.21.3 was promoted.
const candidateRelease = HERMES_RELEASES.find(release => release.product === "0.21.2")!;

it("stages a catalog candidate while RECOMMENDED stays on the shipped release", async () => {
  applyPropertyPack(home);
  expect(HERMES_RECOMMENDED.product).toBe("0.21.3");
  start({ release: candidateRelease, verify: async () => `Hermes Agent v${candidateRelease.product} (${candidateRelease.tag.slice(1)})` });
  await waitForBootstrapStop();
  expect(installStatus().state).toBe("done");
  // Staged and selectable, and still not what a fresh office receives.
  expect(readRuntimeSelection(home).selected).toContain(candidateRelease.commit);
  expect(HERMES_RECOMMENDED.product).not.toBe(candidateRelease.product);
});

it("refuses to stage a release that is not in the install catalog", () => {
  const admit = vi.spyOn(profileStorage, "ensureProfileDirectory");
  const forged = { product: "9.9.9", tag: "v2099.1.1", commit: "f".repeat(40), installers: { unix: "x", windows: "y" } };
  expect(() => start({ release: forged })).toThrow(/not in the install catalog/);
  expect(admit).not.toHaveBeenCalled();
});

it.each(["darwin", "linux", "win32"] as const)("never rewrites the shared launcher in a private %s installation", platform => {
  const plan = bootstrapPlan(platform, HERMES_RECOMMENDED, true)!;
  expect(plan.stages).not.toContain("path");
  expect(plan.stages).not.toEqual(expect.arrayContaining(["gateway", "desktop", "setup"]));
  expect(plan.url).toContain(HERMES_RECOMMENDED.commit);
});

it("prefers a previously owned CLI over an unrelated PATH installation", () => {
  const cli = runtimeCli(home); mkdirSync(dirname(cli), { recursive: true }); writeFileSync(cli, "fixture");
  expect(selectedHermesCli()).toBe(cli);
});

it("treats upstream metadata as advisory and builds its own release link", async () => {
  const request = vi.fn(async () => new Response(JSON.stringify({ tag_name: "v2099.1.1", html_url: "https://evil.invalid", draft: false, prerelease: false })));
  expect(await checkUpstreamRelease(request)).toEqual({ latestTag: "v2099.1.1", supported: false, releaseUrl: "https://github.com/NousResearch/hermes-agent/releases/tag/v2099.1.1" });
  expect(request).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ redirect: "error" }));
  expect(readRuntimeSelection(home).selected).toBeNull();
});

it.each([{ tag_name: "main" }, { tag_name: "v2026.8.31", draft: true }, { tag_name: "v2026.8.31", prerelease: true }])("refuses unstable or invalid release metadata %j", async value => {
  await expect(checkUpstreamRelease(async () => new Response(JSON.stringify(value)))).rejects.toThrow();
});
it("bounds release responses and preserves the installation on network failure", async () => {
  await expect(checkUpstreamRelease(async () => new Response(new Uint8Array(256_001)))).rejects.toThrow(/Unexpected/);
  await expect(checkUpstreamRelease(async () => new Response("", { status: 503 }))).rejects.toThrow(/Could not check/);
  expect(readRuntimeSelection(home).selected).toBeNull();
});
