// Finding the office service, and telling *our* service apart from a stranger.
//
// Why this exists: the desktop app used to identify its server by PID —
// `body.pid === proc.pid`. That works only for the child this process just
// forked. Once the office service can outlive the window, and can already be
// running when RealBud launches, PID identity is wrong in both directions:
//
//   - RealBud relaunches, finds its own service already listening, fails the PID
//     check, skips the port and forks a SECOND service. Two authorities on one
//     company database is the worst outcome in this codebase.
//   - A development harness or a different installation serves the same API
//     shape on the same port and gets mistaken for ours.
//
// So identity is a stable instance id derived from the installation's own data
// directory, published on the health endpoint. It does not authorise anything —
// it only decides "is this the service for this office?".
import { createRequire } from "node:module";

import { serviceInstanceId } from "../shared/service-identity.mjs";

/** Ports the office service may occupy, in preference order. */
/** @type {readonly number[]} */
export const SERVICE_PORTS = [8799, 18799, 28799];

/** @typedef {object} ServiceIdentity
 * @property {string} instanceId Stable id for one installation's data directory.
 * @property {readonly number[]} ports Ports this installation may serve on.
 */

/**
 * Derive the installation's service identity.
 *
 * Stable across app restarts so a relaunched app recognises its own service;
 * different for a different data directory, so two installations on one machine
 * can never adopt each other's service. The path is hashed rather than sent, so
 * the health endpoint does not disclose a filesystem path.
 */
/** @param {string} dataDirectory @param {readonly number[]} [ports] @returns {ServiceIdentity} */
export function serviceIdentity(dataDirectory, ports = SERVICE_PORTS) {
  return { instanceId: serviceInstanceId(dataDirectory), ports: [...ports] };
}

/** Does this health payload describe the service for `identity`? */
/** @param {unknown} body @param {ServiceIdentity} identity @returns {boolean} */
export function isOurService(body, identity) {
  if (!body || typeof body !== "object") return false;
  const health = /** @type {Record<string, unknown>} */ (body);
  return health.app === "realbud" && health.static === true && health.instanceId === identity.instanceId;
}

/** @typedef {object} ProbeOptions
 * @property {typeof fetch} [fetchImpl]
 * @property {number} [timeoutMs]
 */

/** Probe one port. Returns the health payload, or null when nothing answers. */
/**
 * @param {number} port
 * @param {ProbeOptions} [options]
 * @returns {Promise<{ port: number, body: unknown } | null>}
 */
export async function probeService(port, options = {}) {
  const request = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 1_500);
  try {
    const response = await request(`http://127.0.0.1:${port}/api/health`, { signal: controller.signal });
    if (!response.ok) return null;
    return { port, body: await response.json().catch(() => null) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Find this installation's already-running service.
 *
 * Returns the port it is serving on, or null. A service answering on a port with
 * a different instance id is deliberately ignored: adopting it would point this
 * office at another office's database.
 */
/**
 * @param {ServiceIdentity} identity
 * @param {ProbeOptions} [options]
 * @returns {Promise<{ port: number, body: unknown } | null>}
 */
export async function findRunningService(identity, options = {}) {
  for (const port of identity.ports) {
    const found = await probeService(port, options);
    if (found && isOurService(found.body, identity)) return found;
  }
  return null;
}

/** @typedef {ProbeOptions & { isPortFree: (port: number) => Promise<boolean> }} BusyProbeOptions */

/**
 * Before anything spawns: ask each port of this installation that is already
 * bound, with patience, whether our own service holds it.
 *
 * A service busy with slow work (a long Recheck, a backup pause) can miss the
 * quick probe while it still holds its port. Starting then either fails with
 * EADDRINUSE or, worse, picks the next port for a second service over the same
 * data directory. A free port cannot hide a service, so only bound ports are
 * asked again; a stranger's answer is ignored exactly as in findRunningService.
 */
/**
 * @param {ServiceIdentity} identity
 * @param {BusyProbeOptions} options
 * @returns {Promise<{ port: number, body: unknown } | null>}
 */
export async function findBusyService(identity, options) {
  const { isPortFree, ...probe } = options;
  for (const port of identity.ports) {
    if (await isPortFree(port)) continue;
    const found = await probeService(port, { timeoutMs: 10_000, ...probe });
    if (found && isOurService(found.body, identity)) return found;
  }
  return null;
}
