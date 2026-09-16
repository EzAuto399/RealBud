import { useSyncExternalStore } from "react";
import type { ServiceAdminStatus } from "../../shared/service-admin";
import { hasServiceAdminSession, serviceAdminRevision, subscribeServiceAdmin } from "./service-admin-session";

/** Unknown policy stays closed. A shared config/status response alone cannot
 * grant this renderer access. Expiry unmounts secret-bearing fields everywhere.
 */
export function useServiceAdminAccess(status: ServiceAdminStatus | undefined): boolean {
  useSyncExternalStore(subscribeServiceAdmin, serviceAdminRevision, serviceAdminRevision);
  return status?.managed === false || Boolean(status?.authenticated && hasServiceAdminSession());
}
