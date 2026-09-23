import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { createGrantedCuaHost, existingProfileGrantLauncher, WINDOWS_CUA_LAUNCHER } from "./cua-launcher.mjs";
import { findCsc } from "./build-speech-helper-win.mjs";

const temporary = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const args = ["one", "", "two words", 'a"b', "trailing\\", "quote\\\"end\\", "&|<>^", "%PATH%", "!NAME!", "$HOME", "`literal`", "漢字🙂", "thirteen", "fourteen"];
const regular = { isFile: () => true, isSymbolicLink: () => false };

describe("shared CUA grant launcher selection", () => {
  it("selects a fixed adjacent Windows executable without shell or user-data writes", () => {
    const binary = "C:\\Fictional space & %PATH%!\\漢字\\cua-driver.exe", inspected = [];
    const fileSystem = { lstatSync: file => { inspected.push(file); return regular; } };
    const launcher = existingProfileGrantLauncher(binary, { platform: "win32", fileSystem });
    expect(launcher).toBe(win32.join(win32.dirname(binary), WINDOWS_CUA_LAUNCHER));
    expect(inspected).toEqual([binary, launcher]);
  });
  it("refuses missing/linked launchers, unsupported platforms and alternate targets", () => {
    const binary = "C:\\Fictional\\cua-driver.exe";
    for (const fileSystem of [
      { lstatSync: () => { throw new Error("missing"); } },
      { lstatSync: () => ({ ...regular, isSymbolicLink: () => true }) },
    ]) expect(() => existingProfileGrantLauncher(binary, { platform: "win32", fileSystem })).toThrow(/missing or unsafe/);
    for (const target of ["cua-driver.exe", "C:\\Fictional\\other.exe", "/cua-driver.exe"]) {
      expect(() => existingProfileGrantLauncher(target, { platform: "win32" })).toThrow(/requires the bundled/);
    }
    expect(() => existingProfileGrantLauncher("/fictional/cua-driver", { platform: "linux" })).toThrow(/supported/);
  });
  it("constructs the SDK host with the same selected grant launcher and fixed host identity", () => {
    const binary = "C:\\Fictional\\cua-driver.exe";
    const sdk = { EmbeddedCuaDriverHost: class { constructor(...values) { this.values = values; } } };
    const host = createGrantedCuaHost(sdk, binary, { platform: "win32", fileSystem: { lstatSync: () => regular } });
    expect(host.values).toEqual(["C:\\Fictional\\RealBud CUA.exe", "com.realbud.app"]);
  });
});

