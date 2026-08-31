// Pure V2 → V3 transform. No filesystem, no clocks from the host date
// except the caller-supplied migratedAt used for ingested/stale stamps.
import type { Draft, LedgerFacts, PortalCapability, Property, SourceIdentity, WorkItem } from "../shared/contracts.ts";
import type { DeskFileV2 } from "../shared/desk-v2.ts";
import { workStateFromV1Draft } from "./desk-work.ts";
import {
  emptyV3,
  lockedNever,
  migratedEvidenceId,
  migratedRevisionId,
  tenantContactIdFromProperty,
  tenancyIdFromProperty,
  type Case,
  type Contact,
  type DeskFileV3,
  type Evidence,
  type EvidenceAuthority,
  type EvidenceCollector,
  type Handoff,
  type ImportIssue,
  type MoneyPosition,
  type PropertyV3,
  type Proposal,
  type ProposalRevision,
  type Source,
  type Tenancy,
} from "../shared/desk-v3.ts";

const DEFAULT_STALE_MS = 12 * 60 * 60 * 1000;

function sourceAuthority(source: SourceIdentity, mode: DeskFileV2["mode"]): EvidenceAuthority {
  if (source.kind === "demo" || mode === "demo") return "demo";
  return "legacy-unverified";
}

function sourceCollector(source: SourceIdentity): EvidenceCollector {
  if (source.kind === "csv") return "csv";
  if (source.kind === "hermes") return "hermes";
  if (source.kind === "portal") return "bounded-portal";
  return "migration";
}

function isImportHold(reason: string | undefined): reason is "unmatched" | `ambiguous-match${string}` {
  return reason === "unmatched" || Boolean(reason?.startsWith("ambiguous-match"));
}

function migrateSources(v2: DeskFileV2): Source[] {
  return v2.sources.map((source) => ({
    id: source.id,
    authority: sourceAuthority(source, v2.mode),
    collector: sourceCollector(source),
    label: source.label,
    stableKey: source.stableKey,
    freshnessMs: source.kind === "csv" ? DEFAULT_STALE_MS : 30 * 60 * 1000,
  }));
}

function migrateProperties(v2: DeskFileV2): { properties: PropertyV3[]; tenancies: Tenancy[]; contacts: Contact[] } {
  const properties: PropertyV3[] = [];
  const tenancies: Tenancy[] = [];
  const contacts: Contact[] = [];
  for (const property of v2.properties) {
    properties.push({
      id: property.id,
      address: property.address,
      status: "active",
      options: { ...property.options, never: [...lockedNever()] },
    });
    tenancies.push({
      id: tenancyIdFromProperty(property.id),
      propertyId: property.id,
      status: "current",
      weeklyRentCents: property.weeklyRentCents,
    });
    contacts.push({
      id: tenantContactIdFromProperty(property.id),
      role: "tenant",
      name: property.tenantName,
      phone: property.tenantPhone,
      propertyId: property.id,
      tenancyId: tenancyIdFromProperty(property.id),
      safeguards: {
        hardship: false,
        dispute: false,
        paymentArrangement: false,
        doNotContact: false,
        preferredChannel: property.options.notifyChannel,
      },
    });
  }
  return { properties, tenancies, contacts };
}

function migrateEvidence(v2: DeskFileV2, migratedAt: number): { evidence: Evidence[]; moneyPositions: MoneyPosition[] } {
  const evidence: Evidence[] = [];
  const seen = new Set<string>();
  for (const observation of v2.observations) {
    const source = v2.sources.find((item) => item.id === observation.sourceId);
    const row: Evidence = {
      id: observation.id,
      authority: "legacy-unverified",
      collector: source ? sourceCollector(source) : "migration",
      sourceId: observation.sourceId,
      sourceRecordKey: observation.id,
      observedAt: observation.observedAt,
      ingestedAt: migratedAt,
      staleAt: observation.observedAt + observation.staleAfterMs,
      propertyId: observation.propertyId,
      tenancyId: observation.propertyId ? tenancyIdFromProperty(observation.propertyId) : undefined,
      payload: observation.facts ?? {},
    };
    evidence.push(row);
    seen.add(observation.id);
  }
  for (const row of v2.ledger) {
    const id = migratedEvidenceId(row.propertyId);
    if (seen.has(id)) continue;
    evidence.push({
      id,
      authority: "legacy-unverified",
      collector: "migration",
      sourceId: v2.sources[0]?.id ?? "src-demo",
      sourceRecordKey: `ledger:${row.propertyId}`,
      observedAt: null,
      ingestedAt: migratedAt,
      staleAt: migratedAt,
      propertyId: row.propertyId,
      tenancyId: tenancyIdFromProperty(row.propertyId),
      payload: {
        daysSinceDue: row.daysSinceDue,
        rentLanded: row.rentLanded,
        levyPaid: row.levyPaid,
        daysSinceCourtesy: row.daysSinceCourtesy,
        amountPaidCents: row.amountPaidCents ?? null,
        reversed: row.reversed,
      },
    });
  }
  const moneyPositions: MoneyPosition[] = v2.properties.map((property) => {
    const tenancyId = tenancyIdFromProperty(property.id);
    let ev = evidence.find((item) => item.tenancyId === tenancyId) ?? evidence.find((item) => item.propertyId === property.id);
    if (!ev) {
      ev = {
        id: migratedEvidenceId(property.id),
        authority: "legacy-unverified",
        collector: "migration",
        sourceId: v2.sources[0]?.id ?? "src-demo",
        sourceRecordKey: `ledger:${property.id}`,
        observedAt: null,
        ingestedAt: migratedAt,
        staleAt: migratedAt,
        propertyId: property.id,
        tenancyId,
        payload: {},
      };
      evidence.push(ev);
    }
    return {
      tenancyId,
      evidenceId: ev.id,
      sourceId: ev.sourceId,
      observedAt: ev.observedAt,
      staleAt: ev.staleAt,
      facts: ev.payload,
      status: "requires-recheck",
    };
  });
  return { evidence, moneyPositions };
}

