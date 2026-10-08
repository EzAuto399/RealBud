import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HERMES_PIN } from "./hermes-pin.ts";
import { HERMES_RECOMMENDED } from "./hermes-releases.ts";
import { runtimeCli } from "./hermes-paths.ts";
import { repairExistingProfile } from "./hermes-lifecycle.ts";
import { heldHermesCli, readRuntimeSelection, releaseHome, resetRuntimeSelectionForTests, saveRuntimeSelection, selectedHermesCli } from "./hermes-runtime-selection.ts";
import { hermesStatus } from "./hermes-status.ts";
import { installOrRepairWorker, restorePreviousRuntime, startRuntimeUpdate } from "./hermes-update.ts";
import { commitModelChoice, controlPath, storedModelChoice, workerControlDir } from "./worker-control.ts";
import { cancelWorkerRemoval, completeWorkerRemoval, requestWorkerRemoval, systemBootId, workerRemovalPending, workerRemovalStatus } from "./worker-removal.ts";
import { acquireWorkerSetupLock } from "./worker-bootstrap.ts";
import { sandboxedLaunch, setWorkerLaunchesHeld, workerLaunchesHeld, WORKERS_HELD } from "./worker-network-sandbox.ts";
import { createWorkerAutoSetup } from "./worker-auto-setup.ts";
import { privateFixtureDirectory, privateFixtureRoot, writePrivateFixtureFile } from "./testing/private-profile-fixture.ts";

let home: string, data: string;
const id = `${HERMES_RECOMMENDED.commit}-aaaaaaaaaaaa`;
const BOOT = "darwin:11111111-1111-1111-1111-111111111111", NEXT_BOOT = "darwin:22222222-2222-2222-2222-222222222222";
const migrated = async () => true;
const profile = () => join(home, "profiles", HERMES_PIN.profile);
const launch = () => sandboxedLaunch("/bin/sh", ["-c", "true"], {}, { loopbackPorts: [], writable: [] }, { platform: "linux" });

beforeEach(async () => {
  home = privateFixtureRoot(join(tmpdir(), "realbud-removal-"));
  data = privateFixtureRoot(join(tmpdir(), "realbud-removal-data-"));
  vi.stubEnv("REALBUD_HERMES_HOME", home); vi.stubEnv("REALBUD_HERMES_CLI", "");
  resetRuntimeSelectionForTests(); setWorkerLaunchesHeld(false);
  const cli = runtimeCli(releaseHome(home, id));
  mkdirSync(dirname(cli), { recursive: true }); writeFileSync(cli, "fictional runtime");
  mkdirSync(join(home, "hermes-agent"), { recursive: true }); writeFileSync(join(home, "hermes-agent", "fictional.py"), "legacy runtime");
  privateFixtureDirectory(profile());
  writePrivateFixtureFile(join(profile(), "SOUL.md"), "# Fictional office\n");
  writePrivateFixtureFile(join(profile(), "MEMORY.md"), "Fictional office memory\n");
  writePrivateFixtureFile(join(home, "auth.json"), '{"providers":{}}');
  writePrivateFixtureFile(join(data, "desk.json"), '{"book":"fictional"}');
  saveRuntimeSelection(home, { version: 1, selected: id, previous: null });
  await commitModelChoice(home, HERMES_PIN.profile, "sonnet-xhigh", "office");
});
afterEach(() => {
  setWorkerLaunchesHeld(false); vi.unstubAllEnvs(); resetRuntimeSelectionForTests();
  for (const dir of [home, data, workerControlDir(home)]) rmSync(dir, { recursive: true, force: true });
});

const kept = () => {
  expect(readFileSync(runtimeCli(releaseHome(home, id)), "utf8")).toBe("fictional runtime");
  expect(readFileSync(join(home, "hermes-agent", "fictional.py"), "utf8")).toBe("legacy runtime");
  expect(readFileSync(join(profile(), "MEMORY.md"), "utf8")).toBe("Fictional office memory\n");
};

