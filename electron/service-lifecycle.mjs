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
// no plaintext key is written to disk.
//
// What the customer can now switch on (`electron/service-persistence.mjs`, the
// two settings on You):
//   - START AFTER SIGN-IN. A login item relaunches the installed app with
//     `--service`, which opens no window and comes straight here to adopt or
//     start the office service. The key still comes from the keychain, unlocked
//     by that same sign-in, so custody is unchanged.
//   - KEEP THIS COMPUTER AWAKE. While the office has something scheduled and
//     the machine is plugged in, a `prevent-app-suspension` blocker stops it
//     sleeping through a scheduled time. Never display sleep.
//
// What is still NOT provided, and must not be implied anywhere in the interface:
//   - A sign-in is not a power-on. A computer that is switched off, or switched
//     on but sitting at its sign-in screen, is running no office at all; this is
//     "after you sign in", never "survives a reboot".
//   - A closed lid, a power cut or a shutdown still stops scheduled work. The
//     schedule surface must show the occurrence as missed or late, with when it
//     was last checked — never as apparent success.
// A managed OS unit that runs before any sign-in remains open, and would have to
// solve key custody without an unlocked keychain first.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { uptime as osUptime } from "node:os";
import { isOurService, probeService } from "./service-instance.mjs";

/** @typedef {object} ServicePidFile
 * @property {1} version
 * @property {number} pid
 * @property {number} port
 * @property {string} instanceId
 * @property {number} startedAt
 * @property {string} [controlToken] Private capability for this service process.
 */

/** @param {string} dataDirectory @returns {string} */
export function servicePidPath(dataDirectory) {
  return join(dataDirectory, "service.json");
}

/**
 * Children THIS process spawned, keyed by the handle we handed back.
 *
 * A recorded pid is diagnostic only and never authorises a signal, so the one
 * thing that legitimately allows a kill is holding the ChildProcess object for a
 * process we started ourselves. Keeping that object out of the pid file keeps the
 * rule mechanical: no object, no kill. A WeakMap so a forgotten handle does not
 * pin a dead child's bookkeeping for the life of the app.
 *
 * @type {WeakMap<ServicePidFile, import("node:child_process").ChildProcess>}
 */
const spawnedChildren = new WeakMap();

/**
 * What became of a service this process spawned?
 *
 * 'unknown' is the honest answer for a handle read back from disk: another
 * session started it, so this process holds no child object for it and must not
 * treat it as its own.
 */
/** @param {ServicePidFile | null | undefined} handle @returns {'unknown' | 'running' | 'exited'} */
export function spawnedServiceState(handle) {
  const child = handle ? spawnedChildren.get(handle) : undefined;
  if (!child) return "unknown";
  // A real ChildProcess reports null for both until it ends; ?? null keeps a
  // stub that omits them from reading as "exited".
  const exited = (child.exitCode ?? null) !== null || (child.signalCode ?? null) !== null;
  return exited ? "exited" : "running";
}

/**
 * Give up on a service this process started but that never answered.
 *
 * This is the escape from the worst outcome in this design: a slow child that
 * holds a port silently, so the next start skips that port and puts a SECOND
 * service on the same company database. Abandoning the first one instead is only
 * possible because we still hold its ChildProcess — the kill goes through that
 * object, never through a pid read from a file, so a reused or foreign pid can
 * never be signalled here.
 *
 * The record is cleared only for a child we owned, and only when it still
 * describes exactly that handle (same pid AND same private capability). Both
 * halves matter: the pid file is a running service's ONLY management handle, so
 * deleting one that a later start wrote — or one belonging to a service this
 * process never spawned — would leave a live service permanently unstoppable.
 */
