// Strict V1/V2/V3 decoders and referential validation. No filesystem.
import type { DeskFileV2 } from "../shared/desk-v2.ts";
import {
  CLOSURE_KINDS,
  INBOUND_CATEGORIES,
  INBOUND_PRIORITIES,
  WAITING_PARTIES,
  type InboundCaseDetail,
  type ImportIdentity,
  type SourceIncidentDetail,
  type WorkLifecycle,
} from "../shared/contracts.ts";
import {
  CASE_KINDS,
  CASE_STATES,
  CONTACT_ROLES,
  CLOSED_HANDOFF_OPERATIONS,
  DECISION_KINDS,
  DESK_FILE_VERSION,
  EVIDENCE_AUTHORITIES,
  EVIDENCE_COLLECTORS,
  FORBIDDEN_HANDOFF_ACTIONS,
  IMPORT_ISSUE_KINDS,
  IMPORT_ISSUE_STATUSES,
  MONEY_POSITION_STATUSES,
  PROPERTY_LIFECYCLES,
  TENANCY_LIFECYCLES,
  lockedNever,
  type Agency,
  type Case,
  type Contact,
  type ContactSafeguards,
  type Decision,
  type DeskFileV3,
  type Evidence,
  type EvidencePayload,
  type Handoff,
  type HandoffAuthorization,
  type ImportIssue,
  type MoneyPosition,
  type PortalBinding,
  type PortalRecipe,
  type PropertyV3,
  type Proposal,
  type ProposalRevision,
  type Source,
  type Tenancy,
  type BookProposal,
} from "../shared/desk-v3.ts";
import { migrateV1ToV2 } from "./desk-v3-migrate.ts";

export class DeskDecodeError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(errors[0] ?? "desk decode failed");
    this.name = "DeskDecodeError";
    this.errors = errors;
  }
}

const WORK_STATES = [
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
  "waiting",
  "effect-unknown",
  "handoff-expired",
] as const;
const HANDS = ["demo", "hermes", "held", "csv", "fixture"] as const;
const RENT_SOURCES = ["mepay", "bank", "pms-export", "fixture", "csv"] as const;
const CHANNELS = ["sms", "email", "portal", "desk"] as const;
const DRAFT_KINDS = ["courtesy-rent", "levy-from-rent", "owner-letter", "inbound-reply"] as const;
const DRAFT_STATUS = ["pending", "allowed", "denied", "stale"] as const;
const SOURCE_KINDS = ["csv", "hermes", "portal", "mail", "demo"] as const;
const WORK_KINDS = ["money-arrears", "owner-letter", "inbound-triage", "maintenance-intake", "lease-review", "inspection-prep", "source-incident"] as const;

function isRec(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, errors: string[]): T | null {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  errors.push(`${field} is not a closed union value`);
  return null;
}

function str(value: unknown, field: string, errors: string[]): string {
  if (typeof value === "string" && value.length > 0) return value;
  errors.push(`${field} must be a non-empty string`);
  return "";
}

function num(value: unknown, field: string, errors: string[]): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  errors.push(`${field} must be a finite number`);
  return 0;
}

function retentionDays(value: unknown, errors: string[]): number | null {
  if (value === null) return null;
  const days = num(value, "retentionDays", errors);
  if (!Number.isInteger(days) || days < 1 || days > 3_650) {
    errors.push("retentionDays must be an integer from 1 to 3650 or null");
  }
  return days;
}

function arr(value: unknown, field: string, errors: string[]): unknown[] {
  if (Array.isArray(value)) return value;
  errors.push(`${field} must be an array`);
  return [];
}

function uniqueIds(ids: string[], label: string, errors: string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) errors.push(`duplicate ${label} id ${id}`);
    seen.add(id);
  }
}

export function decodeDeskV2(value: unknown): DeskFileV2 {
  const errors: string[] = [];
  if (!isRec(value) || value.version !== 2) throw new DeskDecodeError(["expected desk version 2"]);
  const properties = arr(value.properties, "properties", errors);
  const decoded: DeskFileV2 = {
    version: 2,
    revision: num(value.revision, "revision", errors),
    mode: oneOf(value.mode, ["demo", "live"], "mode", errors) ?? "demo",
    timezone: str(value.timezone, "timezone", errors),
    retentionDays: retentionDays(value.retentionDays, errors),
    properties: properties.map((item, i) => decodeProperty(item, `properties[${i}]`, errors)),
    ledger: arr(value.ledger, "ledger", errors).map((item, i) => decodeLedger(item, `ledger[${i}]`, errors)),
    drafts: arr(value.drafts, "drafts", errors).map((item, i) => decodeDraft(item, `drafts[${i}]`, errors)),
    escalations: arr(value.escalations, "escalations", errors).map((item, i) => decodeEscalation(item, `escalations[${i}]`, errors)),
    workItems: arr(value.workItems, "workItems", errors).map((item, i) => decodeWork(item, `workItems[${i}]`, errors)),
    lastRunAt: value.lastRunAt === null ? null : num(value.lastRunAt, "lastRunAt", errors),
    results: Array.isArray(value.results) ? (value.results as DeskFileV2["results"]) : [],
    hands: oneOf(value.hands, HANDS, "hands", errors) ?? "demo",
    handsDetail: typeof value.handsDetail === "string" ? value.handsDetail : null,
    sources: arr(value.sources, "sources", errors).map((item, i) => decodeSourceV2(item, `sources[${i}]`, errors)),
    observations: Array.isArray(value.observations) ? (value.observations as DeskFileV2["observations"]) : [],
    portalBindings: Array.isArray(value.portalBindings) ? (value.portalBindings as DeskFileV2["portalBindings"]) : [],
    recipes: Array.isArray(value.recipes) ? (value.recipes as DeskFileV2["recipes"]) : [],
    capabilities: Array.isArray(value.capabilities) ? (value.capabilities as DeskFileV2["capabilities"]) : [],
    importIssues: Array.isArray(value.importIssues)
      ? value.importIssues.map((item, i) => decodeImportIssue(item, `importIssues[${i}]`, errors))
      : [],
  };
  uniqueIds(decoded.properties.map((p) => p.id), "property", errors);
  uniqueIds(decoded.drafts.map((d) => d.id), "draft", errors);
  uniqueIds(decoded.workItems.map((w) => w.id), "workItem", errors);
  uniqueIds(decoded.capabilities.map((c) => c.id), "capability", errors);
  uniqueIds(decoded.importIssues.map((issue) => issue.id), "importIssue", errors);
  if (errors.length) throw new DeskDecodeError(errors);
  return decoded;
}

