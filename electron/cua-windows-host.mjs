// Cua 0.19.3's Rust host cannot pass --grant and requires its direct child's
// PID. Keep our Job Object supervisor, authenticate its contained driver, and
// leave the generated SDK unchanged. The pinned metadata contract comes from
// trycua/cua@a1672e7b11951275ecfba3384264d4530185d0db embedded.rs:892-937.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export const WINDOWS_CUA_HOST_FLAG = "--realbud-cua-host-v1";
export const WINDOWS_CUA_METADATA = Object.freeze({
  driverVersion: "0.19.3", contractVersion: "0.6.0", toolsListSchemaVersion: "1",
  capabilityVersion: "1", mcpProtocolVersion: "2025-06-18",
});
const SAFE_ENVIRONMENT = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP", "LANG",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA",
  "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XDG_SESSION_TYPE", "DBUS_SESSION_BUS_ADDRESS", "XAUTHORITY", "CUA_LOG",
  // Preserve the pinned SDK's inherited managed-policy restrictions. These are
  // never supplied by a renderer or worker, nor overwritten by launch options.
  "CUA_DRIVER_PERMISSION_MODE", "CUA_DRIVER_DANGEROUSLY_BYPASS_APPROVALS", "CUA_DRIVER_DISABLE_UNRESTRICTED",
  "CUA_DRIVER_ALLOW_LEGACY_EXISTING_PROFILE_APPROVAL", "CUA_DRIVER_SESSION_POLICY_FILE",
  "CUA_DRIVER_SESSION_POLICY_APPROVED", "CUA_DRIVER_POLICY_FILE", "CUA_DRIVER_MANAGED_POLICY_FILE",
]);
const stopped = 0, starting = 1, ready = 2, stopping = 3;
const fail = message => new Error(`Windows desktop host: ${message}`);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  // A child can exit before startup reaches the corresponding awaited stage.
  promise.catch(() => {});
  return { promise, resolve, reject };
};

function hostEnvironment(environment, pid) {
  const values = {};
  for (const [name, value] of Object.entries(environment)) {
    const key = name.toUpperCase();
    if (typeof value === "string" && (SAFE_ENVIRONMENT.has(key) || key.startsWith("LC_"))) values[key] = value;
  }
  values.CUA_DRIVER_EMBEDDED_HOST_PID = String(pid);
  return values;
}

function verifyMetadata(metadata, pid, hostBundleId) {
  if (metadata?.pid !== pid || metadata.embedded !== true || metadata.hostBundleId !== hostBundleId) {
    throw fail("the daemon identity does not match its owned driver.");
  }
  for (const [field, expected] of Object.entries(WINDOWS_CUA_METADATA)) {
    if (metadata[field] !== expected) throw fail("the daemon does not match the pinned SDK contract.");
  }
}