/** @param {ServicePidFile | null | undefined} handle @param {string} dataDirectory @returns {boolean} */
export function abandonSpawnedService(handle, dataDirectory) {
  if (!handle) return false;
  const child = spawnedChildren.get(handle);
  // No child object means this process did not start it: nothing to signal, and
  // no standing to forget the record either.
  if (!child) return false;
  spawnedChildren.delete(handle);
  let killed = false;
  try {
    child.kill();
    killed = true;
  } catch {
    // Already gone, or refusing the signal: either way we no longer own it.
  }
  const recorded = readServiceHandle(dataDirectory, handle.instanceId);
  if (
    recorded &&
    recorded.pid === handle.pid &&
    typeof handle.controlToken === "string" &&
    recorded.controlToken === handle.controlToken
  ) {
    clearServiceHandle(dataDirectory);
  }
  return killed;
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
  if (handle.controlToken !== undefined && !/^[a-f0-9]{64}$/.test(handle.controlToken)) return null;
  return {
    version: 1,
    pid: Number(handle.pid),
    port: Number(handle.port),
    instanceId,
    startedAt: Number.isSafeInteger(handle.startedAt) ? Number(handle.startedAt) : 0,
    ...(handle.controlToken ? { controlToken: handle.controlToken } : {}),
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
 *
 * "Answering" is not the only way a service of ours can exist. A service that is
 * still opening the company database has not published health yet, so probing
 * finds nothing while it silently holds its port. Starting "another" one then
 * picks the NEXT port and puts a second authority on the same database. The
 * recorded handle is the evidence for that case: a live pid whose recorded port
 * is NOT free is a service of this installation that has simply not answered
 * yet, and we hold.
 *
 * The converse matters just as much. After a reboot the pid file usually
 * survives and the pid is often reused by something unrelated, so a live pid
 * alone must never block startup. Requiring the recorded port to be occupied as
 * well is what keeps a stale record from bricking a launch.
 *
 * That pair of conditions is still not enough on its own. After a reboot BOTH
 * can be satisfied by coincidence — the recycled pid belongs to some unrelated
 * process and something unrelated holds the port — and then the hold blocks
 * every port and a retry walks straight back into it, with no way out but
 * deleting the file by hand. Reboot survival is deliberately not implemented
 * (see the module header), so a record written before the current boot CANNOT
 * describe a live service of ours no matter what the pid and port look like.
 * `startedAt: 0`, the legacy record with no timestamp, is covered by the same
 * comparison. Boot time comes from `os.uptime()`, so it is second-granular;
 * that is harmless here because nothing starts this service within a second of
 * boot — the app is launched by a person.
 */
/**
 * @param {object} decision
 * @param {boolean} decision.adopted A service of ours is already answering.
 * @param {ServicePidFile | null} [decision.recorded] Handle recorded by this or an earlier session.
 * @param {boolean} [decision.recordedPortFree] The recorded port could be bound right now.
 * @param {number | null} [decision.bootedAt] Wall-clock ms of the current boot, from `systemBootedAt()`.
 * @param {(pid: number) => boolean} [decision.alive]
 * @returns {{ start: boolean, reason: 'adopted' | 'recorded-service-alive' | 'recorded-before-boot' | 'nothing-of-ours' }}
 */
export function shouldStartService({ adopted, recorded = null, recordedPortFree = true, bootedAt = null, alive = processAlive }) {
  if (adopted) return { start: false, reason: "adopted" };
  if (recorded && !recordedPortFree && alive(recorded.pid)) {
    if (Number.isFinite(bootedAt) && recorded.startedAt < Number(bootedAt)) {
      return { start: true, reason: "recorded-before-boot" };
    }
    return { start: false, reason: "recorded-service-alive" };
  }
  return { start: true, reason: "nothing-of-ours" };
}

/**
 * Wall-clock time of the current boot.
 *
 * Here rather than in main.mjs so the reboot rule above has one testable source
 * for its input. `os.uptime()` is Node, not Electron, so this module stays
 * importable from tests without booting Electron.
 */
/** @param {number} [uptimeSeconds] @param {number} [now] @returns {number} */
export function systemBootedAt(uptimeSeconds = osUptime(), now = Date.now()) {
  return now - uptimeSeconds * 1000;
}

/** Choose a free loopback port without treating a foreign HTTP service as ours.
 * The service still proves its identity after binding; this probe grants no authority.
 * @param {readonly number[]} ports @returns {Promise<number | null>} */
export async function availableServicePort(ports) {
  for (const port of ports) {
    const available = await new Promise(resolve => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
    });
    if (available) return port;
  }
  return null;
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
  const controlToken = randomBytes(32).toString("hex");

  /** @type {import("node:child_process").ChildProcess} */
  const child = spawnImpl(executable, [options.entry], {
    env: {
      ...options.env,
      // Run Electron's bundled Node as a plain Node process.
      ELECTRON_RUN_AS_NODE: "1",
      OMB_PORT: String(options.port),
      REALBUD_DATA_DIR: options.dataDirectory,
      REALBUD_SERVICE_CONTROL_TOKEN: controlToken,
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
    controlToken,
  };
  // Remember the child itself, not just its pid: this is the only thing that
  // ever authorises abandoning a start that went silent.
  spawnedChildren.set(handle, child);
  try {
    mkdirSync(dirname(servicePidPath(options.dataDirectory)), { recursive: true });
    write(servicePidPath(options.dataDirectory), `${JSON.stringify(handle)}\n`, { mode: 0o600 });
  } catch {
    // The service is already starting; failing to record it only means this
    // launch cannot stop it later, which is reported rather than fatal.
  }
  return handle;
}

/** How often the window re-checks for a slow office service, and for how long. */
export const SERVICE_WAIT_INTERVAL_MS = 2_000;
export const SERVICE_WAIT_LIMIT_MS = 180_000;

/**
 * How many checks fit in a bounded wait.
 *
 * Bounded on purpose: a window that polls forever hides a service that is never
 * coming back, and the recovery copy promises "a few minutes", not indefinitely.
 */
/** @param {number} [limitMs] @param {number} [intervalMs] @returns {number} */
export function serviceWaitTicks(limitMs = SERVICE_WAIT_LIMIT_MS, intervalMs = SERVICE_WAIT_INTERVAL_MS) {
  if (!(intervalMs > 0)) return 1;
  return Math.max(1, Math.floor(limitMs / intervalMs));
}

/**
 * Should a failed main-frame load restart the bounded wait for the service?
 *
 * The danger is a load/fail/load cycle spinning the main process. Four guards,
 * each for a real case:
 *   - sub-frame failures say nothing about the service;
 *   - ERR_ABORTED (-3) is our own next navigation superseding this one, not a
 *     dead service;
 *   - a failure on anything other than the app origin (the recovery page is a
 *     data: URL) is not evidence about the service either;
 *   - and while a wait is already running, or within the cooldown of the last
 *     restart, another restart would only add a second timer.
 */
/**
 * @param {object} event
 * @param {boolean} event.mainFrame
 * @param {number} [event.errorCode]
 * @param {string} event.url
 * @param {string} event.appOrigin
 * @param {boolean} event.waiting
 * @param {number | null} event.lastRestartAt
 * @param {number} event.now
 * @param {number} [event.cooldownMs]
 * @returns {boolean}
 */
export function shouldRestartServiceWait({ mainFrame, errorCode = 0, url, appOrigin, waiting, lastRestartAt, now, cooldownMs = 5_000 }) {
  if (!mainFrame || waiting) return false;
  if (errorCode === -3) return false;
  if (typeof url !== "string" || !appOrigin || !url.startsWith(appOrigin)) return false;
  if (lastRestartAt !== null && now - lastRestartAt < cooldownMs) return false;
  return true;
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

/** A PID is only diagnostic. Match the per-process capability before management.
 * @param {ServicePidFile | null} handle
 * @param {{ port: number, body: unknown } | null} running
 * @param {import('./service-instance.mjs').ServiceIdentity} identity */
export function ownsRunningService(handle, running, identity) {
  if (!handle?.controlToken || !running || handle.port !== running.port || !isOurService(running.body, identity)) return false;
  const body = /** @type {Record<string, unknown>} */ (running.body);
  return body.pid === handle.pid && body.controlId === createHash("sha256").update(handle.controlToken).digest("hex");
}

/** Ask the authenticated service to stop itself. Never signal a recorded PID.
 * @param {ServicePidFile | null} handle
 * @param {import('./service-instance.mjs').ServiceIdentity} identity
 * @param {{fetchImpl?: typeof fetch}} [options] */
export async function requestServiceStop(handle, identity, options = {}) {
  if (!handle?.controlToken) return false;
  const request = options.fetchImpl ?? fetch;
  const running = await probeService(handle.port, { fetchImpl: request });
  if (!ownsRunningService(handle, running, identity)) return false;
  try {
    const origin = `http://127.0.0.1:${handle.port}`;
    const session = await request(`${origin}/api/session`, { signal: AbortSignal.timeout(3000) });
    if (!session.ok) return false;
    const auth = await session.json();
    if (!auth || typeof auth.token !== "string") return false;
    const response = await request(`${origin}/api/service/stop`, {
      method: "POST", signal: AbortSignal.timeout(5000),
      headers: { "content-type": "application/json", "x-realbud-session": auth.token, "x-realbud-service-control": handle.controlToken },
      body: JSON.stringify({ pid: handle.pid, instanceId: identity.instanceId, controlId: createHash("sha256").update(handle.controlToken).digest("hex") }),
    });
    return response.ok;
  } catch { return false; }
}