function migrateImportIssues(workItems: WorkItem[], migratedAt: number): ImportIssue[] {
  return workItems.filter((work) => isImportHold(work.holdReason)).map((work) => ({
    id: work.id,
    kind: work.holdReason === "unmatched" ? "unmatched" : "ambiguous",
    status: "open",
    sourceId: work.sourceIds[0] ?? "src-demo",
    // V2 unmatched/ambiguous holds carry the CSV identity in propertyId
    rawIdentity: work.propertyId || work.holdReason || "unmatched",
    candidates: [],
    createdAt: work.createdAt || migratedAt,
  }));
}

function migrateCases(v2: DeskFileV2): Case[] {
  const cases: Case[] = [];
  for (const work of v2.workItems) {
    if (isImportHold(work.holdReason)) continue;
    cases.push({
      id: work.id,
      kind: work.kind === "owner-letter" ? "owner-update" : "money-arrears",
      state: work.state,
      propertyId: work.propertyId,
      tenancyId: tenancyIdFromProperty(work.propertyId),
      proposalId: work.draftId,
      holdReason: work.holdReason,
      periodDueAt: work.periodDueAt,
      createdAt: work.createdAt,
      updatedAt: work.updatedAt,
    });
  }
  for (const escalation of v2.escalations) {
    cases.push({
      id: escalation.id,
      kind: "licensee-required",
      state: "held",
      propertyId: escalation.propertyId,
      tenancyId: tenancyIdFromProperty(escalation.propertyId),
      holdReason: escalation.reason,
      createdAt: escalation.createdAt,
      updatedAt: escalation.createdAt,
    });
  }
  return cases;
}

function migrateProposals(drafts: Draft[]): { proposals: Proposal[]; revisions: ProposalRevision[]; decisions: DeskFileV3["decisions"] } {
  const proposals: Proposal[] = [];
  const revisions: ProposalRevision[] = [];
  const decisions: DeskFileV3["decisions"] = [];
  for (const draft of drafts) {
    const revisionId = migratedRevisionId(draft.id);
    proposals.push({
      id: draft.id,
      caseId: draft.workItemId ?? `work-${draft.id}`,
      kind: draft.kind,
      currentRevisionId: revisionId,
      periodDueAt: draft.periodDueAt,
      createdAt: draft.createdAt,
    });
    revisions.push({
      id: revisionId,
      proposalId: draft.id,
      body: draft.body,
      channel: draft.channel,
      to: draft.to,
      hash: `migrated-${draft.id}`,
      createdAt: draft.createdAt,
    });
    if (draft.status === "allowed" || draft.status === "denied") {
      decisions.push({
        id: `dec-${draft.id}`,
        proposalId: draft.id,
        revisionId,
        kind: draft.status === "allowed" ? "allow" : "deny",
        actorId: "legacy-unknown",
        at: draft.decidedAt ?? draft.createdAt,
      });
    }
  }
  return { proposals, revisions, decisions };
}

function migrateHandoffs(capabilities: PortalCapability[], migratedAt: number): Handoff[] {
  return capabilities.map((capability) => ({
    id: capability.id,
    authorization: {
      operation: "prefill-courtesy",
      caseId: capability.workItemId,
      proposalId: capability.workItemId,
      revisionId: migratedRevisionId(capability.workItemId),
      proposalHash: capability.proposalHash,
      propertyId: capability.propertyId,
      tenancyId: tenancyIdFromProperty(capability.propertyId),
      bindingId: `bind-${capability.propertyId}`,
      recipeId: capability.recipeId,
      recipeVersion: capability.recipeVersion,
      allowedOrigins: [],
      allowedActions: [],
      expiresAt: capability.expiresAt,
    },
    usedAt: capability.usedAt,
    invalidatedAt: capability.usedAt ? capability.invalidatedAt : (capability.invalidatedAt ?? migratedAt),
    verification: capability.usedAt ? "effect-unknown" : "invalidated",
  }));
}