function decodeProperty(value: unknown, field: string, errors: string[]): DeskFileV2["properties"][number] {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { id: "", address: "", tenantName: "", tenantPhone: "", weeklyRentCents: 0, options: { rentSource: "fixture", graceDays: 3, courtesyUntilDay: 7, levyFromRent: null, notifyChannel: "sms", never: [] } };
  }
  const options = isRec(value.options) ? value.options : {};
  return {
    id: str(value.id, `${field}.id`, errors),
    address: str(value.address, `${field}.address`, errors),
    propertyCode: typeof value.propertyCode === "string" ? value.propertyCode : undefined,
    tenantName: typeof value.tenantName === "string" ? value.tenantName : "",
    tenantPhone: typeof value.tenantPhone === "string" ? value.tenantPhone : "",
    weeklyRentCents: num(value.weeklyRentCents, `${field}.weeklyRentCents`, errors),
    options: {
      rentSource: oneOf(options.rentSource, RENT_SOURCES, `${field}.options.rentSource`, errors) ?? "fixture",
      graceDays: num(options.graceDays, `${field}.options.graceDays`, errors),
      courtesyUntilDay: num(options.courtesyUntilDay, `${field}.options.courtesyUntilDay`, errors),
      levyFromRent: options.levyFromRent && isRec(options.levyFromRent)
        ? { amountCents: num(options.levyFromRent.amountCents, `${field}.levy`, errors), cadence: options.levyFromRent.cadence === "monthly" ? "monthly" : "quarterly" }
        : null,
      notifyChannel: oneOf(options.notifyChannel, CHANNELS, `${field}.options.notifyChannel`, errors) ?? "sms",
      never: Array.isArray(options.never) ? options.never.map(String) : [],
    },
  };
}

function decodeLedger(value: unknown, field: string, errors: string[]): DeskFileV2["ledger"][number] {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { propertyId: "", daysSinceDue: 0, rentLanded: false, levyPaid: false, daysSinceCourtesy: null };
  }
  return {
    propertyId: str(value.propertyId, `${field}.propertyId`, errors),
    daysSinceDue: num(value.daysSinceDue, `${field}.daysSinceDue`, errors),
    rentLanded: Boolean(value.rentLanded),
    levyPaid: Boolean(value.levyPaid),
    daysSinceCourtesy: value.daysSinceCourtesy === null || value.daysSinceCourtesy === undefined ? null : num(value.daysSinceCourtesy, `${field}.daysSinceCourtesy`, errors),
    amountPaidCents: typeof value.amountPaidCents === "number" ? value.amountPaidCents : null,
    reversed: Boolean(value.reversed),
  };
}

function decodeDraft(value: unknown, field: string, errors: string[]): DeskFileV2["drafts"][number] {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { id: "", propertyId: "", kind: "courtesy-rent", status: "pending", channel: "sms", to: "", body: "", periodDueAt: 0, createdAt: 0 };
  }
  return {
    id: str(value.id, `${field}.id`, errors),
    propertyId: typeof value.propertyId === "string" ? value.propertyId : "",
    kind: oneOf(value.kind, DRAFT_KINDS, `${field}.kind`, errors) ?? "courtesy-rent",
    status: oneOf(value.status, DRAFT_STATUS, `${field}.status`, errors) ?? "pending",
    channel: oneOf(value.channel, CHANNELS, `${field}.channel`, errors) ?? "sms",
    to: typeof value.to === "string" ? value.to : "",
    body: typeof value.body === "string" ? value.body : "",
    periodDueAt: num(value.periodDueAt, `${field}.periodDueAt`, errors),
    createdAt: num(value.createdAt, `${field}.createdAt`, errors),
    decidedAt: typeof value.decidedAt === "number" ? value.decidedAt : undefined,
    workItemId: typeof value.workItemId === "string" ? value.workItemId : undefined,
  };
}

function decodeEscalation(value: unknown, field: string, errors: string[]): DeskFileV2["escalations"][number] {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { id: "", propertyId: "", reason: "statutory-clock", detail: "", periodDueAt: 0, createdAt: 0 };
  }
  return {
    id: str(value.id, `${field}.id`, errors),
    propertyId: str(value.propertyId, `${field}.propertyId`, errors),
    reason: "statutory-clock",
    detail: typeof value.detail === "string" ? value.detail : "",
    periodDueAt: num(value.periodDueAt, `${field}.periodDueAt`, errors),
    createdAt: num(value.createdAt, `${field}.createdAt`, errors),
  };
}

function decodeWork(value: unknown, field: string, errors: string[]): DeskFileV2["workItems"][number] {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return {
      id: "",
      kind: "money-arrears",
      state: "held",
      propertyId: "",
      occurrenceKey: "",
      periodDueAt: 0,
      recipient: { name: "", phone: "" },
      sourceIds: [],
      observedAt: 0,
      proposalHash: "",
      createdAt: 0,
      updatedAt: 0,
    };
  }
  return {
    id: str(value.id, `${field}.id`, errors),
    kind: oneOf(value.kind, WORK_KINDS, `${field}.kind`, errors) ?? "money-arrears",
    state: oneOf(value.state, WORK_STATES, `${field}.state`, errors) ?? "held",
    propertyId: typeof value.propertyId === "string" ? value.propertyId : "",
    occurrenceKey: typeof value.occurrenceKey === "string" ? value.occurrenceKey : `${value.propertyId}`,
    periodDueAt: num(value.periodDueAt, `${field}.periodDueAt`, errors),
    draftId: typeof value.draftId === "string" ? value.draftId : undefined,
    recipient: isRec(value.recipient)
      ? {
          name: String(value.recipient.name ?? ""),
          phone: String(value.recipient.phone ?? ""),
          hardship: typeof value.recipient.hardship === "boolean" ? value.recipient.hardship : undefined,
          dispute: typeof value.recipient.dispute === "boolean" ? value.recipient.dispute : undefined,
          paymentArrangement: typeof value.recipient.paymentArrangement === "boolean" ? value.recipient.paymentArrangement : undefined,
          doNotContact: typeof value.recipient.doNotContact === "boolean" ? value.recipient.doNotContact : undefined,
        }
      : { name: "", phone: "" },
    sourceIds: Array.isArray(value.sourceIds) ? value.sourceIds.map(String) : [],
    observedAt: num(value.observedAt, `${field}.observedAt`, errors),
    evidenceId: typeof value.evidenceId === "string" ? value.evidenceId : undefined,
    evidenceIds: Array.isArray(value.evidenceIds) ? value.evidenceIds.map(String) : undefined,
    evidenceStatus:
      value.evidenceStatus === undefined
        ? undefined
        : oneOf(value.evidenceStatus, MONEY_POSITION_STATUSES, `${field}.evidenceStatus`, errors) ?? undefined,
    evidenceStaleAt: optNum(value.evidenceStaleAt, `${field}.evidenceStaleAt`, errors),
    proposalHash: typeof value.proposalHash === "string" ? value.proposalHash : "",
    createdAt: num(value.createdAt, `${field}.createdAt`, errors),
    updatedAt: num(value.updatedAt, `${field}.updatedAt`, errors),
    holdReason: typeof value.holdReason === "string" ? value.holdReason : undefined,
    artifactIds: Array.isArray(value.artifactIds) ? value.artifactIds.map(String) : undefined,
    origin: isRec(value.origin)
      ? {
          kind: "routine",
          runId: str(value.origin.runId, `${field}.origin.runId`, errors),
          loopId: str(value.origin.loopId, `${field}.origin.loopId`, errors),
        }
      : undefined,
    inbound: value.inbound === undefined ? undefined : decodeInbound(value.inbound, `${field}.inbound`, errors),
    lifecycle: value.lifecycle === undefined ? undefined : decodeLifecycle(value.lifecycle, `${field}.lifecycle`, errors),
    sourceIncident: value.sourceIncident === undefined
      ? undefined
      : decodeSourceIncident(value.sourceIncident, `${field}.sourceIncident`, errors),
    importIdentity: value.importIdentity === undefined
      ? undefined
      : decodeImportIdentity(value.importIdentity, `${field}.importIdentity`, errors),
  };
}

