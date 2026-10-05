import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fresh module instance stands in for a restarted server process.
const restart = async () => { vi.resetModules(); return { custody: await import("./worker-custody.ts"), sandbox: await import("./worker-network-sandbox.ts") }; };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } };
async function waitGone(pid: number) { for (let i = 0; i < 100 && !gone(pid); i++) await pause(20); expect(gone(pid)).toBe(true); }
const owned: ChildProcess[] = [];
const ownedPids: number[] = [];
let dataDir: string;
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "realbud-custody-")); vi.stubEnv("REALBUD_DATA_DIR", dataDir); });
afterEach(() => {
  for (const pid of ownedPids.splice(0)) { try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch { /* already gone */ } }
  for (const child of owned.splice(0)) child.kill("SIGKILL");
  vi.unstubAllEnvs();
});
function idleWorker(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { stdio: "ignore", detached: process.platform !== "win32" });
  owned.push(child); ownedPids.push(child.pid!);
  return child;
}
const launch = (sandbox: typeof import("./worker-network-sandbox.ts")) => sandbox.sandboxedLaunch(process.execPath, ["-e", ""], {}, { loopbackPorts: [], writable: [] }, { platform: "linux" });

describe("durable worker custody across restart", () => {
  it("holds new launches while a group from an earlier run is alive, and releases it once confirmed gone", async () => {
    const worker = idleWorker();
    const before = await restart();
    before.custody.recordWorkerCustody(worker.pid!);
    // This run's own live worker never blocks its own launches.
    expect(before.custody.workerCustodyRefusal()).toBeNull();
    expect(() => launch(before.sandbox)).not.toThrow();

    const after = await restart();
    expect(after.custody.workerCustodyRefusal()).toBe(after.custody.WORKER_CUSTODY_HELD);
    expect(() => launch(after.sandbox)).toThrow(after.custody.WORKER_CUSTODY_HELD);
    worker.kill("SIGKILL"); await waitGone(worker.pid!);
    expect(after.custody.workerCustodyRefusal()).toBeNull();
    expect(JSON.parse(readFileSync(join(dataDir, "worker-custody.json"), "utf8")).entries).toEqual([]);
    expect((await restart()).custody.workerCustodyRefusal()).toBeNull();
  });

  it("forgets a group only after its stop is confirmed", async () => {
    const worker = idleWorker();
    const before = await restart();
    before.custody.recordWorkerCustody(worker.pid!);
    before.custody.releaseWorkerCustody(worker.pid!);
    expect((await restart()).custody.workerCustodyRefusal()).toBeNull();
  });

  it("lets a person release a hold, but never clears a damaged record", async () => {
    const worker = idleWorker();
    (await restart()).custody.recordWorkerCustody(worker.pid!);
    const after = await restart();
    expect(after.custody.workerCustodyRefusal()).toBe(after.custody.WORKER_CUSTODY_HELD);
    after.custody.resolveWorkerCustody();
    expect(after.custody.workerCustodyRefusal()).toBeNull();
    expect((await restart()).custody.workerCustodyRefusal()).toBeNull();

    const file = join(dataDir, "worker-custody.json");
    writeFileSync(file, "{not json"); if (process.platform !== "win32") chmodSync(file, 0o600);
    const damaged = await restart();
    expect(damaged.custody.workerCustodyRefusal()).toBe(damaged.custody.WORKER_CUSTODY_DAMAGED);
    expect(() => damaged.custody.resolveWorkerCustody()).toThrow(/needs recovery/);
    damaged.custody.recordWorkerCustody(worker.pid!);
    expect(readFileSync(file, "utf8")).toBe("{not json");
  });

  it("fails closed when custody cannot be saved, and recovers once a save lands", async () => {
    let full = true;
    vi.doMock("./atomic.ts", async original => {
      const real = await original<typeof import("./atomic.ts")>();
      return { ...real, writeFileAtomic: (...args: Parameters<typeof real.writeFileAtomic>) => {
        if (full) throw Object.assign(new Error("fictional full disk"), { code: "ENOSPC" });
        real.writeFileAtomic(...args);
      } };
    });
    try {
      const { custody, sandbox } = await restart();
      custody.recordWorkerCustody(idleWorker().pid!);
      expect(() => launch(sandbox)).toThrow(custody.WORKER_CUSTODY_UNSAVED);
      full = false;
      expect(() => launch(sandbox)).not.toThrow();
    } finally { vi.doUnmock("./atomic.ts"); }
  });
});

// Native POSIX evidence: a real owner process dies while its tracked worker
// group lives on. Windows checks the Job Object supervisor instead, whose
// parent-death cleanup is proved in worker-supervisor.native.test.ts.
describe.skipIf(process.platform === "win32")("native: parent dies, descendant survives", () => {
  it("refuses overlapping work after restart until the whole group has stopped", async () => {
    const tree = `const {spawn}=require('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},100)'],{stdio:'ignore'});
child.once('spawn',()=>console.log(JSON.stringify({leader:process.pid,descendant:child.pid})));
setInterval(()=>{},100);`;
    const owner = `import { spawn } from 'node:child_process';
const { trackSandboxedChild } = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "worker-network-sandbox.ts")).href)});
const leader = trackSandboxedChild(spawn(process.execPath, ['-e', ${JSON.stringify(tree)}], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] }));
leader.stdout.on('data', chunk => process.stdout.write(chunk));
setInterval(() => {}, 100);`;
    const parent = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", owner], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, REALBUD_DATA_DIR: dataDir } });
    owned.push(parent);
    const pids = await new Promise<{ leader: number; descendant: number }>((resolve, reject) => {
      let output = ""; const cap = setTimeout(() => reject(new Error("owner fixture did not become ready")), 8_000);
      parent.stdout!.on("data", chunk => { output += String(chunk); if (output.includes("\n")) { clearTimeout(cap); resolve(JSON.parse(output.split("\n")[0])); } });
      parent.once("exit", code => { clearTimeout(cap); reject(new Error(`owner fixture exited: ${code}`)); });
    });
    ownedPids.push(pids.leader);
    parent.kill("SIGKILL"); await waitGone(parent.pid!);
    expect(gone(pids.leader) || gone(pids.descendant)).toBe(false);

    const { custody, sandbox } = await restart();
    expect(() => launch(sandbox)).toThrow(custody.WORKER_CUSTODY_HELD);
    // Leader exit is not proof: the descendant keeps the group alive.
    process.kill(pids.leader, "SIGKILL"); await waitGone(pids.leader);
    expect(() => launch(sandbox)).toThrow(custody.WORKER_CUSTODY_HELD);
    process.kill(pids.descendant, "SIGKILL"); await waitGone(pids.descendant);
    expect(() => launch(sandbox)).not.toThrow();
  }, 15_000);
});
