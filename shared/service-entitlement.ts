export const SERVICE_ENTITLEMENT_CAPABILITIES = ["reasoning", "connected-tools", "computer-use", "voice"] as const;
export type ServiceEntitlementCapability = typeof SERVICE_ENTITLEMENT_CAPABILITIES[number];

export type ServiceEntitlementState = "unmanaged" | "not-required" | "unconfigured" | "invalid" | "not-yet-valid" | "expired" | "active";

export interface ServiceEntitlementStatus {
  state: ServiceEntitlementState;
  managed: boolean;
  required: boolean;
  /** Capabilities presently permitted; inactive grants expose an empty list. */
  capabilities: ServiceEntitlementCapability[];
  expiresAt: number | null;
  error: string | null;
}

/** Timestamp fields are integer Unix milliseconds. IDs are opaque, not names. */
export interface ServiceEntitlementPayload {
  schema: 1;
  licenseId: string;
  companyId: string;
  hostInstallationId: string;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  capabilities: ServiceEntitlementCapability[];
}
