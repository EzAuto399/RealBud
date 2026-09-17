/** Administrator authority is separate from an office member or owner role. */
export const SERVICE_ADMIN_HEADER = "x-realbud-service-admin";

export interface ServiceAdminStatus {
  managed: boolean;
  configured: boolean;
  authenticated: boolean;
  expiresAt: number | null;
  configurationError: boolean;
}

export interface ServiceAdminLogin {
  token: string;
  expiresAt: number;
  status: ServiceAdminStatus;
}

export type ServiceAdminGate =
  | { ok: true; expiresAt: number }
  | { ok: false; status: 401 | 403; error: string };
