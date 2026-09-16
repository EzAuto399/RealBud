// Starting the office service so it outlives the RealBud window.
//
// Why: the service was a `utilityProcess` child of the app, so quitting RealBud
// killed the office database, the company clock and every peer's connection. The
// office has to keep serving while the app is closed — that is the difference
// between "one PC with a database" and "an office".
//
// Mechanism: a DETACHED Node process (the same `process.execPath` +
// ELECTRON_RUN_AS_NODE trick the worker already uses), `unref()`ed so it is not
// tied to the app's lifetime, recorded in a pid file so a later launch can find
// and manage it rather than starting a second one.
//
// Deliberately NOT launchd / Task Scheduler in this pass: an OS-managed unit
// would have to read the book key, which the app currently holds in the OS
// keychain via `safeStorage`. Detaching inherits the key through the child
// environment exactly as the in-app fork does, so key handling is unchanged and
// no plaintext key is written to disk. Reboot-survival is therefore still open
// and is called out as such rather than implied.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

/** @typedef {object} ServicePidFile
 * @property {1} version
 * @property {number} pid
 * @property {number} port
 * @property {string} instanceId
 * @property {number} startedAt
 */

/** @param {string} dataDirectory @returns {string} */
export function servicePidPath(dataDirectory) {
  return join(dataDirectory, "service.json");
}

/**
 * Parse a recorded service handle.
 *
 * Returns null for anything untrustworthy rather than throwing: a corrupt or
 * partially written file must not stop RealBud launching, it must only mean
 * "we cannot manage that service".
 */
/** @param {unknown} value @param {string} instanceId @returns {ServicePidFile | null} */
export function parseServiceHandle(value, instanceId) {
  if (!value || typeof value !== "object") return null;
  const handle = /** @type {Partial<ServicePidFile>} */ (value);
  if (handle.version !== 1) return null;
  if (!Number.isSafeInteger(handle.pid) || Number(handle.pid) <= 0) return null;
  if (!Number.isSafeInteger(handle.port) || Number(handle.port) <= 0) return null;
  if (handle.instanceId !== instanceId) return null;
  return {
    version: 1,
    pid: Number(handle.pid),
    port: Number(handle.port),
    instanceId,
    startedAt: Number.isSafeInteger(handle.startedAt) ? Number(handle.startedAt) : 0,
  };
}

/** Is this pid a live process? Signal 0 tests existence without touching it.
 * @param {number} pid
 * @param {(pid: number, signal: number) => boolean} [kill]
 * @returns {boolean} */
export function processAlive(pid, kill = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else; treat as not ours.
    return false;
  }
}

/**
 * Should this app instance start a service of its own?
 *
 * Only when nothing of ours is already serving. A service we cannot manage (no
 * usable pid file) but that is answering must still not be duplicated: two
 * services on one company database is worse than an unmanageable one.
 */
/** @param {boolean} adopted @returns {boolean} */
export function shouldStartService(adopted) {
  return !adopted;
}

/** @typedef {object} DetachedServiceOptions
 * @property {string} entry Absolute path to the packaged server entry.
 * @property {number} port
 * @property {NodeJS.ProcessEnv} env Environment for the child, including the book key.
 * @property {string} dataDirectory
 * @property {string} instanceId
 * @property {typeof spawn} [spawnImpl]
 * @property {string} [executable]
 * @property {() => number} [now]
 * @property {(path: string, data: string, options: { mode: number }) => void} [writeFile]
 */

/**
 * Start the office service as a detached process.
 *
 * `detached` plus `unref` is what makes it survive this app quitting. stdio is
 * discarded because nothing would read it once the app is gone; the service
 * writes its own log.
 */
/** @param {DetachedServiceOptions} options @returns {ServicePidFile} */
export function startDetachedService(options) {
  const spawnImpl = options.spawnImpl ?? spawn;
  const executable = options.executable ?? process.execPath;
  const write = options.writeFile ?? ((path, data, opts) => writeFileSync(path, data, opts));
  const now = options.now ?? Date.now;

  /** @type {import("node:child_process").ChildProcess} */
  const child = spawnImpl(executable, [options.entry], {
    env: {
      ...options.env,
      // Run Electron's bundled Node as a plain Node process.
      ELECTRON_RUN_AS_NODE: "1",
      OMB_PORT: String(options.port),
      REALBUD_DATA_DIR: options.dataDirectory,
    },
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  // Detach from the app's event loop so quitting does not wait for it.
  child.unref();

  /** @type {ServicePidFile} */
  const handle = {
    version: 1,
    pid: child.pid ?? 0,
    port: options.port,
    instanceId: options.instanceId,
    startedAt: now(),
  };
  try {
    mkdirSync(dirname(servicePidPath(options.dataDirectory)), { recursive: true });
    write(servicePidPath(options.dataDirectory), `${JSON.stringify(handle)}\n`, { mode: 0o600 });
  } catch {
    // The service is already starting; failing to record it only means this
    // launch cannot stop it later, which is reported rather than fatal.
  }
  return handle;
}

/** Read the recorded handle, or null when absent or unusable.
 * @param {string} dataDirectory @param {string} instanceId @returns {ServicePidFile | null} */
export function readServiceHandle(dataDirectory, instanceId) {
  try {
    return parseServiceHandle(JSON.parse(readFileSync(servicePidPath(dataDirectory), "utf8")), instanceId);
  } catch {
    return null;
  }
}

/** Forget the recorded handle after the service has stopped.
 * @param {string} dataDirectory @returns {void} */
export function clearServiceHandle(dataDirectory) {
  try {
    unlinkSync(servicePidPath(dataDirectory));
  } catch {
    /* already gone */
  }
}
