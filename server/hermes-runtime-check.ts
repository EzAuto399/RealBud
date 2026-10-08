import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { augmentedPath } from "./env-path.ts";
import { execCli, killCliTree, spawnCli } from "./procs.ts";
import { hermesHome, runtimeCli } from "./hermes-paths.ts";
import { HERMES_RELEASES, type HermesRelease } from "./hermes-releases.ts";
import { runtimeCommit, selectedHermesCli } from "./hermes-runtime-selection.ts";
import { BootstrapError } from "./worker-bootstrap.ts";
import { windowsHermesGit, windowsHermesRuntimeEnv } from "./hermes-runtime-env.ts";
import { documentToolsStatus, type DocumentToolsStatus } from "./hermes-document-deps.ts";
import { DATA_DIR } from "./config.ts";
import { sandboxedLaunch, type SandboxedLaunch } from "./worker-network-sandbox.ts";

/** The check could not run right now (worker custody, a launch hold, a
 * timeout, a process that could not start). It says nothing about the files:
 * never cached as damage and never a reason to replace the runtime. */
export class RuntimeCheckUnavailable extends BootstrapError {}

function command(command: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => execCli(command, args, { env, timeout, maxBuffer: 64_000 }, (error, stdout) => {
    if (!error) { resolve(String(stdout).trim()); return; }
    // A non-zero exit or oversized output is the runtime's answer; a timeout
    // or a spawn error (string code) is not.
    const failure = error as NodeJS.ErrnoException & { killed?: boolean };
    const unavailable = failure.killed || (typeof failure.code === "string" && failure.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
    reject(new (unavailable ? RuntimeCheckUnavailable : BootstrapError)("The downloaded agent did not pass its integrity check. Your current agent is kept."));
  }));
}

/** The downloaded agent runs its checks as a worker would: no network,
 * writes only to the scratch folder, reads of RealBud's data only for the
 * release being checked. A refusing sandbox fails the check. */
function checkedLaunch(home: string, scratch: string, cli: string, args: string[], env: NodeJS.ProcessEnv): SandboxedLaunch {
  try { return sandboxedLaunch(cli, args, env, { loopbackPorts: [], writable: [scratch], reads: [["deny", DATA_DIR], ["allow", home]] }); }
  catch { throw new RuntimeCheckUnavailable("The downloaded agent could not be checked in isolation. Your current agent is kept."); }
}

/** No provider call or office profile access. Verify source and ACP startup.
 * Document libraries are import-checked for `documentTools` only: their
 * absence reads "Document tools need Repair." and never fails the worker. */
