import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runOneShot, windowsWorkerSupervisor, WINDOWS_WORKER_SUPERVISOR, type OneShotDependencies, type OneShotOptions } from "./one-shot-process.ts";

type Result = { error: (Error & { code?: string | number; killed?: boolean; cleanupUnconfirmed?: boolean }) | null; stdout: string; stderr: string };
class FakeChild extends EventEmitter {
  pid: number | undefined = 123;
  stdin = new PassThrough(); stdout = new PassThrough(); stderr = new PassThrough();
  kill = vi.fn(() => true); unref = vi.fn();
  complete(code = 0) { this.emit("exit", code, null); this.stdout.destroy(); this.stderr.destroy(); this.emit("close", code, null); }
}
function fakeRun(options: OneShotOptions = {}, extra: OneShotDependencies = {}) {
  const child = new FakeChild(), callback = vi.fn();
  const spawnChild = vi.fn((_command: string, _args: string[], _options: SpawnOptions) => child as unknown as ChildProcess);
  runOneShot("C:\\fictional\\node.exe", ["fictional argument"], options, callback, {
    platform: "win32", spawn: spawnChild as unknown as typeof spawn, supervisor: () => "C:\\fictional\\RealBud Worker.exe", ...extra,
  });
  return { child, callback, spawnChild };
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function capture(source: string, options: OneShotOptions = {}, args: string[] = []): Promise<Result> {
  return new Promise(resolve => runOneShot(process.execPath, ["-e", source, "--", ...args], { timeout: 4_000, ...options },
    (error, stdout, stderr) => resolve({ error, stdout, stderr })));
}
async function expectGone(pid: number) {
  let alive = true;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") { alive = false; break; } throw error; }
    await pause(20);
  }
  if (alive) try { process.kill(pid, "SIGKILL"); } catch { /* fixture already exited */ }
  expect(alive, `fixture process ${pid} survived containment`).toBe(false);
}
const tree = `
  const {spawn} = require('node:child_process');
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 100); setTimeout(() => process.exit(77), 15000);'], {stdio: ['ignore', 'inherit', 'inherit']});
  descendant.once('spawn', () => {
    console.log(JSON.stringify({leader: process.pid, descendant: descendant.pid}));
    FIXTURE_ACTION
  });
`;
function treePids(stdout: string): { leader: number; descendant: number } {
  return JSON.parse(stdout.split("\n")[0]);
}

afterEach(() => { vi.useRealTimers(); });

