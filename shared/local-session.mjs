// The per-boot local API session token reaches its owner only through a file
// in the private data directory, never over unauthenticated HTTP. The service
// writes it (0600 on POSIX, a protected ACL on Windows) before it listens;
// Electron main, owner-side scripts and fixture tests read it here. Anyone who
// can read this file can already read the office's data directory.
//
// Plain JavaScript in `shared/` for the same reason as service-identity.mjs:
// the service and Electron main import the one file.
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export const LOCAL_SESSION_FILE = join("local-auth", "session.json");
const MAX_BYTES = 4_096;
const TOKEN = /^[a-f0-9]{48}$/;

/** @param {string} dataDirectory */
export function localSessionPath(dataDirectory) {
  return join(resolve(dataDirectory), LOCAL_SESSION_FILE);
}

/** @param {unknown} value */
export function parseLocalSession(value) {
  const record = /** @type {Record<string, unknown> | null} */ (value && typeof value === "object" ? value : null);
  if (!record || record.version !== 1 || !Number.isSafeInteger(record.pid) || Number(record.pid) < 1 ||
      !Number.isSafeInteger(record.port) || Number(record.port) < 1 || Number(record.port) > 65_535 ||
      typeof record.token !== "string" || !TOKEN.test(record.token)) throw new Error("Local session file needs recovery.");
  return { version: 1, pid: Number(record.pid), port: Number(record.port), token: record.token };
}

/**
 * Read the running service's session record, or null when none is published.
 * A symlink, hardlink, loose mode, foreign owner or (on Windows) an unverified
 * ACL fails closed: the token is never read from a file others could have seen.
 * @param {string} dataDirectory
 * @param {{ verifyWindowsPrivacy?: (path: string, kind: "file") => unknown }} [options]
 */
export async function readLocalSession(dataDirectory, { verifyWindowsPrivacy } = {}) {
  const path = localSessionPath(dataDirectory);
  const admit = (stat, directory = false) => {
    if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) ||
        (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())))
      throw new Error("Local session file is not private.");
  };
  let before;
  try { admit(await lstat(dirname(path)), true); before = await lstat(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  admit(before);
  if (process.platform === "win32") {
    if (!verifyWindowsPrivacy) throw new Error("Windows file privacy verification is unavailable.");
    await verifyWindowsPrivacy(path, "file");
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await file.stat();
    admit(opened);
    if (opened.ino !== before.ino || opened.dev !== before.dev) throw new Error("Local session file changed while reading.");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error("Local session file is too large.");
    return parseLocalSession(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
  } finally { await file.close(); }
}

/**
 * The token of the service answering `health` on `port`, or null. The record
 * must name that exact process: a stale file from an earlier boot never lends
 * its token to whichever process now holds the port.
 * @param {string} dataDirectory
 * @param {{ port: number, body: unknown } | null} running
 * @param {{ verifyWindowsPrivacy?: (path: string, kind: "file") => unknown }} [options]
 */
export async function localSessionFor(dataDirectory, running, options) {
  if (!running) return null;
  const body = /** @type {Record<string, unknown> | null} */ (running.body && typeof running.body === "object" ? running.body : null);
  const record = await readLocalSession(dataDirectory, options).catch(() => null);
  return record && body && record.pid === body.pid && record.port === running.port ? record.token : null;
}