function decodeSourceV2(value: unknown, field: string, errors: string[]): DeskFileV2["sources"][number] {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { id: "", kind: "demo", label: "", stableKey: "" };
  }
  return {
    id: str(value.id, `${field}.id`, errors),
    kind: oneOf(value.kind, SOURCE_KINDS, `${field}.kind`, errors) ?? "demo",
    label: typeof value.label === "string" ? value.label : "",
    stableKey: typeof value.stableKey === "string" ? value.stableKey : "",
  };
}

export function decodeDeskV1ToV2(value: unknown, book: { properties: DeskFileV2["properties"]; ledger: DeskFileV2["ledger"] }, timezone: string): DeskFileV2 {
  if (!isRec(value) || value.version !== 1) throw new DeskDecodeError(["expected desk version 1"]);
  if (!Array.isArray(value.properties)) throw new DeskDecodeError(["v1 properties must be an array"]);
  return decodeDeskV2(migrateV1ToV2(value, book, timezone));
}

function text(value: unknown, field: string, errors: string[]): string {
  if (typeof value === "string") return value;
  errors.push(`${field} must be a string`);
  return "";
}

function bool(value: unknown, field: string, errors: string[]): boolean {
  if (typeof value === "boolean") return value;
  errors.push(`${field} must be a boolean`);
  return false;
}

function optNum(value: unknown, field: string, errors: string[]): number | undefined {
  if (value === undefined) return undefined;
  return num(value, field, errors);
}

function decodeLifecycle(value: unknown, field: string, errors: string[]): WorkLifecycle {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return {};
  }
  return {
    waitingParty: value.waitingParty === undefined
      ? undefined
      : oneOf(value.waitingParty, WAITING_PARTIES, `${field}.waitingParty`, errors) ?? undefined,
    dueAt: optNum(value.dueAt, `${field}.dueAt`, errors),
    nextCheckAt: optNum(value.nextCheckAt, `${field}.nextCheckAt`, errors),
    reminderSuppressedUntil: optNum(value.reminderSuppressedUntil, `${field}.reminderSuppressedUntil`, errors),
    closedAt: optNum(value.closedAt, `${field}.closedAt`, errors),
    closedBy: value.closedBy === undefined
      ? undefined
      : oneOf(value.closedBy, ["pm", "system"] as const, `${field}.closedBy`, errors) ?? undefined,
    closureKind: value.closureKind === undefined
      ? undefined
      : oneOf(value.closureKind, CLOSURE_KINDS, `${field}.closureKind`, errors) ?? undefined,
  };
}

function decodeSourceIncident(value: unknown, field: string, errors: string[]): SourceIncidentDetail {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { sourceId: "", code: "unavailable", affectedPropertyCount: 0, firstSeenAt: 0, lastSeenAt: 0 };
  }
  return {
    sourceId: str(value.sourceId, `${field}.sourceId`, errors),
    code: oneOf(value.code, ["missing", "stale", "unavailable", "unverified", "revoked"] as const, `${field}.code`, errors) ?? "unavailable",
    affectedPropertyCount: num(value.affectedPropertyCount, `${field}.affectedPropertyCount`, errors),
    firstSeenAt: num(value.firstSeenAt, `${field}.firstSeenAt`, errors),
    lastSeenAt: num(value.lastSeenAt, `${field}.lastSeenAt`, errors),
  };
}

function decodeImportIdentity(value: unknown, field: string, errors: string[]): ImportIdentity {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { kind: "address", value: "" };
  }
  return {
    kind: oneOf(value.kind, ["id", "address", "code"] as const, `${field}.kind`, errors) ?? "address",
    value: str(value.value, `${field}.value`, errors),
  };
}

function decodeInbound(value: unknown, field: string, errors: string[]): InboundCaseDetail {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return {
      category: "unmatched",
      priority: "routine",
      senderName: "",
      senderAddress: "",
      subject: "",
      summary: "",
      receivedAt: 0,
      messageKey: "",
      threadKey: "",
      attachmentCount: 0,
      messageCount: 1,
      flags: [],
    };
  }
  return {
    category: oneOf(value.category, INBOUND_CATEGORIES, `${field}.category`, errors) ?? "unmatched",
    priority: oneOf(value.priority, INBOUND_PRIORITIES, `${field}.priority`, errors) ?? "routine",
    senderName: text(value.senderName, `${field}.senderName`, errors),
    senderAddress: text(value.senderAddress, `${field}.senderAddress`, errors),
    subject: text(value.subject, `${field}.subject`, errors),
    summary: text(value.summary, `${field}.summary`, errors),
    receivedAt: num(value.receivedAt, `${field}.receivedAt`, errors),
    messageKey: str(value.messageKey, `${field}.messageKey`, errors),
    threadKey: str(value.threadKey, `${field}.threadKey`, errors),
    attachmentCount: num(value.attachmentCount, `${field}.attachmentCount`, errors),
    messageCount: num(value.messageCount, `${field}.messageCount`, errors),
    flags: arr(value.flags, `${field}.flags`, errors).map(String),
    waitingOn: value.waitingOn === undefined
      ? undefined
      : oneOf(value.waitingOn, ["pm-send", "sender", "licensed-review"] as const, `${field}.waitingOn`, errors) ?? undefined,
    followUpAt: optNum(value.followUpAt, `${field}.followUpAt`, errors),
  };
}

function numOrNull(value: unknown, field: string, errors: string[]): number | null {
  if (value === null) return null;
  return num(value, field, errors);
}

function decodeAgency(value: unknown, errors: string[]): Agency {
  if (!isRec(value)) {
    errors.push("agency is required");
    return { name: "", timezone: "", jurisdictions: [] };
  }
  return {
    name: text(value.name, "agency.name", errors),
    timezone: str(value.timezone, "agency.timezone", errors),
    jurisdictions: arr(value.jurisdictions, "agency.jurisdictions", errors).map(String),
  };
}

function decodeOptionsV3(value: unknown, field: string, errors: string[]): PropertyV3["options"] {
  const options = isRec(value) ? value : {};
  if (!isRec(value)) errors.push(`${field} is required`);
  return {
    rentSource: oneOf(options.rentSource, RENT_SOURCES, `${field}.rentSource`, errors) ?? "fixture",
    graceDays: num(options.graceDays, `${field}.graceDays`, errors),
    courtesyUntilDay: num(options.courtesyUntilDay, `${field}.courtesyUntilDay`, errors),
    levyFromRent: options.levyFromRent && isRec(options.levyFromRent)
      ? { amountCents: num(options.levyFromRent.amountCents, `${field}.levy`, errors), cadence: options.levyFromRent.cadence === "monthly" ? "monthly" : "quarterly" }
      : null,
    notifyChannel: oneOf(options.notifyChannel, CHANNELS, `${field}.notifyChannel`, errors) ?? "sms",
    never: Array.isArray(options.never) ? options.never.map(String) : [],
  };
}