export async function verifyRuntime(home: string, release: HermesRelease, options: {
  documentTools?: (status: DocumentToolsStatus) => void; checkDocuments?: typeof documentToolsStatus;
  /** Per command and for the connection check; tests shorten it. */
  timeoutMs?: number;
} = {}): Promise<string> {
  const timeout = options.timeoutMs ?? 30_000;
  const scratch = mkdtempSync(join(tmpdir(), "realbud-runtime-check-"));
  let env: NodeJS.ProcessEnv = {
    PATH: augmentedPath(), HOME: scratch, HERMES_HOME: scratch, HERMES_MANAGED_DIR: scratch,
    ...(process.platform === "win32" ? { SYSTEMROOT: process.env.SYSTEMROOT, WINDIR: process.env.WINDIR, TEMP: scratch, TMP: scratch, USERPROFILE: scratch } : { TMPDIR: scratch }),
    HERMES_ACP_SKIP_CONFIGURED_MCP: "1", HERMES_SAFE_MODE: "1", PYTHONNOUSERSITE: "1", PYTHONDONTWRITEBYTECODE: "1",
    LITELLM_LOCAL_MODEL_COST_MAP: "True", HF_HUB_OFFLINE: "1",
  };
  if (process.platform === "win32") env = windowsHermesRuntimeEnv(home, env);
  try {
    const repo = join(home, "hermes-agent");
    const git = process.platform === "win32" ? windowsHermesGit(home) : "git";
    // The checkout has files past Windows' MAX_PATH; without longpaths Git cannot
    // read them and reports them as modified (seen once on a fresh Windows 11).
    const repoGit = ["-c", "core.longpaths=true", "-C", repo];
    if (await command(git, [...repoGit, "rev-parse", "HEAD"], env, timeout) !== release.commit) throw new BootstrapError("The downloaded source does not match the reviewed release. Your current agent is kept.");
    // Upstream/environment contribution accounting can stamp email metadata
    // during an official install. It is not executable agent code.
    const changed = await command(git, [...repoGit, "diff", "--name-only", "HEAD", "--"], env, timeout);
    const modified = changed.split("\n").filter(Boolean).filter(path => !/^contributors\/emails\/[^/]+$/.test(path));
    if (modified.length) {
      // Repository-relative names only, so a one-off on a customer machine can be traced.
      console.warn(`[${new Date().toISOString()}] Bud runtime check: ${modified.length} modified source file(s): ${modified.slice(0, 5).join(", ").slice(0, 300)}`);
      throw new BootstrapError("The downloaded agent contains modified source files. Your current agent is kept.");
    }
    const versionLaunch = checkedLaunch(home, scratch, runtimeCli(home), ["--version"], env);
    const version = await command(versionLaunch.command, versionLaunch.args, env, timeout).finally(() => versionLaunch.release());
    const acpLaunch = checkedLaunch(home, scratch, runtimeCli(home), ["--toolsets", "realbud_runtime_check", "acp"], env);
    await new Promise<void>((resolve, reject) => {
      const child = spawnCli(acpLaunch.command, acpLaunch.args, { env, cwd: scratch, stdio: ["pipe", "pipe", "pipe"] });
      let buffer = ""; let passed = false; let failed = false; let timedOut = false;
      let forceStop: ReturnType<typeof setTimeout> | undefined;
      const stop = () => {
        killCliTree(child);
        if (!forceStop && process.platform !== "win32") forceStop = setTimeout(() => {
          if (!child.pid) return;
          try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
        }, 2000);
      };
      const timer = setTimeout(() => { failed = true; timedOut = true; stop(); }, timeout);
      child.stderr?.resume();
      child.stdin?.on("error", () => { failed = true; stop(); });
      child.stdout?.on("data", chunk => {
        buffer += String(chunk);
        if (buffer.length > 64_000) { failed = true; stop(); return; }
        let index: number;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
          try {
            const response = JSON.parse(line);
            if (response.id === 1) { passed = response.result?.protocolVersion === 1; failed = !passed; stop(); }
          } catch { failed = true; stop(); }
        }
      });
      child.once("error", () => { clearTimeout(timer); if (forceStop) clearTimeout(forceStop); acpLaunch.release(); reject(new RuntimeCheckUnavailable("The downloaded agent could not start. Your current agent is kept.")); });
      child.once("close", () => {
        clearTimeout(timer);
        if (forceStop) clearTimeout(forceStop);
        acpLaunch.release();
        if (passed && !failed) resolve();
        // A slow start (antivirus, a busy disk) is not a wrong answer.
        else reject(new (timedOut ? RuntimeCheckUnavailable : BootstrapError)("The downloaded agent did not pass the connection check. Your current agent is kept."));
      });
      child.stdin?.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "realbud-runtime-check", version: "1" } } }) + "\n");
    });
    if (options.documentTools) options.documentTools(await (options.checkDocuments ?? documentToolsStatus)(home));
    return version;
  } finally { rmSync(scratch, { recursive: true, force: true }); }
}

// ── Runtime integrity for readiness (M3) ─────────────────────────────────
// The same source and ACP checks as installation, run against the runtime
// this process launches: at boot, at Repair and before generation admission.
// A damaged runtime that still answers --version stays not ready, and is kept
// on disk while a replacement is staged.

/** `unavailable`: the check could not run just now; turns wait, nothing is replaced. */
export type RuntimeIntegrity = "ok" | "damaged" | "unavailable" | "unknown" | "not_applicable";
export const RUNTIME_DAMAGED = "Bud’s private runtime failed its safety check, so Bud is paused. Your files are kept. Repair Bud to replace it.";
export const RUNTIME_UNCHECKED = "Bud couldn’t check its private runtime just now, so this request is waiting. Try again in a moment; nothing was changed.";
/** ponytail: damage is re-checked after this long; in-place edits between
 * checks are found at the next boot, Repair or replaced runtime, not on
 * every turn. */
const DAMAGED_RECHECK_MS = 10 * 60_000;
/** Background re-check of a check that could not run. Generation admission retries at once. */
const UNAVAILABLE_RETRY_MS = 30_000;
type IntegrityResult = { state: "ok" | "damaged" | "unavailable"; at: number };
const integrityResults = new Map<string, IntegrityResult>();
const integrityChecks = new Map<string, Promise<RuntimeIntegrity>>();
let integrityGeneration = 0;

/** Which runtime on disk this CLI is: a replaced folder or executable,
 * including one of the same version, reads as a different runtime. */
