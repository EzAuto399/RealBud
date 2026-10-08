import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { checkUpstreamRelease, discardFailedCandidate, installOrRepairWorker, recommendedUpdateAwaitingRestart, restorePreviousRuntime, runtimeUpdateStatus, startRuntimeUpdate } from "./hermes-update.ts";
import type { HermesStatus } from "./hermes-status.ts";
import { cancelBootstrapInstall, installStatus, waitForBootstrapStop } from "./hermes-bridge.ts";
import { HERMES_RECOMMENDED, HERMES_RELEASES } from "./hermes-releases.ts";
import { applyPropertyPack, propertyProfileDir } from "./hermes-pack.ts";
import { readRuntimeSelection, releaseHome, resetRuntimeSelectionForTests, saveRuntimeSelection, selectedHermesCli } from "./hermes-runtime-selection.ts";
import { runtimeCli } from "./hermes-paths.ts";
import { controlPath } from "./worker-control.ts";
import { acquireWorkerSetupLock, bootstrapPlan, runWorkerBootstrap } from "./worker-bootstrap.ts";
import * as profileStorage from "./hermes-profile-storage.ts";
import * as filePrivacy from "./windows-file-privacy.ts";

import { privateFixtureDirectory, privateFixtureRoot, writePrivateFixtureFile } from "./testing/private-profile-fixture.ts";

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

