// OS boundary for every Hermes worker process RealBud starts: the Ask worker
// (Hermes ACP), the one-shot CLI jobs, the department worker and the
// diagnostic `--version` / install checks.
//
// Hermes asks RealBud only for commands its dangerous-pattern detector flags
// (tools/approval.py `check_all_command_guards`), so `curl -d @file`, a
// script, or a stdio tool could send office data anywhere without a card,
// and a script could overwrite the runtime's own `venv/bin/hermes` for the
// next unsandboxed launch to run. On macOS every worker therefore runs under
// `sandbox-exec` (Seatbelt) with:
//   network   no outbound connection at all (public hosts, other loopback
//             ports such as RealBud's API or the work browser's DevTools port,
//             Unix sockets, DNS) except the loopback ports RealBud names at
//             launch; nothing inbound or bound.
//   writes    only the folders the launch names: the worker's workroom, its
//             own session/state folders and a private temp folder made per
//             launch. The runtime, the profile's policy files, RealBud's
//             records and everything else are read-only.
//   reads     the person's credential stores (`~/.ssh`, `~/.aws`, keychains,
//             Chrome's profile, ...) and whatever the launch marks private.
//   exec      system programs, the launched program and its interpreter, and
//             the folders the launch names; never the workroom or temp.
//   services  Mach lookups only for what Python and Node need; no Launch
//             Services (`open`), launchd jobs or raw sockets, and the
//             scripting tools (`osascript`, ...) refused by name, since this
//             macOS does not enforce `appleevent-send` for sandbox-exec.
// Children inherit the profile. A missing or refusing `sandbox-exec` refuses
// the launch; there is no unconfined fallback.
//
// Windows and Linux have no equivalent here yet: there the pack's
// `approvals.deny` globs (server/hermes-pack.ts WORKER_DENIED_COMMANDS) are a
// blocklist, not a boundary. Windows needs a per-program firewall rule.
import { spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readlinkSync, readSync, realpathSync, rmSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, parse, resolve } from "node:path";
import { recordWorkerCustody, releaseWorkerCustody, workerCustodyRefusal } from "./worker-custody.ts";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/** Office copy while Bud's private setup is being removed. */
export const WORKERS_HELD = "Bud is being removed from this computer right now. Wait for that to finish, then try again.";

