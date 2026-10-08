import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAcpDriver, type AcpSupport } from "./drivers/acp/core.ts";
import { hardenHermesChildEnv, hermesNetworkSandbox, hermesWorkerSandbox } from "./drivers/acp/hermes.ts";
import { startAskModelRelay } from "./ask-model-relay.ts";
import { DATA_DIR } from "./config.ts";
import { augmentedPath } from "./env-path.ts";
import { applyManagedModelProfile, applyPropertyPack } from "./hermes-pack.ts";
import { hermesCli } from "./hermes-pin.ts";
import { resetRuntimeSelectionForTests } from "./hermes-runtime-selection.ts";
import { BUD_WORK_FOLDER, seedVault, vaultDir } from "./vault.ts";
import { BROKER_PORT_POOL_SIZE, BROKER_PORTS_EXHAUSTED, NETWORK_ISOLATION_UNAVAILABLE, PRIVATE_HOME_PATHS, SANDBOX_EXEC, regexLiteral, SANDBOX_TEST_WRITABLE, sandboxedLaunch, scriptInterpreter, setWorkerLaunchesHeld, stopSandboxedChildren, trackSandboxedChild, trustedPath, WORKERS_HELD, workerLaunchesHeld, startBrokerPortPool, workerSandboxProfile } from "./worker-network-sandbox.ts";

const FAKE_CLI = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-acp-cli.ts");
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { vi.unstubAllEnvs(); for (const step of cleanup.splice(0).reverse()) await step(); });

const scratch = (prefix: string) => { const dir = mkdtempSync(join(tmpdir(), prefix)); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return realpathSync(dir); };
const listen = async (server: Server) => {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return (server.address() as { port: number }).port;
};
const script = (dir: string, name: string, body: string) => { const path = join(dir, name); writeFileSync(path, body); chmodSync(path, 0o755); return path; };
const rule = (profile: string, operation: string) => profile.match(new RegExp(`\\((?:allow|deny) ${operation.replace("*", "\\*")}[^()]*(?:\\([^()]*\\)[^()]*)*\\)`, "g")) ?? [];
/** The one allow rule for writes under the launch's folders (its regex may nest parentheses). */
/** The children-only write rule a verified root gets. */
const w = (root: string) => `(regex #"^${regexLiteral(root)}/")`;
const writesOf = (profile: string) => { const from = profile.indexOf("(allow file-write* ", profile.indexOf("(deny file-write*)")); return profile.slice(from, profile.indexOf("(allow file-write* (literal")); };