describe("one-shot lifecycle ordering", () => {
  it("owns the deadline without closing output before containment starts", async () => {
    vi.useFakeTimers();
    const { child, callback, spawnChild } = fakeRun({ timeout: 100, env: { FICTIONAL_VALUE: "unchanged" } });
    child.stdout.write("before\n");
    child.kill.mockImplementation(() => {
      expect(child.stdout.destroyed).toBe(false); expect(child.stderr.destroyed).toBe(false);
      child.stdout.write("after\n"); return true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(spawnChild.mock.calls[0]).toEqual(["C:\\fictional\\RealBud Worker.exe", ["--", "C:\\fictional\\node.exe", "fictional argument"], {
      cwd: undefined, env: { FICTIONAL_VALUE: "unchanged" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false, shell: false,
    }]);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(callback).not.toHaveBeenCalled();
    child.complete(); await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "ETIMEDOUT", killed: true }), "before\nafter\n", "");
  });

  it("never turns accepted timeout into success when the leader exits zero", async () => {
    vi.useFakeTimers();
    const { child, callback } = fakeRun({ timeout: 100 });
    await vi.advanceTimersByTimeAsync(100);
    child.stdout.write('{"looks":"valid but partial"}');
    child.complete(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ killed: true, code: "ETIMEDOUT" }), '{"looks":"valid but partial"}', "");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it.each([0, 100])("bounds inherited output after the supervisor has exited (timeout %i)", async timeout => {
    vi.useFakeTimers();
    const { child, callback } = fakeRun({ timeout }, { cleanupMs: 200 });
    child.stdout.write("partial"); child.emit("exit", 0, null);
    await vi.advanceTimersByTimeAsync(201);
    expect(callback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ killed: true, cleanupUnconfirmed: true }), "partial", "");
    expect(child.kill).not.toHaveBeenCalled();
    child.complete(); await vi.advanceTimersByTimeAsync(1_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("preserves ordinary zero exit and ignores a closing liveness pipe", async () => {
    vi.useFakeTimers();
    const { child, callback } = fakeRun({ timeout: 100 });
    child.stdin.emit("error", Object.assign(new Error("closed"), { code: "EPIPE" }));
    child.stdout.write("answer"); child.complete(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, "answer", "");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("settles exactly once when supervisor termination is refused", async () => {
    vi.useFakeTimers();
    const { child, callback } = fakeRun({ timeout: 100 }, { cleanupMs: 200 });
    child.kill.mockReturnValue(false);
    await vi.advanceTimersByTimeAsync(301);
    expect(callback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "ETIMEDOUT", killed: true, cleanupUnconfirmed: true }), "", "");
    expect(child.unref).toHaveBeenCalledTimes(1); expect(child.stdout.destroyed).toBe(true);
    child.complete(); await vi.advanceTimersByTimeAsync(1_000);
    expect(callback).toHaveBeenCalledTimes(1); expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("retains the original asynchronous spawn error object", async () => {
    vi.useFakeTimers();
    const { child, callback } = fakeRun(); child.pid = undefined;
    const original = Object.assign(new Error("fictional failure"), { code: "EACCES" });
    child.emit("error", original); child.complete();
    await vi.advanceTimersByTimeAsync(10);
    expect(callback).toHaveBeenCalledExactlyOnceWith(original, "", "");
  });

  it("escalates an owned POSIX group after leader exit and confirms group disappearance", async () => {
    vi.useFakeTimers(); let exists = true;
    const groupSignal = vi.fn((_pid: number, signal: NodeJS.Signals | 0) => {
      if (!exists) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (signal === "SIGKILL") exists = false;
    });
    const { child, callback, spawnChild } = fakeRun({}, { platform: "darwin", groupSignal, graceMs: 40 });
    child.complete(); await vi.advanceTimersByTimeAsync(80);
    expect(spawnChild.mock.calls[0]?.[2]).toMatchObject({ detached: true });
    expect(groupSignal).toHaveBeenCalledWith(123, "SIGTERM"); expect(groupSignal).toHaveBeenCalledWith(123, "SIGKILL");
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, "", "");
  });

  it("preserves split UTF-8 and applies maxBuffer independently to each stream", async () => {
    vi.useFakeTimers();
    const { child, callback } = fakeRun({ maxBuffer: 4 }); const bytes = Buffer.from("😀");
    child.stdout.write(bytes.subarray(0, 2)); child.stdout.write(bytes.subarray(2)); child.stderr.write("1234");
    child.complete(); await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledExactlyOnceWith(null, "😀", "1234");
  });

  it("latches the first maxBuffer failure, bounds capture and keeps draining", async () => {
    vi.useFakeTimers(); const { child, callback } = fakeRun({ maxBuffer: 4, timeout: 100 });
    child.stdout.write("123456"); child.stdout.write("789"); child.stderr.write("ok");
    await vi.advanceTimersByTimeAsync(100); child.complete(); await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true }), "1234", "ok");
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("pre-aborted and unresolvable Windows work never spawns", async () => {
    const controller = new AbortController(); controller.abort();
    const callback = vi.fn(), spawnChild = vi.fn();
    expect(runOneShot("C:\\fictional\\node.exe", [], { signal: controller.signal }, callback, { platform: "win32", spawn: spawnChild as typeof spawn })).toBeNull();
    await Promise.resolve(); expect(callback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: "AbortError", code: "ABORT_ERR", killed: true }), "", "");
    callback.mockClear();
    expect(runOneShot("missing-worker", [], {}, callback, { platform: "win32", spawn: spawnChild as typeof spawn })).toBeNull();
    await Promise.resolve(); expect(callback).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: "ENOENT" }), "", "");
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it.each([-1, 0.5, Infinity, NaN])("rejects invalid timeout %s before spawning", timeout => {
    expect(() => fakeRun({ timeout })).toThrow(expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }));
  });
});