export function migrateV2ToV3(v2: DeskFileV2, migratedAt: number): DeskFileV3 {
  const { properties, tenancies, contacts } = migrateProperties(v2);
  const { evidence, moneyPositions } = migrateEvidence(v2, migratedAt);
  const { proposals, revisions, decisions } = migrateProposals(v2.drafts);
  const cases = migrateCases(v2);
  const caseIds = new Set(cases.map((item) => item.id));
  for (const proposal of proposals) {
    if (caseIds.has(proposal.caseId)) continue;
    const draft = v2.drafts.find((item) => item.id === proposal.id);
    cases.push({
      id: proposal.caseId,
      kind: proposal.kind === "owner-letter" ? "owner-update" : "money-arrears",
      state: draft?.status === "denied" ? "denied" : draft?.status === "allowed" ? "approved" : "proposed",
      propertyId: draft?.propertyId,
      tenancyId: draft?.propertyId ? tenancyIdFromProperty(draft.propertyId) : undefined,
      proposalId: proposal.id,
      periodDueAt: proposal.periodDueAt,
      createdAt: proposal.createdAt,
      updatedAt: draft?.decidedAt ?? proposal.createdAt,
    });
    caseIds.add(proposal.caseId);
  }
  const book = emptyV3({
    name: v2.mode === "demo" ? "RealBud Demo Book" : "",
    timezone: v2.timezone,
    jurisdictions: [],
  });
  return {
    ...book,
    revision: v2.revision,
    mode: v2.mode,
    retentionDays: v2.retentionDays,
    sources: migrateSources(v2),
    properties,
    tenancies,
    contacts,
    importIssues: migrateImportIssues(v2.workItems, migratedAt),
    cases,
    evidence,
    moneyPositions,
    proposals,
    proposalRevisions: revisions,
    decisions,
    portalBindings: v2.portalBindings.map((binding) => ({
      id: `bind-${binding.propertyId}-${binding.recipeId}`,
      propertyId: binding.propertyId,
      recipeId: binding.recipeId,
      recipeVersion: binding.recipeVersion,
      remotePropertyId: binding.remotePropertyId,
      remoteAccountId: binding.remoteAccountId,
    })),
    portalRecipes: v2.recipes.map((recipe) => ({ ...recipe })),
    handoffs: migrateHandoffs(v2.capabilities, migratedAt),
    lastRunAt: v2.lastRunAt,
    results: v2.results.map((result) => ({ ...result })),
    hands: v2.hands,
    handsDetail: v2.handsDetail,
  };
}

export function migrateV1ToV2(
  parsed: Record<string, unknown>,
  book: { properties: Property[]; ledger: LedgerFacts[] },
  timezone: string,
): DeskFileV2 {
  const properties = Array.isArray(parsed.properties) ? (parsed.properties as Property[]) : book.properties;
  const ledgerRaw = Array.isArray(parsed.ledger) ? (parsed.ledger as LedgerFacts[]) : book.ledger;
  const drafts = Array.isArray(parsed.drafts) ? (parsed.drafts as Draft[]) : [];
  const workItems: WorkItem[] = drafts.map((draft) => ({
    id: draft.workItemId ?? `work-${draft.id}`,
    kind: "money-arrears",
    state: workStateFromV1Draft(draft.status),
    propertyId: draft.propertyId,
    occurrenceKey: `${draft.propertyId}:${draft.kind}:${draft.periodDueAt}`,
    periodDueAt: draft.periodDueAt,
    draftId: draft.id,
    recipient: { name: "", phone: "" },
    sourceIds: ["src-demo"],
    observedAt: draft.createdAt,
    proposalHash: `migrated-${draft.id}`,
    createdAt: draft.createdAt,
    updatedAt: draft.decidedAt ?? draft.createdAt,
  }));
  const ledger = ledgerRaw.map((row) => ({ ...row, daysSinceCourtesy: null }));
  return {
    version: 2,
    revision: 1,
    mode: "demo",
    timezone,
    retentionDays: 90,
    properties,
    ledger,
    drafts,
    escalations: Array.isArray(parsed.escalations) ? (parsed.escalations as DeskFileV2["escalations"]) : [],
    workItems,
    lastRunAt: typeof parsed.lastRunAt === "number" ? parsed.lastRunAt : null,
    results: Array.isArray(parsed.results) ? (parsed.results as DeskFileV2["results"]) : [],
    hands: parsed.hands === "hermes" ? "hermes" : "demo",
    handsDetail: typeof parsed.handsDetail === "string" ? parsed.handsDetail : null,
    sources: [{ id: "src-demo", kind: "demo", label: "Demo training book", stableKey: "demo:training-book" }],
    observations: [],
    portalBindings: [],
    recipes: [],
    capabilities: [],
  };
}
