// One owner for one-shot worker capture, deadlines and containment. Streaming
// ACP/OAuth workers have a different lifetime and do not use this module.
import { spawn, type ChildProcess, type ExecFileOptions } from "node:child_process";
import { lstatSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const WINDOWS_WORKER_SUPERVISOR = "RealBud Worker.exe";
export type OneShotOptions = Pick<ExecFileOptions, "cwd" | "env" | "timeout" | "maxBuffer" | "encoding" | "signal">;
export type OneShotCallback = (error: Error | null, stdout: string, stderr: string) => void;
type Failure = Error & { code?: string | number; killed?: boolean; signal?: NodeJS.Signals | null; cleanupUnconfirmed?: boolean };
const failure = (message: string, code: string | number, killed = false): Failure => Object.assign(new Error(message), { code, killed });

export function windowsWorkerSupervisor(environment = process.env, location: { modulePath?: string; resourcesPath?: string } = {}): string {
  const modulePath = location.modulePath ?? fileURLToPath(import.meta.url), here = dirname(modulePath);
  const source = extname(modulePath) === ".ts", compiledCheckout = basename(dirname(here)) === "dist-server";
  // OMB_STATIC_DIR may be a UI fixture; it grants no executable authority.
  // Electron-as-Node may omit resourcesPath, so packaged server location is
  // also authoritative. Neither installed layout falls back to a checkout.
  const resources = environment.REALBUD_RESOURCES_DIR || (source ? join(here, "..", "electron", "resources") :
    compiledCheckout ? join(here, "..", "..", "electron", "resources") :
      location.resourcesPath || (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath || dirname(here));
  const file = join(resources, WINDOWS_WORKER_SUPERVISOR);
  try { const stat = lstatSync(file); if (stat.isFile() && !stat.isSymbolicLink() && stat.size > 0) return file; } catch { /* unavailable */ }
  throw failure("The worker supervisor is missing. Build or reinstall RealBud before starting Bud.", "ERR_WORKER_SUPERVISOR_UNAVAILABLE");
}

/** Explicit dependency seams for lifecycle tests; never selected through child input or environment. */
export type OneShotDependencies = {
  platform?: NodeJS.Platform;
  spawn?: typeof spawn;
  supervisor?: () => string;
  groupSignal?: (pid: number, signal: NodeJS.Signals | 0) => void;
  cleanupMs?: number;
  graceMs?: number;
};

export function runOneShot(command: string, args: string[], options: OneShotOptions, callback: OneShotCallback,
  dependencies: OneShotDependencies = {}): ChildProcess | null {
  const timeout = options.timeout ?? 0, maxBuffer = options.maxBuffer ?? 1024 * 1024;
  if (!Number.isInteger(timeout) || timeout < 0) throw Object.assign(new RangeError("timeout must be a non-negative integer"), { code: "ERR_OUT_OF_RANGE" });
  if (typeof maxBuffer !== "number" || Number.isNaN(maxBuffer) || maxBuffer < 0) throw Object.assign(new RangeError("maxBuffer must be non-negative"), { code: "ERR_OUT_OF_RANGE" });
  if (options.encoding != null && options.encoding !== "utf8" && options.encoding !== "utf-8") throw new TypeError("One-shot workers require UTF-8 output");
  const abortError = () => Object.assign(failure("Worker cancelled.", "ABORT_ERR", true), { name: "AbortError" });
  if (options.signal?.aborted) { queueMicrotask(() => callback(abortError(), "", "")); return null; }
  const platform = dependencies.platform ?? process.platform;
  let executable = command, argv = args;
  try {
    if (platform === "win32") {
      // Resolution must choose a real executable before crossing the native
      // boundary. Drive-relative paths and missing bare CLI names fail closed.
      if (!/^(?:[a-z]:[\\/]|[\\/]{2}[^\\/]+[\\/][^\\/]+[\\/])/i.test(command)) {
        throw failure("The worker executable could not be resolved.", "ENOENT");
      }
      executable = (dependencies.supervisor ?? windowsWorkerSupervisor)(); argv = ["--", command, ...args];
    }
  }
  catch (error) { queueMicrotask(() => callback(error as Error, "", "")); return null; }
  const child = (dependencies.spawn ?? spawn)(executable, argv, {
    cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true, detached: platform !== "win32", shell: false,
  });
  const chunks: Buffer[][] = [[], []], sizes = [0, 0], ended = [false, false];
  let error: Failure | null = null, exited = false, code: number | null = null, signal: NodeJS.Signals | null = null;
  let settled = false, stopping = false, cleaned = false, forceSent = false;
  let deadline: ReturnType<typeof setTimeout> | undefined, cleanupDeadline: ReturnType<typeof setTimeout> | undefined;
  let poll: ReturnType<typeof setInterval> | undefined;
  const groupSignal = dependencies.groupSignal ?? ((pid, requested) => { process.kill(-pid, requested); });
  const cleanupMs = dependencies.cleanupMs ?? 2_000, graceMs = dependencies.graceMs ?? 500;

  const finish = (forced = false) => {
    if (settled || (!forced && (!exited || !ended.every(Boolean) || !cleaned))) return;
    settled = true;
    clearTimeout(deadline); clearTimeout(cleanupDeadline); clearInterval(poll);
    options.signal?.removeEventListener("abort", abort);
    if (!error && (code !== 0 || signal)) error = Object.assign(failure("Worker exited unsuccessfully.", code ?? "ERR_WORKER_SIGNAL"), { signal });
    if (forced) { child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref(); }
    callback(error, Buffer.concat(chunks[0]).toString("utf8"), Buffer.concat(chunks[1]).toString("utf8"));
  };
  const sendGroup = (requested: NodeJS.Signals) => {
    if (!child.pid) return;
    try { groupSignal(child.pid, requested); }
    catch (caught) {
      if ((caught as NodeJS.ErrnoException).code !== "ESRCH") {
        error ??= failure("Worker cleanup could not be confirmed.", "ERR_WORKER_CLEANUP", true);
        error.cleanupUnconfirmed = true;
      }
    }
  };
  const groupExists = () => {
    if (!child.pid) return false;
    try { groupSignal(child.pid, 0); return true; }
    catch (caught) { return (caught as NodeJS.ErrnoException).code !== "ESRCH"; }
  };
  const cleanup = () => {
    if (stopping || settled) return;
    stopping = true;
    const started = Date.now();
    cleanupDeadline = setTimeout(() => {
      error ??= failure("Worker cleanup could not be confirmed.", "ERR_WORKER_CLEANUP", true);
      error.cleanupUnconfirmed = true;
      finish(true);
    }, cleanupMs);
    if (platform === "win32") {
      // This handle is the job-owning supervisor, never the potentially exited
      // worker leader. Closing its process closes the noninherited job handle.
      if (!exited) try { child.kill("SIGKILL"); } catch { /* bounded refusal below */ }
      else { cleaned = true; finish(); }
      return;
    }
    sendGroup("SIGTERM");
    const inspect = () => {
      if (settled || cleaned) return;
      if (!groupExists()) { cleaned = true; clearInterval(poll); finish(); return; }
      if (!forceSent && Date.now() - started >= graceMs) { forceSent = true; sendGroup("SIGKILL"); }
    };
    poll = setInterval(inspect, 20); inspect();
  };
  const stop = (reason: Failure) => { if (settled) return; error ??= reason; cleanup(); };
  const abort = () => stop(abortError());
  const capture = (index: number, chunk: Buffer | string) => {
    if (settled) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const left = Math.max(0, maxBuffer - sizes[index]);
    if (left > 0) chunks[index].push(bytes.subarray(0, Math.min(left, bytes.length)));
    sizes[index] += bytes.length;
    if (sizes[index] > maxBuffer) stop(failure(`${index === 0 ? "stdout" : "stderr"} maxBuffer length exceeded`, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", true));
  };
  [child.stdout, child.stderr].forEach((stream, index) => {
    if (!stream) { ended[index] = true; return; }
    stream.on("data", chunk => capture(index, chunk));
    stream.once("close", () => { ended[index] = true; finish(); });
    stream.once("error", caught => stop(caught));
  });
  // No caller writes worker input. A closed liveness pipe during ordinary
  // supervisor teardown is expected and must not replace its exit result.
  child.stdin?.on("error", () => {});
  child.once("error", caught => {
    error ??= caught;
    if (!child.pid) { exited = true; cleaned = true; finish(true); } else cleanup();
  });
  child.once("exit", (exitCode, exitSignal) => {
    exited = true; code = exitCode; signal = exitSignal;
    if (platform === "win32") { cleaned = true; cleanup(); finish(); }
    else cleanup();
  });
  child.once("close", () => { ended[0] = ended[1] = true; finish(); });
  options.signal?.addEventListener("abort", abort, { once: true });
  // This deadline stays armed even after the leader exits. Inherited pipes and
  // cleanup are part of the operation, not permission to extend its lifetime.
  if (timeout > 0) deadline = setTimeout(() => stop(failure("Worker took too long.", "ETIMEDOUT", true)), timeout);
  if (options.signal?.aborted) abort();
  // Windows stdin is the supervisor's parent-liveness channel. Worker input is
  // NUL; the four one-shot callers send prompts as argv and never write stdin.
  if (platform !== "win32") child.stdin?.end();
  return child;
}
