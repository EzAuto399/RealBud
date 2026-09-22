// Identity for one RealBud installation's office service.
//
// Shared by the server child (which publishes it on /api/health) and the desktop
// app (which uses it to recognise its own service). It is plain JavaScript in
// `shared/` on purpose, so BOTH sides import the same file:
//
//   - the server build emits `dist-server/shared/service-identity.mjs`, and the
//     packaged app ships it as `<resources>/shared/`;
//   - Electron main runs JavaScript and cannot import TypeScript, so a `.ts`
//     module here would have forced a second implementation on the app side.
//
// Two implementations would be a correctness hazard, not a style question: if
// the two sides hashed differently, the app would fail to recognise its own
// running service and fork a second one beside it — two authorities on one
// company database.
//
// The id is a hash of the data directory, never the path itself, so the health
// endpoint does not disclose a filesystem layout.
import { createHash } from "node:crypto";
import { resolve } from "node:path";

/** Fraction of the digest kept. Long enough that a collision is not a concern. */
const ID_LENGTH = 32;

/**
 * Derive the stable service identity for one installation.
 *
 * Same data directory in, same id out — across restarts, and across the app and
 * the service that outlives it. A different data directory yields a different
 * id, so two installations on one machine can never adopt each other's service.
 *
 * The path is normalised before hashing because the two callers obtain it
 * differently: the app composes it from `app.getPath("home")`, the server reads
 * it from the environment. Hashing the raw strings would make one office look
 * like two installations whenever a side carried a trailing separator or a
 * relative path.
 *
 * @param {string} dataDirectory Absolute path of this installation's data directory.
 * @returns {string} Stable identity for this installation.
 */
export function serviceInstanceId(dataDirectory) {
  const normalised = resolve(dataDirectory);
  return createHash("sha256").update(`realbud-instance:${normalised}`).digest("hex").slice(0, ID_LENGTH);
}