// The Seatbelt profile exists on macOS only (see the module header). Its
// blocks build real profiles from POSIX programs and paths (/bin/sh, shebang
// scripts, /private/tmp, symlinks, 0700 modes), so they run on macOS; what
// other platforms launch is asserted below on every host.
const SEATBELT = process.platform === "darwin";
describe.runIf(SEATBELT)("worker sandbox profile", () => {
  it("names only IPv4 loopback ports, deduplicated, and refuses an invalid one", () => {
    const dir = scratch("rb-profile-");
    const profile = workerSandboxProfile("/bin/sh", dir, { loopbackPorts: [4100, 4000, 4100], writable: [] });
    expect(profile).toContain('(deny network*)(allow network-outbound (remote ip4 "localhost:4000"))(allow network-outbound (remote ip4 "localhost:4100"))(deny system-socket)');
    expect(workerSandboxProfile("/bin/sh", dir, { loopbackPorts: [], writable: [] })).toContain("(deny network*)(deny system-socket)");
    for (const ports of [[0], [65_536], [1.5]]) expect(() => workerSandboxProfile("/bin/sh", dir, { loopbackPorts: ports, writable: [] })).toThrow(NETWORK_ISOLATION_UNAVAILABLE);
  });

  it("allows writes only under the named folders and the temp folder, by real path", () => {
    const dir = scratch("rb-profile-");
    const workroom = join(dir, "vault"); mkdirSync(workroom);
    const profile = workerSandboxProfile("/bin/sh", join(dir, "tmp"), { loopbackPorts: [], writable: [workroom, join(dir, "sessions")], writablePatterns: [`^${dir}/state\\.db[^/]*$`] });
    expect(profile).toContain("(deny file-write*)(deny file-link)");
    expect(rule(profile, "file-write\\*")).toEqual([
      "(deny file-write*)",
      `(allow file-write* ${w(workroom)}${w(join(dir, "sessions"))}(subpath "${join(dir, "tmp")}")(regex #"^${dir}/state\\.db[^/]*$"))`,
      '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    ]);
    // A folder node named for `access(W_OK)` gets file-write-data on that exact node only.
    expect(profile).not.toContain("file-write-data");
    expect(rule(workerSandboxProfile("/bin/sh", join(dir, "tmp"), { loopbackPorts: [], writable: [], writableFolderNodes: [dir] }), "file-write-data")).toEqual([`(allow file-write-data (literal "${dir}"))`]);
    // A root whose parent is missing is not created on the way; the launch is refused.
    expect(() => workerSandboxProfile("/bin/sh", join(dir, "tmp"), { loopbackPorts: [], writable: [join(dir, "later", "sessions")] })).toThrow(NETWORK_ISOLATION_UNAVAILABLE);
    expect(() => workerSandboxProfile("/bin/sh", "", { loopbackPorts: [], writable: [] })).toThrow(NETWORK_ISOLATION_UNAVAILABLE);
  });

  it("allows programs from the system, the launched program's folder, its interpreter's and the named folders only", () => {
    const dir = scratch("rb-profile-");
    const node = dirname(realpathSync(process.execPath));
    const viaEnv = script(dir, "worker.mjs", "#!/usr/bin/env node\nconsole.log(1)\n");
    const viaPath = script(dir, "worker.sh", "#!/bin/sh\necho 1\n");
    const native = script(dir, "native", "not a script\n");
    expect(scriptInterpreter(viaEnv, `${node}:/usr/bin`)).toBe(join(node, "node"));
    expect(scriptInterpreter(viaEnv, "/usr/bin")).toBeNull();
    expect(scriptInterpreter(viaPath)).toBe("/bin/sh");
    expect(scriptInterpreter(native)).toBeNull();
    const profile = workerSandboxProfile(viaEnv, join(dir, "tmp"), { loopbackPorts: [], writable: [], executable: [join(dir, "bin")] }, { PATH: `${node}:/usr/bin` });
    expect(rule(profile, "process-exec\\*")).toEqual([
      "(deny process-exec*)",
      `(allow process-exec* (subpath "/bin")(subpath "/sbin")(subpath "/usr/bin")(subpath "/usr/sbin")(subpath "/usr/libexec")(subpath "${dir}")(subpath "${node}")(subpath "${join(dir, "bin")}"))`,
      expect.stringMatching(/^\(deny process-exec\* \(literal "\/usr\/bin\/osascript"\).*\(literal "\/usr\/bin\/open"\).*\(literal "\/bin\/launchctl"\)/),
    ]);
  });

  it("hides trees in order, keeps their own node visible, and always hides the person's credential stores", () => {
    const dir = scratch("rb-profile-");
    const home = join(dir, "home"); mkdirSync(home);
    const profile = workerSandboxProfile("/bin/sh", join(dir, "tmp"), { loopbackPorts: [], writable: [], reads: [["deny", join(dir, "data")], ["allow", join(dir, "data", "vault")]] }, { HOME: home });
    expect(profile).toContain(`(deny file-read* (subpath "${join(dir, "data")}"))(allow file-read-metadata (literal "${join(dir, "data")}"))(allow file-read* (subpath "${join(dir, "data", "vault")}"))`);
    expect(profile).toContain(`(deny file-read* ${PRIVATE_HOME_PATHS.map(name => `(subpath "${join(userInfo().homedir, name)}")`).join("")}`);
    expect(profile).toContain(PRIVATE_HOME_PATHS.map(name => `(subpath "${join(home, name)}")`).join(""));
    expect(PRIVATE_HOME_PATHS).toEqual(expect.arrayContaining([".ssh", ".aws", ".config/gcloud", "Library/Keychains", "Library/Application Support/Google/Chrome"]));
    for (const operation of ["appleevent-send", "lsopen", "job-creation", "mach-register", "mach-lookup"]) expect(profile).toContain(`(deny ${operation})`);
    expect(profile).toMatch(/\(allow mach-lookup (\(global-name "com\.apple\.[a-z_.]+"\))+\)/);
  });

  it("resolves only the fixed pip trampoline's sibling Python, including paths longer than a shebang", () => {
    const dir = scratch("rb-python-trampoline-");
    const bin = join(dir, "fictional runtime ".repeat(10), "venv", "bin"); mkdirSync(bin, { recursive: true });
    const runtime = join(dir, "python-runtime"); mkdirSync(runtime);
    const python = script(runtime, "python3.11", "fictional native Python");
    const localPython = join(bin, "python"); symlinkSync(python, localPython);
    const cli = script(bin, "hermes", `#!/bin/sh\n'''exec' '${localPython}' "$0" "$@"\n' '''\nprint('fictional')\n`);
    expect(localPython.length).toBeGreaterThan(127);
    expect(scriptInterpreter(cli)).toBe(python);
    expect(workerSandboxProfile(cli, join(dir, "tmp"), { loopbackPorts: [], writable: [] })).toContain(`(subpath "${runtime}")`);
    // Standard pip also omits the quotes when its path contains no spaces.
    const plain = join(dir, "bin"); mkdirSync(plain); symlinkSync(python, join(plain, "python3"));
    expect(scriptInterpreter(script(plain, "hermes", `#!/bin/sh\n'''exec' ${join(plain, "python3")} "$0" "$@"\n' '''\n`))).toBe(python);
  });

  it("does not infer interpreter grants from malformed shell wrappers or an unrelated executable", () => {
    const dir = scratch("rb-python-trampoline-refused-");
    const bin = join(dir, "bin"), foreign = join(dir, "foreign"); mkdirSync(bin); mkdirSync(foreign);
    const python = script(bin, "python", "fictional Python");
    const outside = script(foreign, "python", "fictional foreign Python");
    const node = script(bin, "node", "fictional Node");
    symlinkSync("/bin/sh", join(bin, "python3"));
    const wrappers = [
      `'''exec' '${python}' "$0" "$@"; echo extra`,
      `exec '${python}' "$0" "$@"`,
      `'''exec' '${outside}' "$0" "$@"`,
      `'''exec' '${node}' "$0" "$@"`,
      `'''exec' '${join(bin, "python3")}' "$0" "$@"`,
      `'''exec' '${join(bin, "$(fictional)", "python")}' "$0" "$@"`,
      `'''exec' '${join(bin, "back`tick", "python")}' "$0" "$@"`,
    ];
    for (const [index, wrapper] of wrappers.entries()) {
      const cli = script(bin, `refused-${index}`, `#!/bin/sh\n${wrapper}\n' '''\n`);
      expect(scriptInterpreter(cli)).toBe("/bin/sh");
    }
    const malformed = script(bin, "malformed", `#!/bin/sh\n'''exec' '${python}' "$0" "$@"\n' incomplete\n`);
    expect(scriptInterpreter(malformed)).toBe("/bin/sh");
  });

  it("resolves only the OS's own aliases, keeps missing tails literal, and refuses a link anyone else made", () => {
    const dir = scratch("rb-profile-");
    expect(trustedPath("/tmp/rb-not-yet/x")).toBe("/private/tmp/rb-not-yet/x");
    expect(trustedPath(join(dir, "not", "yet"))).toBe(join(dir, "not", "yet"));
    const target = join(dir, "real"); mkdirSync(target); symlinkSync(target, join(dir, "link"));
    expect(() => trustedPath(join(dir, "link", "deeper"))).toThrow(NETWORK_ISOLATION_UNAVAILABLE);
    // A planted root never becomes a rule: the launch is refused.
    expect(() => workerSandboxProfile("/bin/sh", join(dir, "tmp"), { loopbackPorts: [], writable: [join(dir, "link")] })).toThrow(NETWORK_ISOLATION_UNAVAILABLE);
    expect(() => workerSandboxProfile("/bin/sh", join(dir, "tmp"), { loopbackPorts: [], writable: [], reads: [["allow", join(dir, "link")]] })).toThrow(NETWORK_ISOLATION_UNAVAILABLE);
  });

  it("makes every writable root a real owner-only folder before naming it", () => {
    const dir = scratch("rb-profile-");
    mkdirSync(join(dir, "loose"), { mode: 0o755 });
    const profile = workerSandboxProfile("/bin/sh", join(dir, "tmp"), { loopbackPorts: [], writable: [join(dir, "cache"), join(dir, "loose")] });
    expect(profile).toContain(`${w(join(dir, "cache"))}${w(join(dir, "loose"))}`);
    expect(realpathSync(join(dir, "cache"))).toBe(join(dir, "cache"));
    for (const name of ["cache", "loose"]) expect(lstatSync(join(dir, name)).mode & 0o777).toBe(0o700);
    writeFileSync(join(dir, "file"), "x");
    expect(() => workerSandboxProfile("/bin/sh", join(dir, "tmp"), { loopbackPorts: [], writable: [join(dir, "file")] })).toThrow(NETWORK_ISOLATION_UNAVAILABLE);
  });

  it("hides the signed-in account's credential stores even when the child gets another HOME, and keeps process control inside the sandbox", () => {
    const dir = scratch("rb-profile-");
    const profile = workerSandboxProfile("/bin/sh", join(dir, "tmp"), { loopbackPorts: [], writable: [] }, { HOME: join(dir, "scratch-home") });
    for (const home of [userInfo().homedir, join(dir, "scratch-home")]) expect(profile).toContain(`(subpath "${trustedPath(join(home, ".ssh"))}")`);
    expect(profile).toContain('(deny signal)(allow signal (target same-sandbox))(deny process-info*)(allow process-info* (target same-sandbox))(deny mach-priv*)(deny sysctl*)(allow sysctl-read (sysctl-name "kern.version")');
    expect(profile).toContain('(sysctl-name-prefix "hw.")(sysctl-name-prefix "kern.os")');
    expect(profile).toContain('(deny sysctl-read (sysctl-name-prefix "kern.proc"))');
  });
});

describe("sandboxed launch", () => {
  it.runIf(SEATBELT)("wraps the launch on macOS with a private temp folder", () => {
    const profiles: string[] = [];
    const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
    const wrapped = sandboxedLaunch("/bin/sh", ["-p", "property", "acp"], env, { loopbackPorts: [4000], writable: [] }, { platform: "darwin", probe: profile => { profiles.push(profile); return true; } });
    cleanup.push(() => wrapped.release());
    expect(wrapped.command).toBe(SANDBOX_EXEC);
    expect(wrapped.args.slice(2)).toEqual(["/bin/sh", "-p", "property", "acp"]);
    expect(wrapped.args[1]).toBe(profiles[0]);
    expect(env.TMPDIR).toMatch(/realbud-worker-/);
    expect(env.TMP).toBe(env.TMPDIR); expect(env.TEMP).toBe(env.TMPDIR);
    expect(wrapped.args[1]).toContain(`(subpath "${trustedPath(env.TMPDIR!)}")`);
    expect(existsSync(env.TMPDIR!)).toBe(true);
    wrapped.release();
    expect(existsSync(env.TMPDIR!)).toBe(false);
  });

  it("leaves the launch unchanged on other platforms", () => {
    for (const platform of ["linux", "win32"] as const) {
      const other: Record<string, string | undefined> = {};
      expect(sandboxedLaunch("/synthetic/hermes", ["acp"], other, { loopbackPorts: [4000], writable: [] }, { platform, probe: () => { throw new Error("not probed"); } })).toMatchObject({ command: "/synthetic/hermes", args: ["acp"] });
      expect(other.TMPDIR).toBeUndefined();
    }
  });

  it.runIf(SEATBELT)("refuses to start rather than run unconfined when sandbox-exec is missing or rejects the profile", () => {
    const env: Record<string, string | undefined> = {};
    expect(() => sandboxedLaunch("/bin/sh", ["-c", "true"], env, { loopbackPorts: [4000], writable: [] }, { platform: "darwin", probe: () => false })).toThrow(NETWORK_ISOLATION_UNAVAILABLE);
    expect(env.TMPDIR).toBeUndefined();
  });

  it("reports a missing program as ENOENT, resolving a bare name on the child's PATH", () => {
    const dir = scratch("rb-launch-");
    const env: Record<string, string | undefined> = { PATH: dir };
    expect(() => sandboxedLaunch("/synthetic/hermes", ["acp"], env, { loopbackPorts: [], writable: [] }, { platform: "darwin", probe: () => true })).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(() => sandboxedLaunch("hermes", ["acp"], env, { loopbackPorts: [], writable: [] }, { platform: "darwin", probe: () => true })).toThrow(expect.objectContaining({ code: "ENOENT" }));
    if (!SEATBELT) return; // A found program goes on to build the Seatbelt profile.
    script(dir, "hermes", "#!/bin/sh\necho ok\n");
    const launch = sandboxedLaunch("hermes", ["--version"], env, { loopbackPorts: [], writable: [] }, { platform: "darwin", probe: () => true });
    cleanup.push(() => launch.release());
    expect(launch.args.slice(2)).toEqual([join(dir, "hermes"), "--version"]);
  });
});

describe("live sandboxed children", () => {
  it.skipIf(process.platform !== "darwin")("waits for an owned zombie group to be reaped after Darwin reports EPERM", async () => {
    const child = trackSandboxedChild(spawn("/bin/sh", ["-c", "exit 0"], { detached: true, stdio: "ignore" }));
    try {
      // Keep this event loop from reaping SIGCHLD while the owned shell exits.
      // The kernel sees a zombie group; Node has not received its exit yet.
      let state = "";
      const deadline = Date.now() + 2_000;
      while (!state.startsWith("Z") && Date.now() < deadline) {
        state = execFileSync("/bin/ps", ["-p", String(child.pid), "-o", "stat="], { encoding: "utf8" }).trim();
      }
      expect(state).toMatch(/^Z/);
      expect(child.exitCode).toBe(null);
      expect(child.signalCode).toBe(null);
      expect(() => process.kill(-child.pid!, 0)).toThrow(expect.objectContaining({ code: "EPERM" }));
      await stopSandboxedChildren(150);
      expect(child.exitCode).toBe(0);
      expect(() => process.kill(-child.pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* owned child may already be reaped */ }
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
      await stopSandboxedChildren(100);
    }
  });

  it.skipIf(process.platform === "win32")("retries a refused SIGKILL before confirming an owned worker group has stopped", async () => {
    const child = trackSandboxedChild(spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000);"], { detached: true, stdio: ["ignore", "pipe", "ignore"] }));
    const kill = process.kill.bind(process);
    let killAttempts = 0;
    let restoreKill = () => {};
    try {
      await once(child.stdout!, "data");
      const spy = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (pid === -child.pid! && signal === "SIGKILL" && ++killAttempts === 1) throw Object.assign(new Error("owned signal temporarily refused"), { code: "EPERM" });
        return kill(pid, signal);
      });
      restoreKill = () => spy.mockRestore();
      await stopSandboxedChildren(30);
      expect(killAttempts).toBe(2);
      expect(child.signalCode).toBe("SIGKILL");
      expect(() => kill(-child.pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    } finally {
      restoreKill();
      try { kill(-child.pid!, "SIGKILL"); } catch { /* owned worker already stopped */ }
      if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
      await stopSandboxedChildren(100);
    }
  });

  it.skipIf(process.platform !== "darwin").each([false, true])("waits for a TERM-resistant descendant when its leader exits first (already exited: %s)", async alreadyExited => {
    const descendantCode = "process.on('SIGTERM',()=>{}); process.send('ready'); setInterval(()=>{},1000); setTimeout(()=>process.exit(),15000);";
    const parentCode = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{stdio:['ignore','ignore','ignore','ipc']}); child.once('message',()=>console.log(child.pid)); setInterval(()=>{},1000);`;
    const child = trackSandboxedChild(spawn(process.execPath, ["-e", parentCode], { detached: true, stdio: ["ignore", "pipe", "ignore"] }));
    let descendant: number | undefined;
    try {
      const [output] = await once(child.stdout!, "data"); descendant = Number(String(output).trim());
      expect(descendant).toBeGreaterThan(0);
      if (alreadyExited) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
      await stopSandboxedChildren(150);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
      expect(() => process.kill(descendant!, 0)).toThrow();
      expect(() => process.kill(-child.pid!, 0)).toThrow();
    } finally {
      try { process.kill(-child.pid!, "SIGKILL"); } catch { /* fixture already gone */ }
      if (descendant) try { process.kill(descendant, "SIGKILL"); } catch { /* fixture already gone */ }
    }
  }, 12_000);

  it("stops every registered child, waits for it to exit, and kills one that ignores SIGTERM at the deadline", async () => {
    const stubborn = trackSandboxedChild(spawn("/bin/sh", ["-c", 'trap "" TERM; sleep 30'], { detached: true, stdio: "ignore" }));
    const polite = trackSandboxedChild(spawn("/bin/sh", ["-c", "sleep 30"], { detached: true, stdio: "ignore" }));
    await new Promise(resolve => setTimeout(resolve, 200));
    const started = Date.now();
    await stopSandboxedChildren(700);
    expect(Date.now() - started).toBeLessThan(4_000);
    for (const child of [stubborn, polite]) expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(() => process.kill(stubborn.pid!, 0)).toThrow();
  }, 10_000);

  it("refuses every launch while workers are held", () => {
    setWorkerLaunchesHeld(true); cleanup.push(() => setWorkerLaunchesHeld(false));
    expect(workerLaunchesHeld()).toBe(true);
    expect(() => sandboxedLaunch("/bin/sh", ["-c", "true"], {}, { loopbackPorts: [], writable: [] }, { platform: "darwin", probe: () => true })).toThrow(WORKERS_HELD);
    expect(() => sandboxedLaunch("/bin/sh", ["-c", "true"], {}, { loopbackPorts: [], writable: [] }, { platform: "linux" })).toThrow(WORKERS_HELD);
  });
});

describe("Hermes worker launch off macOS", () => {
  it("starts the program unchanged, with no Seatbelt profile or temp override", () => {
    seedVault();
    const root = scratch("rb-plain-home-");
    for (const platform of ["linux", "win32"] as const) {
      const env: Record<string, string | undefined> = { HERMES_HOME: root };
      expect(hermesNetworkSandbox("/synthetic/hermes", ["acp"], env, [4000], "ask", { platform })).toMatchObject({ command: "/synthetic/hermes", args: ["acp"] });
      expect(env.TMPDIR).toBeUndefined();
    }
  });
});

describe.runIf(SEATBELT)("Hermes worker sandbox", () => {
  const deps = { platform: "darwin" as const, probe: () => true };

  it("takes the Ask relay's port from this process, never from the overlay file", async () => {
    seedVault();
    const root = scratch("rb-relay-home-");
    const relay = await startAskModelRelay({ root, overlayDir: join(root, "overlay") }); cleanup.push(() => relay.close());
    const port = Number(new URL(relay.url).port);
    // A forged overlay naming another port changes nothing: the port comes from memory.
    const forged = join(root, "forged"); mkdirSync(forged);
    writeFileSync(join(forged, "config.yaml"), JSON.stringify({ providers: { realbud: { base_url: "http://127.0.0.1:8799", url: "http://127.0.0.1:8799", api: "http://127.0.0.1:8799" } } }));
    const cli = script(root, "hermes", "#!/bin/sh\necho ok\n");
    const launch = hermesNetworkSandbox(cli, ["-p", "property", "acp"], { HERMES_MANAGED_DIR: forged, HERMES_HOME: root, PATH: "/usr/bin" }, [4000], "ask", deps);
    cleanup.push(() => launch.release());
    expect(launch.args[1]).toContain(`(allow network-outbound (remote ip4 "localhost:4000"))(allow network-outbound (remote ip4 "localhost:${port}"))`);
    expect(launch.args[1]).not.toContain("8799");
    const plain = hermesNetworkSandbox(cli, ["acp"], { HERMES_HOME: root, PATH: "/usr/bin" }, [4000], "ask", deps);
    cleanup.push(() => plain.release());
    expect(rule(plain.args[1], "network-outbound")).toEqual(['(allow network-outbound (remote ip4 "localhost:4000"))']);
  });

  it("lets a turn write the workroom and the profile's own state, never the runtime, policy files or another seat", () => {
    seedVault();
    const root = scratch("rb-worker-home-");
    const profile = join(root, "profiles", "property"); mkdirSync(profile, { recursive: true });
    const tools = join(root, "dev-cli"); mkdirSync(tools);
    const cli = script(tools, "hermes", "#!/bin/sh\necho ok\n");
    const launch = hermesWorkerSandbox("ask", cli, ["-p", "property", "acp"], { HERMES_HOME: root, PATH: "/usr/bin" }, [4000], deps);
    cleanup.push(() => launch.release());
    const sbpl = launch.args[1];
    const writes = writesOf(sbpl);
    // Of the workroom only Bud's own folder; the book, decisions and uploads stay read-only.
    expect(writes).toContain(w(trustedPath(join(vaultDir(), BUD_WORK_FOLDER))));
    expect(writes).not.toContain(w(trustedPath(vaultDir())));
    for (const name of ["sessions", "logs", "cache", "pending/memory", "pending/skills"]) expect(writes).toContain(w(join(profile, name)));
    // Memory changes reach MEMORY.md only through RealBud's review; the skills prompt cache is Hermes-trusted, so read-only.
    for (const name of ["pending", "memories"]) expect(writes).not.toContain(w(join(profile, name)));
    expect(writes).not.toContain("skills_prompt_snapshot");
    expect(sbpl).toContain("(deny file-link)(deny file-clone)");
    expect(writes).toContain(`(regex #"^${profile.replace(/\./g, "\\.")}/\\.?\\.?(state\\.db|`);
    // Hermes 0.21.5 opens state.db only once the profile folder answers access(W_OK); its node, nothing under it.
    expect(rule(sbpl, "file-write-data")).toEqual([`(allow file-write-data (literal "${profile}"))`]);
    for (const name of ["hooks", "cron", "bin", "config.yaml", "SOUL.md", ".env", "auth.json"]) expect(writes).not.toContain(`/${name}"`);
    expect(writes).not.toContain(w(join(profile, "skills")));
    expect(writes).not.toContain(`(subpath "${root}")`);
    expect(writes).not.toContain(`(subpath "${profile}")`);
    // Hermes insists on these folders; RealBud makes them so the worker never writes `cron`, `hooks` or `skills`.
    for (const name of ["cron", "hooks", "skills", "logs/curator"]) expect(existsSync(join(profile, name))).toBe(true);
    // Under the test hook (server/testing/setup.ts) the temp folder is writable for the fakes' evidence.
    expect(writes).toContain(w(trustedPath(tmpdir())));
    // Production: the hook is empty, and the program's folder is never writable, whatever runtime is
    // selected (a pending update leaves the old executable frozen in this process; it must not open that runtime).
    const hook = SANDBOX_TEST_WRITABLE.splice(0);
    cleanup.push(() => { SANDBOX_TEST_WRITABLE.push(...hook); });
    const production = hermesWorkerSandbox("ask", cli, ["-p", "property", "acp"], { HERMES_HOME: root, PATH: "/usr/bin", FAKE_ACP_DUMP: join(root, "dump.json") }, [4000], deps);
    cleanup.push(() => production.release());
    const productionWrites = writesOf(production.args[1]);
    expect(productionWrites).not.toContain(tools);
    expect(productionWrites).not.toContain(`(subpath "${root}")`);
    expect(productionWrites).not.toContain(w(trustedPath(tmpdir())));
    expect(productionWrites).toContain(w(trustedPath(join(vaultDir(), BUD_WORK_FOLDER))));
    expect(sbpl).toContain(`(deny file-read* (subpath "${trustedPath(DATA_DIR)}"))`);
    expect(sbpl).toContain(`(deny file-read* (subpath "${join(root, "profiles")}"))(allow file-read-metadata (literal "${join(root, "profiles")}"))(allow file-read* (subpath "${profile}"))`);
    expect(sbpl).toContain(`(deny file-read* (subpath "${join(root, "auth.json")}"))`);
    expect(rule(sbpl, "process-exec\\*")[1]).toContain(`(subpath "${join(profile, "bin")}")`);
  });

  it("refuses a launch whose profile skeleton would be made through a planted link, and fixes a loose root", () => {
    seedVault();
    const root = scratch("rb-worker-home-");
    const profile = join(root, "profiles", "property"); mkdirSync(profile, { recursive: true });
    const cli = script(root, "hermes", "#!/bin/sh\necho ok\n");
    const elsewhere = join(root, "elsewhere"); mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(profile, "logs"));
    expect(() => hermesWorkerSandbox("ask", cli, ["-p", "property", "acp"], { HERMES_HOME: root, PATH: "/usr/bin" }, [4000], deps)).toThrow(NETWORK_ISOLATION_UNAVAILABLE);
    expect(existsSync(join(elsewhere, "curator"))).toBe(false);
    rmSync(join(profile, "logs"));
    mkdirSync(join(profile, "cache"), { mode: 0o755 });
    chmodSync(profile, 0o755);
    const launch = hermesWorkerSandbox("ask", cli, ["-p", "property", "acp"], { HERMES_HOME: root, PATH: "/usr/bin" }, [4000], deps);
    cleanup.push(() => launch.release());
    for (const path of [profile, join(profile, "cache"), join(profile, "pending")]) expect(lstatSync(path).mode & 0o777).toBe(0o700);
    writeFileSync(join(profile, ".skills_prompt_snapshot.json"), "{}");
    hermesWorkerSandbox("ask", cli, ["-p", "property", "acp"], { HERMES_HOME: root, PATH: "/usr/bin" }, [4000], deps).release();
    expect(existsSync(join(profile, ".skills_prompt_snapshot.json"))).toBe(false);
    // A profile that is a file, or one standing behind a link, refuses the launch.
    const other = scratch("rb-worker-home-"); mkdirSync(join(other, "profiles"));
    writeFileSync(join(other, "profiles", "property"), "not a folder");
    expect(() => hermesWorkerSandbox("ask", cli, ["-p", "property", "acp"], { HERMES_HOME: other, PATH: "/usr/bin" }, [4000], deps)).toThrow(NETWORK_ISOLATION_UNAVAILABLE);
    expect(existsSync(join(profile, "logs", "curator"))).toBe(true);
  });

  it("gives a diagnostic launch no network and nothing to write but its temp folder", () => {
    const root = scratch("rb-worker-home-");
    const cli = script(root, "hermes", "#!/bin/sh\necho ok\n");
    const env: Record<string, string | undefined> = { HERMES_HOME: root, PATH: "/usr/bin" };
    const launch = hermesWorkerSandbox("diagnostic", cli, ["--version"], env, [], deps);
    cleanup.push(() => launch.release());
    expect(rule(launch.args[1], "network-outbound")).toEqual([]);
    expect(launch.args[1]).not.toContain("file-write-data");
    expect(writesOf(launch.args[1])).toBe(`(allow file-write* (subpath "${trustedPath(env.TMPDIR!)}"))`);
    expect(existsSync(join(root, "profiles", "property", "cron"))).toBe(false);
  });
});

describe("broker port pool", () => {
  it("forwards to one broker per held port, drops released ports and fails when every port is in use", async () => {
    const hosts: string[] = [];
    const broker = createServer((req, res) => { hosts.push(String(req.headers.host)); res.end(`${req.method} ${req.url}`); });
    const brokerPort = await listen(broker);
    const pool = await startBrokerPortPool(2); cleanup.push(() => pool.close());
    expect(pool.ports).toHaveLength(2);
    expect(pool.mount("https://backend.example.invalid/mcp")).toBeNull();
    const first = pool.mount(`http://127.0.0.1:${brokerPort}/mcp`)!;
    expect(first.url).toMatch(new RegExp(`^http://127\\.0\\.0\\.1:(${pool.ports.join("|")})/mcp$`));
    expect(await (await fetch(first.url, { method: "POST", body: "{}" })).text()).toBe("POST /mcp");
    expect(hosts).toEqual([`127.0.0.1:${brokerPort}`]);
    const second = pool.mount(`http://127.0.0.1:${brokerPort}/mcp`)!;
    expect(() => pool.mount(`http://127.0.0.1:${brokerPort}/mcp`)).toThrow(BROKER_PORTS_EXHAUSTED);
    first.release();
    await expect(fetch(first.url, { method: "POST" })).rejects.toThrow();
    const third = pool.mount(`http://127.0.0.1:${brokerPort}/mcp`)!;
    expect(third.url).toBe(first.url);
    second.release(); third.release();
  });

  it("refuses an Ask launch before any process starts when the sandbox refuses", async () => {
    const dump = join(mkdtempSync(join(tmpdir(), "realbud-sandbox-refusal-")), "dump.json");
    cleanup.push(() => rmSync(dirname(dump), { recursive: true, force: true }));
    process.env.FAKE_ACP_DUMP = dump; cleanup.push(() => { delete process.env.FAKE_ACP_DUMP; });
    const seen: number[][] = [];
    const support: AcpSupport = {
      driverKind: "sandboxTest", displayName: "Sandbox test", models: { default: "default", options: [] }, defaultCli: FAKE_CLI,
      nativeSource: "sandbox-test.acp", loginNote: "", spawnArgs: () => [], pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true,
      networkSandbox: (_command, _args, _env, ports) => { seen.push(ports); throw new Error(NETWORK_ISOLATION_UNAVAILABLE); },
    };
    const instance = await createAcpDriver(support).create({ instanceId: "sandbox-test", displayName: "Sandbox test", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    cleanup.push(() => instance.dispose());
    await expect(instance.adapter.sendTurn({ threadId: "sandbox-refused", text: "hi" })).rejects.toThrow(NETWORK_ISOLATION_UNAVAILABLE);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(BROKER_PORT_POOL_SIZE);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(existsSync(dump)).toBe(false);
    // The diagnostic probe refuses the same way instead of running the binary unconfined.
    expect(await instance.snapshot()).toMatchObject({ state: "unavailable" });
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual([]);
  });

  it("stopAll resolves only once the worker process has exited, and sendTurn is refused while workers are held", async () => {
    const dump = join(mkdtempSync(join(tmpdir(), "realbud-sandbox-stop-")), "dump.json");
    cleanup.push(() => rmSync(dirname(dump), { recursive: true, force: true }));
    process.env.FAKE_ACP_DUMP = dump; process.env.FAKE_ACP_MODE = "hang";
    cleanup.push(() => { delete process.env.FAKE_ACP_DUMP; delete process.env.FAKE_ACP_MODE; });
    const support: AcpSupport = {
      driverKind: "sandboxStop", displayName: "Sandbox stop", models: { default: "default", options: [] }, defaultCli: FAKE_CLI,
      nativeSource: "sandbox-stop.acp", loginNote: "", spawnArgs: () => [], pickAuthMethod: () => null, authFailure: "continue", isAuthenticated: () => true,
      networkSandbox: (command, args) => ({ command, args: [...args], release() {} }),
    };
    const instance = await createAcpDriver(support).create({ instanceId: "sandbox-stop", displayName: "Sandbox stop", environment: {}, enabled: true, config: { cli: FAKE_CLI, fullAuto: false } });
    cleanup.push(() => instance.dispose());
    await instance.adapter.sendTurn({ threadId: "stop-me", text: "hang" });
    for (let waited = 0; !existsSync(dump) && waited < 10_000; waited += 50) await new Promise(resolve => setTimeout(resolve, 50));
    const pid = JSON.parse(readFileSync(dump, "utf8")).pid as number;
    expect(pid).toBeGreaterThan(0);
    await instance.adapter.stopAll();
    expect(() => process.kill(pid, 0)).toThrow();
    setWorkerLaunchesHeld(true); cleanup.push(() => setWorkerLaunchesHeld(false));
    await expect(instance.adapter.sendTurn({ threadId: "held", text: "hi" })).rejects.toThrow(WORKERS_HELD);
  }, 30_000);
});

// Real macOS sandbox: REALBUD_TEST_SANDBOX=1 pnpm exec vitest run server/worker-network-sandbox.test.ts
describe.runIf(process.env.REALBUD_TEST_SANDBOX === "1" && process.platform === "darwin")("sandbox-exec on this Mac", () => {
  const run = async (launch: { command: string; args: string[]; release(): void }, env: Record<string, string | undefined>) => {
    try {
      expect(launch.command).toBe(SANDBOX_EXEC);
      const { stdout } = await promisify(execFile)(launch.command, launch.args, { timeout: 60_000, env, maxBuffer: 1024 * 1024 });
      return JSON.parse(stdout);
    } finally { launch.release(); }
  };

  it.skipIf(!process.env.REALBUD_TEST_PYTHON)("starts a pip-generated long-path Python entrypoint under the unchanged network and write restrictions", async () => {
    const dir = scratch("rb-pip-entrypoint-");
    const longPart = "fictional-équipe-runtime-".repeat(8);
    const bin = join(dir, longPart, longPart, longPart, "venv", "bin"); mkdirSync(bin, { recursive: true });
    // Explicit native CPython for this opt-in fixture. Apple's system Python
    // chains into a separate app binary; its launcher is not this boundary.
    const python = realpathSync(process.env.REALBUD_TEST_PYTHON!);
    symlinkSync(python, join(bin, "python"));
    // Generate the wrapper with pip itself instead of approximating its bytes.
    const generate = `import sys\nfrom pip._vendor.distlib.scripts import ScriptMaker\nm = ScriptMaker(None, sys.argv[1])\nm.executable = sys.argv[1] + '/python'\nm.variants = {''}\nm.make('fictional-runtime = fictional_runtime:main')\n`;
    execFileSync("/usr/bin/python3", ["-c", generate, bin], { env: { PATH: "/usr/bin:/bin", HOME: dir, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" } });
    const unlisted = await listen(createServer((_req, res) => res.end("fictional reachable host")));
    script(bin, "fictional_runtime.py", `import json, pathlib, socket\ndef main():\n    def blocked(fn):\n        try: fn(); return False\n        except OSError as error: return error.errno in (1, 13)\n    print(json.dumps({'started': True, 'writeBlocked': blocked(lambda: pathlib.Path(${JSON.stringify(join(dir, "outside-write"))}).write_text('fictional')), 'networkBlocked': blocked(lambda: socket.create_connection(('127.0.0.1', ${unlisted}), timeout=1))}))\n`);
    const cli = join(bin, "fictional-runtime");
    expect(join(bin, "python").length).toBeGreaterThan(512);
    expect(readFileSync(cli, "utf8").startsWith("#!/bin/sh\n'''exec' ")).toBe(true);
    expect(scriptInterpreter(cli)).toBe(python);
    const env = { PATH: "/usr/bin:/bin", HOME: dir, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1" };
    expect(await run(sandboxedLaunch(cli, [], env, { loopbackPorts: [], writable: [] }), env)).toEqual({ started: true, writeBlocked: true, networkBlocked: true });
  });

  it("lets safe readers inspect reopened-profile ancestors while keeping sibling records and directory listings private", async () => {
    const data = scratch("rb-read-ancestry-"), profile = join(data, "hermes", "profiles", "property");
    mkdirSync(profile, { recursive: true, mode: 0o700 });
    writeFileSync(join(data, "hermes", "private-key.txt"), "fictional secret");
    writeFileSync(join(profile, "config.yaml"), "fictional visible");
    const probe = `const fs=require('node:fs');const attempt=fn=>{try{return fn()}catch(e){return 'failed:'+e.code}};console.log(JSON.stringify({ancestor:attempt(()=>fs.lstatSync(${JSON.stringify(dirname(profile))}).isDirectory()),list:attempt(()=>fs.readdirSync(${JSON.stringify(dirname(profile))})),sibling:attempt(()=>fs.readFileSync(${JSON.stringify(join(data,"hermes","private-key.txt"))},'utf8')),profile:attempt(()=>fs.readFileSync(${JSON.stringify(join(profile,"config.yaml"))},'utf8'))}));`;
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    const result = await run(sandboxedLaunch(process.execPath, ["-e", probe], env, { loopbackPorts: [], writable: [], reads: [["deny", data], ["allow", profile]] }), env);
    expect(result).toEqual({ ancestor: true, list: "failed:EPERM", sibling: "failed:EPERM", profile: "fictional visible" });
  });

  it("lets a named folder answer access(W_OK) for its state files while nothing else in it can be made, moved or re-moded", async () => {
    const dir = scratch("rb-folder-node-");
    const probe = `const fs=require('node:fs'),p=require('node:path'),d=${JSON.stringify(dir)};const attempt=fn=>{try{fn();return 'ok'}catch(e){return 'failed:'+e.code}};console.log(JSON.stringify({access:attempt(()=>fs.accessSync(d,fs.constants.R_OK|fs.constants.W_OK)),state:attempt(()=>fs.writeFileSync(p.join(d,'state.db-wal'),'fictional')),other:attempt(()=>fs.writeFileSync(p.join(d,'config.yaml'),'planted')),folder:attempt(()=>fs.mkdirSync(p.join(d,'backups'))),chmod:attempt(()=>fs.chmodSync(d,0o777)),rename:attempt(()=>fs.renameSync(d,d+'-moved')),overwrite:attempt(()=>fs.writeFileSync(p.join(d,'SOUL.md'),'planted')),unlink:attempt(()=>fs.unlinkSync(p.join(d,'SOUL.md'))),over:attempt(()=>fs.renameSync(p.join(d,'state.db-wal'),p.join(d,'SOUL.md'))),link:attempt(()=>fs.symlinkSync('/etc/hosts',p.join(d,'linked'))),rmdir:attempt(()=>fs.rmdirSync(p.join(d,'skills'))),times:attempt(()=>fs.utimesSync(d,1,1))}));`;
    writeFileSync(join(dir, "SOUL.md"), "fictional identity"); mkdirSync(join(dir, "skills"));
    const env = { PATH: process.env.PATH, HOME: process.env.HOME };
    const spec = { loopbackPorts: [], writable: [], writablePatterns: [`^${regexLiteral(dir)}/state\\.db[^/]*$`] };
    expect(await run(sandboxedLaunch(process.execPath, ["-e", probe], env, spec), env)).toMatchObject({ access: expect.stringMatching(/^failed:/), state: "ok" });
    expect(await run(sandboxedLaunch(process.execPath, ["-e", probe], env, { ...spec, writableFolderNodes: [dir] }), env))
      .toEqual({ access: "ok", state: "ok", other: "failed:EPERM", folder: "failed:EPERM", chmod: "failed:EPERM", rename: "failed:EPERM",
        overwrite: "failed:EPERM", unlink: "failed:EPERM", over: "failed:EPERM", link: "failed:EPERM", rmdir: "failed:EPERM", times: "failed:EPERM" });
    expect(readFileSync(join(dir, "SOUL.md"), "utf8")).toBe("fictional identity");
  });

  it("reaches only the allowed IPv4 loopback port: no public host, other port, IPv6, mapped, mDNS, Unix socket or DNS", async () => {
    const allowed = await listen(createServer((_req, res) => res.end("allowed")));
    const unlisted = await listen(createServer((_req, res) => res.end("unlisted")));
    const socketDir = scratch("rb-sock-");
    const socketPath = join(socketDir, "s");
    const unix = createNetServer(socket => socket.end("unix")); await new Promise<void>(resolve => unix.listen(socketPath, resolve));
    cleanup.push(() => new Promise<void>(resolve => unix.close(() => resolve())));
    const probe = `
      const net = require("node:net"), dns = require("node:dns/promises"), http = require("node:http");
      const get = (host, port) => new Promise(done => { const q = http.get({ host, port, path: "/", timeout: 4000 }, r => { let t = ""; r.on("data", d => t += d); r.on("end", () => done(t)); });
        q.on("timeout", () => { q.destroy(); done("failed:timeout"); }); q.on("error", e => done("failed:" + e.code)); });
      const unix = path => new Promise(done => { const s = net.connect(path); s.on("data", d => done(String(d))); s.on("error", () => done("failed")); });
      (async () => {
        const started = Date.now();
        const lookup = await dns.lookup("example.com").then(() => "resolved", () => "failed");
        const mdns = await dns.lookup("fictional-printer.local").then(() => "resolved", () => "failed");
        console.log(JSON.stringify({ lookup, mdns, lookupMs: Date.now() - started, publicHost: await get("example.com", 80),
          allowed: await get("127.0.0.1", ${allowed}), localhost: await get("localhost", ${allowed}), unlisted: await get("127.0.0.1", ${unlisted}),
          v6: await get("::1", ${allowed}), mapped: await get("::ffff:127.0.0.1", ${allowed}), anyUnlisted: await get("0.0.0.0", ${unlisted}),
          unix: await unix(${JSON.stringify(socketPath)}) }));
        process.exit(0);
      })();`;
    const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: process.env.HOME };
    const result = await run(sandboxedLaunch(process.execPath, ["-e", probe], env, { loopbackPorts: [allowed], writable: [] }), env);
    expect(result).toMatchObject({ lookup: "failed", mdns: "failed", publicHost: "failed:ENOTFOUND", allowed: "allowed", localhost: "allowed", unlisted: "failed:EPERM",
      v6: expect.stringMatching(/^failed:/), mapped: "failed:EPERM", anyUnlisted: "failed:EPERM", unix: "failed" });
    expect(result.lookupMs).toBeLessThan(3_000);
  }, 70_000);

  it("writes only the workroom and temp, reads no credential store, runs nothing from the workroom and sends no Apple event", async () => {
    // The test's HOME is the account home this process reports (`os.homedir()`), so the fixture
    // key stands in for the person's own `~/.ssh` while the child is given a scratch HOME.
    const home = process.env.HOME!;
    const ssh = join(home, ".ssh"); mkdirSync(ssh, { recursive: true, mode: 0o700 });
    writeFileSync(join(ssh, "id_fictional"), "fictional private key\n", { mode: 0o600 }); cleanup.push(() => rmSync(ssh, { recursive: true, force: true }));
    const dir = scratch("rb-files-");
    const workroom = join(dir, "workroom"); mkdirSync(workroom);
    const runtime = join(dir, "runtime", "venv", "bin"); mkdirSync(runtime, { recursive: true });
    const worker = script(runtime, "hermes", "#!/bin/sh\necho runtime\n");
    const sitePackages = join(dir, "runtime", "venv", "lib", "python3.11", "site-packages"); mkdirSync(sitePackages, { recursive: true });
    const planted = script(workroom, "planted.sh", "#!/bin/sh\necho planted\n");
    const realHome = userInfo().homedir;
    const probe = `
      const fs = require("node:fs"), { spawnSync } = require("node:child_process");
      const attempt = fn => { try { fn(); return "ok"; } catch (e) { return "failed:" + e.code; } };
      const exec = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 10000 }); return r.status === 0 ? "ran:" + r.stdout.trim() : "failed:" + (r.error?.code ?? r.status); };
      console.log(JSON.stringify({
        workroom: attempt(() => fs.writeFileSync(${JSON.stringify(join(workroom, "note.md"))}, "x")),
        temp: attempt(() => fs.writeFileSync(require("node:path").join(process.env.TMPDIR, "t"), "x")),
        runtime: attempt(() => fs.writeFileSync(${JSON.stringify(worker)}, "#!/bin/sh\\necho replaced\\n")),
        outside: attempt(() => fs.writeFileSync(${JSON.stringify(join(dir, "outside.txt"))}, "x")),
        sshRead: attempt(() => fs.readFileSync(${JSON.stringify(join(ssh, "id_fictional"))})),
        sshList: attempt(() => fs.readdirSync(${JSON.stringify(ssh)})),
        hostSshList: attempt(() => fs.readdirSync(${JSON.stringify(join(realHome, ".ssh"))})),
        pth: attempt(() => fs.writeFileSync(${JSON.stringify(join(sitePackages, "planted.pth"))}, "import os")),
        signalParent: attempt(() => process.kill(process.ppid, 0)),
        signalSelf: attempt(() => process.kill(process.pid, 0)),
        hardlink: attempt(() => fs.linkSync(${JSON.stringify(worker)}, ${JSON.stringify(join(workroom, "alias"))})),
        hardlinkOwn: attempt(() => { fs.writeFileSync(${JSON.stringify(join(workroom, "own"))}, "x"); fs.linkSync(${JSON.stringify(join(workroom, "own"))}, ${JSON.stringify(join(workroom, "own-alias"))}); }),
        parentArgs: exec("/bin/ps", ["-o", "args=", "-p", String(process.ppid)]),
        runtimeRun: exec(${JSON.stringify(worker)}, []),
        workroomRun: exec(${JSON.stringify(planted)}, []),
        shell: exec("/bin/sh", ["-c", "echo shell"]),
        appleEvent: exec("/usr/bin/osascript", ["-e", 'tell application "Finder" to get name']),
      }));`;
    // The child's HOME is a scratch folder, as the department worker and install check give theirs.
    const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: join(dir, "scratch-home") };
    const result = await run(sandboxedLaunch(process.execPath, ["-e", probe], env, { loopbackPorts: [], writable: [workroom], executable: [runtime] }), env);
    expect(result).toEqual({ workroom: "ok", temp: "ok", runtime: "failed:EPERM", outside: "failed:EPERM", sshRead: "failed:EPERM", sshList: "failed:EPERM",
      hostSshList: expect.stringMatching(/^failed:E(PERM|NOENT)$/), pth: "failed:EPERM", signalParent: "failed:EPERM", signalSelf: "ok",
      hardlink: "failed:EPERM", hardlinkOwn: "failed:EPERM", parentArgs: expect.stringMatching(/^failed:/),
      runtimeRun: "ran:runtime", workroomRun: expect.stringMatching(/^failed:E(PERM|ACCES)$/), shell: "ran:shell", appleEvent: expect.stringMatching(/^failed:/) });
    expect(readFileSync(worker, "utf8")).toContain("echo runtime");
    expect(existsSync(join(workroom, "alias"))).toBe(false);
  }, 70_000);

  it("lets the worker write only bud-work in the workroom: no file, replacement, link or clone in the book, uploads or inputs", async () => {
    const dir = scratch("rb-book-");
    const vault = join(dir, "vault"); mkdirSync(vault);
    for (const name of ["properties", "decisions", "ask-uploads", "uploads", "workflow-inputs", BUD_WORK_FOLDER]) mkdirSync(join(vault, name), { mode: 0o700 });
    writeFileSync(join(vault, "properties", "prop-oak.md"), "# note\n");
    const protectedFile = join(dir, "protected.txt"); writeFileSync(protectedFile, "fictional protected");
    const probe = `
      const fs = require("node:fs"), path = require("node:path");
      const attempt = fn => { try { fn(); return "ok"; } catch (e) { return "failed:" + e.code; } };
      const vault = ${JSON.stringify(vault)}, out = {};
      for (const name of ["properties", "decisions", "ask-uploads", "uploads", "workflow-inputs"]) {
        out[name + ".create"] = attempt(() => fs.writeFileSync(path.join(vault, name, "planted.md"), "x"));
        out[name + ".link"] = attempt(() => fs.symlinkSync(${JSON.stringify(protectedFile)}, path.join(vault, name, "link.md")));
      }
      out.replaceNote = attempt(() => fs.writeFileSync(path.join(vault, "properties", "prop-oak.md"), "replaced"));
      out.renameNote = attempt(() => fs.renameSync(path.join(vault, "properties", "prop-oak.md"), path.join(vault, "properties", "moved.md")));
      out.rootFile = attempt(() => fs.writeFileSync(path.join(vault, "DESK-CONTEXT.md"), "x"));
      out.budWork = attempt(() => fs.writeFileSync(path.join(vault, ${JSON.stringify(BUD_WORK_FOLDER)}, "draft.md"), "x"));
      out.budWorkFolder = attempt(() => fs.mkdirSync(path.join(vault, ${JSON.stringify(BUD_WORK_FOLDER)}, "images")));
      const pending = ${JSON.stringify(join(dir, "pending"))};
      out.pendingSkills = attempt(() => fs.writeFileSync(path.join(pending, "skills", "abcd1234.json"), "{}"));
      out.pendingMemory = attempt(() => fs.writeFileSync(path.join(pending, "memory", "abcd1234.json"), "{}"));
      out.pendingOther = attempt(() => fs.writeFileSync(path.join(pending, "other", "planted.json"), "{}"));
      out.pendingRoot = attempt(() => fs.writeFileSync(path.join(pending, "planted.json"), "{}"));
      out.rmBudWork = attempt(() => fs.rmdirSync(path.join(vault, ${JSON.stringify(BUD_WORK_FOLDER)})));
      out.renameBudWork = attempt(() => fs.renameSync(path.join(vault, ${JSON.stringify(BUD_WORK_FOLDER)}), path.join(vault, "bud-work-moved")));
      out.rmPendingSkills = attempt(() => fs.rmdirSync(path.join(pending, "skills")));
      out.renamePendingSkills = attempt(() => fs.renameSync(path.join(pending, "skills"), path.join(pending, "skills-moved")));
      out.memory = attempt(() => fs.writeFileSync(${JSON.stringify(join(dir, "memories", "MEMORY.md"))}, "planted"));
      out.clone = attempt(() => fs.copyFileSync(${JSON.stringify(protectedFile)}, path.join(vault, ${JSON.stringify(BUD_WORK_FOLDER)}, "clone.txt"), fs.constants.COPYFILE_FICLONE_FORCE));
      out.readNote = attempt(() => fs.readFileSync(path.join(vault, "properties", "prop-oak.md")));
      console.log(JSON.stringify(out));`;
    const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: process.env.HOME };
    const pending = join(dir, "pending"); for (const name of ["skills", "memory", "other"]) mkdirSync(join(pending, name), { recursive: true, mode: 0o700 });
    mkdirSync(join(dir, "memories"), { mode: 0o700 }); writeFileSync(join(dir, "memories", "MEMORY.md"), "kept");
    const result = await run(sandboxedLaunch(process.execPath, ["-e", probe], env, { loopbackPorts: [], writable: [join(vault, BUD_WORK_FOLDER), join(pending, "skills"), join(pending, "memory")] }), env);
    for (const name of ["properties", "decisions", "ask-uploads", "uploads", "workflow-inputs"]) { expect(result[`${name}.create`]).toBe("failed:EPERM"); expect(result[`${name}.link`]).toBe("failed:EPERM"); }
    expect(result).toMatchObject({ replaceNote: "failed:EPERM", renameNote: "failed:EPERM", rootFile: "failed:EPERM", budWork: "ok", budWorkFolder: "ok", clone: expect.stringMatching(/^failed:/), readNote: "ok",
      pendingSkills: "ok", pendingMemory: "ok", pendingOther: "failed:EPERM", pendingRoot: "failed:EPERM",
      rmBudWork: "failed:EPERM", renameBudWork: "failed:EPERM", rmPendingSkills: "failed:EPERM", renamePendingSkills: "failed:EPERM", memory: "failed:EPERM" });
    expect(readFileSync(join(dir, "memories", "MEMORY.md"), "utf8")).toBe("kept");
    expect(existsSync(join(vault, BUD_WORK_FOLDER, "draft.md"))).toBe(true);
    expect(readFileSync(join(vault, "properties", "prop-oak.md"), "utf8")).toBe("# note\n");
    expect(existsSync(join(vault, BUD_WORK_FOLDER, "clone.txt"))).toBe(false);
  }, 30_000);

  it("refuses a launch whose writable root was replaced by a link, and a link planted later widens nothing", async () => {
    const dir = scratch("rb-link-");
    const runtime = join(dir, "runtime"); mkdirSync(runtime);
    const profile = join(dir, "profile"); mkdirSync(profile);
    symlinkSync(runtime, join(profile, "cache"));
    const env: Record<string, string | undefined> = { PATH: process.env.PATH, HOME: process.env.HOME };
    expect(() => sandboxedLaunch(process.execPath, ["-e", ""], env, { loopbackPorts: [], writable: [join(profile, "cache")] })).toThrow(NETWORK_ISOLATION_UNAVAILABLE);
    rmSync(join(profile, "cache"));
    const probe = `
      const fs = require("node:fs");
      const attempt = fn => { try { fn(); return "ok"; } catch (e) { return "failed:" + e.code; } };
      console.log(JSON.stringify({ inside: attempt(() => fs.writeFileSync(${JSON.stringify(join(profile, "cache", "own"))}, "x")),
        removeRoot: attempt(() => fs.rmSync(${JSON.stringify(join(profile, "cache"))}, { recursive: true })),
        through: attempt(() => fs.writeFileSync(${JSON.stringify(join(profile, "cache", "planted"))}, "x")) }));`;
    // The root cannot be removed or replaced from inside; a link put in its place from outside after the
    // rules were built names nothing the rules allow (they name the real folder, not what a link points at).
    const launch = sandboxedLaunch(process.execPath, ["-e", probe], env, { loopbackPorts: [], writable: [join(profile, "cache")] });
    const result = await run(launch, env);
    expect(result).toEqual({ inside: "ok", removeRoot: "failed:EPERM", through: "ok" });
    rmSync(join(profile, "cache"), { recursive: true }); symlinkSync(runtime, join(profile, "cache"));
    const planted = await run(sandboxedLaunch(process.execPath, ["-e", probe], env, { loopbackPorts: [], writable: [join(profile, "logs")] }).command === SANDBOX_EXEC
      ? { command: SANDBOX_EXEC, args: ["-p", launch.args[1], process.execPath, "-e", probe], release() {} } : launch, env);
    expect(planted).toMatchObject({ inside: "failed:EPERM", through: "failed:EPERM" });
    expect(existsSync(join(runtime, "planted"))).toBe(false);
    expect(existsSync(join(runtime, "own"))).toBe(false);
  }, 30_000);

  // Real Hermes 0.21.3: REALBUD_TEST_SANDBOX=1 REALBUD_HERMES_TEST_RUNTIME=<hermes home>/runtimes/<commit> ...
  const runtimeDir = process.env.REALBUD_HERMES_TEST_RUNTIME?.trim();
  it.runIf(runtimeDir && existsSync(join(runtimeDir, "hermes-agent", "venv", "bin", "hermes")))("runs Hermes ACP initialize, session/new and a tool-free prompt against a fake model under the final profile", async () => {
    // Private storage: every level owner-only, as the installer makes them, and
    // named by real path (the throwaway home sits under the `/var` link).
    const data = trustedPath(DATA_DIR), root = join(data, "hermes");
    for (const dir of [data, root, join(root, "runtimes")]) if (!existsSync(dir)) mkdirSync(dir, { mode: 0o700 });
    const commit = runtimeDir!.split("/").pop()!;
    symlinkSync(runtimeDir!, join(root, "runtimes", commit));
    writeFileSync(join(root, "realbud-runtime.json"), JSON.stringify({ version: 1, selected: commit, previous: null }));
    resetRuntimeSelectionForTests(); cleanup.push(() => resetRuntimeSelectionForTests());
    applyPropertyPack(root);
    const calls: string[] = [];
    let prompts = 0;
    const allowed = join(BUD_WORK_FOLDER, "x.txt"), denied = join("properties", "x.md");
    const model = createServer(async (req, res) => {
      for await (const _chunk of req) { /* drained */ }
      calls.push(`${req.method} ${req.url}`);
      if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-v4.1-flash", context_length: 128000, max_output_tokens: 32000 }] })); return; }
      const base = { id: `fictional-${calls.length}`, created: 1, model: "deepseek-v4.1-flash" };
      // First model turn: two terminal commands, one into bud-work (allowed), one into the book (denied by the OS). Then the answer.
      const delta = ++prompts === 1
        ? { role: "assistant", content: null, tool_calls: [
            { index: 0, id: "call-allowed", type: "function", function: { name: "terminal", arguments: JSON.stringify({ command: `printf fictional > ${allowed}` }) } },
            { index: 1, id: "call-denied", type: "function", function: { name: "terminal", arguments: JSON.stringify({ command: `printf planted > ${denied}` }) } }] }
        : { role: "assistant", content: "OK" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: prompts === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    });
    const port = await listen(model);
    applyManagedModelProfile(`http://127.0.0.1:${port}/v1`, { root, choice: "flash-high" });
    const vault = seedVault();
    const env: Record<string, string | undefined> = { ...process.env, PATH: augmentedPath(), REALBUD_MODEL_API_KEY: "fictional-sandbox-key" };
    hardenHermesChildEnv(env);
    // Production grants only: the test hook (which covers the temp folder this throwaway home lives in) is cleared.
    const hook = SANDBOX_TEST_WRITABLE.splice(0);
    cleanup.push(() => { SANDBOX_TEST_WRITABLE.push(...hook); });
    const launch = hermesWorkerSandbox("ask", hermesCli(), ["-p", "property", "--toolsets", "realbud_explicit_sandbox_test", "acp"], env, [port]);
    cleanup.push(() => launch.release());
    const child = spawn(launch.command, launch.args, { cwd: vault, env, stdio: ["pipe", "pipe", "pipe"] });
    cleanup.push(() => { child.kill("SIGKILL"); });
    let buffer = ""; let id = 0; const pending = new Map<number, (value: any) => void>();
    child.stderr.resume();
    child.stdout.on("data", chunk => {
      buffer += chunk; let at: number;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let message: any; try { message = JSON.parse(line); } catch { continue; }
        if (typeof message.id === "number" && pending.has(message.id)) { pending.get(message.id)!(message); pending.delete(message.id); }
        else if (message.method === "session/request_permission") {
          const option = (message.params?.options ?? []).find((item: { kind?: string }) => /allow/.test(String(item.kind)));
          child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: option ? { outcome: { outcome: "selected", optionId: option.optionId } } : { outcome: { outcome: "cancelled" } } })}\n`);
        }
      }
    });
    const send = (method: string, params: unknown) => new Promise<any>(resolve => { const n = ++id; pending.set(n, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, params })}\n`); });
    const initialized = await send("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }, clientInfo: { name: "realbud-sandbox-test", version: "1" } });
    expect(initialized.result?.agentInfo?.version).toBe("0.21.3");
    const session = await send("session/new", { cwd: vault, mcpServers: [] });
    expect(typeof session.result?.sessionId).toBe("string");
    const answer = await send("session/prompt", { sessionId: session.result.sessionId, prompt: [{ type: "text", text: "Reply with exactly OK. Do not use tools." }] });
    expect(answer.result?.stopReason).toBe("end_turn");
    expect(calls.filter(call => call === "POST /v1/chat/completions").length).toBeGreaterThanOrEqual(2);
    // The terminal ran inside the sandbox: bud-work took the file, the book did not.
    expect(readFileSync(join(vault, allowed), "utf8")).toBe("fictional");
    expect(existsSync(join(vault, denied))).toBe(false);
    expect(existsSync(join(root, "profiles", "property", "state.db"))).toBe(true);
    expect(readFileSync(join(root, "profiles", "property", "config.yaml"), "utf8")).toContain("mode: manual");
  }, 120_000);
});