it("records the request outside the worker home, holds launches and setup, and deletes nothing", async () => {
  expect(await requestWorkerRemoval({ bootId: BOOT })).toMatchObject({ phase: "awaiting-reboot", detail: expect.stringMatching(/Restart this computer/) });
  expect(controlPath(home, "removal").startsWith(home)).toBe(false);
  expect(JSON.parse(readFileSync(controlPath(home, "removal"), "utf8"))).toMatchObject({ phase: "awaiting-reboot", requestedBootId: BOOT, projectionRevision: null });
  expect(workerLaunchesHeld()).toBe(true);
  expect(launch).toThrow(WORKERS_HELD);
  // Repeating the request keeps the original boot.
  await requestWorkerRemoval({ bootId: NEXT_BOOT });
  expect(JSON.parse(readFileSync(controlPath(home, "removal"), "utf8")).requestedBootId).toBe(BOOT);

  for (const refused of [
    () => installOrRepairWorker({ home }), async () => startRuntimeUpdate({ home }), () => restorePreviousRuntime(home), () => repairExistingProfile({ root: home }),
  ]) await expect(refused()).rejects.toMatchObject({ status: 409, code: "worker_removal_pending" });
  const status = await hermesStatus({ root: home });
  expect(status).toMatchObject({ ready: false, hold: "removal_pending", cli: { compatible: false } });
  expect(status.detail).toMatch(/removed after this computer restarts/);
  kept();
});

it("survives an app restart: launches stay held and nothing is removed without a new boot", async () => {
  await requestWorkerRemoval({ bootId: BOOT });
  // A fresh service process: no in-memory hold, no cached runtime.
  setWorkerLaunchesHeld(false); resetRuntimeSelectionForTests();
  expect(selectedHermesCli(home)).toBe(heldHermesCli(home));
  expect(await completeWorkerRemoval({ bootId: BOOT, migrationComplete: migrated })).toMatchObject({ phase: "awaiting-reboot" });
  expect(workerLaunchesHeld()).toBe(true);
  // An unknown boot is never a reboot.
  expect(await completeWorkerRemoval({ bootId: null, migrationComplete: migrated })).toMatchObject({ phase: "awaiting-reboot" });
  // A reboot alone is not enough: the worker-state migration must be complete.
  expect(await completeWorkerRemoval({ bootId: NEXT_BOOT, migrationComplete: async () => false })).toMatchObject({ phase: "awaiting-reboot" });
  // Another RealBud process holding the installer lock keeps it too.
  const unlock = acquireWorkerSetupLock(join(home, ".runtime-install"));
  try { expect(await completeWorkerRemoval({ bootId: NEXT_BOOT, migrationComplete: migrated })).toMatchObject({ phase: "awaiting-reboot" }); }
  finally { unlock(); }
  kept();
  expect(workerRemovalPending()).toBe(true);
});

