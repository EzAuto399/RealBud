// Dependency-free contracts shared by the RealBud server and UI.
// Discriminated `kind` only — no workflow DSL. Money/arrears is the first kind.

export const NEVER_ACTIONS = ["statutory-send", "trust-pay"] as const;

export const COURTESY_DISCLAIMER =
  "This is not a formal notice and does not start any notice period.";

export type RentSource = "mepay" | "bank" | "pms-export" | "fixture" | "csv";
export type NotifyChannel = "sms" | "email" | "portal" | "desk";
export type DraftKind = "courtesy-rent" | "levy-from-rent" | "owner-letter";
export type DraftStatus = "pending" | "allowed" | "denied";
export type CheckOutcome = "draft" | "escalate" | "clear" | "skip" | "hold";
export type CheckReason =
  | "rent-unpaid-courtesy"
  | "rent-landed-levy-unpaid"
  | "rent-landed"
  | "inside-grace"
  | "already-reminded"
  | "statutory-clock"
  | "stale-source"
  | "unknown-facts"
  | "unmatched"
  | "reversed"
  | "partial"
  | "ambiguous-match";

export type HandsSource = "demo" | "hermes" | "held" | "csv" | "fixture";

export type BookMode = "demo" | "live";

export type WorkKind = "money-arrears" | "owner-letter";

export type WorkState =
  | "proposed"
  | "approved"
  | "denied"
  | "held"
  | "preparing"
  | "handoff-ready"
  | "confirmed"
  | "failed"
  | "stale"
  | "superseded"
  | "cancelled"
  | "effect-unknown"
  | "handoff-expired";

export type LoopId = "morning-arrears" | "owner-letter" | "inbound-triage";

export type LoopSchedule = { type: "daily"; time: string; weekdays: number[] };

export type LoopRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "missed"
  | "interrupted";

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
  notes?: string;
}

export interface LedgerFacts {
  propertyId: string;
  daysSinceDue: number;
  rentLanded: boolean;
  levyPaid: boolean;
  daysSinceCourtesy: number | null;
  amountPaidCents?: number | null;
  reversed?: boolean;
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
  workItemId?: string;
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

export interface SourceIdentity {
  id: string;
  kind: "csv" | "hermes" | "portal" | "demo";
  label: string;
  stableKey: string;
}

export interface Observation {
  id: string;
  sourceId: string;
  observedAt: number;
  propertyId?: string;
  facts?: Partial<LedgerFacts>;
  staleAfterMs: number;
}

export interface RecipientSnapshot {
  name: string;
  phone: string;
  doNotContact?: boolean;
  hardship?: boolean;
  dispute?: boolean;
  paymentArrangement?: boolean;
}

export interface WorkItem {
  id: string;
  kind: WorkKind;
  state: WorkState;
  propertyId: string;
  occurrenceKey: string;
  periodDueAt: number;
  draftId?: string;
  recipient: RecipientSnapshot;
  sourceIds: string[];
  observedAt: number;
  proposalHash: string;
  createdAt: number;
  updatedAt: number;
  holdReason?: string;
  artifactIds?: string[];
}

export interface PropertyPortalBinding {
  propertyId: string;
  recipeId: string;
  recipeVersion: number;
  remotePropertyId: string;
  remoteAccountId?: string;
}

export interface PortalRecipe {
  id: string;
  version: number;
  origin: string;
  published: boolean;
  steps: string[];
  finalControlFingerprint: string;
}

export interface PortalCapability {
  id: string;
  workItemId: string;
  revision: number;
  proposalHash: string;
  propertyId: string;
  recipeId: string;
  recipeVersion: number;
  operation: "prefill-courtesy";
  approver: string;
  expiresAt: number;
  usedAt?: number;
  invalidatedAt?: number;
}

export interface RecoveryState {
  active: boolean;
  reason: string | null;
  quarantined: string[];
}

export interface DeskSnapshot {
  version: 2;
  revision: number;
  mode: BookMode;
  recovery: RecoveryState;
  timezone: string;
  retentionDays: number | null;
  properties: Property[];
  ledger: LedgerFacts[];
  drafts: Draft[];
  escalations: Escalation[];
  workItems: WorkItem[];
  lastRunAt: number | null;
  results: CheckResult[];
  hands: HandsSource;
  handsDetail: string | null;
  sources: SourceIdentity[];
  demo: boolean;
}

export interface Loop {
  id: LoopId;
  name: string;
  description: string;
  available: boolean;
  enabled: boolean;
  /** Catalog default unless the PM retuned the clock (persisted in loops.json). */
  schedule: LoopSchedule;
  revision: number;
  nextRunAt: number | null;
  evaluatorId: string;
  evaluatorVersion: number;
  timezonePaused?: boolean;
}

export interface LoopRun {
  id: string;
  loopId: LoopId;
  loopName: string;
  scheduledFor: number;
  status: LoopRunStatus;
  manual: boolean;
  detail?: string;
  startedAt?: number;
  finishedAt?: number;
  seenAt?: number;
  createdAt: number;
}

export function aud(cents: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
}
