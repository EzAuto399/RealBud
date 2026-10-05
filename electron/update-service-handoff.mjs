// Handing the office service over to an update.
//
// The service is detached and outlives the window, so "Restart to update" used
// to swap the app underneath a service that kept running the OLD code, and the
// relaunched window then adopted it: a new interface over an old runtime. The
// install now waits for the office to be idle, stops the service through its
// authenticated control route, and proves it gone before anything is replaced.
// A service that cannot be stopped this way holds the install; it is never
// signalled by pid and never left running beside the new version.
import { createRequire } from "node:module";

import { findRunningService, isOurService, probeService } from "./service-instance.mjs";
import { availableServicePort, clearServiceHandle, readServiceHandle, requestServiceStop } from "./service-lifecycle.mjs";

/** The version this app bundle carries; the service publishes its own on /api/health. */
export const APP_VERSION = /** @type {string} */ (createRequire(import.meta.url)("../package.json").version);

/**
 * May this app adopt the answering service? Identity says "this office";
 * compatibility says "the same runtime this window was built for". A service
 * that predates version reporting is not compatible.
 * @param {unknown} body @param {import('./service-instance.mjs').ServiceIdentity} identity @param {string} [version]
 */
export function serviceCompatible(body, identity, version = APP_VERSION) {
  return isOurService(body, identity) && /** @type {Record<string, unknown>} */ (body).version === version;
}

/**
 * @typedef {{ ready: true } | { ready: false, reason: 'busy' | 'cannot-stop' | 'still-running' }} HandoffResult
 * @param {object} options
 * @param {string} options.dataDirectory
 * @param {import('./service-instance.mjs').ServiceIdentity} options.identity
 * @param {typeof fetch} [options.fetchImpl]
 * @param {(port: number) => Promise<boolean>} [options.isPortFree]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {number} [options.waitMs] How long a stopping service may take to release its port.
 * @returns {Promise<HandoffResult>}
 */
export async function prepareServiceForUpdate({ dataDirectory, identity, fetchImpl = fetch, isPortFree = async (port) => (await availableServicePort([port])) !== null,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), waitMs = 15_000 }) {
  const handle = readServiceHandle(dataDirectory, identity.instanceId);
  const running = await findRunningService(identity, { fetchImpl });
  if (!running) {
    // Nothing answers, but a recorded service may still be opening the book
    // on its port. Updating under it would leave old code running.
    return handle && !(await isPortFree(handle.port)) ? { ready: false, reason: "still-running" } : { ready: true };
  }
  if (/** @type {Record<string, unknown>} */ (running.body).busy === true) return { ready: false, reason: "busy" };
  if (!(await requestServiceStop(handle, identity, { fetchImpl, ifIdle: true }))) {
    // Refused because work started meanwhile, or not ours to stop.
    const again = await probeService(running.port, { fetchImpl });
    return /** @type {Record<string, unknown> | undefined} */ (again?.body)?.busy === true ? { ready: false, reason: "busy" } : { ready: false, reason: "cannot-stop" };
  }
  for (let waited = 0; waited <= waitMs; waited += 250) {
    if (!(await findRunningService(identity, { fetchImpl })) && (await isPortFree(running.port))) {
      clearServiceHandle(dataDirectory);
      return { ready: true };
    }
    await sleep(250);
  }
  return { ready: false, reason: "still-running" };
}
