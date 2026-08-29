// Desk V3 contracts and closed unions only. No filesystem, no evaluators.
// Canonical product constraints: docs/GOAL-PROMPT.md wins conflicts.
// Architecture: docs/PRODUCT-DESIGN-PLAN.md.

import {
  NEVER_ACTIONS,
  type BookMode,
  type DraftKind,
  type HandsSource,
  type NotifyChannel,
  type PropertyOptions,
  type WorkState,
} from "./contracts.ts";
import { emptyOffice, type Office } from "./office.ts";

export type { Office } from "./office.ts";

export const DESK_FILE_VERSION = 3 as const;

export const CASE_KINDS = [
  "money-arrears",
  "owner-update",
  "inbound-triage",
  "maintenance-intake",
  "lease-review",
  "inspection-prep",
  "licensee-required",
] as const;

export const EVIDENCE_AUTHORITIES = ["pms", "demo", "legacy-unverified"] as const;
export const EVIDENCE_COLLECTORS = ["csv", "hermes", "bounded-portal", "migration"] as const;
export const MONEY_POSITION_STATUSES = ["current", "stale", "conflicted", "requires-recheck"] as const;
export const DECISION_KINDS = ["allow", "deny", "copy", "done"] as const;
export const CONTACT_ROLES = ["tenant", "occupant", "owner", "tradie"] as const;
export const PROPERTY_LIFECYCLES = ["active", "archived"] as const;
export const TENANCY_LIFECYCLES = ["current", "closed"] as const;
export const IMPORT_ISSUE_KINDS = ["unmatched", "ambiguous"] as const;
export const IMPORT_ISSUE_STATUSES = ["open", "linked", "rejected"] as const;
export const CLOSED_HANDOFF_OPERATIONS = ["prefill-courtesy"] as const;
export const FORBIDDEN_HANDOFF_ACTIONS = ["submit", "send", "pay"] as const;
export const LEGACY_UNKNOWN_ACTOR = "legacy-unknown" as const;

export type CaseKind = (typeof CASE_KINDS)[number];
export type EvidenceAuthority = (typeof EVIDENCE_AUTHORITIES)[number];
export type EvidenceCollector = (typeof EVIDENCE_COLLECTORS)[number];
export type MoneyPositionStatus = (typeof MONEY_POSITION_STATUSES)[number];
export type DecisionKind = (typeof DECISION_KINDS)[number];
export type ContactRole = (typeof CONTACT_ROLES)[number];
export type PropertyLifecycle = (typeof PROPERTY_LIFECYCLES)[number];
export type TenancyLifecycle = (typeof TENANCY_LIFECYCLES)[number];
export type ImportIssueKind = (typeof IMPORT_ISSUE_KINDS)[number];
export type ImportIssueStatus = (typeof IMPORT_ISSUE_STATUSES)[number];
export type ClosedHandoffOperation = (typeof CLOSED_HANDOFF_OPERATIONS)[number];
export type ForbiddenHandoffAction = (typeof FORBIDDEN_HANDOFF_ACTIONS)[number];
export const CASE_STATES = [
  "proposed",
  "approved",
  "denied",
  "held",
  "preparing",
  "handoff-ready",
  "confirmed",
  "failed",
  "stale",
  "superseded",
  "cancelled",
  "effect-unknown",
  "handoff-expired",
] as const satisfies readonly WorkState[];

export type CaseState = (typeof CASE_STATES)[number];
export type ActorId = typeof LEGACY_UNKNOWN_ACTOR | string;

export function lockedNever(): readonly ["statutory-send", "trust-pay"] {
  return NEVER_ACTIONS;
}

export function tenancyIdFromProperty(propertyId: string): string {
  return `ten-${propertyId}`;
}

export function tenantContactIdFromProperty(propertyId: string): string {
  return `ctc-tenant-${propertyId}`;
}

export function propertyNotePath(propertyId: string): string {
  return `vault/properties/${propertyId}.md`;
}

export function migratedRevisionId(proposalId: string): string {
  return `rev-${proposalId}-0`;
}

export function migratedEvidenceId(propertyId: string): string {
  return `ev-legacy-${propertyId}`;
}

export interface Agency {
  name: string;
  timezone: string;
  jurisdictions: string[];
}

export interface Source {
  id: string;
  authority: EvidenceAuthority;
  collector: EvidenceCollector;
  label: string;
  stableKey: string;
  freshnessMs: number;
  lastCheckedAt?: number | null;
}

export interface PropertyV3 {
  id: string;
  address: string;
  propertyCode?: string;
  status: PropertyLifecycle;
  options: PropertyOptions;
  archivedAt?: number;
}

export interface Tenancy {
  id: string;
  propertyId: string;
  status: TenancyLifecycle;
  weeklyRentCents: number;
  closedAt?: number;
}