it("removes only the worker's code after a verified reboot and keeps the office's data, choice and history", async () => {
  const outside = privateFixtureRoot(join(tmpdir(), "realbud-removal-outside-"));
  try {
    writeFileSync(join(outside, "keep"), "outside");
    rmSync(join(home, "hermes-agent"), { recursive: true, force: true });
    if (process.platform !== "win32") symlinkSync(outside, join(home, "hermes-agent"));
    await requestWorkerRemoval({ bootId: BOOT, projectionRevision: 7 });
    setWorkerLaunchesHeld(false);
    expect(await completeWorkerRemoval({ bootId: NEXT_BOOT, migrationComplete: migrated })).toMatchObject({ phase: "removed" });
    expect(existsSync(join(home, "runtimes"))).toBe(false);
    expect(existsSync(join(home, "hermes-agent"))).toBe(false);
    expect(readFileSync(join(outside, "keep"), "utf8")).toBe("outside");
    expect(readFileSync(join(profile(), "MEMORY.md"), "utf8")).toBe("Fictional office memory\n");
    expect(readFileSync(join(home, "auth.json"), "utf8")).toContain("providers");
    expect(readFileSync(join(data, "desk.json"), "utf8")).toContain("fictional");
    expect(storedModelChoice(home, HERMES_PIN.profile)).toBe("sonnet-xhigh");
    expect(readRuntimeSelection(home)).toMatchObject({ selected: null, previous: null, previousAvailable: false });
    expect(JSON.parse(readFileSync(controlPath(home, "runtime-selection"), "utf8")).history.at(-1)).toMatchObject({ runtime: null, event: "removed" });
    expect(workerLaunchesHeld()).toBe(false);
    expect(workerRemovalStatus()).toEqual({ phase: "none" });
    expect(await completeWorkerRemoval({ bootId: NEXT_BOOT, migrationComplete: migrated })).toEqual({ phase: "none" });
  } finally { rmSync(outside, { recursive: true, force: true }); }
});

it("can be cancelled before the restart, releasing the hold and keeping everything", async () => {
  await requestWorkerRemoval({ bootId: BOOT });
  expect(await cancelWorkerRemoval()).toEqual({ phase: "none" });
  expect(workerLaunchesHeld()).toBe(false);
  expect(selectedHermesCli(home)).toBe(runtimeCli(releaseHome(home, id)));
  expect(await completeWorkerRemoval({ bootId: NEXT_BOOT, migrationComplete: migrated })).toEqual({ phase: "none" });
  kept();
});

it("refuses a request on a computer that cannot report its boot, and keeps a damaged request held", async () => {
  await expect(requestWorkerRemoval({ bootId: null })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/can’t confirm/) });
  expect(workerRemovalPending()).toBe(false);
  await requestWorkerRemoval({ bootId: BOOT });
  writeFileSync(controlPath(home, "removal"), "{damaged");
  setWorkerLaunchesHeld(false);
  expect(await completeWorkerRemoval({ bootId: NEXT_BOOT, migrationComplete: migrated })).toMatchObject({ phase: "awaiting-reboot" });
  expect(workerLaunchesHeld()).toBe(true);
  await expect(cancelWorkerRemoval()).rejects.toMatchObject({ status: 409 });
  kept();
});

it("keeps automatic setup from reinstalling while a removal is pending", async () => {
  await requestWorkerRemoval({ bootId: BOOT });
  const installOrRepair = vi.fn(async () => installOrRepairWorker({ home }));
  const setup = createWorkerAutoSetup({
    directory: data, active: async () => true, status: () => hermesStatus({ root: home }), installOrRepair,
    installInFlight: () => false, installStatus: () => ({ state: "idle", lines: [], startedAt: null, finishedAt: null, error: null }),
    waitForInstall: async () => {}, ensurePack: () => {}, reconcileProfile: async () => false, syncBud: () => {},
    readinessPing: async () => ({ ok: false, detail: "held" }),
    // Wiring for server/index.ts: the existing operator-runtime hook also covers a pending removal.
    customRuntime: () => workerRemovalPending(),
  });
  await setup.ensure("boot");
  expect(installOrRepair).not.toHaveBeenCalled();
  expect(setup.status().state).toBe("idle");
  // Without that hook the install itself still refuses.
  await expect(installOrRepair()).rejects.toMatchObject({ code: "worker_removal_pending" });
  kept();
});

it("reads the boot session the same way as the desktop app", () => {
  expect(systemBootId("darwin", () => "ABCDEF01-2345-6789-ABCD-EF0123456789\n")).toBe("darwin:abcdef01-2345-6789-abcd-ef0123456789");
  expect(systemBootId("win32", () => "    BootId    REG_DWORD    0x2a\n")).toBe("win32:42");
  expect(systemBootId("darwin", () => { throw new Error("no sysctl"); })).toBeNull();
});