function decodeSourceV3(value: unknown, field: string, errors: string[]): Source {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { id: "", authority: "legacy-unverified", collector: "migration", label: "", stableKey: "", freshnessMs: 0 };
  }
  return {
    id: str(value.id, `${field}.id`, errors),
    authority: oneOf(value.authority, EVIDENCE_AUTHORITIES, `${field}.authority`, errors) ?? "legacy-unverified",
    collector: oneOf(value.collector, EVIDENCE_COLLECTORS, `${field}.collector`, errors) ?? "migration",
    label: text(value.label, `${field}.label`, errors),
    stableKey: text(value.stableKey, `${field}.stableKey`, errors),
    freshnessMs: num(value.freshnessMs, `${field}.freshnessMs`, errors),
  };
}

function decodePropertyV3(value: unknown, field: string, errors: string[]): PropertyV3 {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { id: "", address: "", status: "active", options: decodeOptionsV3({}, `${field}.options`, errors) };
  }
  return {
    id: str(value.id, `${field}.id`, errors),
    address: str(value.address, `${field}.address`, errors),
    propertyCode: typeof value.propertyCode === "string" ? value.propertyCode : undefined,
    status: oneOf(value.status, PROPERTY_LIFECYCLES, `${field}.status`, errors) ?? "active",
    options: decodeOptionsV3(value.options, `${field}.options`, errors),
    archivedAt: optNum(value.archivedAt, `${field}.archivedAt`, errors),
  };
}

function decodeTenancy(value: unknown, field: string, errors: string[]): Tenancy {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { id: "", propertyId: "", status: "current", weeklyRentCents: 0 };
  }
  return {
    id: str(value.id, `${field}.id`, errors),
    propertyId: str(value.propertyId, `${field}.propertyId`, errors),
    status: oneOf(value.status, TENANCY_LIFECYCLES, `${field}.status`, errors) ?? "current",
    weeklyRentCents: num(value.weeklyRentCents, `${field}.weeklyRentCents`, errors),
    closedAt: optNum(value.closedAt, `${field}.closedAt`, errors),
  };
}

function decodeSafeguards(value: unknown, field: string, errors: string[]): ContactSafeguards {
  const row = isRec(value) ? value : {};
  if (!isRec(value)) errors.push(`${field} is required`);
  return {
    hardship: bool(row.hardship, `${field}.hardship`, errors),
    dispute: bool(row.dispute, `${field}.dispute`, errors),
    paymentArrangement: bool(row.paymentArrangement, `${field}.paymentArrangement`, errors),
    doNotContact: bool(row.doNotContact, `${field}.doNotContact`, errors),
    preferredChannel: oneOf(row.preferredChannel, CHANNELS, `${field}.preferredChannel`, errors) ?? "desk",
  };
}

function decodeContact(value: unknown, field: string, errors: string[]): Contact {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { id: "", role: "tenant", name: "", phone: "", propertyId: "", safeguards: decodeSafeguards({}, `${field}.safeguards`, errors) };
  }
  return {
    id: str(value.id, `${field}.id`, errors),
    role: oneOf(value.role, CONTACT_ROLES, `${field}.role`, errors) ?? "tenant",
    name: text(value.name, `${field}.name`, errors),
    phone: text(value.phone, `${field}.phone`, errors),
    propertyId: str(value.propertyId, `${field}.propertyId`, errors),
    tenancyId: typeof value.tenancyId === "string" ? value.tenancyId : undefined,
    safeguards: decodeSafeguards(value.safeguards, `${field}.safeguards`, errors),
  };
}

function decodeBookProposal(value: unknown, field: string, errors: string[]): BookProposal {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return {
      id: "",
      kind: "add-property",
      status: "open",
      origin: "manual",
      fields: { address: "", tenantName: "", tenantPhone: "", weeklyRentCents: 0 },
      createdAt: 0,
    };
  }
  const fieldsRec = isRec(value.fields) ? value.fields : {};
  return {
    id: str(value.id, `${field}.id`, errors),
    kind: "add-property",
    status: "open",
    origin: value.origin === "ask" ? "ask" : "manual",
    fields: {
      address: text(fieldsRec.address, `${field}.fields.address`, errors),
      tenantName: text(fieldsRec.tenantName, `${field}.fields.tenantName`, errors),
      tenantPhone: text(fieldsRec.tenantPhone, `${field}.fields.tenantPhone`, errors),
      weeklyRentCents: num(fieldsRec.weeklyRentCents, `${field}.fields.weeklyRentCents`, errors),
    },
    createdAt: num(value.createdAt, `${field}.createdAt`, errors),
  };
}

function decodeImportIssue(value: unknown, field: string, errors: string[]): ImportIssue {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { id: "", kind: "unmatched", status: "open", sourceId: "", rawIdentity: "", candidates: [], createdAt: 0 };
  }
  return {
    id: str(value.id, `${field}.id`, errors),
    kind: oneOf(value.kind, IMPORT_ISSUE_KINDS, `${field}.kind`, errors) ?? "unmatched",
    status: oneOf(value.status, IMPORT_ISSUE_STATUSES, `${field}.status`, errors) ?? "open",
    sourceId: str(value.sourceId, `${field}.sourceId`, errors),
    rawIdentity: text(value.rawIdentity, `${field}.rawIdentity`, errors),
    identityKind: value.identityKind === undefined
      ? undefined
      : oneOf(value.identityKind, ["id", "address", "code"] as const, `${field}.identityKind`, errors) ?? undefined,
    candidates: arr(value.candidates, `${field}.candidates`, errors).map(String),
    createdAt: num(value.createdAt, `${field}.createdAt`, errors),
    linkedPropertyId: typeof value.linkedPropertyId === "string" ? value.linkedPropertyId : undefined,
    resolvedAt: optNum(value.resolvedAt, `${field}.resolvedAt`, errors),
    resolvedBy: typeof value.resolvedBy === "string" ? value.resolvedBy : undefined,
    resolutions: value.resolutions === undefined
      ? undefined
      : arr(value.resolutions, `${field}.resolutions`, errors).map((resolution, index) => {
          const row = isRec(resolution) ? resolution : {};
          if (!isRec(resolution)) errors.push(`${field}.resolutions[${index}] must be an object`);
          return {
            id: str(row.id, `${field}.resolutions[${index}].id`, errors),
            action: oneOf(row.action, ["linked", "rejected"] as const, `${field}.resolutions[${index}].action`, errors) ?? "rejected",
            propertyId: typeof row.propertyId === "string" ? row.propertyId : undefined,
            actorId: str(row.actorId, `${field}.resolutions[${index}].actorId`, errors),
            at: num(row.at, `${field}.resolutions[${index}].at`, errors),
          };
        }),
  };
}