// Every sandboxed process group this process started and has not confirmed
// stopped, so uninstall can wait for descendants as well as their leaders.
const liveChildren = new Set<ChildProcess>();
const stoppingChildren = new Map<ChildProcess, Promise<void>>();
let launchesHeld = false;
export function workerLaunchesHeld(): boolean { return launchesHeld; }
/** While held, every sandboxed launch (and every Ask turn) is refused. */
export function setWorkerLaunchesHeld(held: boolean): void { launchesHeld = held; }
/** Register a child made from a `sandboxedLaunch` so the stopper finds it. */
export function trackSandboxedChild<T extends ChildProcess | null>(child: T): T {
  if (!child || child.exitCode !== null || child.signalCode !== null) return child;
  liveChildren.add(child);
  // Durable before the caller hands the worker any work. A worker whose
  // custody could not be saved is stopped rather than left unrecorded.
  if (child.pid && !recordWorkerCustody(child.pid)) {
    try { if (process.platform === "win32") child.kill("SIGKILL"); else process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
  // A leader's exit does not prove its process group is gone. Keep ownership
  // until every descendant has stopped, including on ordinary worker exit.
  child.once("exit", () => { void stopSandboxedChild(child, 5_000).catch(() => { /* retained for an explicit stop to retry/refuse */ }); });
  child.once("error", () => { if (!child.pid) liveChildren.delete(child); });
  return child;
}
/** SIGTERM every live sandboxed child's process group, wait for each to exit,
 * and SIGKILL whatever is still there at the deadline. Resolves once none
 * are running. */
export async function stopSandboxedChildren(deadlineMs = 5_000): Promise<void> {
  await Promise.all([...liveChildren].map(child => stopSandboxedChild(child, deadlineMs)));
}

function stopSandboxedChild(child: ChildProcess, deadlineMs: number): Promise<void> {
  const existing = stoppingChildren.get(child);
  if (existing) return existing;
  const stopped = (async () => {
    const pid = child.pid;
    if (!pid) { liveChildren.delete(child); return; }
    const leaderAlive = () => child.exitCode === null && child.signalCode === null;
    const groupAlive = () => {
      if (process.platform === "win32") return false;
      try { process.kill(-pid, 0); return true; }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ESRCH") return false;
        // Darwin returns EPERM while an exited group still contains an
        // unreaped zombie. It is unknown, never proof that the group is gone.
        if (code === "EPERM") return true;
        throw error;
      }
    };
    const signal = (name: NodeJS.Signals): boolean => {
      if (process.platform !== "win32") {
        try { process.kill(-pid, name); return true; }
        catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code === "EPERM") return false;
          if (code !== "ESRCH") throw error;
        }
      }
      if (leaderAlive()) child.kill(name);
      return true;
    };
    const forceAt = Date.now() + deadlineMs;
    let signalName: NodeJS.Signals = "SIGTERM";
    let signalPending = !signal(signalName);
    while (groupAlive() || leaderAlive()) {
      if (signalName === "SIGTERM" && Date.now() >= forceAt) { signalName = "SIGKILL"; signalPending = true; }
      // Retry refused signals within the same bound, including SIGKILL.
      if (signalPending) signalPending = !signal(signalName);
      if (Date.now() >= forceAt + 2_000) {
        throw new Error("Bud's worker processes have not stopped. Its private setup was kept; try removing it again.");
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    liveChildren.delete(child);
    void releaseWorkerCustody(pid);
  })();
  stoppingChildren.set(child, stopped);
  void stopped.finally(() => stoppingChildren.delete(child)).catch(() => {});
  return stopped;
}

export const NETWORK_ISOLATION_UNAVAILABLE =
  "This computer can't isolate Bud's network, so Bud was not started. Restart RealBud; if this keeps happening, contact RealBud support.";

/** Credential and private-data locations under the person's home that no
 * worker may read, whatever its job. */
/** Test-only: extra writable roots for the fakes' evidence files. Honoured
 * only under vitest; production never reads it. */
export const SANDBOX_TEST_WRITABLE: string[] = [];

export const PRIVATE_HOME_PATHS = [
  ".ssh", ".aws", ".config/gcloud", ".config/gh", ".gnupg", ".netrc", ".kube", ".docker",
  // Other agents' logins (Hermes 0.21.3 probes `~/.claude` for one), and the
  // person's own Hermes home.
  ".claude", ".codex", ".hermes",
  "Library/Keychains", "Library/Cookies", "Library/Application Support/Google/Chrome",
] as const;

/** Kernel values a worker may read (see the sysctl rule below). */
const SYSCTL_PREFIXES = ["hw.", "kern.os", "machdep.cpu", "vm."] as const;
const SYSCTL_NAMES = ["kern.version", "kern.hostname", "kern.bootargs", "kern.iossupportversion", "kern.boottime", "kern.argmax",
  "kern.maxfilesperproc", "kern.usrstack64", "kern.tcsm_available", "kern.tcsm_enable", "security.mac.lockdown_mode_state",
  "sysctl.proc_cputype", "sysctl.proc_native"] as const;

/** Program folders every worker may run from. */
const SYSTEM_EXEC_DIRS = ["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/libexec"] as const;

/** System programs no worker may run: on macOS 26 Seatbelt's
 * `appleevent-send` rule does not stop an Apple event from a `sandbox-exec`
 * process (checked: `osascript` reached Finder under `(deny default)` with
 * no Apple-event allow), so the scripting, launching, scheduling and
 * credential tools are refused by name. A blocklist, not a boundary: Python
 * could still speak to the Apple event service itself. */
const DENIED_SYSTEM_PROGRAMS = [
  "/usr/bin/osascript", "/usr/bin/osacompile", "/usr/bin/osadecompile", "/usr/bin/automator", "/usr/bin/open",
  "/bin/launchctl", "/usr/bin/at", "/usr/bin/batch", "/usr/bin/crontab", "/usr/bin/security", "/usr/bin/tccutil",
  "/usr/sbin/systemsetup", "/usr/sbin/networksetup", "/usr/bin/defaults",
] as const;

/** Mach services a worker asked for while Hermes 0.21.3 ACP ran a full
 * initialize, session/new and prompt round trip under `(deny mach-lookup)`
 * with denial logging on macOS 26: user lookup, notifications and logging.
 * Launch Services, Apple events, the pasteboard, TCC, SystemConfiguration
 * and every other service stay unreachable. */
const MACH_SERVICES = [
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.notification_center",
  "com.apple.logd",
] as const;

export interface WorkerSandboxSpec {
  /** Loopback TCP ports the worker may connect to. Empty means no network. */
  loopbackPorts: readonly number[];
  /** Folders (or files) the worker may create, change and delete under. The
   * launch's private temp folder is added. */
  writable: readonly string[];
  /** Files the worker may write, as Seatbelt regexes over real paths (for
   * the temp names an atomic write uses beside its target). Seatbelt's regex
   * has no `{m,n}`; a backslash escapes as written. */
  writablePatterns?: readonly string[];
  /** Folders inside which hard links may be made (source under one of them):
   * only for RealBud's own helpers whose atomic publish uses `link(2)` within
   * their one writable tree; a worker launch never names any. */
  links?: readonly string[];
  /** Program folders the worker may run from, beyond the system ones, the
   * launched program's own folder and its interpreter's. */
  executable?: readonly string[];
  /** Ordered read rules, later wins: `["deny", dir]` hides a tree,
   * `["allow", dir]` reopens part of it. The person's credential stores are
   * denied after these, whatever they say. */
  reads?: ReadonlyArray<readonly ["allow" | "deny", string]>;
}

/**
 * The path Seatbelt will match for `path`, with only the OS's own aliases
 * resolved (`/tmp` → `/private/tmp`, `/var` → `/private/var`: links owned by
 * root). A link owned by anyone else anywhere in the chain refuses the launch:
 * a worker that replaced `profile/cache` with a link to the runtime would
 * otherwise turn the next launch's "cache" rule into runtime writes. Missing
 * tail components are kept literally. The result is never a worker-chosen
 * expansion, so a link planted after this check cannot widen the rule either:
 * writes through it resolve to a path the rule does not name.
 */
export function trustedPath(path: string): string {
  const absolute = resolve(path);
  const { root } = parse(absolute);
  let current = root;
  const pending = absolute.slice(root.length).split("/").filter(Boolean);
  while (pending.length) {
    const next = join(current, pending.shift()!);
    let stat;
    try { stat = lstatSync(next); } catch { return join(next, ...pending); }
    if (!stat.isSymbolicLink()) { current = next; continue; }
    if (stat.uid !== 0) throw new Error(NETWORK_ISOLATION_UNAVAILABLE);
    const target = resolve(dirname(next), readlinkSync(next));
    const { root: targetRoot } = parse(target);
    current = targetRoot;
    pending.unshift(...target.slice(targetRoot.length).split("/").filter(Boolean));
  }
  return current;
}

/**
 * A root RealBud hands a worker (or Hermes insists on) is a real folder of
 * ours: made owner-only when missing, and when present a plain directory
 * owned by this process (its mode brought back to 0700 through a no-follow
 * descriptor). A link, a file, another owner or any other creation error
 * refuses the launch; nothing is created through a link because the
 * ancestry was already resolved by `trustedPath`.
 */
export function ensurePrivateRoot(path: string): string {
  const trusted = trustedPath(path);
  try { mkdirSync(trusted, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(NETWORK_ISOLATION_UNAVAILABLE); }
  let fd: number;
  try { fd = openSync(trusted, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0)); }
  catch { throw new Error(NETWORK_ISOLATION_UNAVAILABLE); }
  try {
    const stat = fstatSync(fd);
    if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid())) throw new Error(NETWORK_ISOLATION_UNAVAILABLE);
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) fchmodSync(fd, 0o700);
  } finally { closeSync(fd); }
  return trusted;
}