export function createWindowsCuaHost(sdk, launcher, binary, hostBundleId, {
  spawnProcess = spawn, environment = process.env, processId = process.pid,
  createId = randomUUID, startupTimeoutMs = 15000, shutdownTimeoutMs = 7000,
  forceTimeoutMs = 5000,
} = {}) {
  let current = null, lastExit = null, phase = stopped, disposed = false;

  // Only host-mode exit 0 proves that the helper observed an empty Job. Forced
  // termination requests Job cleanup but cannot prove it; retain that hold.
  function cleanup(run) {
    if (run.cleanup) return run.cleanup;
    run.cancelled = true;
    run.cancel.reject(fail("startup was stopped."));
    run.abort.abort();
    run.connection = undefined;
    if (current === run) phase = stopping;
    run.cleanup = (async () => {
      if (!run.exited && run.child) {
        try { run.child.stdin.end(); } catch { /* Force-stop still requires observed exit. */ }
        // No bytes: stdin is exclusively parent liveness.
        const exited = await waitForExitWithin(run, shutdownTimeoutMs);
        if (!exited) {
          try { run.child.kill(); } catch { /* Still require observed exit. */ }
          if (!await waitForExitWithin(run, forceTimeoutMs)) throw fail("the owned supervisor has not stopped; desktop control remains unavailable.");
        }
      }
      if (run.child?.pid && !run.cleanExit) throw fail("the supervisor exited without confirming an empty Job; desktop control remains unavailable.");
      if (current === run) { current = null; phase = stopped; }
    })();
    run.cleanup.finally(() => { run.cleanup = null; }).catch(() => {});
    return run.cleanup;
  }

  async function waitForExitWithin(run, milliseconds) {
    if (run.exited) return true;
    let timer;
    try {
      return await Promise.race([run.exit.promise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]);
    } finally { clearTimeout(timer); }
  }

  async function guard(run, promise, milliseconds, timeoutMessage) {
    let timer;
    try {
      return await Promise.race([
        promise, run.cancel.promise,
        run.exit.promise.then(() => { throw fail("the owned supervisor exited before readiness."); }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(fail(timeoutMessage)), milliseconds); }),
      ]);
    } finally { clearTimeout(timer); }
  }

  function receiveIdentity(run, bytes) {
    if (run.cancelled || run.exited) return;
    if (run.identity || run.record.length + bytes.length > 512) {
      run.identityReady.reject(fail("invalid supervisor identity record."));
      cleanup(run).catch(() => {});
      return;
    }
    run.record = Buffer.concat([run.record, bytes]);
    const newline = run.record.indexOf(10);
    if (newline < 0) return;
    try {
      if (newline !== run.record.length - 1) throw fail("invalid supervisor identity record.");
      const identity = JSON.parse(run.record.subarray(0, newline).toString("utf8"));
      if (identity?.schema !== "realbud-cua-host" || identity.version !== 1 ||
          identity.supervisorPid !== run.child.pid || !Number.isSafeInteger(identity.driverPid) ||
          identity.driverPid <= 0 || identity.driverPid > 0xffffffff || identity.driverPid === run.child.pid ||
          Object.keys(identity).sort().join(",") !== "driverPid,schema,supervisorPid,version") throw fail("invalid supervisor identity record.");
      run.identity = identity;
      run.identityReady.resolve(identity);
    } catch {
      run.identityReady.reject(fail("invalid supervisor identity record."));
      cleanup(run).catch(() => {});
    }
  }

  async function launch(run) {
    let client;
    const destroyReadinessClient = () => {
      const closing = client; client = undefined;
      try { closing?.uniffiDestroy(); }
      catch { throw fail("the readiness client could not be released."); }
    };
    try {
      run.child = spawnProcess(launcher, [
        WINDOWS_CUA_HOST_FLAG, "serve", "--embedded", "--parent-liveness-stdio", "--no-permissions-gate",
        "--socket", run.socketPath, "--host-bundle-id", hostBundleId, "--permission-mode", "standard",
      ], { windowsHide: true, shell: false, stdio: ["pipe", "pipe", "inherit"], env: hostEnvironment(environment, processId) });
      const observedExit = (code, signal) => {
        if (run.exited) return;
        run.exited = true;
        run.cleanExit = code === 0 && signal == null;
        run.connection = undefined;
        lastExit = { generation: run.generation, code: code ?? undefined, success: run.cleanExit };
        run.exit.resolve(lastExit);
        if (current === run && phase === ready) {
          if (run.cleanExit) { current = null; phase = stopped; }
          else {
            run.cancelled = true; phase = stopping;
            run.cancel.reject(fail("the supervisor exited without confirming an empty Job."));
          }
        }
      };
      run.child.once("exit", observedExit);
      run.child.once("error", () => {
        run.identityReady.reject(fail("the owned supervisor could not start."));
        // A spawn failure has no process and therefore no future exit event.
        if (!run.child.pid) observedExit(null, null);
        else cleanup(run).catch(() => {});
      });
      run.child.stdin.on("error", () => {
        if (!run.cancelled && !run.exited) {
          run.identityReady.reject(fail("the parent-liveness pipe closed during startup."));
          cleanup(run).catch(() => {});
        }
      });
      run.child.stdout.on("data", bytes => receiveIdentity(run, bytes));
      run.child.stdout.on("error", () => {
        run.identityReady.reject(fail("the supervisor identity pipe failed."));
        cleanup(run).catch(() => {});
      });
      const deadline = Date.now() + startupTimeoutMs;
      const identity = await guard(run, run.identityReady.promise, startupTimeoutMs, "supervisor identity timed out.");
      client = sdk.CuaDriver.connect(run.socketPath);
      let metadata;
      while (!metadata) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw fail("daemon readiness timed out.");
        try {
          // Keep one SDK request in flight for the remaining startup budget.
          // A slow reply must not start another request or shorten that budget.
          metadata = await guard(run, client.metadata({ signal: run.abort.signal }), remaining, "daemon metadata timed out.");
        } catch (error) {
          if (run.cancelled || run.exited || /metadata timed out/.test(error.message)) throw error;
          const retryRemaining = deadline - Date.now();
          if (retryRemaining <= 0) throw fail("daemon readiness timed out.");
          let retryTimer;
          try {
            await guard(run, new Promise(resolve => { retryTimer = setTimeout(resolve, 50); }), retryRemaining, "daemon readiness timed out.");
          } finally { clearTimeout(retryTimer); }
        }
      }
      verifyMetadata(metadata, identity.driverPid, hostBundleId);
      destroyReadinessClient();
      if (run.cancelled || run.exited || current !== run || disposed) throw fail("startup was stopped.");
      run.connection = Object.freeze({
        socketPath: run.socketPath, pid: identity.driverPid, generation: run.generation,
        driverVersion: metadata.driverVersion, contractVersion: metadata.contractVersion, mcpProtocolVersion: metadata.mcpProtocolVersion,
        mcp: { command: binary, args: ["mcp", "--embedded", "--socket", run.socketPath, "--host-bundle-id", hostBundleId],
          environment: [{ name: "CUA_DRIVER_EMBEDDED", value: "1" }, { name: "CUA_DRIVER_HOST_BUNDLE_ID", value: hostBundleId }] },
      });
      phase = ready;
      return run.connection;
    } catch (error) {
      try { destroyReadinessClient(); } catch (releaseError) { error = releaseError; }
      await cleanup(run); // Never report failure or permit retry before release.
      throw error;
    } finally {
      run.abort.abort();
    }
  }

  const host = {
    start() {
      if (disposed) return Promise.reject(fail("the host has been destroyed."));
      if (current) {
        if (current.cancelled) return Promise.reject(fail("the previous supervisor has not been released."));
        return current.start;
      }
      const generation = createId();
      if (!/^[a-zA-Z0-9-]{1,64}$/.test(generation)) return Promise.reject(fail("invalid generation."));
      const run = {
        generation, socketPath: `\\\\.\\pipe\\realbud-cua-${processId}-${generation}`, record: Buffer.alloc(0),
        identityReady: deferred(), exit: deferred(), cancel: deferred(), abort: new AbortController(),
        cancelled: false, exited: false, connection: undefined, cleanup: null,
      };
      current = run; phase = starting;
      run.start = launch(run);
      return run.start;
    },
    stop() { return current ? cleanup(current) : Promise.resolve(); },
    async restart() { await host.stop(); return host.start(); },
    connection() { return current?.connection; },
    state() { return phase; },
    waitForExit(generation) {
      if (current?.generation === generation) return current.exit.promise;
      if (lastExit?.generation === generation) return Promise.resolve(lastExit);
      return Promise.reject(fail("unknown generation."));
    },
    uniffiDestroy() { disposed = true; if (current) cleanup(current).catch(() => {}); },
  };
  return host;
}