export interface ContactSafeguards {
  hardship: boolean;
  dispute: boolean;
  paymentArrangement: boolean;
  doNotContact: boolean;
  preferredChannel: NotifyChannel;
}

export interface Contact {
  id: string;
  role: ContactRole;
  name: string;
  phone: string;
  propertyId: string;
  tenancyId?: string;
  safeguards: ContactSafeguards;
}

export interface BookProposal {
  id: string;
  kind: "add-property";
  status: "open";
  origin: "ask" | "manual";
  fields: {
    address: string;
    tenantName: string;
    tenantPhone: string;
    weeklyRentCents: number;
  };
  createdAt: number;
}

export interface ImportIssue {
  id: string;
  kind: ImportIssueKind;
  status: ImportIssueStatus;
  sourceId: string;
  rawIdentity: string;
  candidates: string[];
  createdAt: number;
  linkedPropertyId?: string;
}

export interface RoutineOrigin {
  kind: "routine";
  runId: string;
  loopId: string;
}

export interface Case {
  id: string;
  kind: CaseKind;
  state: CaseState;
  propertyId?: string;
  tenancyId?: string;
  proposalId?: string;
  importIssueId?: string;
  origin?: RoutineOrigin;
  holdReason?: string;
  periodDueAt?: number;
  occurrenceKey?: string;
  sourceIds?: string[];
  proposalHash?: string;
  artifactIds?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface EvidencePayload {
  daysSinceDue?: number;
  rentLanded?: boolean;
  levyPaid?: boolean;
  daysSinceCourtesy?: number | null;
  amountPaidCents?: number | null;
  reversed?: boolean;
}

export interface Evidence {
  id: string;
  authority: EvidenceAuthority;
  collector: EvidenceCollector;
  sourceId: string;
  sourceRecordKey: string;
  observedAt: number | null;
  ingestedAt: number;
  staleAt: number;
  propertyId?: string;
  tenancyId?: string;
  payload: EvidencePayload;
}

export interface MoneyPosition {
  tenancyId: string;
  evidenceId: string;
  sourceId: string;
  observedAt: number | null;
  staleAt: number;
  facts: EvidencePayload;
  status: MoneyPositionStatus;
}

export interface Proposal {
  id: string;
  caseId: string;
  kind: DraftKind;
  currentRevisionId: string;
  periodDueAt: number;
  createdAt: number;
}

export interface ProposalRevision {
  id: string;
  proposalId: string;
  body: string;
  channel: NotifyChannel;
  to: string;
  hash: string;
  createdAt: number;
}

export interface Decision {
  id: string;
  proposalId: string;
  revisionId: string;
  kind: DecisionKind;
  actorId: ActorId;
  at: number;
}

export interface PortalBinding {
  id: string;
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

export interface HandoffAuthorization {
  operation: ClosedHandoffOperation;
  caseId: string;
  proposalId: string;
  revisionId: string;
  proposalHash: string;
  propertyId: string;
  tenancyId: string;
  bindingId: string;
  recipeId: string;
  recipeVersion: number;
  allowedOrigins: string[];
  allowedActions: string[];
  expiresAt: number;
}

export type HandoffVerification = "verified" | "human-confirmed" | "effect-unknown" | "expired" | "failed" | "invalidated";

export interface Handoff {
  id: string;
  authorization: HandoffAuthorization;
  usedAt?: number;
  invalidatedAt?: number;
  verification?: HandoffVerification;
}

export interface DeskFileV3 {
  version: typeof DESK_FILE_VERSION;
  revision: number;
  mode: BookMode;
  retentionDays: number | null;
  agency: Agency;
  office: Office;
  sources: Source[];
  properties: PropertyV3[];
  tenancies: Tenancy[];
  contacts: Contact[];
  importIssues: ImportIssue[];
  bookProposals: BookProposal[];
  cases: Case[];
  evidence: Evidence[];
  moneyPositions: MoneyPosition[];
  proposals: Proposal[];
  proposalRevisions: ProposalRevision[];
  decisions: Decision[];
  portalBindings: PortalBinding[];
  portalRecipes: PortalRecipe[];
  handoffs: Handoff[];
  lastRunAt: number | null;
  hands: HandsSource;
  handsDetail: string | null;
}

export function emptyV3(agency: Agency): DeskFileV3 {
  return {
    version: DESK_FILE_VERSION,
    revision: 1,
    mode: "demo",
    retentionDays: 90,
    agency,
    office: emptyOffice(),
    sources: [],
    properties: [],
    tenancies: [],
    contacts: [],
    importIssues: [],
    bookProposals: [],
    cases: [],
    evidence: [],
    moneyPositions: [],
    proposals: [],
    proposalRevisions: [],
    decisions: [],
    portalBindings: [],
    portalRecipes: [],
    handoffs: [],
    lastRunAt: null,
    hands: "demo",
    handsDetail: null,
  };
}