describe("supervisor resolution", () => {
  it.each(["source", "compiled checkout", "installed", "Electron-as-Node"])("resolves %s without treating a UI directory as executable authority", layout => {
    const directory = mkdtempSync(join(tmpdir(), "realbud-worker-layout-"));
    try {
      const developer = layout === "source" || layout === "compiled checkout";
      const modulePath = join(directory, ...(layout === "source" ? ["server", "one-shot-process.ts"] : layout === "compiled checkout" ? ["dist-server", "server", "one-shot-process.js"] : ["resources", "server", "one-shot-process.js"]));
      const resources = developer ? join(directory, "electron", "resources") : join(directory, "resources");
      mkdirSync(resources, { recursive: true });
      writeFileSync(join(resources, WINDOWS_WORKER_SUPERVISOR), "fictional executable fixture");
      const location = { modulePath, ...(layout === "installed" ? { resourcesPath: resources } : {}) };
      expect(windowsWorkerSupervisor({ OMB_STATIC_DIR: join(directory, "fictional-ui") }, location)).toBe(join(resources, WINDOWS_WORKER_SUPERVISOR));
      expect(() => windowsWorkerSupervisor({ REALBUD_RESOURCES_DIR: join(directory, "missing-explicit-resources") }, location)).toThrow(expect.objectContaining({ code: "ERR_WORKER_SUPERVISOR_UNAVAILABLE" }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("does not use a checkout helper when the installed copy is missing", () => {
    const directory = mkdtempSync(join(tmpdir(), "realbud-worker-no-fallback-"));
    try {
      const resources = join(directory, "electron", "resources"); mkdirSync(resources, { recursive: true });
      writeFileSync(join(resources, WINDOWS_WORKER_SUPERVISOR), "fictional executable fixture");
      expect(() => windowsWorkerSupervisor({}, { modulePath: join(directory, "resources", "server", "one-shot-process.js") })).toThrow(expect.objectContaining({ code: "ERR_WORKER_SUPERVISOR_UNAVAILABLE" }));
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it("fails closed for missing packaged resources and accepts only the fixed regular file", () => {
    const directory = mkdtempSync(join(tmpdir(), "realbud-worker-resource-"));
    try {
      expect(() => windowsWorkerSupervisor({ REALBUD_RESOURCES_DIR: directory })).toThrow(expect.objectContaining({ code: "ERR_WORKER_SUPERVISOR_UNAVAILABLE" }));
      const path = join(directory, WINDOWS_WORKER_SUPERVISOR); writeFileSync(path, "fictional executable fixture");
      expect(windowsWorkerSupervisor({ REALBUD_RESOURCES_DIR: directory })).toBe(path);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});

describe("real contained one-shot processes (native host)", () => {
  it("preserves exact argv, Unicode, cwd, env, both streams and nonzero exit", async () => {
    const args = ["", "space inside", 'quote"inside', "backslash\\", 'mixed\\\\\"quote', "line\nbreak", "文字😀", "&|<>^%!"];
    const result = await capture("console.log(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),value:process.env.FICTIONAL_VALUE})); console.error('fictional stderr'); process.exitCode=23;", {
      cwd: process.cwd(), env: { ...process.env, FICTIONAL_VALUE: "fictional-value" },
    }, args);
    expect(result.error).toMatchObject({ code: 23, killed: false });
    expect(JSON.parse(result.stdout)).toEqual({ args, cwd: process.cwd(), value: "fictional-value" });
    expect(result.stderr).toBe("fictional stderr\n");
  });

  it("gives the worker empty stdin", async () => {
    const result = await capture("let data=''; process.stdin.on('data',chunk=>data+=chunk); process.stdin.on('end',()=>console.log(JSON.stringify({data,pid:process.pid}))); process.stdin.resume();");
    expect(result.error).toBeNull(); expect(JSON.parse(result.stdout).data).toBe("");
  });

  it("reaps a descendant holding inherited pipes when its leader exits before the deadline", async () => {
    const started = Date.now();
    const result = await capture(tree.replace("FIXTURE_ACTION", "process.exit(0);"), { timeout: 3_000 });
    const pids = treePids(result.stdout);
    await expectGone(pids.descendant); await expectGone(pids.leader);
    expect(result.error).toBeNull(); expect(Date.now() - started).toBeLessThan(3_000);
  }, 8_000);

  it("times out an active writer without inducing EPIPE before tree termination", async () => {
    const result = await capture(tree.replace("FIXTURE_ACTION", "process.stdout.on('error',()=>process.exit(0)); setInterval(()=>process.stdout.write('active-output\\n'),10);"), { timeout: 1_000 });
    const pids = treePids(result.stdout);
    await expectGone(pids.descendant); await expectGone(pids.leader);
    expect(result.error).toMatchObject({ code: "ETIMEDOUT", killed: true }); expect(result.stdout).toContain("active-output");
  }, 8_000);

  it("cancels a live worker exactly once and reaps its descendant", async () => {
    const controller = new AbortController(); let callbacks = 0;
    const result = await new Promise<Result>((resolve) => {
      const child = runOneShot(process.execPath, ["-e", tree.replace("FIXTURE_ACTION", "setInterval(()=>{},100);")], { signal: controller.signal, timeout: 4_000 },
        (error, stdout, stderr) => { callbacks++; resolve({ error, stdout, stderr }); });
      child?.stdout?.once("data", () => controller.abort());
    });
    const pids = treePids(result.stdout); await expectGone(pids.descendant); await expectGone(pids.leader);
    expect(result.error).toMatchObject({ name: "AbortError", code: "ABORT_ERR", killed: true });
    controller.abort(); await pause(30); expect(callbacks).toBe(1);
  }, 8_000);

  it("bounds overflow while terminating the entire worker group", async () => {
    const result = await capture(tree.replace("FIXTURE_ACTION", "setInterval(()=>process.stdout.write('x'.repeat(1024)),10);"), { maxBuffer: 256 });
    const pids = treePids(result.stdout); await expectGone(pids.descendant); await expectGone(pids.leader);
    expect(result.error).toMatchObject({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true });
    expect(Buffer.byteLength(result.stdout)).toBe(256);
  }, 8_000);
});