export function runtimeIdentity(cli: string): string {
  try {
    const file = lstatSync(cli), folder = lstatSync(dirname(dirname(dirname(dirname(cli)))));
    return [cli, file.dev, file.ino, file.size, file.mtimeMs, folder.ino, folder.birthtimeMs].join(":");
  } catch { return `${cli}:missing`; }
}

/** The RealBud-selected runtime behind `cli`, with the release it must match.
 * A custom, personal or legacy worker has no reviewed source to compare. */
function ownedRuntime(cli: string, home: string): { runtime: string; release: HermesRelease } | null {
  const runtime = dirname(dirname(dirname(dirname(cli))));
  if (dirname(runtime) !== join(home, "runtimes") || runtimeCli(runtime) !== cli || !/^[a-f0-9]{40}(?:-[a-f0-9]{12})?$/.test(basename(runtime))) return null;
  const release = HERMES_RELEASES.find(entry => entry.commit === runtimeCommit(basename(runtime)));
  return release ? { runtime, release } : null;
}

type IntegrityOptions = { cli?: string; root?: string; verify?: typeof verifyRuntime };
const target = (opts: IntegrityOptions) => {
  if (process.env.REALBUD_HERMES_CLI?.trim() && !opts.cli) return null;
  const home = hermesHome(opts.root), cli = opts.cli ?? selectedHermesCli(home);
  const owned = ownedRuntime(cli, home), key = runtimeIdentity(cli);
  // A runtime that is not there reads as missing (status), not as damaged.
  return owned && !key.endsWith(":missing") ? { ...owned, key } : null;
};
const fresh = (known: IntegrityResult | undefined, retryUnavailable = false) => {
  if (!known || known.state === "ok") return known?.state;
  const age = Date.now() - known.at;
  if (known.state === "damaged") return age < DAMAGED_RECHECK_MS ? known.state : undefined;
  return !retryUnavailable && age < UNAVAILABLE_RETRY_MS ? known.state : undefined;
};

/** Cached state for status polls; an unchecked runtime starts its check in the background. */
export function runtimeIntegrity(opts: IntegrityOptions = {}): RuntimeIntegrity {
  const owned = target(opts);
  if (!owned) return "not_applicable";
  const known = integrityResults.get(owned.key);
  if (fresh(known)) return known!.state;
  // A failed runtime stays failed while its re-check runs.
  void checkRuntimeIntegrity(opts);
  return known?.state ?? "unknown";
}

/** Runs the check (once at a time per runtime) unless a current result exists. */
export function checkRuntimeIntegrity(opts: IntegrityOptions & { force?: boolean; retryUnavailable?: boolean } = {}): Promise<RuntimeIntegrity> {
  const owned = target(opts);
  if (!owned) return Promise.resolve("not_applicable");
  const known = opts.force ? undefined : fresh(integrityResults.get(owned.key), opts.retryUnavailable);
  if (known) return Promise.resolve(known);
  const pending = integrityChecks.get(owned.key);
  if (pending) return pending;
  const generation = integrityGeneration;
  const check = (opts.verify ?? verifyRuntime)(owned.runtime, owned.release)
    .then((): "ok" => "ok", (error): "damaged" | "unavailable" => {
      if (error instanceof RuntimeCheckUnavailable) {
        console.warn(`[${new Date().toISOString()}] Bud runtime check could not run just now; it will be retried.`);
        return "unavailable";
      }
      console.warn(`[${new Date().toISOString()}] Bud runtime check: the selected runtime failed its integrity check; it is kept and Bud is paused.`);
      return "damaged";
    })
    .then(state => {
      if (generation === integrityGeneration) integrityResults.set(owned.key, { state, at: Date.now() });
      return state;
    })
    .finally(() => { if (integrityChecks.get(owned.key) === check) integrityChecks.delete(owned.key); });
  integrityChecks.set(owned.key, check);
  return check;
}

/** Generation admission: refuse a turn on a runtime that failed its check,
 * and hold one that could not be checked (re-tried at once, e.g. after
 * worker custody clears). */
export async function assertRuntimeIntegrity(opts: IntegrityOptions = {}): Promise<void> {
  const state = await checkRuntimeIntegrity({ ...opts, retryUnavailable: true });
  if (state === "damaged") throw Object.assign(new Error(RUNTIME_DAMAGED), { status: 409, code: "worker_runtime_damaged" });
  if (state === "unavailable") throw Object.assign(new Error(RUNTIME_UNCHECKED), { status: 503, code: "worker_runtime_unchecked" });
}

/** Repair and removal start from a fresh check. */
export function clearRuntimeIntegrity(): void { integrityGeneration++; integrityResults.clear(); integrityChecks.clear(); }
