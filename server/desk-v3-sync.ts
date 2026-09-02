// Apply a V2 working copy onto V3 without dropping V3-only records.
// File authority stays V3. Historic tenancies, extra contacts and extra cases survive.
import type { DeskFileV2 } from "../shared/desk-v2.ts";
import {
  CASE_KINDS,
  FORBIDDEN_HANDOFF_ACTIONS,
  lockedNever,
  tenantContactIdFromProperty,
  tenancyIdFromProperty,
  type CaseKind,
  type DeskFileV3,
  type EvidenceCollector,
} from "../shared/desk-v3.ts";

function caseKindFromWork(kind: string): CaseKind {
  if (kind === "owner-letter") return "owner-update";
  if ((CASE_KINDS as readonly string[]).includes(kind)) return kind as CaseKind;
  return "money-arrears";
}

function collectorFromKind(kind: DeskFileV2["sources"][number]["kind"]): EvidenceCollector {
  if (kind === "csv") return "csv";
  if (kind === "hermes") return "hermes";
  if (kind === "portal") return "bounded-portal";
  return "migration";
}

function factsEqual(a: DeskFileV3["moneyPositions"][number]["facts"], b: DeskFileV2["ledger"][number]): boolean {
  return (
    (a.daysSinceDue ?? 0) === b.daysSinceDue &&
    Boolean(a.rentLanded) === b.rentLanded &&
    Boolean(a.levyPaid) === b.levyPaid &&
    (a.daysSinceCourtesy ?? null) === (b.daysSinceCourtesy ?? null) &&
    (a.amountPaidCents ?? null) === (b.amountPaidCents ?? null) &&
    Boolean(a.reversed) === Boolean(b.reversed)
  );
}