describe.skipIf(process.platform !== "darwin")("actual macOS grant launcher with fictional executable", () => {
  it.each(["serve", "probe"])("preserves all arguments, literal path syntax and exit status for %s", command => {
    const directory = mkdtempSync(join(tmpdir(), "realbud-fictional-cua-")); temporary.push(directory);
    const install = join(directory, "space & $HOME `literal` ' 漢字"); mkdirSync(install);
    const binary = join(install, "cua-driver");
    writeFileSync(binary, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify(process.argv.slice(2))); process.exit(37);\n`, { mode: 0o755 });
    const launcher = existingProfileGrantLauncher(binary, { userData: join(directory, "profile") });
    const result = spawnSync(launcher, [command, ...args], { encoding: "utf8", timeout: 5000 });
    expect(result.error).toBeUndefined(); expect(result.status).toBe(37);
    expect(JSON.parse(result.stdout)).toEqual(command === "serve" ? ["serve", "--grant", "existing-profile", ...args] : [command, ...args]);
    expect(readFileSync(launcher, "utf8")).not.toContain("dangerously-bypass");
  });
});

const fixtureSource = String.raw`
using System; using System.Diagnostics; using System.Text; using System.Threading;
class Fixture {
  static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    if (Array.IndexOf(args, "--fictional-linger") >= 0) { Thread.Sleep(4500); return 0; }
    foreach (string value in args) Console.WriteLine("ARG:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(value)));
    Console.WriteLine("PID:" + Process.GetCurrentProcess().Id);
    if (Array.IndexOf(args, "--fictional-child") >= 0) {
      var info = new ProcessStartInfo(System.Reflection.Assembly.GetExecutingAssembly().Location, "--fictional-linger");
      info.UseShellExecute = false; info.CreateNoWindow = true;
      var child = Process.Start(info); Console.WriteLine("CHILD:" + child.Id);
    }
    Console.Out.Flush();
    if (Array.IndexOf(args, "--fictional-stdin") >= 0) Console.WriteLine("IN:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(Console.In.ReadToEnd())));
    if (Array.IndexOf(args, "--fictional-wait") >= 0) Thread.Sleep(4500);
    return 37;
  }
}`;
const processAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitUntil = async check => {
  const deadline = Date.now() + 3000;
  while (!check()) { if (Date.now() >= deadline) throw new Error("Fictional process condition timed out."); await new Promise(resolve => setTimeout(resolve, 20)); }
};

describe.skipIf(process.platform !== "win32")("native Windows CUA launcher with fictional adjacent executable", () => {
  let directory, launcher;
  beforeAll(() => {
    expect(process.arch).toBe("x64");
    const built = fileURLToPath(new URL("../dist-native/RealBud CUA.exe", import.meta.url));
    expect(existsSync(built), "Run build:cua-launcher:win before native launcher tests.").toBe(true);
    directory = mkdtempSync(join(tmpdir(), "RealBud fictional CUA "));
    const install = join(directory, "space & %PATH%! 漢字"); mkdirSync(install);
    launcher = join(install, WINDOWS_CUA_LAUNCHER); copyFileSync(built, launcher);
    const source = join(directory, "fictional-driver.cs"); writeFileSync(source, fixtureSource);
    const compiler = findCsc(); expect(compiler).toBeTruthy();
    execFileSync(compiler, ["/nologo", "/target:exe", "/platform:x64", `/out:${join(install, "cua-driver.exe")}`, source], { timeout: 30000, windowsHide: true });
  }, 40000);
  afterAll(() => { if (directory) rmSync(directory, { recursive: true, force: true }); });
  it.each(["serve", "probe"])("preserves more than nine UTF-16 arguments and exact exit for %s", command => {
    const result = spawnSync(launcher, [command, ...args], { encoding: "utf8", timeout: 10000, windowsHide: true });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(37);
    const received = result.stdout.split(/\r?\n/).filter(line => line.startsWith("ARG:")).map(line => Buffer.from(line.slice(4), "base64").toString("utf8"));
    expect(received).toEqual(command === "serve" ? ["serve", "--grant", "existing-profile", ...args] : [command, ...args]);
  });
  it("preserves stdin contents and EOF for the SDK parent-liveness contract", async () => {
    const child = spawn(launcher, ["serve", "--fictional-stdin"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.resume();
    const exit = new Promise(resolve => child.once("close", resolve));
    child.stdin.end("fictional liveness payload 漢字");
    const timer = setTimeout(() => child.kill(), 5000);
    try {
      expect(await exit).toBe(37);
      expect(output).toContain("IN:" + Buffer.from("fictional liveness payload 漢字").toString("base64"));
    } finally { clearTimeout(timer); if (child.exitCode === null) child.kill(); }
  }, 8000);
  it("drains owned descendants before reporting the driver's normal exit", () => {
    const result = spawnSync(launcher, ["serve", "--fictional-child"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    expect(result.status, result.stderr).toBe(37);
    const pid = Number(result.stdout.match(/CHILD:(\d+)/)?.[1]); expect(pid).toBeGreaterThan(0);
    expect(processAlive(pid)).toBe(false);
  });
  it("SDK-style forced launcher termination kills its driver and descendants", async () => {
    const child = spawn(launcher, ["serve", "--fictional-child", "--fictional-wait"], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = ""; child.stdout.on("data", bytes => { output += bytes; }); child.stderr.resume();
    const closed = new Promise(resolve => child.once("close", resolve));
    try {
      await waitUntil(() => /CHILD:\d+/.test(output));
      const pids = [...output.matchAll(/(?:PID|CHILD):(\d+)/g)].map(match => Number(match[1]));
      expect(pids.length).toBe(2); child.kill();
      await waitUntil(() => pids.every(pid => !processAlive(pid)));
      await closed;
    } finally {
      if (child.exitCode === null) child.kill();
      // Every fictional fallback lifetime is bounded even if a native assertion fails.
      await closed;
    }
  }, 10000);
});