function decodeCase(value: unknown, field: string, errors: string[]): Case {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { id: "", kind: "money-arrears", state: "held", createdAt: 0, updatedAt: 0 };
  }
  const origin = isRec(value.origin)
    ? {
        kind: "routine" as const,
        runId: str(value.origin.runId, `${field}.origin.runId`, errors),
        loopId: str(value.origin.loopId, `${field}.origin.loopId`, errors),
      }
    : undefined;
  return {
    id: str(value.id, `${field}.id`, errors),
    kind: oneOf(value.kind, CASE_KINDS, `${field}.kind`, errors) ?? "money-arrears",
    state: oneOf(value.state, CASE_STATES, `${field}.state`, errors) ?? "held",
    propertyId: typeof value.propertyId === "string" ? value.propertyId : undefined,
    tenancyId: typeof value.tenancyId === "string" ? value.tenancyId : undefined,
    proposalId: typeof value.proposalId === "string" ? value.proposalId : undefined,
    importIssueId: typeof value.importIssueId === "string" ? value.importIssueId : undefined,
    origin,
    holdReason: typeof value.holdReason === "string" ? value.holdReason : undefined,
    periodDueAt: optNum(value.periodDueAt, `${field}.periodDueAt`, errors),
    occurrenceKey: typeof value.occurrenceKey === "string" ? value.occurrenceKey : undefined,
    sourceIds: Array.isArray(value.sourceIds) ? value.sourceIds.map(String) : undefined,
    evidenceIds: Array.isArray(value.evidenceIds) ? value.evidenceIds.map(String) : undefined,
    evidenceStatus:
      value.evidenceStatus === undefined
        ? undefined
        : oneOf(value.evidenceStatus, MONEY_POSITION_STATUSES, `${field}.evidenceStatus`, errors) ?? undefined,
    evidenceStaleAt: optNum(value.evidenceStaleAt, `${field}.evidenceStaleAt`, errors),
    observedAt: optNum(value.observedAt, `${field}.observedAt`, errors),
    proposalHash: typeof value.proposalHash === "string" ? value.proposalHash : undefined,
    artifactIds: Array.isArray(value.artifactIds) ? value.artifactIds.map(String) : undefined,
    inbound: value.inbound === undefined ? undefined : decodeInbound(value.inbound, `${field}.inbound`, errors),
    lifecycle: value.lifecycle === undefined ? undefined : decodeLifecycle(value.lifecycle, `${field}.lifecycle`, errors),
    sourceIncident: value.sourceIncident === undefined
      ? undefined
      : decodeSourceIncident(value.sourceIncident, `${field}.sourceIncident`, errors),
    createdAt: num(value.createdAt, `${field}.createdAt`, errors),
    updatedAt: num(value.updatedAt, `${field}.updatedAt`, errors),
  };
}

function decodePayload(value: unknown, field: string, errors: string[]): EvidencePayload {
  if (value === undefined) return {};
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return {};
  }
  return {
    coverage:
      value.coverage === undefined
        ? undefined
        : oneOf(value.coverage, ["observed", "missing", "conflicted"] as const, `${field}.coverage`, errors) ?? undefined,
    daysSinceDue: typeof value.daysSinceDue === "number" ? value.daysSinceDue : undefined,
    rentLanded: typeof value.rentLanded === "boolean" ? value.rentLanded : undefined,
    levyPaid: typeof value.levyPaid === "boolean" ? value.levyPaid : undefined,
    daysSinceCourtesy: value.daysSinceCourtesy === null || value.daysSinceCourtesy === undefined
      ? value.daysSinceCourtesy === null ? null : undefined
      : num(value.daysSinceCourtesy, `${field}.daysSinceCourtesy`, errors),
    amountPaidCents: value.amountPaidCents === null || value.amountPaidCents === undefined
      ? value.amountPaidCents === null ? null : undefined
      : num(value.amountPaidCents, `${field}.amountPaidCents`, errors),
    reversed: typeof value.reversed === "boolean" ? value.reversed : undefined,
    inbound: value.inbound === undefined ? undefined : decodeInbound(value.inbound, `${field}.inbound`, errors),
  };
}

function decodeEvidence(value: unknown, field: string, errors: string[]): Evidence {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { id: "", authority: "legacy-unverified", collector: "migration", sourceId: "", sourceRecordKey: "", observedAt: null, ingestedAt: 0, staleAt: 0, payload: {} };
  }
  return {
    id: str(value.id, `${field}.id`, errors),
    authority: oneOf(value.authority, EVIDENCE_AUTHORITIES, `${field}.authority`, errors) ?? "legacy-unverified",
    collector: oneOf(value.collector, EVIDENCE_COLLECTORS, `${field}.collector`, errors) ?? "migration",
    sourceId: str(value.sourceId, `${field}.sourceId`, errors),
    sourceRecordKey: str(value.sourceRecordKey, `${field}.sourceRecordKey`, errors),
    observedAt: numOrNull(value.observedAt, `${field}.observedAt`, errors),
    ingestedAt: num(value.ingestedAt, `${field}.ingestedAt`, errors),
    staleAt: num(value.staleAt, `${field}.staleAt`, errors),
    propertyId: typeof value.propertyId === "string" ? value.propertyId : undefined,
    tenancyId: typeof value.tenancyId === "string" ? value.tenancyId : undefined,
    payload: decodePayload(value.payload, `${field}.payload`, errors),
  };
}

function decodeMoney(value: unknown, field: string, errors: string[]): MoneyPosition {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { tenancyId: "", evidenceId: "", sourceId: "", observedAt: null, staleAt: 0, facts: {}, status: "requires-recheck" };
  }
  return {
    tenancyId: str(value.tenancyId, `${field}.tenancyId`, errors),
    evidenceId: str(value.evidenceId, `${field}.evidenceId`, errors),
    sourceId: str(value.sourceId, `${field}.sourceId`, errors),
    observedAt: numOrNull(value.observedAt, `${field}.observedAt`, errors),
    staleAt: num(value.staleAt, `${field}.staleAt`, errors),
    facts: decodePayload(value.facts, `${field}.facts`, errors),
    status: oneOf(value.status, MONEY_POSITION_STATUSES, `${field}.status`, errors) ?? "requires-recheck",
  };
}

function decodeProposal(value: unknown, field: string, errors: string[]): Proposal {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { id: "", caseId: "", kind: "courtesy-rent", currentRevisionId: "", periodDueAt: 0, createdAt: 0 };
  }
  return {
    id: str(value.id, `${field}.id`, errors),
    caseId: str(value.caseId, `${field}.caseId`, errors),
    kind: oneOf(value.kind, DRAFT_KINDS, `${field}.kind`, errors) ?? "courtesy-rent",
    currentRevisionId: str(value.currentRevisionId, `${field}.currentRevisionId`, errors),
    periodDueAt: num(value.periodDueAt, `${field}.periodDueAt`, errors),
    createdAt: num(value.createdAt, `${field}.createdAt`, errors),
  };
}

function decodeRevision(value: unknown, field: string, errors: string[]): ProposalRevision {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { id: "", proposalId: "", body: "", channel: "desk", to: "", hash: "", createdAt: 0 };
  }
  return {
    id: str(value.id, `${field}.id`, errors),
    proposalId: str(value.proposalId, `${field}.proposalId`, errors),
    body: text(value.body, `${field}.body`, errors),
    channel: oneOf(value.channel, CHANNELS, `${field}.channel`, errors) ?? "desk",
    to: text(value.to, `${field}.to`, errors),
    hash: text(value.hash, `${field}.hash`, errors),
    createdAt: num(value.createdAt, `${field}.createdAt`, errors),
  };
}

function decodeDecision(value: unknown, field: string, errors: string[]): Decision {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { id: "", proposalId: "", revisionId: "", kind: "deny", actorId: "legacy-unknown", at: 0 };
  }
  return {
    id: str(value.id, `${field}.id`, errors),
    proposalId: str(value.proposalId, `${field}.proposalId`, errors),
    revisionId: str(value.revisionId, `${field}.revisionId`, errors),
    kind: oneOf(value.kind, DECISION_KINDS, `${field}.kind`, errors) ?? "deny",
    actorId: str(value.actorId, `${field}.actorId`, errors),
    at: num(value.at, `${field}.at`, errors),
  };
}

