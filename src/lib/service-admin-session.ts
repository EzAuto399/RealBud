import { SERVICE_ADMIN_HEADER, type ServiceAdminLogin, type ServiceAdminStatus } from "../../shared/service-admin";

// Administration belongs to this renderer only: never localStorage, a URL,
// the shared store/SSE stream, a worker or a company invitation.
let credential: { token: string; expiresAt: number } | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
let revision = 0;
const listeners = new Set<() => void>();
export const SERVICE_ADMIN_CHANGED = "realbud-service-admin-changed";
function changed(): void {
  revision++;
  for (const listener of listeners) listener();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SERVICE_ADMIN_CHANGED));
}
export const subscribeServiceAdmin = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const serviceAdminRevision = (): number => revision;
function scheduleExpiry(): void {
  clearTimeout(expiryTimer);
  if (!credential) return;
  expiryTimer = setTimeout(() => {
    if (credential && credential.expiresAt <= Date.now()) clearServiceAdminSession();
    else scheduleExpiry();
  }, Math.max(1, credential.expiresAt - Date.now()));
}
export function setServiceAdminSession(login: ServiceAdminLogin): void {
  if (!/^[a-f0-9]{64}$/.test(login.token) || !Number.isSafeInteger(login.expiresAt) || login.expiresAt <= Date.now() ||
    login.expiresAt > Date.now() + 15 * 60_000 || login.status?.authenticated !== true || login.status.expiresAt !== login.expiresAt) {
    throw new Error("Administrator sign-in could not be confirmed.");
  }
  credential = { token: login.token, expiresAt: login.expiresAt };
  scheduleExpiry();
  changed();
}
export function clearServiceAdminSession(expectedToken?: string | null): void {
  if (expectedToken !== undefined && expectedToken !== (credential?.token ?? null)) return;
  clearTimeout(expiryTimer);
  if (!credential) return;
  credential = null; changed();
}
export function refreshServiceAdminExpiry(requestToken: string | null, responseExpiry: string | null): void {
  if (!credential || credential.token !== requestToken || !responseExpiry) return;
  if (credential.expiresAt <= Date.now()) { clearServiceAdminSession(); return; }
  const expiresAt = Number(responseExpiry);
  if (Number.isSafeInteger(expiresAt) && expiresAt > Date.now() && expiresAt <= Date.now() + 15 * 60_000) {
    credential.expiresAt = expiresAt;
    scheduleExpiry();
  }
}
export function refreshServiceAdminSession(status: ServiceAdminStatus, requestToken: string | null = credential?.token ?? null): boolean {
  if (requestToken !== (credential?.token ?? null)) return false;
  if (!credential) return !status.authenticated;
  if (credential.expiresAt <= Date.now()) { clearServiceAdminSession(); return false; }
  if (!status.authenticated || status.expiresAt === null || status.expiresAt <= Date.now()) {
    clearServiceAdminSession();
  } else {
    credential.expiresAt = status.expiresAt;
    scheduleExpiry();
  }
  return true;
}
export function hasServiceAdminSession(): boolean { return Boolean(credential && credential.expiresAt > Date.now()); }
export function serviceAdminHeaders(): Record<string, string> {
  if (credential && credential.expiresAt <= Date.now()) clearServiceAdminSession();
  return credential ? { [SERVICE_ADMIN_HEADER]: credential.token } : {};
}
