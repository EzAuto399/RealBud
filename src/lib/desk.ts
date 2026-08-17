export type RentSource = "mepay" | "bank" | "pms-export" | "fixture";
export type NotifyChannel = "sms" | "email" | "portal" | "desk";
export type DraftKind = "courtesy-rent" | "levy-from-rent";
export type DraftStatus = "pending" | "allowed" | "denied";
export type CheckOutcome = "draft" | "escalate" | "clear" | "skip";
export type CheckReason =
  | "rent-unpaid-courtesy"
  | "rent-landed-levy-unpaid"
  | "rent-landed"
  | "inside-grace"
  | "already-reminded"
  | "statutory-clock";

export interface LevyFromRent {
  amountCents: number;
  cadence: "quarterly" | "monthly";
}

export interface PropertyOptions {
  rentSource: RentSource;
  graceDays: number;
  courtesyUntilDay: number;
  levyFromRent: LevyFromRent | null;
  notifyChannel: NotifyChannel;
  never: string[];
}

export interface Property {
  id: string;
  address: string;
  tenantName: string;
  tenantPhone: string;
  weeklyRentCents: number;
  options: PropertyOptions;
}

export interface Draft {
  id: string;
  propertyId: string;
  kind: DraftKind;
  status: DraftStatus;
  channel: NotifyChannel;
  to: string;
  body: string;
  periodDueAt: number;
  createdAt: number;
  decidedAt?: number;
}

export interface Escalation {
  id: string;
  propertyId: string;
  reason: "statutory-clock";
  detail: string;
  periodDueAt: number;
  createdAt: number;
}

export interface CheckResult {
  propertyId: string;
  outcome: CheckOutcome;
  reason: CheckReason;
  daysLate: number;
}

export interface DeskSnapshot {
  properties: Property[];
  drafts: Draft[];
  escalations: Escalation[];
  lastRunAt: number | null;
  results: CheckResult[];
}

export function aud(cents: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
}