function decodeBinding(value: unknown, field: string, errors: string[]): PortalBinding {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { id: "", propertyId: "", recipeId: "", recipeVersion: 0, remotePropertyId: "" };
  }
  return {
    id: str(value.id, `${field}.id`, errors),
    propertyId: str(value.propertyId, `${field}.propertyId`, errors),
    recipeId: str(value.recipeId, `${field}.recipeId`, errors),
    recipeVersion: num(value.recipeVersion, `${field}.recipeVersion`, errors),
    remotePropertyId: text(value.remotePropertyId, `${field}.remotePropertyId`, errors),
    remoteAccountId: typeof value.remoteAccountId === "string" ? value.remoteAccountId : undefined,
  };
}

function decodeRecipe(value: unknown, field: string, errors: string[]): PortalRecipe {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { id: "", version: 0, origin: "", published: false, steps: [], finalControlFingerprint: "" };
  }
  return {
    id: str(value.id, `${field}.id`, errors),
    version: num(value.version, `${field}.version`, errors),
    origin: text(value.origin, `${field}.origin`, errors),
    published: bool(value.published, `${field}.published`, errors),
    steps: arr(value.steps, `${field}.steps`, errors).map(String),
    finalControlFingerprint: text(value.finalControlFingerprint, `${field}.finalControlFingerprint`, errors),
  };
}

function decodeAuthorization(value: unknown, field: string, errors: string[]): HandoffAuthorization {
  if (!isRec(value)) {
    errors.push(`${field} is required`);
    return {
      operation: "prefill-courtesy",
      caseId: "",
      proposalId: "",
      revisionId: "",
      proposalHash: "",
      propertyId: "",
      tenancyId: "",
      bindingId: "",
      recipeId: "",
      recipeVersion: 0,
      allowedOrigins: [],
      allowedActions: [],
      expiresAt: 0,
    };
  }
  return {
    operation: oneOf(value.operation, CLOSED_HANDOFF_OPERATIONS, `${field}.operation`, errors) ?? "prefill-courtesy",
    caseId: str(value.caseId, `${field}.caseId`, errors),
    proposalId: str(value.proposalId, `${field}.proposalId`, errors),
    revisionId: str(value.revisionId, `${field}.revisionId`, errors),
    proposalHash: text(value.proposalHash, `${field}.proposalHash`, errors),
    propertyId: str(value.propertyId, `${field}.propertyId`, errors),
    tenancyId: str(value.tenancyId, `${field}.tenancyId`, errors),
    bindingId: str(value.bindingId, `${field}.bindingId`, errors),
    recipeId: str(value.recipeId, `${field}.recipeId`, errors),
    recipeVersion: num(value.recipeVersion, `${field}.recipeVersion`, errors),
    allowedOrigins: arr(value.allowedOrigins, `${field}.allowedOrigins`, errors).map(String),
    allowedActions: arr(value.allowedActions, `${field}.allowedActions`, errors).map(String),
    expiresAt: num(value.expiresAt, `${field}.expiresAt`, errors),
  };
}

function decodeHandoff(value: unknown, field: string, errors: string[]): Handoff {
  if (!isRec(value)) {
    errors.push(`${field} must be an object`);
    return { id: "", authorization: decodeAuthorization({}, `${field}.authorization`, errors) };
  }
  const verification = value.verification === undefined
    ? undefined
    : oneOf(value.verification, ["verified", "human-confirmed", "effect-unknown", "expired", "failed", "invalidated"], `${field}.verification`, errors) ?? undefined;
  return {
    id: str(value.id, `${field}.id`, errors),
    authorization: decodeAuthorization(value.authorization, `${field}.authorization`, errors),
    usedAt: optNum(value.usedAt, `${field}.usedAt`, errors),
    invalidatedAt: optNum(value.invalidatedAt, `${field}.invalidatedAt`, errors),
    verification,
  };
}

export function decodeDeskV3(value: unknown): DeskFileV3 {
  const errors: string[] = [];
  if (!isRec(value) || value.version !== DESK_FILE_VERSION) throw new DeskDecodeError(["expected desk version 3"]);
  const book: DeskFileV3 = {
    version: DESK_FILE_VERSION,
    revision: num(value.revision, "revision", errors),
    mode: oneOf(value.mode, ["demo", "live"], "mode", errors) ?? "demo",
    retentionDays: retentionDays(value.retentionDays, errors),
    agency: decodeAgency(value.agency, errors),
    sources: arr(value.sources, "sources", errors).map((item, i) => decodeSourceV3(item, `sources[${i}]`, errors)),
    properties: arr(value.properties, "properties", errors).map((item, i) => decodePropertyV3(item, `properties[${i}]`, errors)),
    tenancies: arr(value.tenancies, "tenancies", errors).map((item, i) => decodeTenancy(item, `tenancies[${i}]`, errors)),
    contacts: arr(value.contacts, "contacts", errors).map((item, i) => decodeContact(item, `contacts[${i}]`, errors)),
    importIssues: arr(value.importIssues, "importIssues", errors).map((item, i) => decodeImportIssue(item, `importIssues[${i}]`, errors)),
    bookProposals: arr(value.bookProposals, "bookProposals", errors).map((item, i) => decodeBookProposal(item, `bookProposals[${i}]`, errors)),
    cases: arr(value.cases, "cases", errors).map((item, i) => decodeCase(item, `cases[${i}]`, errors)),
    evidence: arr(value.evidence, "evidence", errors).map((item, i) => decodeEvidence(item, `evidence[${i}]`, errors)),
    moneyPositions: arr(value.moneyPositions, "moneyPositions", errors).map((item, i) => decodeMoney(item, `moneyPositions[${i}]`, errors)),
    proposals: arr(value.proposals, "proposals", errors).map((item, i) => decodeProposal(item, `proposals[${i}]`, errors)),
    proposalRevisions: arr(value.proposalRevisions, "proposalRevisions", errors).map((item, i) => decodeRevision(item, `proposalRevisions[${i}]`, errors)),
    decisions: arr(value.decisions, "decisions", errors).map((item, i) => decodeDecision(item, `decisions[${i}]`, errors)),
    portalBindings: arr(value.portalBindings, "portalBindings", errors).map((item, i) => decodeBinding(item, `portalBindings[${i}]`, errors)),
    portalRecipes: arr(value.portalRecipes, "portalRecipes", errors).map((item, i) => decodeRecipe(item, `portalRecipes[${i}]`, errors)),
    handoffs: arr(value.handoffs, "handoffs", errors).map((item, i) => decodeHandoff(item, `handoffs[${i}]`, errors)),
    lastRunAt: value.lastRunAt === null || value.lastRunAt === undefined ? null : num(value.lastRunAt, "lastRunAt", errors),
    hands: oneOf(value.hands, HANDS, "hands", errors) ?? "demo",
    handsDetail: typeof value.handsDetail === "string" ? value.handsDetail : null,
  };
  if (errors.length) throw new DeskDecodeError(errors);
  validateDeskV3(book);
  return book;
}

