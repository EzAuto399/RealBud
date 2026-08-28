// Dependency-free contracts shared by the RealBud server and UI.
// Discriminated `kind` only — no workflow DSL. Money/arrears is the first kind.

export const NEVER_ACTIONS = ["statutory-send", "trust-pay"] as const;

export const COURTESY_DISCLAIMER =
  "This is not a formal notice and does not start any notice period.";

export type RentSource = "mepay" | "bank" | "pms-export" | "fixture" | "csv";
export type NotifyChannel = "sms" | "email" | "portal" | "desk";
export type DraftKind = "courtesy-rent" | "levy-from-rent" | "owner-letter" | "inbound-reply";
export type DraftStatus = "pending" | "allowed" | "denied" | "stale";
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
  | "ambiguous-match"
  | "uncovered-source"
  | "conflicted-source";

export type HandsSource = "demo" | "hermes" | "held" | "csv" | "fixture";

export type BookMode = "demo" | "live";

export type WorkKind =
  | "money-arrears"
  | "owner-letter"
  | "inbound-triage"
  | "maintenance-intake"
  | "lease-review"
  | "inspection-prep"
  | "source-incident";

export const WAITING_PARTIES = ["sender", "tenant", "owner", "tradie", "licensee", "pm"] as const;
export const CLOSURE_KINDS = ["resolved-externally", "not-needed", "duplicate", "cancelled"] as const;

export type WaitingParty = (typeof WAITING_PARTIES)[number];
export type ClosureKind = (typeof CLOSURE_KINDS)[number];

/** Code-owned operational lifecycle. These timestamps are reminders and
 * receipts only; they are never statutory clocks or proof an external action
 * occurred. */
export interface WorkLifecycle {
  waitingParty?: WaitingParty;
  dueAt?: number;
  nextCheckAt?: number;
  reminderSuppressedUntil?: number;
  closedAt?: number;
  closedBy?: "pm" | "system";
  closureKind?: ClosureKind;
}

export interface SourceIncidentDetail {
  sourceId: string;
  code: "missing" | "stale" | "unavailable" | "unverified" | "revoked";
  affectedPropertyCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface ImportIdentity {
  kind: "id" | "address" | "code";
  value: string;
}

export interface PmsImportPreviewColumn {
  field: "property-identity" | "days-since-due" | "rent-landed" | "levy-paid" | "days-since-courtesy" | "amount-paid" | "reversed";
  label: string;
  sourceHeader: string;
  required: boolean;
}

/** Read-only, privacy-bounded review of one selected structured PMS export.
 * It contains column names and aggregate counts only: no property identity,
 * tenant, money amount, source row or filesystem path. */
export interface PmsImportPreview {
  kind: "realbud.pms-import-preview.v1";
  deskRevision: number;
  csvDigest: string;
  observedAt: number;
  bytes: number;
  totalRows: number;
  identityKind: ImportIdentity["kind"];
  columns: PmsImportPreviewColumn[];
  matchedProperties: number;
  rowsNeedingLink: number;
  conflictingProperties: number;
  duplicateRows: number;
  missingProperties: number;
  willVerifyLiveBook: boolean;
  warnings: string[];
}

export const INBOUND_CATEGORIES = [
  "urgent-maintenance-review",
  "routine-maintenance",
  "tradie-update",
  "owner-instruction",
  "payment-evidence",
  "bdm-lead",
  "licensed-matter",
  "unmatched",
] as const;

export const INBOUND_PRIORITIES = ["urgent-review", "priority", "routine", "licensed-review"] as const;

export type InboundCategory = (typeof INBOUND_CATEGORIES)[number];
export type InboundPriority = (typeof INBOUND_PRIORITIES)[number];

/** Encrypted, bounded case context. Raw message bodies, provider identifiers,
 * credentials and attachment bytes never enter the Desk book. */
export interface InboundCaseDetail {
  category: InboundCategory;
  priority: InboundPriority;
  senderName: string;
  senderAddress: string;
  subject: string;
  summary: string;
  receivedAt: number;
  messageKey: string;
  threadKey: string;
  attachmentCount: number;
  messageCount: number;
  flags: string[];
  waitingOn?: "pm-send" | "sender" | "licensed-review";
  followUpAt?: number;
}

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
  | "waiting"
  | "effect-unknown"
  | "handoff-expired";

export type LoopId = "morning-arrears" | "owner-letter" | "inbound-triage";

export type LoopSchedule = { type: "daily"; time: string; weekdays: number[] };

export type LoopRequirementId =
  | "desk-book"
  | "current-money-source"
  | "read-only-mail";

export type LoopSetupTarget = "desk" | "worker" | "connections";

/** Code-owned dependency metadata. This describes what a typed routine uses;
 * it is not a user-authored tool list and grants no execution authority. */
export interface LoopRequirement {
  id: LoopRequirementId;
  label: string;
  purpose: string;
  setupTarget: LoopSetupTarget;
}

export type LoopRunStepId = "preflight" | "collect" | "evaluate" | "stage-desk";

export type LoopRunStepStatus = "running" | "completed" | "failed" | "skipped" | "interrupted";

/** A bounded, code-authored receipt for one phase of a routine run. */
export interface LoopRunStep {
  id: LoopRunStepId;
  label: string;
  status: LoopRunStepStatus;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}

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
  kind: "csv" | "hermes" | "portal" | "mail" | "demo";
  label: string;
  stableKey: string;
  /** Safe source-health metadata only. No rows, references, account ids or
   * credentials are projected into the queue snapshot. */
  observedAt?: number;
  staleAt?: number;
  coverage?: "complete" | "incomplete" | "unknown";
}