export function syncWorkingV2IntoV3(v3: DeskFileV3, v2: DeskFileV2, now: number): DeskFileV3 {
  const next: DeskFileV3 = structuredClone(v3);
  next.revision = v2.revision;
  next.mode = v2.mode;
  next.retentionDays = v2.retentionDays;
  next.lastRunAt = v2.lastRunAt;
  next.results = v2.results.map((result) => ({ ...result }));
  next.hands = v2.hands;
  next.handsDetail = v2.handsDetail;
  next.agency = { ...next.agency, timezone: v2.timezone };

  const v2Ids = new Set(v2.properties.map((property) => property.id));
  for (const property of next.properties) {
    if (!v2Ids.has(property.id) && property.status === "active") {
      property.status = "archived";
      property.archivedAt = now;
    }
  }

  for (const property of v2.properties) {
    let row = next.properties.find((item) => item.id === property.id);
    if (!row) {
      row = {
        id: property.id,
        address: property.address,
        status: "active",
        options: { ...property.options, never: [...lockedNever()] },
      };
      next.properties.push(row);
    } else {
      row.address = property.address;
      row.status = "active";
      row.archivedAt = undefined;
      row.options = { ...property.options, never: [...lockedNever()] };
    }
    let tenancy = next.tenancies.find((item) => item.propertyId === property.id && item.status === "current");
    if (!tenancy) {
      tenancy = {
        id: tenancyIdFromProperty(property.id),
        propertyId: property.id,
        status: "current",
        weeklyRentCents: property.weeklyRentCents,
      };
      next.tenancies.push(tenancy);
    } else {
      tenancy.weeklyRentCents = property.weeklyRentCents;
    }
    let contact = next.contacts.find((item) => item.id === tenantContactIdFromProperty(property.id));
    if (!contact) {
      next.contacts.push({
        id: tenantContactIdFromProperty(property.id),
        role: "tenant",
        name: property.tenantName,
        phone: property.tenantPhone,
        propertyId: property.id,
        tenancyId: tenancy.id,
        safeguards: {
          hardship: false,
          dispute: false,
          paymentArrangement: false,
          doNotContact: false,
          preferredChannel: property.options.notifyChannel,
        },
      });
    } else {
      contact.name = property.tenantName;
      contact.phone = property.tenantPhone;
      contact.safeguards.preferredChannel = property.options.notifyChannel;
    }
  }

  for (const source of v2.sources) {
    const existing = next.sources.find((item) => item.id === source.id);
    if (existing) {
      if (source.lastCheckedAt != null) existing.lastCheckedAt = source.lastCheckedAt;
      continue;
    }
    next.sources.push({
      id: source.id,
      authority: v2.mode === "demo" || source.kind === "demo" ? "demo" : "legacy-unverified",
      collector: collectorFromKind(source.kind),
      label: source.label,
      stableKey: source.stableKey,
      freshnessMs: source.kind === "csv" ? 12 * 60 * 60 * 1000 : 30 * 60 * 1000,
      lastCheckedAt: source.lastCheckedAt,
    });
  }

  for (const observation of v2.observations) {
    if (next.evidence.some((item) => item.id === observation.id)) continue;
    const source = v2.sources.find((item) => item.id === observation.sourceId);
    next.evidence.push({
      id: observation.id,
      authority: v2.mode === "demo" ? "demo" : "legacy-unverified",
      collector: source ? collectorFromKind(source.kind) : "migration",
      sourceId: observation.sourceId,
      sourceRecordKey: observation.id,
      observedAt: observation.observedAt,
      ingestedAt: now,
      staleAt: observation.observedAt + observation.staleAfterMs,
      propertyId: observation.propertyId,
      tenancyId: observation.propertyId ? tenancyIdFromProperty(observation.propertyId) : undefined,
      payload: observation.facts ?? {},
    });
  }

  for (const row of v2.ledger) {
    const tenancyId = tenancyIdFromProperty(row.propertyId);
    let position = next.moneyPositions.find((item) => item.tenancyId === tenancyId);
    if (position && factsEqual(position.facts, row)) continue;
    const sourceId = v2.sources[0]?.id ?? next.sources[0]?.id ?? "src-demo";
    if (!next.sources.some((item) => item.id === sourceId)) {
      next.sources.push({
        id: sourceId,
        authority: v2.mode === "demo" ? "demo" : "legacy-unverified",
        collector: "migration",
        label: "Book",
        stableKey: sourceId,
        freshnessMs: 1,
      });
    }
    const evidenceId = `ev-sync-${row.propertyId}-${now}`;
    if (!next.evidence.some((item) => item.id === evidenceId)) {
      next.evidence.push({
        id: evidenceId,
        authority: v2.mode === "demo" ? "demo" : "legacy-unverified",
        collector: "migration",
        sourceId,
        sourceRecordKey: `ledger:${row.propertyId}:${now}`,
        observedAt: null,
        ingestedAt: now,
        staleAt: now,
        propertyId: row.propertyId,
        tenancyId,
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
    const evidence = next.evidence.find((item) => item.id === evidenceId)!;
    if (!position) {
      next.moneyPositions.push({
        tenancyId,
        evidenceId: evidence.id,
        sourceId: evidence.sourceId,
        observedAt: evidence.observedAt,
        staleAt: evidence.staleAt,
        facts: evidence.payload,
        status: "requires-recheck",
      });
    } else {
      position.evidenceId = evidence.id;
      position.sourceId = evidence.sourceId;
      position.observedAt = evidence.observedAt;
      position.staleAt = evidence.staleAt;
      position.facts = evidence.payload;
      position.status = "requires-recheck";
    }
  }

  const importIds = new Set<string>();
  for (const work of v2.workItems) {
    const importHold = work.holdReason === "unmatched" || Boolean(work.holdReason?.startsWith("ambiguous-match"));
    if (importHold) {
      importIds.add(work.id);
      const identity = work.propertyId || work.holdReason || "unmatched";
      const existing = next.importIssues.find((item) => item.id === work.id);
      if (existing) {
        // repair pre-fix rows that stored the reason word instead of the address
        existing.rawIdentity = identity;
      } else {
        next.importIssues.push({
          id: work.id,
          kind: work.holdReason === "unmatched" ? "unmatched" : "ambiguous",
          status: "open",
          sourceId: work.sourceIds[0] ?? "src-demo",
          // V2 unmatched holds store the CSV identity in propertyId; the
          // holdReason is just the reason word and must not mask the address
          rawIdentity: identity,
          candidates: [],
          createdAt: work.createdAt || now,
        });
      }
      continue;
    }
    let item = next.cases.find((row) => row.id === work.id);
    const kind = caseKindFromWork(work.kind);
    if (!item) {
      next.cases.push({
        id: work.id,
        kind,
        state: work.state,
        propertyId: work.propertyId || undefined,
        tenancyId: work.propertyId ? tenancyIdFromProperty(work.propertyId) : undefined,
        proposalId: work.draftId,
        origin: work.origin,
        holdReason: work.holdReason,
        periodDueAt: work.periodDueAt,
        occurrenceKey: work.occurrenceKey,
        sourceIds: work.sourceIds,
        proposalHash: work.proposalHash,
        artifactIds: work.artifactIds,
        createdAt: work.createdAt,
        updatedAt: work.updatedAt,
      });
    } else {
      item.kind = kind;
      item.state = work.state;
      item.proposalId = work.draftId;
      item.origin = work.origin ?? item.origin;
      item.holdReason = work.holdReason;
      item.periodDueAt = work.periodDueAt;
      item.occurrenceKey = work.occurrenceKey;
      item.sourceIds = work.sourceIds;
      item.proposalHash = work.proposalHash;
      item.artifactIds = work.artifactIds;
      item.updatedAt = work.updatedAt;
    }
  }

  // issues are 1:1 with import-hold work items: drop orphans left behind by
  // resets or resolved holds, then keep one open issue per identity.
  // A rawIdentity equal to the reason word is a pre-fix artifact with no
  // recoverable address — it told the PM nothing, so it does not survive.
  next.importIssues = next.importIssues.filter(
    (issue) => importIds.has(issue.id) && issue.rawIdentity !== issue.kind && issue.rawIdentity !== "ambiguous-match",
  );
  {
    const seenIdentities = new Set<string>();
    next.importIssues = next.importIssues
      .slice()
      .sort((a, b) => a.createdAt - b.createdAt)
      .filter((issue) => {
        const key = issue.rawIdentity.trim().toLowerCase();
        if (!key || seenIdentities.has(key)) return false;
        seenIdentities.add(key);
        return true;
      });
  }

  for (const escalation of v2.escalations) {
    if (next.cases.some((item) => item.id === escalation.id)) continue;
    next.cases.push({
      id: escalation.id,
      kind: "licensee-required",
      state: "held",
      propertyId: escalation.propertyId,
      tenancyId: tenancyIdFromProperty(escalation.propertyId),
      holdReason: escalation.reason,
      detail: escalation.detail,
      periodDueAt: escalation.periodDueAt,
      createdAt: escalation.createdAt,
      updatedAt: escalation.createdAt,
    });
  }

  for (const draft of v2.drafts) {
    const caseId = draft.workItemId ?? `work-${draft.id}`;
    let proposal = next.proposals.find((item) => item.id === draft.id);
    if (!proposal) {
      const revisionId = `rev-${draft.id}-0`;
      next.proposals.push({
        id: draft.id,
        caseId,
        kind: draft.kind,
        currentRevisionId: revisionId,
        periodDueAt: draft.periodDueAt,
        createdAt: draft.createdAt,
      });
      next.proposalRevisions.push({
        id: revisionId,
        proposalId: draft.id,
        body: draft.body,
        channel: draft.channel,
        to: draft.to,
        hash: `sync-${draft.id}-0`,
        createdAt: draft.createdAt,
      });
    } else {
      proposal.caseId = caseId;
      proposal.kind = draft.kind;
      proposal.periodDueAt = draft.periodDueAt;
      const current = next.proposalRevisions.find((item) => item.id === proposal.currentRevisionId);
      if (!current || current.body !== draft.body || current.channel !== draft.channel || current.to !== draft.to) {
        const revisionId = `rev-${draft.id}-${next.proposalRevisions.filter((item) => item.proposalId === draft.id).length}`;
        next.proposalRevisions.push({
          id: revisionId,
          proposalId: draft.id,
          body: draft.body,
          channel: draft.channel,
          to: draft.to,
          hash: `sync-${draft.id}-${now}`,
          createdAt: now,
        });
        proposal.currentRevisionId = revisionId;
      }
    }
    const saved = next.proposals.find((item) => item.id === draft.id)!;
    if (draft.status === "allowed" || draft.status === "denied") {
      const kind = draft.status === "allowed" ? "allow" : "deny";
      const existing = next.decisions.find((item) => item.proposalId === draft.id);
      if (!existing) {
        next.decisions.push({
          id: `dec-${draft.id}`,
          proposalId: draft.id,
          revisionId: saved.currentRevisionId,
          kind,
          actorId: draft.via ?? "pm",
          at: draft.decidedAt ?? now,
        });
      } else {
        existing.kind = kind;
        existing.revisionId = saved.currentRevisionId;
        existing.at = draft.decidedAt ?? existing.at;
        if (draft.via) existing.actorId = draft.via;
      }
    }
  }

  next.portalRecipes = v2.recipes.map((recipe) => ({ ...recipe }));
  const fromV2 = v2.portalBindings.map((binding) => ({
    id: `bind-${binding.propertyId}-${binding.recipeId}`,
    propertyId: binding.propertyId,
    recipeId: binding.recipeId,
    recipeVersion: binding.recipeVersion,
    remotePropertyId: binding.remotePropertyId,
    remoteAccountId: binding.remoteAccountId,
  }));
  const kept = next.portalBindings.filter((binding) => !fromV2.some((item) => item.id === binding.id) && !v2Ids.has(binding.propertyId));
  next.portalBindings = [...fromV2, ...kept];

  for (const capability of v2.capabilities) {
    let handoff = next.handoffs.find((item) => item.id === capability.id);
    const recipe = next.portalRecipes.find((item) => item.id === capability.recipeId && item.version === capability.recipeVersion);
    const allowedActions = (recipe?.steps ?? []).filter((step) => !(FORBIDDEN_HANDOFF_ACTIONS as readonly string[]).includes(step));
    if (!handoff) {
      next.handoffs.push({
        id: capability.id,
        authorization: {
          operation: "prefill-courtesy",
          caseId: capability.workItemId,
          proposalId: capability.workItemId,
          revisionId: `rev-${capability.workItemId}-0`,
          proposalHash: capability.proposalHash,
          propertyId: capability.propertyId,
          tenancyId: tenancyIdFromProperty(capability.propertyId),
          bindingId: `bind-${capability.propertyId}-${capability.recipeId}`,
          recipeId: capability.recipeId,
          recipeVersion: capability.recipeVersion,
          allowedOrigins: recipe?.origin ? [recipe.origin] : [],
          allowedActions,
          expiresAt: capability.expiresAt,
        },
        usedAt: capability.usedAt,
        invalidatedAt: capability.invalidatedAt,
        verification: capability.usedAt ? "effect-unknown" : capability.invalidatedAt ? "invalidated" : undefined,
      });
    } else {
      handoff.usedAt = capability.usedAt;
      handoff.invalidatedAt = capability.invalidatedAt;
      handoff.authorization.expiresAt = capability.expiresAt;
      handoff.authorization.proposalHash = capability.proposalHash;
      if (capability.usedAt) handoff.verification = handoff.verification ?? "effect-unknown";
      else if (capability.invalidatedAt) handoff.verification = "invalidated";
    }
  }

  void importIds;
  return next;
}
