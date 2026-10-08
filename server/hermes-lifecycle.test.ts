import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HERMES_PIN } from "./hermes-pin.ts";
import { cancelBootstrapInstall, installInFlight, startBootstrapInstall, waitForBootstrapStop } from "./hermes-bridge.ts";
import { repairExistingProfile, uninstallWorker, WorkerCleanupUnprovenError } from "./hermes-lifecycle.ts";
import type { runWorkerBootstrap } from "./worker-bootstrap.ts";
import { fakeHermesVersion } from "./testing/fake-hermes.ts";
import { HERMES_RECOMMENDED } from "./hermes-releases.ts";
import { runtimeCli } from "./hermes-paths.ts";
import { releaseHome, saveRuntimeSelection } from "./hermes-runtime-selection.ts";

import { privateFixtureDirectory, privateFixtureRoot, writePrivateFixtureFile, WINDOWS_PROFILE_TEST_OPTIONS } from "./testing/private-profile-fixture.ts";

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = privateFixtureRoot(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

afterEach(async () => {
  const deadline = Date.now() + 12_000;
  while (installInFlight() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("uninstallWorker", () => {
  it("refuses concurrent removal without releasing an existing launch hold", async () => {
    const home = tempDir("realbud-life-concurrent-");
    const data = tempDir("realbud-life-concurrent-data-");
    const profile = join(home, "profiles", HERMES_PIN.profile);
    privateFixtureDirectory(profile);
    writeFileSync(join(profile, "SOUL.md"), "# keep until stopped\n");
    const { setWorkerLaunchesHeld, workerLaunchesHeld, sandboxedLaunch, WORKERS_HELD } = await import("./worker-network-sandbox.ts");
    const stopWorkers = vi.fn(async () => {});
    setWorkerLaunchesHeld(true);
    try {
      await Promise.all([0, 1].map(async () => {
        await expect(uninstallWorker({ root: home, dataDir: data, stopWorkers })).rejects.toMatchObject({ status: 409, message: WORKERS_HELD });
      }));
      expect(workerLaunchesHeld()).toBe(true);
      expect(readFileSync(join(profile, "SOUL.md"), "utf8")).toBe("# keep until stopped\n");
      expect(() => sandboxedLaunch("/bin/sh", ["-c", "true"], {}, { loopbackPorts: [], writable: [] }, { platform: "linux" })).toThrow(WORKERS_HELD);
      expect(stopWorkers).not.toHaveBeenCalled();
    } finally { setWorkerLaunchesHeld(false); }
    expect(workerLaunchesHeld()).toBe(false);
  });

  it("refuses before invoking even a failing stopper or taking a launch hold", async () => {
    const home = tempDir("realbud-life-stop-failed-");
    const data = tempDir("realbud-life-stop-failed-data-");
    const profile = join(home, "profiles", HERMES_PIN.profile);
    privateFixtureDirectory(profile);
    writeFileSync(join(profile, "SOUL.md"), "# retained\n");
    const stopWorkers = vi.fn(async () => { throw new Error("cleanup unconfirmed"); });
    await expect(uninstallWorker({ root: home, dataDir: data, stopWorkers })).rejects.toBeInstanceOf(WorkerCleanupUnprovenError);
    expect(stopWorkers).not.toHaveBeenCalled();
    expect(readFileSync(join(profile, "SOUL.md"), "utf8")).toBe("# retained\n");
    expect((await import("./worker-network-sandbox.ts")).workerLaunchesHeld()).toBe(false);
  });

  it.skipIf(process.platform === "win32")("keeps the profile through persistent EPERM and still refuses deletion after a successful group drain", async () => {
    const home = tempDir("realbud-life-denied-home-");
    const data = tempDir("realbud-life-denied-data-");
    const profile = join(home, "profiles", HERMES_PIN.profile);
    privateFixtureDirectory(profile);
    writeFileSync(join(profile, "SOUL.md"), "# retained until stopped\n");
    const { trackSandboxedChild, stopSandboxedChildren, workerLaunchesHeld } = await import("./worker-network-sandbox.ts");
    const child = trackSandboxedChild(spawn(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000);"], { detached: true, stdio: ["ignore", "pipe", "ignore"] }));
    const kill = process.kill.bind(process);
    let restoreKill = () => {};
    try {
      await once(child.stdout!, "data");
      const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -child.pid!) throw Object.assign(new Error("owned group cannot be confirmed"), { code: "EPERM" });
        return kill(pid, signal);
      });
      restoreKill = () => spy.mockRestore();
      await expect(stopSandboxedChildren(30)).rejects.toThrow("worker processes have not stopped");
      await expect(uninstallWorker({ root: home, dataDir: data })).rejects.toMatchObject({ status: 409, code: "worker_cleanup_unproven" });
      expect(readFileSync(join(profile, "SOUL.md"), "utf8")).toBe("# retained until stopped\n");
      expect(workerLaunchesHeld()).toBe(false);
      expect(kill(child.pid!, 0)).toBe(true);
      restoreKill(); restoreKill = () => {};
      await stopSandboxedChildren(100);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(() => kill(-child.pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      await expect(uninstallWorker({ root: home, dataDir: data })).rejects.toMatchObject({ status: 409, code: "worker_cleanup_unproven" });
      expect(readFileSync(join(profile, "SOUL.md"), "utf8")).toBe("# retained until stopped\n");
    } finally {
      restoreKill();
      try { kill(-child.pid!, "SIGKILL"); } catch { /* owned worker already stopped */ }
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
      await stopSandboxedChildren(100);
    }
  });

  it.skipIf(process.platform === "win32")("does not interrupt a running worker merely to refuse unavailable removal", async () => {
    const home = tempDir("realbud-life-home-");
    const data = tempDir("realbud-life-data-");
    const profile = join(home, "profiles", HERMES_PIN.profile);
    privateFixtureDirectory(profile);
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    const { trackSandboxedChild, stopSandboxedChildren, workerLaunchesHeld } = await import("./worker-network-sandbox.ts");
    const child = trackSandboxedChild(spawn(process.execPath, ["-e", "console.log('ready');setTimeout(()=>{},30000);"], { detached: true, stdio: ["ignore", "pipe", "ignore"] }));
    const stopWorkers = vi.fn(async () => { await stopSandboxedChildren(100); });
    try {
      await once(child.stdout!, "data");
      await Promise.all([0, 1].map(async () => {
        await expect(uninstallWorker({ root: home, dataDir: data, stopWorkers })).rejects.toMatchObject({ status: 409, code: "worker_cleanup_unproven" });
      }));
      expect(stopWorkers).not.toHaveBeenCalled();
      expect(workerLaunchesHeld()).toBe(false);
      expect(process.kill(child.pid!, 0)).toBe(true);
      expect(readFileSync(join(profile, "SOUL.md"), "utf8")).toBe("# RealBud\n");
    } finally { await stopSandboxedChildren(100); }
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("keeps the profile, stamps, shared runtime and unrelated data unchanged", async () => {
    const home = tempDir("realbud-life-home-");
    const data = tempDir("realbud-life-data-");
    const agent = join(home, "hermes-agent");
    const profile = join(home, "profiles", HERMES_PIN.profile);
    mkdirSync(join(agent, "bin"), { recursive: true });
    privateFixtureDirectory(profile);
    mkdirSync(join(home, "profiles", "personal"), { recursive: true });
    mkdirSync(join(data, "vault", "properties"), { recursive: true });
    writeFileSync(join(agent, "bin", "hermes"), "#!/bin/sh\n");
    writeFileSync(join(profile, "SOUL.md"), "# RealBud\n");
    writeFileSync(join(home, "profiles", "personal", "SOUL.md"), "keep-me");
    writeFileSync(join(home, ".env"), "PERSONAL=1\n");
    writeFileSync(join(home, "auth.json"), '{"token":"personal"}');
    writeFileSync(join(data, "config.json"), '{"ok":true}');
    writeFileSync(join(data, "channel.json"), '{"telegram":true}');
    writeFileSync(join(data, "desk.json"), '{"book":true}');
    writeFileSync(join(data, "vault", "properties", "12-river.md"), "# 12 River\n");
    writeFileSync(join(data, "hands-ping.json"), '{"at":1,"ok":true,"detail":"ok","kind":"ping"}');
    writeFileSync(join(data, "hands-last.json"), '{"at":1,"ok":true,"detail":"ok","kind":"ping"}');

    await expect(uninstallWorker({ root: home, dataDir: data })).rejects.toMatchObject({
      status: 409, code: "worker_cleanup_unproven", message: expect.stringMatching(/setup has been kept.*Use Repair/),
    });
    expect(existsSync(agent)).toBe(true);
    expect(readFileSync(join(agent, "bin", "hermes"), "utf8")).toBe("#!/bin/sh\n");
    expect(readFileSync(join(profile, "SOUL.md"), "utf8")).toBe("# RealBud\n");
    expect(readFileSync(join(data, "hands-ping.json"), "utf8")).toBe('{"at":1,"ok":true,"detail":"ok","kind":"ping"}');
    expect(readFileSync(join(data, "hands-last.json"), "utf8")).toBe('{"at":1,"ok":true,"detail":"ok","kind":"ping"}');
    expect(readFileSync(join(home, ".env"), "utf8")).toContain("PERSONAL=1");
    expect(readFileSync(join(home, "auth.json"), "utf8")).toContain("personal");
    expect(readFileSync(join(home, "profiles", "personal", "SOUL.md"), "utf8")).toBe("keep-me");
    expect(readFileSync(join(data, "config.json"), "utf8")).toContain("ok");
    expect(readFileSync(join(data, "channel.json"), "utf8")).toContain("telegram");
    expect(readFileSync(join(data, "desk.json"), "utf8")).toContain("book");
    expect(readFileSync(join(data, "vault", "properties", "12-river.md"), "utf8")).toContain("12 River");
  });

  it.skipIf(process.platform !== "darwin" || process.env.REALBUD_TEST_SANDBOX !== "1")("refuses removal after real sandbox drain leaves a separately detached descendant alive", async () => {
    const home = tempDir("realbud-life-detached-home-");
    const data = tempDir("realbud-life-detached-data-");
    const profile = join(home, "profiles", HERMES_PIN.profile);
    privateFixtureDirectory(profile);
    const file = join(profile, "SOUL.md"), stamp = join(data, "hands-ping.json");
    writeFileSync(file, "# Fictional profile retained\n");
    writeFileSync(stamp, '{"fictional":"retained"}');
    const before = [readFileSync(file), readFileSync(stamp)];
    const { sandboxedLaunch, trackSandboxedChild, stopSandboxedChildren } = await import("./worker-network-sandbox.ts");
    const descendantCode = "process.on('SIGTERM',()=>{});console.log('ready');setTimeout(()=>process.exit(),30000);";
    const parentCode = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{detached:true,stdio:['ignore','pipe','ignore']});child.stdout.once('data',()=>console.log(child.pid));setTimeout(()=>process.exit(),30000);`;
    const env = { PATH: "/usr/bin:/bin", HOME: home, LANG: "C" };
    const launch = sandboxedLaunch(process.execPath, ["-e", parentCode], env, { loopbackPorts: [], writable: [] });
    const child = trackSandboxedChild(spawn(launch.command, launch.args, { env, detached: true, stdio: ["ignore", "pipe", "ignore"] }));
    let descendant: number | undefined;
    const alive = (pid: number) => {
      try { process.kill(pid, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
    };
    try {
      const [output] = await once(child.stdout!, "data", { signal: AbortSignal.timeout(5000) });
      descendant = Number(String(output).trim());
      expect(Number.isSafeInteger(descendant) && descendant > 1).toBe(true);
      await stopSandboxedChildren(300);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(alive(descendant)).toBe(true);
      await expect(uninstallWorker({ root: home, dataDir: data })).rejects.toMatchObject({ status: 409, code: "worker_cleanup_unproven" });
      expect([readFileSync(file), readFileSync(stamp)]).toEqual(before);
      expect(alive(descendant)).toBe(true);
    } finally {
      if (descendant && Number.isSafeInteger(descendant) && descendant > 1) {
        try { process.kill(descendant, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
      await stopSandboxedChildren(100);
      if (descendant && Number.isSafeInteger(descendant) && descendant > 1) {
        for (let n = 0; alive(descendant) && n < 100; n++) await new Promise(resolve => setTimeout(resolve, 20));
        expect(alive(descendant)).toBe(false);
      }
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      launch.release();
    }
  });

  it("refuses a path that resolves outside the worker home", async () => {
    const home = tempDir("realbud-life-guard-");
    const data = tempDir("realbud-life-guard-data-");
    const outside = tempDir("realbud-life-outside-");
    const profile = join(home, "profiles", HERMES_PIN.profile);
    privateFixtureDirectory(profile);
    writeFileSync(join(profile, "SOUL.md"), "# keep\n");
    writeFileSync(join(outside, "precious.txt"), "do-not-delete");
    writeFileSync(join(data, "config.json"), '{"ok":true}');

    await expect(uninstallWorker({ root: home, dataDir: data, agentDir: outside })).rejects.toMatchObject({
      message: expect.stringMatching(/outside the worker home/),
      status: 400,
    });
    expect(existsSync(join(outside, "precious.txt"))).toBe(true);
    expect(existsSync(join(profile, "SOUL.md"))).toBe(true);
    expect(readFileSync(join(data, "config.json"), "utf8")).toContain("ok");
  });
});

describe("repairExistingProfile", WINDOWS_PROFILE_TEST_OPTIONS, () => {
  it("repairs the property pack without replacing an independent 0.21 runtime or model", async () => {
    const home = tempDir("realbud-repair-profile-");
    const profile = join(home, "profiles", HERMES_PIN.profile);
    const agent = join(home, "hermes-agent");
    privateFixtureDirectory(profile);
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, "keep.txt"), "independent runtime");
    writePrivateFixtureFile(join(profile, "config.yaml"), "model:\n  default: fixture-model\n");
    writePrivateFixtureFile(join(profile, ".env"), "FIXTURE_KEY=keep-this-fixture\n");
    const cli = fakeHermesVersion("Hermes Agent v0.21.0 (2026.8.31)");
    dirs.push(dirname(cli));
    const status = await repairExistingProfile({ root: home, cli });
    expect(status?.cli).toMatchObject({ compatible: true, matchesPin: false });
    expect(status?.pack.workroomReady).toBe(true);
    expect(readFileSync(join(agent, "keep.txt"), "utf8")).toBe("independent runtime");
    expect(readFileSync(join(profile, "config.yaml"), "utf8")).toContain("fixture-model");
    expect(readFileSync(join(profile, ".env"), "utf8")).toContain("keep-this-fixture");
  });

  it("adds document tools during Repair and says when they still need it", async () => {
    const home = tempDir("realbud-repair-documents-");
    privateFixtureDirectory(join(home, "profiles", HERMES_PIN.profile));
    const cli = fakeHermesVersion("Hermes Agent v0.21.0 (2026.8.31)");
    dirs.push(dirname(cli));
    const roots: (string | undefined)[] = [];
    const ready = await repairExistingProfile({ root: home, cli, documentDeps: async root => { roots.push(root); return null; } });
    expect(roots).toEqual([home]);
    expect(ready?.detail).not.toContain("Document tools");
    const missing = await repairExistingProfile({ root: home, cli, documentDeps: async () => "Document tools need Repair. Couldn’t download document tools." });
    expect(missing?.pack.workroomReady).toBe(true);
    expect(missing?.detail).toMatch(/Document tools need Repair\. Couldn’t download document tools\.$/);
  });

  it("holds an unknown release without altering its profile", async () => {
    const home = tempDir("realbud-repair-unsupported-");
    const profile = join(home, "profiles", HERMES_PIN.profile);
    privateFixtureDirectory(profile);
    writePrivateFixtureFile(join(profile, "config.yaml"), "keep this unchanged");
    const cli = fakeHermesVersion("Hermes Agent v0.22.0 (2026.9.9)");
    dirs.push(dirname(cli));
    await expect(repairExistingProfile({ root: home, cli })).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(join(profile, "config.yaml"), "utf8")).toBe("keep this unchanged");
  });

  it.skipIf(process.platform === "win32")("re-checks the selected runtime in full at every Repair and never repairs a damaged one in place", async () => {
    const home = tempDir("realbud-repair-integrity-");
    const profile = join(home, "profiles", HERMES_PIN.profile);
    privateFixtureDirectory(profile);
    const id = `${HERMES_RECOMMENDED.commit}-aaaaaaaaaaaa`, cli = runtimeCli(releaseHome(home, id));
    const version = `Hermes Agent v${HERMES_RECOMMENDED.product} (${HERMES_RECOMMENDED.tag.slice(1)})`;
    mkdirSync(dirname(cli), { recursive: true }); writeFileSync(cli, `#!/bin/sh\necho '${version}'\n`); chmodSync(cli, 0o755);
    saveRuntimeSelection(home, { version: 1, selected: id, previous: null });
    const verify = vi.fn(async () => version);
    const options = { root: home, cli, verifyRuntime: verify, documentDeps: async () => null };
    expect(await repairExistingProfile(options)).toMatchObject({ runtimeIntegrity: "ok", cli: { compatible: true } });
    await repairExistingProfile(options);
    expect(verify).toHaveBeenCalledTimes(2);
    const config = readFileSync(join(profile, "config.yaml"), "utf8");
    writePrivateFixtureFile(join(profile, "config.yaml"), `${config}# fictional office edit\n`);
    const refuse = vi.fn(async () => { throw new Error("fictional modified source files"); });
    await expect(repairExistingProfile({ ...options, verifyRuntime: refuse })).rejects.toMatchObject({ status: 409, code: "worker_runtime_damaged" });
    expect(readFileSync(join(profile, "config.yaml"), "utf8")).toBe(`${config}# fictional office edit\n`);
    expect(readFileSync(cli, "utf8")).toContain(version);
  });

  it("returns 409 while an install job is running", async () => {
    const waiting: typeof runWorkerBootstrap = async options => {
      await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
      options.signal.throwIfAborted();
    };
    startBootstrapInstall({ run: waiting });
    try {
      expect(installInFlight()).toBe(true);
      await expect(repairExistingProfile()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/already running/) });
      await expect(uninstallWorker()).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Let Bud setup finish/) });
    } finally {
      cancelBootstrapInstall();
      await waitForBootstrapStop();
    }
  });
});
