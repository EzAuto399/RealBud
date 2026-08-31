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
  | "uncovered-by-worker"
  | "ambiguous-match";

export type HandsSource = "demo" | "hermes" | "held" | "csv" | "fixture";

export type BookMode = "demo" | "live";

export type WorkKind =
  | "money-arrears"
  | "owner-letter"
  | "inbound-triage"
  | "maintenance-intake"
  | "lease-review"
  | "inspection-prep";

export interface RoutineOrigin {
  kind: "routine";
  runId: string;
  loopId: string;
}

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

export type LoopId = "morning-arrears" | "owner-letter" | "inbound-triage" | `recipe-${string}`;

export type LoopSchedule = { type: "daily"; time: string; weekdays: number[] };

export type LoopRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "partial"
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
  /** The office's own PMS code for this property, when the visit named one. */
  propertyCode?: string;
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
  /** Remote audit stamp, e.g. "via Telegram · Yoda". Desk Allow leaves this unset. */
  via?: string;
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
  lastCheckedAt?: number | null;
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
  origin?: RoutineOrigin;
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

export interface DeskBookView {
  bookProposals: Array<{
    id: string;
    address: string;
    tenantName: string;
    tenantPhone: string;
    weeklyRentCents: number;
    origin: "ask" | "manual";
  }>;
  agency: { name: string; timezone: string; jurisdictions: string[] };
  /** Eight visit fields. Empty strings until a named office fills them. */
  office: {
    pmUser: string;
    pmsBrand: string;
    namedExporter: string;
    exportCadence: string;
    exportIdentity: string;
    officeOs: string;
    vendorTestAccount: string;
  };
  tenancies: Array<{
    id: string;
    propertyId: string;
    status: "current" | "closed";
    weeklyRentCents: number;
    closedAt?: number;
  }>;
  contacts: Array<{
    id: string;
    role: string;
    name: string;
    phone: string;
    propertyId: string;
    tenancyId?: string;
    safeguards: {
      hardship: boolean;
      dispute: boolean;
      paymentArrangement: boolean;
      doNotContact: boolean;
      preferredChannel: string;
    };
  }>;
  archivedProperties: Array<{ id: string; address: string; archivedAt?: number }>;
  importIssues: Array<{ id: string; kind: string; status: string; rawIdentity: string }>;
  cases: Array<{
    id: string;
    kind: string;
    /** Decode rejects anything outside WORK_STATES, so the queue can map this
     * exhaustively instead of guessing. */
    state: WorkState;
    propertyId?: string;
    origin?: RoutineOrigin;
  }>;
  decisions: Array<{
    id: string;
    caseId: string;
    proposalId: string;
    revisionId: string;
    action: string;
    actor: string;
    at: number;
  }>;
  handoff?: {
    caseId: string;
    origin: string;
    allowedActions: string[];
    expiresAt: number;
    presentation: "side-by-side" | "inspector" | "window";
  };
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
  book?: DeskBookView;
}

export interface CsvColumnMapping {
  identity?: string;
  daysSinceDue?: string;
  rentLanded?: string;
  levyPaid?: string;
}

export interface CsvRejectedRow {
  row: number;
  reason: string;
}

export interface CsvImportPreview {
  digest: string;
  expectedRevision: number;
  observedAt: number;
  totalRows: number;
  matched: Array<{ propertyId: string; address: string }>;
  unmatched: Array<{ kind: "id" | "address" | "code"; value: string }>;
  ambiguous: Array<{ kind: "id" | "address" | "code"; value: string; matchCount: number }>;
  headers: string[];
  detected: CsvColumnMapping;
  rejected: CsvRejectedRow[];
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
  /** Recipe loops only: the plan is on the book but no one has approved it yet. */
  waitingForPlan?: boolean;
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

export type RecipeStatus = "shadow" | "active" | "paused";
export interface Recipe {
  id: string;
  title: string;
  steps: string[];
  allowedOrigins: string[];
  evidence: string;
  /** What runs taught Bud about this site's layout — page names, button
   * labels, quirks. Written by distill; carried into every later run. */
  siteNotes?: string | null;
  status: RecipeStatus;
  createdAt: number;
  /** RealBud clock; null means the job stays manual until a cadence is taught. */
  schedule: { time: string; weekdays: number[] } | null;
  /** Set once when a person approves the plan. Missing on disk loads as null. */
  planApprovedAt: number | null;
}

/** Clock-runnable: active and a person has approved the plan. Shadow stays manual. */
export function recipeClockRunnable(recipe: Pick<Recipe, "status" | "planApprovedAt">): boolean {
  return recipe.status === "active" && recipe.planApprovedAt != null;
}

export type PortalSessionState = "prepared" | "running" | "awaiting-review" | "done" | "unknown" | "failed";
export interface PortalSession {
  id: string;
  recipeId: string;
  state: PortalSessionState;
  shadow: boolean;
  allowedOrigins: string[];
  submitLease: { origin: string; expiresAt: number } | null;
  evidence: { at: number; note: string }[];
  detail: string;
  startedAt: number;
  endedAt?: number;
}

export function aud(cents: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
}