export function decodeDeskPlain(
  value: unknown,
  book: { properties: DeskFileV2["properties"]; ledger: DeskFileV2["ledger"] },
  timezone: string,
): { version: 2; data: DeskFileV2 } | { version: 3; data: DeskFileV3 } {
  if (!isRec(value)) throw new DeskDecodeError(["desk ledger is not an object"]);
  if (value.version === 3) return { version: 3, data: decodeDeskV3(value) };
  if (value.version === 2) return { version: 2, data: decodeDeskV2(value) };
  if (value.version === 1) return { version: 2, data: decodeDeskV1ToV2(value, book, timezone) };
  throw new DeskDecodeError([`unsupported desk version ${String(value.version)}`]);
}

export function validateDeskV3(book: DeskFileV3): void {
  const errors: string[] = [];
  const propertyIds = new Set(book.properties.map((p) => p.id));
  const tenancyIds = new Set(book.tenancies.map((t) => t.id));
  const caseIds = new Set(book.cases.map((c) => c.id));
  const caseById = new Map(book.cases.map((c) => [c.id, c]));
  const proposalIds = new Set(book.proposals.map((p) => p.id));
  const revisionIds = new Set(book.proposalRevisions.map((r) => r.id));
  const evidenceIds = new Set(book.evidence.map((e) => e.id));
  const evidenceById = new Map(book.evidence.map((e) => [e.id, e]));
  const sourceIds = new Set(book.sources.map((s) => s.id));
  const importIssueIds = new Set(book.importIssues.map((issue) => issue.id));
  uniqueIds(book.properties.map((p) => p.id), "property", errors);
  uniqueIds(book.tenancies.map((t) => t.id), "tenancy", errors);
  uniqueIds(book.contacts.map((c) => c.id), "contact", errors);
  uniqueIds(book.cases.map((c) => c.id), "case", errors);
  uniqueIds(book.proposals.map((p) => p.id), "proposal", errors);
  uniqueIds([...book.importIssues.map((i) => i.id), ...book.cases.map((c) => c.id), ...book.bookProposals.map((p) => p.id)], "importIssue/case/bookProposal", errors);
  uniqueIds(book.handoffs.map((h) => h.id), "handoff", errors);
  uniqueIds(book.evidence.map((e) => e.id), "evidence", errors);

  const currentByProperty = new Map<string, number>();
  for (const tenancy of book.tenancies) {
    if (!propertyIds.has(tenancy.propertyId)) errors.push(`tenancy ${tenancy.id} missing property ${tenancy.propertyId}`);
    if (!TENANCY_LIFECYCLES.includes(tenancy.status)) errors.push(`tenancy ${tenancy.id} has illegal status`);
    if (tenancy.status === "current") currentByProperty.set(tenancy.propertyId, (currentByProperty.get(tenancy.propertyId) ?? 0) + 1);
  }
  for (const [propertyId, count] of currentByProperty) {
    if (count > 1) errors.push(`property ${propertyId} has ${count} current tenancies`);
  }

  for (const property of book.properties) {
    if (!PROPERTY_LIFECYCLES.includes(property.status)) errors.push(`property ${property.id} has illegal status`);
    const never = property.options.never;
    for (const rule of lockedNever()) {
      if (!never.includes(rule)) errors.push(`property ${property.id} dropped never-rule ${rule}`);
    }
  }

  for (const contact of book.contacts) {
    if (!propertyIds.has(contact.propertyId)) errors.push(`contact ${contact.id} missing property`);
    if (contact.tenancyId && !tenancyIds.has(contact.tenancyId)) errors.push(`contact ${contact.id} missing tenancy`);
    if (!CONTACT_ROLES.includes(contact.role)) errors.push(`contact ${contact.id} has illegal role`);
  }

  for (const issue of book.importIssues) {
    if (!IMPORT_ISSUE_KINDS.includes(issue.kind) || !IMPORT_ISSUE_STATUSES.includes(issue.status)) {
      errors.push(`importIssue ${issue.id} has illegal kind/status`);
    }
    if (caseIds.has(issue.id)) errors.push(`importIssue ${issue.id} collided with a case`);
    if (!sourceIds.has(issue.sourceId)) errors.push(`importIssue ${issue.id} missing source ${issue.sourceId}`);
    if (issue.linkedPropertyId && !propertyIds.has(issue.linkedPropertyId)) errors.push(`importIssue ${issue.id} missing linked property`);
    if (issue.status === "linked" && !issue.linkedPropertyId) errors.push(`importIssue ${issue.id} is linked without a property`);
    if (issue.status === "rejected" && issue.linkedPropertyId) errors.push(`importIssue ${issue.id} is rejected with a linked property`);
    if (issue.status !== "open" && (issue.resolvedAt === undefined || !issue.resolvedBy)) errors.push(`importIssue ${issue.id} is resolved without a receipt`);
    if (issue.resolvedAt !== undefined && issue.resolvedAt < issue.createdAt) errors.push(`importIssue ${issue.id} resolved before creation`);
    uniqueIds((issue.resolutions ?? []).map((receipt) => receipt.id), `importIssue ${issue.id} resolution`, errors);
    for (const candidate of issue.candidates) {
      if (!propertyIds.has(candidate)) errors.push(`importIssue ${issue.id} has missing candidate ${candidate}`);
    }
    for (const receipt of issue.resolutions ?? []) {
      if (!Number.isInteger(receipt.at) || receipt.at < issue.createdAt) errors.push(`importIssue ${issue.id} has invalid resolution time`);
      if (receipt.action === "linked" && (!receipt.propertyId || !propertyIds.has(receipt.propertyId))) {
        errors.push(`importIssue ${issue.id} has an invalid linked resolution`);
      }
      if (receipt.action === "rejected" && receipt.propertyId) errors.push(`importIssue ${issue.id} rejected a property link`);
    }
  }

  for (const item of book.cases) {
    if (!CASE_KINDS.includes(item.kind) || !WORK_STATES.includes(item.state)) errors.push(`case ${item.id} has illegal kind/state`);
    if (item.propertyId && !propertyIds.has(item.propertyId)) errors.push(`case ${item.id} missing property`);
    if (item.tenancyId && !tenancyIds.has(item.tenancyId)) errors.push(`case ${item.id} missing tenancy`);
    if (item.proposalId && !proposalIds.has(item.proposalId)) errors.push(`case ${item.id} missing proposal ${item.proposalId}`);
    if (item.importIssueId && !importIssueIds.has(item.importIssueId)) errors.push(`case ${item.id} missing import issue ${item.importIssueId}`);
    for (const evidenceId of item.evidenceIds ?? []) {
      if (!evidenceIds.has(evidenceId)) errors.push(`case ${item.id} missing evidence ${evidenceId}`);
    }
    if (item.inbound) {
      if (item.kind !== "inbound-triage" && item.kind !== "maintenance-intake") errors.push(`case ${item.id} has inbound context on the wrong kind`);
      validateInboundDetail(item.inbound, `case ${item.id}`, errors);
      if (!(item.evidenceIds ?? []).some((id) => evidenceById.get(id)?.sourceRecordKey === item.inbound?.messageKey)) {
        errors.push(`case ${item.id} missing its latest inbound evidence`);
      }
    }
    if (item.lifecycle) validateLifecycle(item.lifecycle, `case ${item.id}`, item.createdAt, errors);
    if (item.sourceIncident) {
      const incident = item.sourceIncident;
      if (item.kind !== "source-incident") errors.push(`case ${item.id} has source incident data on the wrong kind`);
      if (!sourceIds.has(incident.sourceId)) errors.push(`case ${item.id} source incident is missing its source`);
      if (!Number.isInteger(incident.affectedPropertyCount) || incident.affectedPropertyCount < 0 || incident.affectedPropertyCount > 100_000) {
        errors.push(`case ${item.id} has an invalid affected property count`);
      }
      if (!Number.isInteger(incident.firstSeenAt) || !Number.isInteger(incident.lastSeenAt) || incident.firstSeenAt < 0 || incident.lastSeenAt < incident.firstSeenAt) {
        errors.push(`case ${item.id} has invalid source incident times`);
      }
    } else if (item.kind === "source-incident") {
      errors.push(`source incident case ${item.id} is missing source incident data`);
    }
  }

  for (const proposal of book.proposals) {
    if (!caseIds.has(proposal.caseId)) errors.push(`orphan proposal ${proposal.id}`);
    if (!revisionIds.has(proposal.currentRevisionId)) errors.push(`proposal ${proposal.id} missing revision`);
    const owner = caseById.get(proposal.caseId);
    if (proposal.kind === "inbound-reply" && owner?.kind !== "inbound-triage" && owner?.kind !== "maintenance-intake") {
      errors.push(`inbound proposal ${proposal.id} belongs to the wrong case kind`);
    }
  }

  for (const revision of book.proposalRevisions) {
    if (!proposalIds.has(revision.proposalId)) errors.push(`orphan revision ${revision.id}`);
  }

  for (const decision of book.decisions) {
    if (!proposalIds.has(decision.proposalId)) errors.push(`decision ${decision.id} missing proposal`);
    if (!revisionIds.has(decision.revisionId)) errors.push(`decision ${decision.id} missing revision`);
    if (!DECISION_KINDS.includes(decision.kind)) errors.push(`decision ${decision.id} has illegal kind`);
  }

  const mailRecordKeys = new Set<string>();
  for (const evidence of book.evidence) {
    if (!EVIDENCE_AUTHORITIES.includes(evidence.authority) || !EVIDENCE_COLLECTORS.includes(evidence.collector)) {
      errors.push(`evidence ${evidence.id} has illegal authority/collector`);
    }
    if (!sourceIds.has(evidence.sourceId)) errors.push(`evidence ${evidence.id} missing source`);
    if (evidence.authority === "pms" && evidence.observedAt == null) errors.push(`evidence ${evidence.id} claimed PMS without observed time`);
    if (evidence.payload.inbound) {
      validateInboundDetail(evidence.payload.inbound, `evidence ${evidence.id}`, errors);
      if (evidence.collector !== "mail") errors.push(`evidence ${evidence.id} has inbound payload without mail collector`);
      if (evidence.sourceRecordKey !== evidence.payload.inbound.messageKey) errors.push(`evidence ${evidence.id} message key mismatch`);
      const dedupeKey = `${evidence.sourceId}:${evidence.sourceRecordKey}`;
      if (mailRecordKeys.has(dedupeKey)) errors.push(`duplicate inbound source record ${evidence.sourceRecordKey}`);
      mailRecordKeys.add(dedupeKey);
    }
  }

  const positions = new Set<string>();
  for (const position of book.moneyPositions) {
    if (positions.has(position.tenancyId)) errors.push(`duplicate money position for ${position.tenancyId}`);
    positions.add(position.tenancyId);
    if (!tenancyIds.has(position.tenancyId)) errors.push(`money position missing tenancy ${position.tenancyId}`);
    if (!evidenceIds.has(position.evidenceId)) errors.push(`money position missing evidence ${position.evidenceId}`);
    if (!MONEY_POSITION_STATUSES.includes(position.status)) errors.push(`money position ${position.tenancyId} has illegal status`);
  }

  for (const handoff of book.handoffs) {
    const auth = handoff.authorization;
    if (!CLOSED_HANDOFF_OPERATIONS.includes(auth.operation)) errors.push(`handoff ${handoff.id} has illegal operation`);
    if (auth.allowedActions.some((action) => (FORBIDDEN_HANDOFF_ACTIONS as readonly string[]).includes(action))) {
      errors.push(`handoff ${handoff.id} allows a forbidden action`);
    }
    if (!propertyIds.has(auth.propertyId)) errors.push(`handoff ${handoff.id} missing property`);
  }

  if (errors.length) throw new DeskDecodeError(errors);
}