export interface Observation {
  id: string;
  sourceId: string;
  observedAt: number;
  propertyId?: string;
  facts?: Partial<LedgerFacts>;
  /** A complete import records one row for every active property. Missing or
   * duplicate mappings are evidence too, but can never produce wording. */
  coverage?: "observed" | "missing" | "conflicted";
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
  evidenceId?: string;
  evidenceIds?: string[];
  evidenceStatus?: "current" | "stale" | "conflicted" | "requires-recheck";
  evidenceStaleAt?: number;
  proposalHash: string;
  createdAt: number;
  updatedAt: number;
  holdReason?: string;
  artifactIds?: string[];
  origin?: RoutineOrigin;
  inbound?: InboundCaseDetail;
  lifecycle?: WorkLifecycle;
  sourceIncident?: SourceIncidentDetail;
  importIdentity?: ImportIdentity;
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
  importIssues: Array<{
    id: string;
    kind: string;
    status: string;
    sourceId: string;
    rawIdentity: string;
    identityKind?: ImportIdentity["kind"];
    candidates: string[];
    linkedPropertyId?: string;
    resolvedAt?: number;
    resolvedBy?: string;
    resolutionCount: number;
  }>;
  cases: Array<{
    id: string;
    kind: string;
    state: string;
    propertyId?: string;
    origin?: RoutineOrigin;
    inbound?: InboundCaseDetail;
    lifecycle?: WorkLifecycle;
    sourceIncident?: SourceIncidentDetail;
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
  /** A read-only review aid derived from immutable proposal revisions and
   * explicit Allow decisions. It may shorten presentation, never approval. */
  reviewAssist?: Array<{
    proposalId: string;
    mode: "first-time" | "familiar" | "attention";
    priorAllowedCount: number;
    lastAllowedAt?: number;
    evidence: "current" | "practice" | "attention";
    observedAt?: number;
    recipient: "first-time" | "same" | "changed";
    channel: "first-time" | "same" | "changed";
    wording: "first-time" | "same" | "changed";
    editedOnCard: boolean;
    safeguardAttention: boolean;
    moneyBoundary: boolean;
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
  loadOff?: {
    recordsChecked: number;
    draftsPrepared: number;
    exceptionsHeld: number;
    waitingOnSomeone: number;
    followUpsClosed: number;
    systemsAvoided: number | null;
    elapsedMs: number | null;
  };
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
  /** Closed dependency list projected by Schedule. It never contains raw
   * provider tools, URLs, credentials, commands or user-authored steps. */
  requirements?: LoopRequirement[];
  timezonePaused?: boolean;
}

export interface LoopRun {
  id: string;
  loopId: LoopId;
  loopName: string;
  /** Optional command idempotency key. Ask action replays return this run
   * instead of starting the routine twice after a lost response/restart. */
  requestId?: string;
  /** Stable scheduled-occurrence key. Optional so existing loops.json v3
   * files load without migration; legacy scheduled runs receive one on read. */
  occurrenceKey?: string;
  /** Routine revision captured when this run was admitted. */
  routineRevision?: number;
  scheduledFor: number;
  status: LoopRunStatus;
  manual: boolean;
  detail?: string;
  /** Bounded durable phase receipts. Existing runs may have no steps. */
  steps?: LoopRunStep[];
  startedAt?: number;
  finishedAt?: number;
  seenAt?: number;
  /** Set only after the desktop shell accepts the one privacy-safe OS
   * reminder for this final run. Optional for every existing loops.json. */
  notifiedAt?: number;
  createdAt: number;
}

export type SourceConnectionState = "ready" | "practice" | "attention" | "pilot-gated";

export type SourceConnectionMethodId =
  | "local-export"
  | "selected-evidence"
  | "paste-manual"
  | "read-only-bank-browser"
  | "direct-api"
  | "private-pms-browser"
  | "restricted-composio"
  | "approved-mcp";

export type SourceConnectionMethodState = "active" | "practice" | "attention" | "pilot-gated" | "not-built";

/** Read-only product projection for You. A method is an implementation route,
 * never a generic connector/tool grant. */
export interface SourceConnectionMethod {
  id: SourceConnectionMethodId;
  label: string;
  state: SourceConnectionMethodState;
  detail: string;
}

export interface SourceConnection {
  id: "property-book" | "inbound-mail-calendar";
  title: string;
  description: string;
  state: SourceConnectionState;
  status: string;
  capabilities: string[];
  methods: SourceConnectionMethod[];
  /** PM-owned display name. The official title stays the product name. */
  alias?: string;
}

export type PilotDiscoveryFieldId =
  | "agency-pm"
  | "pms-brand"
  | "named-exporter"
  | "export-cadence"
  | "export-identity"
  | "office-os"
  | "jurisdictions"
  | "vendor-test-account";

export type PilotDiscoveryFieldState = "confirmed" | "partial" | "unconfirmed";

export type PilotWorkflowId = "morning-money" | "inbox-maintenance" | "tenancy-dates";

export type AgencySystemFamilyId =
  | "pms-rent-roll"
  | "bank-evidence"
  | "inbox-calendar"
  | "leasing-inspections"
  | "maintenance-compliance"
  | "listing-leads"
  | "mobile-pocket";

/** Read-only pilot discovery projected in You. External agency research is
 * never compiled into this contract and cannot satisfy a release, account or
 * execution gate. Operational confirmation comes from the named PM. */
export interface PilotDiscoveryProjection {
  kind: "realbud.pilot-discovery.v1";
  schemaVersion: 1;
  generatedAt: string;
  office: {
    agency: string | null;
    state: "unconfigured" | "partial" | "contract-complete";
    summary: string;
    signals: string[];
  };
  readiness: {
    confirmedFields: number;
    requiredFields: 8;
    contractComplete: boolean;
    evidence: "pilot-gated" | "contract-complete-unproved";
    detail: string;
  };
  fields: Array<{
    id: PilotDiscoveryFieldId;
    label: string;
    state: PilotDiscoveryFieldState;
    value: string | null;
    question: string;
  }>;
  shadowWorkflows: Array<{
    id: PilotWorkflowId;
    label: string;
    outcome: string;
    baselineQuestion: string;
    currentEvidence: "source-built" | "foundation-built" | "planned";
  }>;
  systemFamilies: Array<{
    id: AgencySystemFamilyId;
    label: string;
    recognisedExamples: string[];
    routeOrder: string[];
    proofNeeded: string;
  }>;
  boundaries: {
    externalResearchGrantsAuthority: false;
    manualAllow: true;
    humanSubmit: true;
    sendAvailable: false;
    paymentAvailable: false;
    statutoryDraftingAvailable: false;
    personalBrowserAccess: false;
    personalHermesAccess: false;
  };
}

export type WorkRoutingPreference = "auto" | "local-standard" | "local-accelerated" | "cloud-accelerated";
export type WorkRoutingMode = Exclude<WorkRoutingPreference, "auto">;
export type WorkRouteKind =
  | "structured-batch"
  | "local-analysis"
  | "remote-analysis"
  | "scripted-browser"
  | "isolated-browser"
  | "remote-browser"
  | "desktop-cua";
export type WorkRouteState = "ready" | "gated";
export type WorkRouteIsolation =
  | "realbud-process"
  | "realbud-workspace"
  | "realbud-browser-profile"
  | "remote-isolated"
  | "visible-desktop";

/** One app-owned lane in a read-only execution plan. It contains workload
 * shape and isolation truth only—never source content, credentials, cookies,
 * personal paths, raw tools or execution authority. */
export interface WorkRouteLane {
  kind: WorkRouteKind;
  state: WorkRouteState;
  itemCount: number;
  batchCount: number;
  concurrency: number;
  isolation: WorkRouteIsolation;
  detail: string;
}

export interface WorkRouteEstimate {
  basis: "measured" | "unavailable";
  minimumSeconds: number | null;
  maximumSeconds: number | null;
  detail: string;
}

/** Versioned local-first projection used by existing RealBud surfaces. Cloud
 * can shorten a run but `cloudRequired` is permanently false. */
export interface WorkRoutingPlan {
  kind: "realbud.work-routing.v1";
  schemaVersion: 1;
  /** False when the planner is using RealBud's safe automatic default. This
   * is presentation state only; choosing a preference never grants a route. */
  preferenceConfigured?: boolean;
  /** Monotonic app-config revision used only to reject stale settings writes. */
  preferenceRevision?: number;
  requestedMode: WorkRoutingPreference;
  selectedMode: WorkRoutingMode;
  propertyCount: number;
  lanes: WorkRouteLane[];
  estimate: WorkRouteEstimate;
  fallbackReasons: string[];
  boundaries: {
    cloudRequired: false;
    maxIsolatedBrowsers: 2;
    maxDesktopCua: 1;
    workerOwnership: "external-pinned-runtime";
    browserOwnership: "realbud-only";
    personalBrowserAccess: false;
    personalHermesAccess: false;
  };
}

export type ExecutionAdapterTransport =
  | "direct-api"
  | "restricted-composio"
  | "approved-mcp"
  | "isolated-task"
  | "private-browser"
  | "bounded-cua"
  | "remote-lane"
  | "history-api";

export type ExecutionAdapterProjectionState =
  | "foundation"
  | "ready"
  | "attention"
  | "stale"
  | "revoked"
  | "runtime-unavailable";

/** Sanitized, read-only truth for You -> Connections. A foundation means the
 * code-owned admission contract exists; it never means an account, provider,
 * browser, command runner or History runtime is connected. */
export interface ExecutionAdapterProjection {
  id: string;
  label: string;
  method: string;
  state: ExecutionAdapterProjectionState;
  status: string;
  detail: string;
  capabilities: string[];
  route: WorkRouteKind | null;
  maxConcurrency: number;
  boundaries: {
    manualAllow: true;
    humanSubmit: true;
    rawToolsExposed: false;
    ambientCredentials: false;
    personalBrowserAccess: false;
    personalHermesAccess: false;
    localFallback: true;
  };
  observedAt: number | null;
  expiresAt: number | null;
}

export type ModelUsageMetering = "empty" | "reported" | "partial" | "unavailable";
export type ModelUsageStorage = "ok" | "recovered" | "attention";

/** Private, message-free usage projection for You. Provider invoices remain
 * authoritative: RealBud reports only events the pinned worker supplied and
 * never manufactures a dollar estimate for a provider that omitted cost. */
export interface ModelUsageSummary {
  period: { kind: "rolling"; days: 7; startsAt: number; endsAt: number };
  completedTurns: number;
  successfulTurns: number;
  failedTurns: number;
  tokenReportedTurns: number;
  inputTokens: number;
  outputTokens: number;
  costReportedTurns: number;
  costUsd: number | null;
  lastUsedAt: number | null;
  lastProvider: string | null;
  lastModel: string | null;
  metering: ModelUsageMetering;
  storage: ModelUsageStorage;
  detail: string;
}

export type SupportEvidenceState =
  | "not-recorded"
  | "requires-installed-proof"
  | "pilot-gated"
  | "contract-complete-unproved";

/** Privacy-safe diagnostics a PM can attach to a support request. It contains
 * only build labels, categorical health and aggregate counts—never people,
 * properties, messages, Notes, source bodies, credentials or host paths. */
export interface SupportReport {
  kind: "realbud.support-report.v1";
  schemaVersion: 1;
  generatedAt: string;
  app: {
    version: string;
    buildId: string | null;
    distribution: "source" | "packaged";
    platform: "darwin" | "win32" | "linux" | "other";
    architecture: "arm64" | "x64" | "other";
    nodeMajor: number;
    productMode: boolean;
    productionMode: boolean;
  };
  evidence: {
    source: SupportEvidenceState;
    installed: SupportEvidenceState;
    namedOffice: SupportEvidenceState;
  };
  desk: {
    mode: BookMode;
    revision: number;
    recoveryActive: boolean;
    properties: number;
    sources: number;
    openWork: number;
    pendingDrafts: number;
    openImportIssues: number;
  };
  worker: {
    state: "ready" | "setup-required" | "recovery" | "busy" | "unavailable";
    pinVersion: string;
    privateRuntimeInstalled: boolean;
    pinMatches: boolean;
    packInstalled: boolean;
    approvalsManual: boolean;
    modelAttached: boolean;
  };
  schedules: {
    state: "ready" | "recovery";
    available: number;
    enabled: number;
    recentRuns: Record<LoopRunStatus, number>;
  };
  connections: Array<{
    id: SourceConnection["id"];
    state: SourceConnectionState;
    methods: Array<{ id: SourceConnectionMethodId; state: SourceConnectionMethodState }>;
  }>;
  execution: Array<{
    id: string;
    state: ExecutionAdapterProjectionState;
    route: WorkRouteKind | null;
    maxConcurrency: number;
  }>;
  mobile: {
    state: "off" | "pilot-gated" | "setup-required" | "connecting" | "ready" | "attention";
    connectedCount: number;
  };
  recovery: {
    active: boolean;
    issues: Array<{ area: string; action: string }>;
  };
}

export function aud(cents: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD" }).format(cents / 100);
}
