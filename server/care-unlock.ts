// Compatibility facade: care access is a scoped administrator session, never
// a process-global unlock. Existing credential values are not rewritten here.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IncomingMessage } from "node:http";
import { DATA_DIR } from "./config.ts";
import { readServiceAdminPolicy, ServiceAdminAuthority } from "./service-admin.ts";

type Request = Pick<IncomingMessage, "headers">;
export const serviceAdmin = new ServiceAdminAuthority({
  loadPolicy: () => readServiceAdminPolicy({
    path: process.env.REALBUD_SERVICE_ADMIN_FILE || join(DATA_DIR, "service-admin.json"),
    managedDefault: process.env.REALBUD_MANAGED_SERVICE === "1" || process.env.REALBUD_PRODUCTION === "1" ||
      process.env.REALBUD_CARE_LOCK === "1" || Boolean(process.env.REALBUD_CARE_UNLOCK) || existsSync(join(DATA_DIR, "care.json")),
  }),
});
export function careCredentialsLocked(request?: Request): boolean {
  const status = serviceAdmin.status(request);
  return status.managed && !status.authenticated;
}
export function careStatus(request?: Request): { credentialsLocked: boolean; unlockAvailable: boolean } {
  const status = serviceAdmin.status(request);
  return { credentialsLocked: status.managed && !status.authenticated, unlockAvailable: status.configured };
}
export const unlockCare = (password: unknown) => serviceAdmin.login(password);
export const lockCare = (request?: Request): void => { serviceAdmin.logout(request); };
