import type { NotifyChannel, RentSource } from "@/lib/desk";

export const RENT_SOURCE_LABELS: Record<RentSource, string> = {
  mepay: "MePay",
  bank: "Bank feed",
  "pms-export": "PMS export",
  fixture: "Sample ledger",
  csv: "CSV export",
};

export const NOTIFY_LABELS: Record<NotifyChannel, string> = {
  sms: "SMS",
  email: "Email",
  portal: "Portal",
  desk: "Desk only",
};

export function sourceLabel(source: RentSource): string {
  return RENT_SOURCE_LABELS[source];
}

export { CASE_KIND_LABELS } from "@/lib/desk-queue";

export const CONTACT_ROLE_LABELS: Record<string, string> = {
  tenant: "Tenant",
  occupant: "Occupant",
  owner: "Owner",
  tradie: "Tradie",
};
