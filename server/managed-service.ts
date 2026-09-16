import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./config.ts";
import { serviceAdmin } from "./care-unlock.ts";
import { createServiceEntitlementAuthority } from "./service-entitlement.ts";
import type { ServiceEntitlementCapability } from "../shared/service-entitlement.ts";

function installation(): { companyId?: string; hostInstallationId?: string } {
  try {
    const path = join(DATA_DIR, "service-installation.json");
    if (statSync(path).size > 2048) return {};
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const fields = value as Record<string, unknown>;
    if (fields.schema !== 1 || Object.keys(fields).some(key => !["schema", "companyId", "hostInstallationId"].includes(key)) ||
      typeof fields.companyId !== "string" || typeof fields.hostInstallationId !== "string") return {};
    return { companyId: fields.companyId, hostInstallationId: fields.hostInstallationId };
  } catch { return {}; }
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
