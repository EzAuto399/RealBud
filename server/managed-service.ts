import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type Stats } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { serviceAdmin } from "./care-unlock.ts";
import { createServiceEntitlementAuthority } from "./service-entitlement.ts";
import { writePrivateJson, removePrivateJson } from "./private-json.ts";
import type { ServiceEntitlementCapability } from "../shared/service-entitlement.ts";

const MAX_INSTALLATION_BYTES = 2048;
const INSTALLATION_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export class ServiceInstallationRecoveryError extends Error {
  readonly status = 503;
  readonly code = "service_installation_recovery_required";
  constructor() {
    super("This computer's service installation needs recovery. Its access records were kept; contact RealBud support.");
    this.name = "ServiceInstallationRecoveryError";
  }
}

export const serviceInstallationPath = (directory = DATA_DIR): string => join(directory, "service-installation.json");

/** The enrolment writer. Only this module knows the file's shape, so a change
 * here cannot drift from the reader the entitlement authority already uses. */
export async function writeServiceInstallation(directory: string, value: { companyId: string; hostInstallationId: string }): Promise<void> {
  await writePrivateJson(serviceInstallationPath(directory), { schema: 1, companyId: value.companyId, hostInstallationId: value.hostInstallationId });
}

/** Withdrawal drops the company/host binding; saved work records are untouched. */
export async function removeServiceInstallation(directory: string): Promise<void> {
  await removePrivateJson(serviceInstallationPath(directory));
}

/** True while this computer still carries a service installation binding. A
 * service administrator removing the file is a withdrawal, not a corruption. */
export function serviceInstallationPresent(directory = DATA_DIR): boolean {
  const { companyId, hostInstallationId } = installation(directory);
  return Boolean(companyId && hostInstallationId);
}

/** The trusted company/host binding, or null when this computer has none. */
export function serviceInstallationBinding(directory = DATA_DIR): { companyId: string; hostInstallationId: string } | null {
  const { companyId, hostInstallationId } = installation(directory);
  return companyId && hostInstallationId ? { companyId, hostInstallationId } : null;
}

function installation(directory = DATA_DIR): { companyId?: string; hostInstallationId?: string } {
  const path = serviceInstallationPath(directory);
  let stat: Stats;
  // Absence is the administrator's withdrawal signal. Damage, an unreadable
  // entry or a dangling link is not permission to destroy a valid model key.
  try { stat = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new ServiceInstallationRecoveryError();
  }
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_INSTALLATION_BYTES ||
      (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new ServiceInstallationRecoveryError();
    // The private writer admits Windows ACLs. This synchronous capability-read
    // path must not launch PowerShell on every worker/tool permission check.
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let value: unknown;
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MAX_INSTALLATION_BYTES) throw new ServiceInstallationRecoveryError();
      // Bound the allocation and read even if the file grows after lstat.
      const bytes = Buffer.alloc(MAX_INSTALLATION_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > MAX_INSTALLATION_BYTES) throw new ServiceInstallationRecoveryError();
      value = JSON.parse(bytes.subarray(0, size).toString("utf8"));
    } finally { closeSync(fd); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ServiceInstallationRecoveryError();
    const fields = value as Record<string, unknown>;
    if (fields.schema !== 1 || Object.keys(fields).some(key => !["schema", "companyId", "hostInstallationId"].includes(key)) ||
      typeof fields.companyId !== "string" || !INSTALLATION_ID.test(fields.companyId) ||
      typeof fields.hostInstallationId !== "string" || !INSTALLATION_ID.test(fields.hostInstallationId)) throw new ServiceInstallationRecoveryError();
    return { companyId: fields.companyId, hostInstallationId: fields.hostInstallationId };
  } catch { throw new ServiceInstallationRecoveryError(); }
}

/** No policy, public key or company/host identity can come from an HTTP body.
 * The real hosted model/tool gateway must independently enforce this grant.
 * This consumer does not claim billing or protection from host administrators.
 */
export const managedService = createServiceEntitlementAuthority(() => ({
  managed: serviceAdmin.status().managed,
  required: process.env.REALBUD_SERVICE_ENTITLEMENT_REQUIRED !== "0",
  path: join(DATA_DIR, "service-entitlement.json"),
  trustedKeysPath: process.env.REALBUD_SERVICE_TRUST_KEYS_FILE || join(DATA_DIR, "service-trust-keys.json"),
  ...installation(),
}));

/** Preserve callers' existing held/failure result contracts on denied service. */
export function managedServiceFailure(capability: ServiceEntitlementCapability): string | null {
  try { managedService.assertCapability(capability); return null; }
  catch (error) { return error instanceof Error ? error.message : "Managed service is unavailable. Contact service support."; }
}