it("creates the installer lock folder private, so a Windows ACL check admits it on first install", async () => {
  // Windows semantics: a folder made by a plain mkdir inherits an unprotected
  // ACL, so verifying it refuses; only a folder restricted at birth passes.
  const restricted = new Set([home]);
  const admit = (path: string, kind: string, restrict: boolean) => {
    if (kind !== "directory" || !path.startsWith(home)) return;
    if (restrict) restricted.add(path);
    else if (!restricted.has(path)) throw new Error("windows-acl:inheritance-not-protected");
  };
  vi.spyOn(filePrivacy, "windowsFilePrivacy").mockImplementation(async (path, kind, restrict = false) => admit(path, kind, restrict));
  vi.spyOn(filePrivacy, "windowsFilePrivacyBatchSync").mockImplementation(operations => operations.map(op => { admit(op.path, op.kind, op.action === "restrict"); return { ...op, applied: op.action === "restrict" }; }));
  start({ firstInstall: true }); await waitForBootstrapStop();
  expect(installStatus().error).toBeNull();
  expect(installStatus().state).toBe("done");
  expect(restricted.has(join(home, ".runtime-install"))).toBe(true);
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

it("reports an installed recommended update as awaiting restart, not as needing another install", async () => {
  expect(recommendedUpdateAwaitingRestart(home)).toBe(false);
  start(); await waitForBootstrapStop();
  expect(installStatus().state).toBe("done");
  expect(recommendedUpdateAwaitingRestart(home)).toBe(true);
  // After the restart the selected runtime is the running one.
  resetRuntimeSelectionForTests();
  expect(recommendedUpdateAwaitingRestart(home)).toBe(false);
});

it("still repairs when the selected recommended runtime is missing from disk", async () => {
  start(); await waitForBootstrapStop();
  rmSync(releaseHome(home, readRuntimeSelection(home).selected!), { recursive: true, force: true });
  expect(recommendedUpdateAwaitingRestart(home)).toBe(false);
});

it("makes a verified first install available without a restart or a false rollback option", async () => {
  expect(selectedHermesCli()).toBe("hermes");
  start({ firstInstall: true }); await waitForBootstrapStop();
  expect(installStatus().state).toBe("done");
  expect(selectedHermesCli()).toBe(runtimeCli(releaseHome(home, readRuntimeSelection(home).selected!)));
  expect(runtimeUpdateStatus()).toMatchObject({ restartRequired: false, canRestorePrevious: false });
  await expect(restorePreviousRuntime()).rejects.toThrow(/No previous/);
});

const workerStatus = (cli: Partial<HermesStatus["cli"]>) => async () => ({ cli: { installed: true, versionText: "Hermes Agent v0.20.6 (fixture)", matchesPin: false, compatible: false, probeState: "ok", ...cli } }) as HermesStatus;

it("adopts RealBud's private runtime at once over an unsupported personal worker, without touching it", async () => {
  expect(selectedHermesCli()).toBe("hermes");
  const repairExisting = vi.fn(async () => null);
  const outcome = await installOrRepairWorker({ home, run, verify: async () => version, status: workerStatus({}), repairExisting });
  expect(outcome.kind).toBe("started");
  await waitForBootstrapStop();
  expect(installStatus().state).toBe("done");
  expect(repairExisting).not.toHaveBeenCalled();
  // No restart: this process now resolves the verified private runtime.
  expect(selectedHermesCli()).toBe(runtimeCli(releaseHome(home, readRuntimeSelection(home).selected!)));
  expect(runtimeUpdateStatus()).toMatchObject({ restartRequired: false, canRestorePrevious: false });
  expect(recommendedUpdateAwaitingRestart(home)).toBe(false);
});

it("adopts a first install when no worker exists, and joins a run already in flight", async () => {
  const outcome = await installOrRepairWorker({ home, run, verify: async () => version, status: workerStatus({ installed: false, versionText: null, probeState: "missing" }), repairExisting: async () => null });
  expect(outcome.kind).toBe("started");
  const second = await installOrRepairWorker({ home, run, verify: async () => version, status: workerStatus({}) });
  expect(second.kind).toBe("running");
  await waitForBootstrapStop();
  expect(selectedHermesCli()).toBe(runtimeCli(releaseHome(home, readRuntimeSelection(home).selected!)));
});

it("repairs a compatible worker in place instead of downloading, and keeps an update waiting for restart", async () => {
  const repaired = { cli: { installed: true, compatible: true } } as HermesStatus;
  expect(await installOrRepairWorker({ home, run, status: workerStatus({ compatible: true, matchesPin: true }), repairExisting: async () => repaired }))
    .toEqual({ kind: "repaired", hermes: repaired });
  start(); await waitForBootstrapStop();
  expect(await installOrRepairWorker({ home, run, status: workerStatus({}) })).toEqual({ kind: "awaiting_restart" });
});

it("stages and adopts a replacement for a damaged runtime at once, keeping the damaged one on disk", async () => {
  start({ firstInstall: true }); await waitForBootstrapStop();
  const damaged = readRuntimeSelection(home).selected!;
  const status = async () => ({ cli: { installed: true, versionText: version, matchesPin: false, compatible: false, probeState: "ok" }, runtimeIntegrity: "damaged" }) as HermesStatus;
  const repairExisting = vi.fn(async () => null);
  expect((await installOrRepairWorker({ home, run, verify: async () => version, status, repairExisting })).kind).toBe("started");
  await waitForBootstrapStop();
  expect(installStatus().state).toBe("done");
  expect(repairExisting).not.toHaveBeenCalled();
  const replacement = readRuntimeSelection(home);
  expect(replacement).toMatchObject({ previous: damaged, previousAvailable: false });
  expect(replacement.selected).not.toBe(damaged);
  expect(existsSync(runtimeCli(releaseHome(home, damaged)))).toBe(true);
  expect(selectedHermesCli()).toBe(runtimeCli(releaseHome(home, replacement.selected!)));
});

it("keeps its records when the worker folder is deleted and installs fresh instead of reusing a vanished download", async () => {
  start({ firstInstall: true }); await waitForBootstrapStop();
  const first = readRuntimeSelection(home).selected!;
  start({ repair: true, verify: async () => { throw new Error("fictional verification refusal"); } }); await waitForBootstrapStop();
  const receipt = JSON.parse(readFileSync(controlPath(home, "completed-runtime"), "utf8"));
  expect(receipt.candidateId).not.toBe(first);
  for (const entry of readdirSync(home)) rmSync(join(home, entry), { recursive: true, force: true });
  expect(readRuntimeSelection(home).selected).toBe(first);
  expect(JSON.parse(readFileSync(controlPath(home, "completed-runtime"), "utf8"))).toEqual(receipt);
  resetRuntimeSelectionForTests();
  const runner = vi.fn(run);
  const outcome = await installOrRepairWorker({ home, run: runner, verify: async () => version, status: workerStatus({ installed: false, versionText: null, probeState: "missing" }) });
  expect(outcome.kind).toBe("started");
  await waitForBootstrapStop();
  expect(installStatus()).toMatchObject({ state: "done", error: null });
  expect(runner).toHaveBeenCalledOnce();
  expect(readRuntimeSelection(home)).toMatchObject({ previous: first, previousAvailable: false });
  expect(selectedHermesCli()).toBe(runtimeCli(releaseHome(home, readRuntimeSelection(home).selected!)));
});

it("restores the previous selection on the next launch without touching profile data", async () => {
  start(); await waitForBootstrapStop(); resetRuntimeSelectionForTests();
  const cli = selectedHermesCli();
  expect(await restorePreviousRuntime()).toEqual({ restartRequired: true });
  expect(selectedHermesCli()).toBe(cli);
  expect(runtimeUpdateStatus().restartRequired).toBe(true);
  resetRuntimeSelectionForTests(); expect(selectedHermesCli()).toBe("hermes");
});

it("rejects concurrent installs and rollback while setup is active", async () => {
  start({ run: async opts => { await new Promise<void>(resolve => opts.signal.addEventListener("abort", () => resolve(), { once: true })); } });
  expect(() => start()).toThrow(/already running/);
  await expect(restorePreviousRuntime()).rejects.toThrow(/Wait/);
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
  try { await expect(restorePreviousRuntime()).rejects.toThrow(/already running/); }
  finally { release(); }
  writeFileSync(join(lockHome, ".realbud-bootstrap.json"), JSON.stringify({ version: 1, pending: true, childPid: process.pid }));
  await expect(restorePreviousRuntime()).rejects.toThrow(/earlier agent setup/);
  expect(readRuntimeSelection(home)).toEqual(before);
});

it("uses a fresh candidate folder when an attempt fails", async () => {
  const homes: string[] = [];
  const fail: typeof runWorkerBootstrap = async opts => { homes.push(opts.home); throw new Error("fixture failure"); };
  start({ run: fail }); await waitForBootstrapStop();
  start({ run: fail }); await waitForBootstrapStop();
  expect(homes).toHaveLength(2); expect(homes[0]).not.toBe(homes[1]);
  expect(readRuntimeSelection(home).selected).toBeNull();
  // Each failed, never-receipted attempt is removed instead of piling up.
  expect(homes.some(existsSync)).toBe(false);
});

it("keeps a receipted candidate when verification fails after all stages, and the retry reuses it", async () => {
  const stages = vi.fn(async () => {});
  const installer: typeof runWorkerBootstrap = opts => runWorkerBootstrap({ ...opts, download: async () => Buffer.from("fixture"), documentDeps: async () => {},
    execute: async invocation => { await stages(); const cli = runtimeCli(opts.home); mkdirSync(dirname(cli), { recursive: true }); writeFileSync(cli, "fixture"); void invocation; } });
  let candidate = "";
  start({ run: installer, verify: async path => { candidate = path; throw new Error("fictional modified source files"); } });
  await waitForBootstrapStop();
  expect(installStatus().state).toBe("failed");
  expect(stages).toHaveBeenCalled();
  const receipt = JSON.parse(readFileSync(controlPath(home, "completed-runtime"), "utf8"));
  expect(receipt.candidateId).toBe(candidate.split(/[\\/]/).at(-1));
  expect(existsSync(runtimeCli(candidate))).toBe(true);
  const calls = stages.mock.calls.length;
  start({ run: installer, verify: async path => { expect(path).toBe(candidate); return version; } });
  await waitForBootstrapStop();
  expect(installStatus().state).toBe("done");
  expect(stages.mock.calls.length).toBe(calls);
  expect(readRuntimeSelection(home).selected).toBe(receipt.candidateId);
});

it("keeps a failed candidate while its installer child may still be writing, and never discards a selected runtime", async () => {
  let candidate = "";
  start({ run: async opts => {
    candidate = opts.home; writeFileSync(join(opts.home, "fictional-partial"), "x");
    writeFileSync(join(home, ".runtime-install", ".realbud-bootstrap.json"), JSON.stringify({ version: 1, pending: true, childPid: process.pid }));
    throw new Error("fixture failure");
  } });
  await waitForBootstrapStop();
  expect(installStatus().state).toBe("failed");
  expect(existsSync(join(candidate, "fictional-partial"))).toBe(true);

  const id = candidate.split(/[\\/]/).at(-1)!;
  discardFailedCandidate(home, id, join(home, "fictional-no-lock"), { selected: null, previous: id });
  discardFailedCandidate(home, id, join(home, "fictional-no-lock"), { selected: id, previous: null });
  saveRuntimeSelection(home, { version: 1, selected: id, previous: null });
  discardFailedCandidate(home, id, join(home, "fictional-no-lock"), { selected: null, previous: null });
  expect(existsSync(join(candidate, "fictional-partial"))).toBe(true);
  saveRuntimeSelection(home, { version: 1, selected: null, previous: null });
  discardFailedCandidate(home, id, join(home, "fictional-no-lock"), { selected: null, previous: null });
  expect(existsSync(candidate)).toBe(false);
});

it.skipIf(process.platform === "win32")("unlinks, never follows, a link planted as a failed candidate", () => {
  const target = join(home, "fictional-profile"); mkdirSync(target); writeFileSync(join(target, "keep"), "x");
  const planted = join(home, "runtimes", `${HERMES_RECOMMENDED.commit}-abcdefabcdef`);
  mkdirSync(dirname(planted), { recursive: true }); symlinkSync(target, planted);
  discardFailedCandidate(home, planted.split(/[\\/]/).at(-1)!, join(home, "fictional-no-lock"), { selected: null, previous: null });
  expect(readFileSync(join(target, "keep"), "utf8")).toBe("x");
});

it("rechecks a completed private download after verification failed without downloading or installing again", async () => {
  const runner = vi.fn(run), checked: string[] = [];
  start({ run: runner, verify: async candidate => { checked.push(candidate); throw new Error("fictional verification refusal"); } });
  await waitForBootstrapStop();
  expect(installStatus().state).toBe("failed");
  const receipt = JSON.parse(readFileSync(controlPath(home, "completed-runtime"), "utf8"));
  expect(receipt).toMatchObject({ version: 1, candidateId: checked[0]!.split(/[\\/]/).at(-1), commit: HERMES_RECOMMENDED.commit });
  expect(readRuntimeSelection(home).selected).toBeNull();

  start({ run: runner, verify: async candidate => {
    checked.push(candidate);
    expect(() => acquireWorkerSetupLock(join(home, ".runtime-install"))).toThrow(/already running/);
    expect(installStatus().progress).toEqual({ detail: "Checking already downloaded Bud", step: 1, total: 1 });
    return version;
  } });
  await waitForBootstrapStop();
  expect(runner).toHaveBeenCalledOnce();
  expect(checked).toEqual([checked[0], checked[0]]);
  expect(installStatus().state).toBe("done");
  expect(readRuntimeSelection(home).selected).toBe(receipt.candidateId);
});

it("keeps a modified completed candidate unselected when repeated full verification refuses it", async () => {
  const runner = vi.fn(run);
  let candidate = "";
  start({ run: runner, verify: async path => { candidate = path; throw new Error("fictional connection check failure"); } });
  await waitForBootstrapStop();
  const changed = join(candidate, "hermes-agent", "fictional-source.py");
  writeFileSync(changed, "fictional modified source");
  const verify = vi.fn(async path => {
    expect(path).toBe(candidate);
    expect(readFileSync(changed, "utf8")).toBe("fictional modified source");
    throw new Error("fictional full source verification refusal");
  });
  start({ run: runner, verify }); await waitForBootstrapStop();
  expect(verify).toHaveBeenCalledOnce(); expect(runner).toHaveBeenCalledOnce();
  expect(readRuntimeSelection(home).selected).toBeNull();
  expect(installStatus().state).toBe("failed");
  expect(readFileSync(changed, "utf8")).toBe("fictional modified source");
});

it("does not reuse an unreceipted candidate or a selected runtime during repair", async () => {
  const unknown = releaseHome(home, `${HERMES_RECOMMENDED.commit}-123456789abc`);
  mkdirSync(dirname(runtimeCli(unknown)), { recursive: true }); writeFileSync(runtimeCli(unknown), "fictional unknown runtime");
  const runner = vi.fn(run);
  start({ run: runner }); await waitForBootstrapStop();
  const selected = readRuntimeSelection(home).selected;
  expect(selected).not.toBe(unknown.split(/[\\/]/).at(-1));
  start({ run: runner, repair: true }); await waitForBootstrapStop();
  expect(runner).toHaveBeenCalledTimes(2);
  expect(readRuntimeSelection(home).selected).not.toBe(selected);
  expect(readFileSync(runtimeCli(unknown), "utf8")).toBe("fictional unknown runtime");
});

it("keeps malformed completion receipts and refuses them before any installer or verifier runs", async () => {
  const runner = vi.fn(run), verify = vi.fn(async () => version);
  privateFixtureDirectory(join(home, ".runtime-install"));
  const receipt = join(home, ".runtime-install", "completed-runtime.json");
  writePrivateFixtureFile(receipt, JSON.stringify({ version: 1, candidateId: "../../fictional-other" }));
  const before = readFileSync(receipt);
  start({ run: runner, verify }); await waitForBootstrapStop();
  expect(installStatus().state).toBe("failed");
  expect(runner).not.toHaveBeenCalled(); expect(verify).not.toHaveBeenCalled();
  expect(readFileSync(receipt)).toEqual(before);
});

it.skipIf(process.platform === "win32")("refuses a symlink substituted for a completed candidate", async () => {
  let candidate = "";
  const runner = vi.fn(run);
  start({ run: runner, verify: async path => { candidate = path; throw new Error("fictional verification refusal"); } });
  await waitForBootstrapStop();
  const moved = join(home, "fictional-moved-runtime"); renameSync(candidate, moved); symlinkSync(moved, candidate);
  const verify = vi.fn(async () => version);
  start({ run: runner, verify }); await waitForBootstrapStop();
  expect(installStatus().state).toBe("failed");
  expect(runner).toHaveBeenCalledOnce(); expect(verify).not.toHaveBeenCalled();
  expect(readRuntimeSelection(home).selected).toBeNull();
});

it("keeps a completed retry out while another installer child is alive, and honours cancellation on verification", async () => {
  const runner = vi.fn(run);
  start({ run: runner, verify: async () => { throw new Error("fictional verification refusal"); } });
  await waitForBootstrapStop();
  const marker = join(home, ".runtime-install", ".realbud-bootstrap.json");
  writePrivateFixtureFile(marker, JSON.stringify({ version: 1, pending: true, childPid: process.pid }));
  const verify = vi.fn(async () => version);
  start({ run: runner, verify }); await waitForBootstrapStop();
  expect(installStatus()).toMatchObject({ state: "failed", error: expect.stringMatching(/earlier agent setup/) });
  expect(verify).not.toHaveBeenCalled(); expect(runner).toHaveBeenCalledOnce();
  writePrivateFixtureFile(marker, JSON.stringify({ version: 1, pending: true, childPid: null }));
  start({ run: runner, verify: async () => { cancelBootstrapInstall(); return version; } }); await waitForBootstrapStop();
  expect(installStatus().state).toBe("failed");
  expect(runner).toHaveBeenCalledOnce(); expect(readRuntimeSelection(home).selected).toBeNull();
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

it("never adopts a personal Hermes on PATH in the product build", () => {
  // QA 2026-09-30: a personal v0.20.6 read as "Bud update blocked" until the
  // private worker finished installing.
  vi.stubEnv("REALBUD_PRODUCTION", "1");
  expect(selectedHermesCli()).toBe(runtimeCli(home, process.platform));
  expect(existsSync(selectedHermesCli())).toBe(false);
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
// candidate is the previous release, which keeps the invariant testable after
// 0.21.5 was promoted.
const candidateRelease = HERMES_RELEASES.find(release => release.product === "0.21.3")!;

it("stages a catalog candidate while RECOMMENDED stays on the shipped release", async () => {
  applyPropertyPack(home);
  expect(HERMES_RECOMMENDED.product).toBe("0.21.5");
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