function validateLifecycle(lifecycle: WorkLifecycle, label: string, createdAt: number, errors: string[]): void {
  const times = [
    ["dueAt", lifecycle.dueAt],
    ["nextCheckAt", lifecycle.nextCheckAt],
    ["reminderSuppressedUntil", lifecycle.reminderSuppressedUntil],
    ["closedAt", lifecycle.closedAt],
  ] as const;
  for (const [name, value] of times) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) errors.push(`${label} has invalid ${name}`);
  }
  if (lifecycle.closedAt !== undefined && lifecycle.closedAt < createdAt) errors.push(`${label} closed before creation`);
  if (lifecycle.closedAt !== undefined && (!lifecycle.closedBy || !lifecycle.closureKind)) errors.push(`${label} closure is missing its receipt`);
  if (lifecycle.closedAt === undefined && (lifecycle.closedBy || lifecycle.closureKind)) errors.push(`${label} has a partial closure receipt`);
  if (lifecycle.closedAt !== undefined && lifecycle.waitingParty) errors.push(`${label} is both closed and waiting`);
  if (lifecycle.reminderSuppressedUntil !== undefined && lifecycle.nextCheckAt !== undefined && lifecycle.reminderSuppressedUntil > lifecycle.nextCheckAt) {
    errors.push(`${label} suppresses reminders beyond its next check`);
  }
}

function validateInboundDetail(detail: InboundCaseDetail, label: string, errors: string[]): void {
  if (!INBOUND_CATEGORIES.includes(detail.category) || !INBOUND_PRIORITIES.includes(detail.priority)) errors.push(`${label} has illegal inbound classification`);
  if (!/^[a-f0-9]{64}$/.test(detail.messageKey) || !/^[a-f0-9]{64}$/.test(detail.threadKey)) errors.push(`${label} has invalid inbound digest`);
  if (!Number.isInteger(detail.receivedAt) || detail.receivedAt < 0) errors.push(`${label} has invalid inbound receivedAt`);
  if (!Number.isInteger(detail.attachmentCount) || detail.attachmentCount < 0 || detail.attachmentCount > 12) errors.push(`${label} has invalid attachment count`);
  if (!Number.isInteger(detail.messageCount) || detail.messageCount < 1 || detail.messageCount > 10_000) errors.push(`${label} has invalid message count`);
  if (detail.senderName.length > 120 || detail.senderAddress.length > 254 || detail.subject.length > 300 || detail.summary.length > 500) errors.push(`${label} has oversized inbound text`);
  if (detail.flags.length > 24 || detail.flags.some((flag) => flag.length > 80)) errors.push(`${label} has invalid inbound flags`);
  if (detail.followUpAt !== undefined && (!Number.isInteger(detail.followUpAt) || detail.followUpAt < detail.receivedAt)) errors.push(`${label} has invalid follow-up time`);
}
