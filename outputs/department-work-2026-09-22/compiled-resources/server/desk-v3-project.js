function viaFromActor(actorId) {
    if (!actorId || actorId === "pm" || actorId === "legacy-unknown")
        return undefined;
    return actorId;
}
export function projectQueueSnapshot(book) {
    const addressById = new Map(book.properties.map((property) => [property.id, property.address]));
    return {
        revision: book.revision,
        cases: book.cases.map((item) => ({
            id: item.id,
            kind: item.kind,
            state: item.state,
            propertyId: item.propertyId,
            address: item.propertyId ? addressById.get(item.propertyId) : undefined,
            holdReason: item.holdReason,
            updatedAt: item.updatedAt,
        })),
        importIssues: book.importIssues.map((issue) => ({ id: issue.id, kind: issue.kind, status: issue.status, rawIdentity: issue.rawIdentity })),
    };
}
export function projectDeskSnapshot(book, recovery, notes) {
    const tenantByProperty = new Map(book.contacts.filter((c) => c.role === "tenant").map((c) => [c.propertyId, c]));
    const properties = book.properties.filter((property) => property.status === "active").map((property) => {
        const tenant = tenantByProperty.get(property.id);
        return {
            id: property.id,
            address: property.address,
            tenantName: tenant?.name ?? "",
            tenantPhone: tenant?.phone ?? "",
            weeklyRentCents: book.tenancies.find((t) => t.propertyId === property.id && t.status === "current")?.weeklyRentCents ?? 0,
            options: property.options,
            notes: notes?.get(property.id),
        };
    });
    const revisionById = new Map(book.proposalRevisions.map((revision) => [revision.id, revision]));
    const decisionByProposal = new Map(book.decisions.map((decision) => [decision.proposalId, decision]));
    const drafts = book.proposals.map((proposal) => {
        const revision = revisionById.get(proposal.currentRevisionId);
        const decision = decisionByProposal.get(proposal.id);
        const via = viaFromActor(decision?.actorId);
        return {
            id: proposal.id,
            propertyId: book.cases.find((item) => item.id === proposal.caseId)?.propertyId ?? "",
            kind: proposal.kind,
            status: decision?.kind === "allow" ? "allowed" : decision?.kind === "deny" ? "denied" : "pending",
            channel: revision?.channel ?? "desk",
            to: revision?.to ?? "",
            body: revision?.body ?? "",
            periodDueAt: proposal.periodDueAt,
            createdAt: proposal.createdAt,
            decidedAt: decision?.at,
            workItemId: proposal.caseId,
            ...(via ? { via } : {}),
        };
    });
    const workItems = book.cases
        .filter((item) => item.kind !== "licensee-required")
        .map((item) => {
        const tenant = item.propertyId ? tenantByProperty.get(item.propertyId) : undefined;
        return {
            id: item.id,
            kind: item.kind === "owner-update"
                ? "owner-letter"
                : item.kind === "maintenance-intake" ||
                    item.kind === "lease-review" ||
                    item.kind === "inspection-prep" ||
                    item.kind === "inbound-triage"
                    ? item.kind
                    : "money-arrears",
            state: item.state,
            propertyId: item.propertyId ?? "",
            occurrenceKey: item.occurrenceKey ?? item.id,
            periodDueAt: item.periodDueAt ?? 0,
            draftId: item.proposalId,
            recipient: {
                name: tenant?.name ?? "",
                phone: tenant?.phone ?? "",
                hardship: tenant?.safeguards.hardship,
                dispute: tenant?.safeguards.dispute,
                paymentArrangement: tenant?.safeguards.paymentArrangement,
                doNotContact: tenant?.safeguards.doNotContact,
            },
            sourceIds: item.sourceIds ?? [],
            observedAt: item.createdAt,
            proposalHash: item.proposalHash ?? item.proposalId ?? "",
            artifactIds: item.artifactIds,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
            holdReason: item.holdReason,
            origin: item.origin,
        };
    });
    const escalations = book.cases
        .filter((item) => item.kind === "licensee-required")
        .map((item) => ({
        id: item.id,
        propertyId: item.propertyId ?? "",
        reason: "statutory-clock",
        // Books written before `detail` existed only kept the code; a plain
        // fallback beats showing "statutory-clock" to the PM.
        detail: item.detail ??
            "For the licensee. A licensed person decides whether any state notice is due — in the PMS. RealBud will not draft or send one.",
        periodDueAt: item.periodDueAt ?? 0,
        createdAt: item.createdAt,
    }));
    const ledger = book.moneyPositions.map((position) => ({
        propertyId: book.tenancies.find((t) => t.id === position.tenancyId)?.propertyId ?? "",
        daysSinceDue: position.facts.daysSinceDue ?? 0,
        rentLanded: position.facts.rentLanded ?? false,
        levyPaid: position.facts.levyPaid ?? false,
        daysSinceCourtesy: position.facts.daysSinceCourtesy ?? null,
        amountPaidCents: position.facts.amountPaidCents,
        reversed: position.facts.reversed,
    }));
    return {
        version: 2,
        revision: book.revision,
        mode: book.mode,
        recovery,
        timezone: book.agency.timezone,
        retentionDays: book.retentionDays,
        properties,
        ledger,
        drafts,
        escalations,
        workItems,
        lastRunAt: book.lastRunAt,
        results: book.results.map((result) => ({ ...result })),
        hands: book.hands,
        handsDetail: book.handsDetail,
        sources: book.sources.map((source) => ({
            id: source.id,
            kind: source.collector === "bounded-portal" ? "portal" : source.collector === "migration" ? "demo" : source.collector,
            label: source.label,
            stableKey: source.stableKey,
            lastCheckedAt: source.lastCheckedAt,
        })),
        demo: book.mode === "demo",
    };
}
export function projectWorkingV2(book) {
    const snap = projectDeskSnapshot(book, { active: false, reason: null, quarantined: [] });
    const importWork = book.importIssues.map((issue) => ({
        id: issue.id,
        kind: "money-arrears",
        state: "held",
        // the CSV identity round-trips through propertyId so the V2→V3 sync can
        // keep repairing the issue; reason words ("unmatched") carry no identity
        propertyId: issue.linkedPropertyId ??
            (issue.rawIdentity && issue.rawIdentity !== issue.kind && issue.rawIdentity !== "ambiguous-match"
                ? issue.rawIdentity
                : ""),
        occurrenceKey: issue.id,
        periodDueAt: issue.createdAt,
        recipient: { name: "", phone: "" },
        sourceIds: [issue.sourceId],
        observedAt: issue.createdAt,
        proposalHash: "",
        createdAt: issue.createdAt,
        updatedAt: issue.createdAt,
        holdReason: issue.kind === "unmatched" ? "unmatched" : "ambiguous-match",
    }));
    return {
        version: 2,
        revision: book.revision,
        mode: book.mode,
        timezone: book.agency.timezone,
        retentionDays: book.retentionDays,
        properties: snap.properties.map(({ notes: _notes, ...property }) => property),
        ledger: snap.ledger,
        drafts: snap.drafts,
        escalations: snap.escalations,
        workItems: [...snap.workItems, ...importWork],
        lastRunAt: book.lastRunAt,
        results: book.results.map((result) => ({ ...result })),
        hands: book.hands,
        handsDetail: book.handsDetail,
        sources: snap.sources,
        observations: book.evidence
            .filter((row) => row.observedAt != null)
            .map((row) => ({
            id: row.id,
            sourceId: row.sourceId,
            observedAt: row.observedAt ?? row.ingestedAt,
            propertyId: row.propertyId,
            facts: {
                propertyId: row.propertyId ?? "",
                daysSinceDue: row.payload.daysSinceDue ?? 0,
                rentLanded: row.payload.rentLanded ?? false,
                levyPaid: row.payload.levyPaid ?? false,
                daysSinceCourtesy: row.payload.daysSinceCourtesy ?? null,
                amountPaidCents: row.payload.amountPaidCents,
                reversed: row.payload.reversed,
            },
            staleAfterMs: Math.max(0, row.staleAt - (row.observedAt ?? row.ingestedAt)),
        })),
        portalBindings: book.portalBindings.map((binding) => ({
            propertyId: binding.propertyId,
            recipeId: binding.recipeId,
            recipeVersion: binding.recipeVersion,
            remotePropertyId: binding.remotePropertyId,
            remoteAccountId: binding.remoteAccountId,
        })),
        recipes: book.portalRecipes.map((recipe) => ({ ...recipe })),
        capabilities: book.handoffs.map((handoff) => ({
            id: handoff.id,
            workItemId: handoff.authorization.caseId,
            revision: book.revision,
            proposalHash: handoff.authorization.proposalHash,
            propertyId: handoff.authorization.propertyId,
            recipeId: handoff.authorization.recipeId,
            recipeVersion: handoff.authorization.recipeVersion,
            operation: "prefill-courtesy",
            approver: "pm",
            expiresAt: handoff.authorization.expiresAt,
            usedAt: handoff.usedAt,
            invalidatedAt: handoff.invalidatedAt,
        })),
    };
}
