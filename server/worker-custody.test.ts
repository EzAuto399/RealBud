import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fresh module instance stands in for a restarted server process; any
// removal the old instance had queued and not finished is lost, as in a crash.
type Custody = typeof import("./worker-custody.ts");
const restart = async () => { vi.resetModules(); return { custody: await import("./worker-custody.ts") as Custody, sandbox: await import("./worker-network-sandbox.ts") }; };
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } };
async function waitGone(pid: number) { for (let i = 0; i < 100 && !gone(pid); i++) await pause(20); expect(gone(pid)).toBe(true); }
const owned: ChildProcess[] = [];
const ownedPids: number[] = [];
let dataDir: string;
const records = () => { try { return readdirSync(join(dataDir, "worker-custody")).filter(name => name.endsWith(".json")); } catch { return []; } };
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
const failure = () => Object.assign(new Error("fictional full disk"), { code: "ENOSPC" });

describe("durable worker custody across restart", () => {
  it("holds new launches while a group from an earlier run is alive, and releases it once confirmed gone", async () => {
    const worker = idleWorker();
    const before = await restart();
    expect(before.custody.recordWorkerCustody(worker.pid!)).toBe(true);
    // This run's own live worker never blocks its own launches.
    expect(before.custody.workerCustodyRefusal()).toBeNull();
    expect(() => launch(before.sandbox)).toThrow(before.sandbox.WORKER_PLATFORM_HELD);

    const after = await restart();
    expect(() => launch(after.sandbox)).toThrow(after.custody.WORKER_CUSTODY_HELD);
    worker.kill("SIGKILL"); await waitGone(worker.pid!);
    expect(after.custody.workerCustodyRefusal()).toBeNull();
    await pause(50);
    expect(records()).toEqual([]);
    expect((await restart()).custody.workerCustodyRefusal()).toBeNull();
  });

  it("(a) the record is durable before the tracker returns; an unsaved worker is stopped and launches are held", async () => {
    const { custody, sandbox } = await restart();
    const tracked = sandbox.trackSandboxedChild(spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { stdio: "ignore", detached: process.platform !== "win32" }));
    owned.push(tracked); ownedPids.push(tracked.pid!);
    expect(records()).toEqual([expect.stringMatching(new RegExp(`-${tracked.pid}\\.json$`))]);

    const create = custody.custodyIo.create;
    custody.custodyIo.create = () => { throw failure(); };
    const unsaved = sandbox.trackSandboxedChild(spawn(process.execPath, ["-e", "setInterval(()=>{},100)"], { stdio: "ignore", detached: process.platform !== "win32" }));
    owned.push(unsaved); ownedPids.push(unsaved.pid!);
    await waitGone(unsaved.pid!);
    expect(() => launch(sandbox)).toThrow(custody.WORKER_CUSTODY_UNSAVED);
    custody.custodyIo.create = create;
    expect(custody.workerCustodyRefusal()).toBeNull();
    expect(() => launch(sandbox)).toThrow(sandbox.WORKER_PLATFORM_HELD);
  });

  it("(b) writes the release only after the stop is confirmed", async () => {
    const { custody, sandbox } = await restart();
    const stubborn = sandbox.trackSandboxedChild(spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},100)"], { stdio: "ignore", detached: process.platform !== "win32" }));
    owned.push(stubborn); ownedPids.push(stubborn.pid!);
    await pause(200);
    const removedWhileAlive: boolean[] = [];
    const remove = custody.custodyIo.remove;
    custody.custodyIo.remove = path => { removedWhileAlive.push(!gone(stubborn.pid!)); return remove(path); };
    await sandbox.stopSandboxedChildren(300);
    await pause(50);
    expect(removedWhileAlive).toEqual([false]);
    expect(records()).toEqual([]);
  });

  it("(c) a failed save keeps the record and the hold, and surfaces a repair state until it lands", async () => {
    const worker = idleWorker();
    const { custody, sandbox } = await restart();
    custody.recordWorkerCustody(worker.pid!);
    const { create, remove } = custody.custodyIo;
    custody.custodyIo.remove = () => Promise.reject(failure());
    custody.custodyIo.create = () => { throw failure(); };
    await custody.releaseWorkerCustody(worker.pid!);
    expect(records()).toHaveLength(1);
    expect(() => launch(sandbox)).toThrow(custody.WORKER_CUSTODY_UNSAVED);
    expect(() => launch(sandbox)).toThrow(custody.WORKER_CUSTODY_UNSAVED);
    expect(records()).toHaveLength(1);
    custody.custodyIo.create = create; custody.custodyIo.remove = remove;
    expect(custody.workerCustodyRefusal()).toBeNull();
    expect(() => launch(sandbox)).toThrow(sandbox.WORKER_PLATFORM_HELD);
    expect(records()).toEqual([]);
  });

  it("(d) a crash between a queued release and its write leaves the group held", async () => {
    const worker = idleWorker();
    const before = await restart();
    before.custody.recordWorkerCustody(worker.pid!);
    before.custody.custodyIo.remove = () => new Promise(() => {});
    void before.custody.releaseWorkerCustody(worker.pid!);
    const after = await restart();
    expect(() => launch(after.sandbox)).toThrow(after.custody.WORKER_CUSTODY_HELD);
  });

  it("lets a person release a hold, but never clears a damaged record", async () => {
    const worker = idleWorker();
    (await restart()).custody.recordWorkerCustody(worker.pid!);
    const after = await restart();
    expect(after.custody.workerCustodyRefusal()).toBe(after.custody.WORKER_CUSTODY_HELD);
    await after.custody.resolveWorkerCustody();
    expect(after.custody.workerCustodyRefusal()).toBeNull();
    expect((await restart()).custody.workerCustodyRefusal()).toBeNull();

    mkdirSync(join(dataDir, "worker-custody"), { recursive: true });
    const file = join(dataDir, "worker-custody", "fictional-1.json");
    writeFileSync(file, "{not json"); if (process.platform !== "win32") chmodSync(file, 0o600);
    const damaged = await restart();
    expect(damaged.custody.workerCustodyRefusal()).toBe(damaged.custody.WORKER_CUSTODY_DAMAGED);
    await expect(damaged.custody.resolveWorkerCustody()).rejects.toThrow(/needs recovery/);
    expect(existsSync(file) && readFileSync(file, "utf8")).toBe("{not json");
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
    expect(custody.workerCustodyRefusal()).toBeNull();
    expect(() => launch(sandbox)).toThrow(sandbox.WORKER_PLATFORM_HELD);
  }, 15_000);
});
