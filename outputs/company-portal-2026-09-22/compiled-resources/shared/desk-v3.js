// Desk V3 contracts and closed unions only. No filesystem, no evaluators.
// Canonical product constraints: docs/GOAL-PROMPT.md wins conflicts.
// Architecture: docs/PRODUCT-DESIGN-PLAN.md.
import { NEVER_ACTIONS, } from "./contracts.js";
import { emptyOffice } from "./office.js";
export const DESK_FILE_VERSION = 3;
export const CASE_KINDS = [
    "money-arrears",
    "owner-update",
    "inbound-triage",
    "maintenance-intake",
    "lease-review",
    "inspection-prep",
    "licensee-required",
];
export const EVIDENCE_AUTHORITIES = ["pms", "demo", "legacy-unverified"];
export const EVIDENCE_COLLECTORS = ["csv", "hermes", "bounded-portal", "migration"];
export const MONEY_POSITION_STATUSES = ["current", "stale", "conflicted", "requires-recheck"];
export const DECISION_KINDS = ["allow", "deny", "copy", "done"];
export const CONTACT_ROLES = ["tenant", "occupant", "owner", "tradie"];
export const PROPERTY_LIFECYCLES = ["active", "archived"];
export const TENANCY_LIFECYCLES = ["current", "closed"];
export const IMPORT_ISSUE_KINDS = ["unmatched", "ambiguous"];
export const IMPORT_ISSUE_STATUSES = ["open", "linked", "rejected"];
export const CLOSED_HANDOFF_OPERATIONS = ["prefill-courtesy"];
export const FORBIDDEN_HANDOFF_ACTIONS = ["submit", "send", "pay"];
export const LEGACY_UNKNOWN_ACTOR = "legacy-unknown";
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
];
export function lockedNever() {
    return NEVER_ACTIONS;
}
export function tenancyIdFromProperty(propertyId) {
    return `ten-${propertyId}`;
}
export function tenantContactIdFromProperty(propertyId) {
    return `ctc-tenant-${propertyId}`;
}
export function propertyNotePath(propertyId) {
    return `vault/properties/${propertyId}.md`;
}
export function migratedRevisionId(proposalId) {
    return `rev-${proposalId}-0`;
}
export function migratedEvidenceId(propertyId) {
    return `ev-legacy-${propertyId}`;
}
export function emptyV3(agency) {
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
        results: [],
        hands: "demo",
        handsDetail: null,
    };
}