/** A path as a literal inside a Seatbelt regex (its own escapes, not JS's). */
export const regexLiteral = (path: string): string => path.replace(/[.*+?^${}()|[\]\\"]/g, c => `\\${c}`);
const quote = (path: string): string => `"${path.replace(/[\\"]/g, c => `\\${c}`)}"`;
const subpaths = (paths: readonly string[]): string => paths.map(path => `(subpath ${quote(trustedPath(path))})`).join("");

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/** The interpreter a `#!` script names: `#!/usr/bin/env node` through PATH,
 * `#!/abs/python` as given. Pip uses a fixed shell trampoline when a Python
 * path is too long for a shebang; admit only that exact sibling interpreter,
 * never a general shell command. A native program has none. */
export function scriptInterpreter(command: string, path = process.env.PATH ?? ""): string | null {
  let lines: string[];
  try {
    const fd = openSync(command, "r");
    try { const buffer = Buffer.alloc(4096); lines = buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString("utf8").split("\n", 3); }
    finally { closeSync(fd); }
  } catch { return null; }
  const line = lines[0] ?? "";
  if (!line.startsWith("#!")) return null;
  if (line === "#!/bin/sh" && lines[2] === "' '''") {
    const trampoline = /^'''exec' (?:'([^'\r\n]+)'|(\/[^\s'"]+)) "\$0" "\$@"$/.exec(lines[1] ?? "");
    const python = trampoline?.[1] ?? trampoline?.[2];
    // No shell expansion or alternate program is accepted, even inside a
    // quoted path. Resolving the sibling symlink supplies the same execution
    // root a direct Python shebang would name (for example uv's Python).
    const pythonName = /^python(?:\d+(?:\.\d+)?)?$/;
    if (python && isAbsolute(python) && resolve(python) === python && !/[\u0000-\u001f\u007f'"\\$`;&|<>(){}\[\]*?!~]/.test(python) && pythonName.test(basename(python))) {
      try {
        const resolved = realpathSync(python);
        if (realpathSync(dirname(python)) === realpathSync(dirname(command)) && pythonName.test(basename(resolved))) return resolved;
      } catch { /* A missing or malformed trampoline receives no extra grant. */ }
    }
  }
  const words = line.slice(2).trim().split(/\s+/).filter(Boolean);
  let program = words[0];
  if (!program) return null;
  if (basename(program) === "env") {
    const named = words.slice(1).find(word => !word.startsWith("-"));
    if (!named) return null;
    if (isAbsolute(named)) program = named;
    else {
      const found = path.split(delimiter).filter(Boolean).map(dir => join(dir, named)).find(candidate => { try { realpathSync(candidate); return true; } catch { return false; } });
      if (!found) return null;
      program = found;
    }
  }
  return realpathSync(program);
}

/**
 * The Seatbelt profile for one worker launch. `command` is the program the
 * launch runs (its folder and its interpreter's are exec-allowed, since the
 * launch cannot work otherwise); `tmp` is the private temp folder.
 */
export function workerSandboxProfile(command: string, tmp: string, spec: WorkerSandboxSpec, env: { PATH?: string; HOME?: string } = process.env): string {
  const ports = [...new Set(spec.loopbackPorts)].sort((a, b) => a - b);
  if (ports.some(port => !validPort(port))) throw new Error(NETWORK_ISOLATION_UNAVAILABLE);
  if (!spec.writable.every(Boolean) || !tmp) throw new Error(NETWORK_ISOLATION_UNAVAILABLE);
  if (spec.writable.some(path => !isAbsolute(path))) throw new Error(NETWORK_ISOLATION_UNAVAILABLE);
  // The program and its interpreter are read-only files run by their real
  // location (the venv's `python` is itself a link into the uv install).
  const program = realpathSync(command);
  const interpreter = scriptInterpreter(program, env.PATH);
  const execDirs = [...SYSTEM_EXEC_DIRS, dirname(program), ...(interpreter ? [dirname(interpreter)] : []), ...(spec.executable ?? [])];
  // The signed-in account's credential stores are hidden whatever HOME the
  // child was given (a scratch HOME must not unhide the real one), and the
  // child's own home gets the same treatment.
  const homes = new Set([userInfo().homedir, homedir(), env.HOME?.trim()].filter((home): home is string => !!home));
  // A hidden tree still answers `stat` on its own node: Hermes checks every
  // ancestor of its home for a link before it starts, and the node's own
  // metadata reveals nothing of what is under it.
  const reads = (spec.reads ?? []).map(([rule, path]) => {
    const real = trustedPath(path), quoted = quote(real);
    if (rule === "deny") return `(deny file-read* (subpath ${quoted}))(allow file-read-metadata (literal ${quoted}))`;
    // The host's safe readers lstat every ancestor to reject planted links.
    // A reopened child needs those exact directory nodes visible, without
    // exposing directory listings or sibling file contents in a denied tree.
    const ancestors: string[] = [];
    for (let parent = dirname(real); parent !== dirname(parent); parent = dirname(parent)) ancestors.push(parent);
    return `(allow file-read* (subpath ${quoted}))` + (ancestors.length ? `(allow file-read-metadata ${ancestors.map(parent => `(literal ${quote(parent)})`).join("")} )` : "");
  }).join("");
  return [
    "(version 1)",
    "(allow default)",
    // Network: nothing out, in or bound, except the named loopback ports.
    "(deny network*)",
    // `ip4`: IPv4 loopback only, where RealBud's relay and brokers listen;
    // `[::1]:port` is somebody else's socket (Seatbelt names no address but
    // `localhost`; 0.0.0.0 reaches loopback and is allowed the same ports).
    ...ports.map(port => `(allow network-outbound (remote ip4 "localhost:${port}"))`),
    "(deny system-socket)",
    // No Apple events, Launch Services (`open`), launchd jobs or new Mach services.
    "(deny appleevent-send)",
    "(deny lsopen)",
    "(deny job-creation)",
    "(deny mach-register)",
    "(deny mach-lookup)",
    `(allow mach-lookup ${MACH_SERVICES.map(name => `(global-name ${quote(name)})`).join("")})`,
    // Programs: system folders, the launched program, its interpreter and the
    // folders the launch names. Nothing from the workroom or temp.
    "(deny process-exec*)",
    `(allow process-exec* ${subpaths(execDirs)})`,
    `(deny process-exec* ${DENIED_SYSTEM_PROGRAMS.map(path => `(literal ${quote(path)})`).join("")})`,
    // Writes: only the launch's folders (verified real folders) and the private temp folder.
    "(deny file-write*)",
    // No new names for existing files: a hard link to a protected file inside
    // a writable folder would be a worker-readable alias of it.
    "(deny file-link)",
    // No clones either: a copy-on-write clone of a protected file into a
    // writable folder would be a readable copy of it.
    "(deny file-clone)",
    ...(spec.links?.length ? [`(allow file-link ${subpaths(spec.links)})`] : []),
    // Each root's children only: `(subpath X)` would also match X itself and
    // let the worker remove or replace the root RealBud verified.
    `(allow file-write* ${spec.writable.map(ensurePrivateRoot).map(root => `(regex #"^${regexLiteral(root)}/")`).join("")}${subpaths([tmp])}${(spec.writablePatterns ?? []).map(pattern => `(regex #"${pattern.replace(/"/g, '\\"')}")`).join("")})`,
    '(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper"))',
    // Reads: the launch's own rules, then the person's credential stores.
    reads,
    `(deny file-read* ${subpaths([...homes].flatMap(home => PRIVATE_HOME_PATHS.map(name => join(home, name))))})`,
    // Processes: signals and inspection stay inside the sandbox (no stopping
    // RealBud or reading another process's environment), no task ports, no
    // kernel tuning. `(allow default)` remains for everything else: Hermes
    // and Python touch too many operations for a deny-default list to be
    // reviewed in one packet; each class above is denied by name instead.
    "(deny signal)(allow signal (target same-sandbox))",
    "(deny process-info*)(allow process-info* (target same-sandbox))",
    "(deny mach-priv*)",
    // Kernel values by name only: what Python's `uname`/`cpu_count` and Node's
    // start-up read (found with denial logging); no process tables, so no
    // other process's arguments or environment (`kern.procargs2`, `kern.proc`).
    "(deny sysctl*)",
    `(allow sysctl-read ${SYSCTL_NAMES.map(name => `(sysctl-name ${quote(name)})`).join("")}${SYSCTL_PREFIXES.map(prefix => `(sysctl-name-prefix ${quote(prefix)})`).join("")})`,
    '(deny sysctl-read (sysctl-name-prefix "kern.proc"))',
  ].join("");
}

export interface SandboxDeps {
  platform?: NodeJS.Platform;
  /** True when sandbox-exec accepts the profile and runs a trivial program. */
  probe?: (profile: string) => boolean;
}

function probeSandbox(profile: string): boolean {
  const result = spawnSync(SANDBOX_EXEC, ["-p", profile, "/usr/bin/true"], { stdio: "ignore", timeout: 5_000 });
  return !result.error && result.status === 0;
}

export interface SandboxedLaunch {
  command: string;
  args: string[];
  /** Removes the launch's private temp folder; call once the process ended. */
  release(): void;
}

/**
 * The launch for one worker. macOS wraps it in `sandbox-exec` with the
 * profile above and points the worker's temp variables at a private folder,
 * or refuses when sandbox-exec is missing or rejects the profile; never an
 * unconfined fallback. Other platforms launch unchanged (see the file note).
 * `env` is the child's environment and is changed in place.
 */
export function sandboxedLaunch(command: string, args: readonly string[], env: Record<string, string | undefined>, spec: WorkerSandboxSpec, deps: SandboxDeps = {}): SandboxedLaunch {
  if (launchesHeld) throw new Error(WORKERS_HELD);
  // Work from an earlier run whose stop was never confirmed may overlap this one.
  const custody = workerCustodyRefusal();
  if (custody) throw new Error(custody);
  if ((deps.platform ?? process.platform) !== "darwin") return { command, args: [...args], release() {} };
  // A missing program fails as a plain spawn would (ENOENT), not as a
  // sandbox refusal: setup copy depends on telling the two apart.
  const program = command.includes("/") ? command
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map(dir => join(dir, command)).find(candidate => { try { accessSync(candidate, constants.X_OK); return true; } catch { return false; } });
  if (!program || !(() => { try { accessSync(program, constants.X_OK); return true; } catch { return false; } })()) {
    throw Object.assign(new Error(`spawn ${command} ENOENT`), { code: "ENOENT" });
  }
  const tmp = mkdtempSync(join(tmpdir(), "realbud-worker-"));
  const release = () => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* already gone */ } };
  try {
    const profile = workerSandboxProfile(program, tmp, spec, env);
    if (!(deps.probe ?? probeSandbox)(profile)) throw new Error(NETWORK_ISOLATION_UNAVAILABLE);
    env.TMPDIR = tmp; env.TMP = tmp; env.TEMP = tmp;
    return { command: SANDBOX_EXEC, args: ["-p", profile, program, ...args], release };
  } catch (error) { release(); throw error; }
}

/** Loopback ports held for one worker driver. A turn mounts at most ten
 * brokers and eight sessions stay warm, so this covers the usual worst case;
 * past it a turn fails rather than use an unlisted port. */
export const BROKER_PORT_POOL_SIZE = 96;

export const BROKER_PORTS_EXHAUSTED = "Bud has too many conversations open right now. Wait a minute, then try again.";

export interface BrokerPortPool {
  ports: number[];
  /** A pool URL that forwards to one loopback broker, or null for any other
   * server. Throws when every pool port is in use. */
  mount(url: string): { url: string; release(): void } | null;
  close(): void;
}

/** Ports bound and held from driver creation, so every worker's sandbox
 * profile can name them before any per-turn broker exists. Each broker keeps
 * its own random port and bearer token; while mounted, one pool port forwards
 * to it unchanged (Host set to the broker's own). A released port drops every
 * new request, as the closed broker's own port would, and goes to the back of
 * the queue so the next mount gets a different URL. */
export async function startBrokerPortPool(size = BROKER_PORT_POOL_SIZE): Promise<BrokerPortPool> {
  const slots: Array<{ port: number; server: Server; target: URL | null }> = [];
  const close = () => { for (const slot of slots) { slot.target = null; slot.server.closeAllConnections(); slot.server.close(); } };
  try {
    for (let n = 0; n < size; n++) {
      const slot: { port: number; server: Server; target: URL | null } = { port: 0, server: createServer((req, res) => {
        const target = slot.target;
        if (!target) { req.socket.destroy(); return; }
        const headers = { ...req.headers, host: target.host };
        delete headers.connection;
        const upstream = request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers, agent: false }, reply => {
          res.writeHead(reply.statusCode ?? 502, reply.headers);
          reply.pipe(res);
        });
        upstream.on("error", () => { if (!res.headersSent) req.socket.destroy(); else res.destroy(); });
        res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
        req.pipe(upstream);
      }), target: null };
      slots.push(slot);
      await new Promise<void>((resolve, reject) => { slot.server.once("error", reject); slot.server.listen(0, "127.0.0.1", () => { slot.server.off("error", reject); resolve(); }); });
      slot.server.unref();
      const address = slot.server.address();
      if (!address || typeof address === "string") throw new Error(NETWORK_ISOLATION_UNAVAILABLE);
      slot.port = address.port;
    }
  } catch (error) { close(); throw error; }
  const free = [...slots];
  return {
    ports: slots.map(slot => slot.port),
    mount(url) {
      let target: URL;
      try { target = new URL(url); } catch { return null; }
      if (target.protocol !== "http:" || target.hostname !== "127.0.0.1") return null;
      const slot = free.shift();
      if (!slot) throw new Error(BROKER_PORTS_EXHAUSTED);
      slot.target = target;
      let released = false;
      return {
        url: `http://127.0.0.1:${slot.port}${target.pathname}${target.search}`,
        release() {
          if (released) return;
          released = true;
          // New requests are dropped; one already forwarded ends as the broker ends it.
          slot.target = null;
          free.push(slot);
        },
      };
    },
    close,
  };
}
