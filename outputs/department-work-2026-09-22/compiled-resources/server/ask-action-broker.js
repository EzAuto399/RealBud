import { randomUUID } from "node:crypto";
import { WORKER_ASK_ACTION_PROTOCOL, readAdmittedAskWorkRoutingPlan, } from "../shared/ask-actions.js";
import { normalizeAddress } from "./csv-ledger.js";
import { applyOptions } from "./desk-evaluate.js";
import { INTAKE_FIELD_LIMITS, intakeItemError } from "./intake.js";
import { redactSecretsInText } from "./redact.js";
import { parseClockTime, parseWeekdays } from "./routines.js";
import { currentBookWorkRoutingPlan } from "./work-routing.js";
const RENT_SOURCES = new Set(["mepay", "bank", "pms-export", "fixture", "csv"]);
const NOTIFY_CHANNELS = new Set(["sms", "email", "portal", "desk"]);
const LOOP_IDS = new Set(["morning-arrears", "owner-letter", "inbound-triage"]);
const SETUP_TARGETS = new Set(["worker", "desktop-reminders", "connections"]);
const DIRECT_SETUP_VERB = /\b(?:connect|set\s*up|setup|link|configure|enable|activate)\b/i;
const DIRECT_SETUP_NEGATION = /\b(?:do\s+not|don't|dont|never)\b/i;
const DIRECT_SETUP_FORBIDDEN_AUDIENCE = /\b(?:tenant|owner|tradie|contractor|group|send|pay|notice)\b/i;
const DIRECT_SETUP_SERVICES = [
    { pattern: /\bwhats\s*app(?:\s+business)?\b/i, service: "WhatsApp Business" },
    { pattern: /\btelegram\b/i, service: "Telegram" },
    { pattern: /\b(?:pocket|mobile\s+(?:message|messaging|channel))\b/i, service: "Pocket" },
];
function boundedString(value, max, allowEmpty = false) {
    if (typeof value !== "string")
        return null;
    const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if ((!clean && !allowEmpty) || clean.length > max)
        return null;
    if (redactSecretsInText(clean) !== clean)
        return null;
    return clean;
}
function allowedKeys(value, allowed, required) {
    const keys = Object.keys(value);
    return keys.every((key) => allowed.includes(key)) && required.every((key) => keys.includes(key));
}
function jsonBody(text) {
    const trimmed = text.trim();
    const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
    return fence?.[1]?.trim() ?? trimmed;
}
function parseWorkerProposal(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const record = value;
    const kind = record.kind;
    if (kind === "run-routine") {
        if (!allowedKeys(record, ["kind", "routineId"], ["kind", "routineId"]))
            return null;
        return typeof record.routineId === "string" && LOOP_IDS.has(record.routineId)
            ? { kind, routineId: record.routineId }
            : null;
    }
    if (kind === "change-routine") {
        if (!allowedKeys(record, ["kind", "routineId", "time", "weekdays", "enabled"], ["kind", "routineId"]))
            return null;
        if (typeof record.routineId !== "string" || !LOOP_IDS.has(record.routineId))
            return null;
        const hasChange = record.time !== undefined || record.weekdays !== undefined || record.enabled !== undefined;
        if (!hasChange)
            return null;
        const time = record.time === undefined ? undefined : parseClockTime(record.time);
        const weekdays = record.weekdays === undefined ? undefined : parseWeekdays(record.weekdays);
        if (record.time !== undefined && !time)
            return null;
        if (record.weekdays !== undefined && !weekdays)
            return null;
        if (record.enabled !== undefined && typeof record.enabled !== "boolean")
            return null;
        return {
            kind,
            routineId: record.routineId,
            ...(time ? { time } : {}),
            ...(weekdays ? { weekdays } : {}),
            ...(record.enabled !== undefined ? { enabled: record.enabled } : {}),
        };
    }
    if (kind === "add-property") {
        if (!allowedKeys(record, ["kind", "address", "tenantName", "tenantPhone", "weeklyRentCents"], ["kind", "address", "tenantName", "tenantPhone", "weeklyRentCents"]))
            return null;
        const address = boundedString(record.address, INTAKE_FIELD_LIMITS.address);
        const tenantName = boundedString(record.tenantName, INTAKE_FIELD_LIMITS.tenantName);
        const tenantPhone = boundedString(record.tenantPhone, INTAKE_FIELD_LIMITS.tenantPhone);
        const weeklyRentCents = record.weeklyRentCents;
        const property = { address: address ?? "", tenantName: tenantName ?? "", tenantPhone: tenantPhone ?? "", weeklyRentCents };
        if (!address || !tenantName || !tenantPhone || typeof weeklyRentCents !== "number" ||
            !Number.isInteger(weeklyRentCents) || weeklyRentCents <= 0 ||
            weeklyRentCents > INTAKE_FIELD_LIMITS.weeklyRentCents || intakeItemError(property))
            return null;
        return { kind, address, tenantName, tenantPhone, weeklyRentCents };
    }
    if (kind === "configure-property") {
        if (!allowedKeys(record, ["kind", "propertyRef", "changes"], ["kind", "propertyRef", "changes"]))
            return null;
        const propertyRef = boundedString(record.propertyRef, 240);
        if (!propertyRef || !record.changes || typeof record.changes !== "object" || Array.isArray(record.changes))
            return null;
        const raw = record.changes;
        if (!allowedKeys(raw, ["rentSource", "graceDays", "courtesyUntilDay", "notifyChannel"], []))
            return null;
        if (Object.keys(raw).length === 0)
            return null;
        const changes = {};
        if (raw.rentSource !== undefined) {
            if (typeof raw.rentSource !== "string" || !RENT_SOURCES.has(raw.rentSource))
                return null;
            changes.rentSource = raw.rentSource;
        }
        if (raw.notifyChannel !== undefined) {
            if (typeof raw.notifyChannel !== "string" || !NOTIFY_CHANNELS.has(raw.notifyChannel))
                return null;
            changes.notifyChannel = raw.notifyChannel;
        }
        if (raw.graceDays !== undefined) {
            if (!Number.isInteger(raw.graceDays) || Number(raw.graceDays) < 0 || Number(raw.graceDays) > 28)
                return null;
            changes.graceDays = Number(raw.graceDays);
        }
        if (raw.courtesyUntilDay !== undefined) {
            if (!Number.isInteger(raw.courtesyUntilDay) || Number(raw.courtesyUntilDay) < 1 || Number(raw.courtesyUntilDay) > 60)
                return null;
            changes.courtesyUntilDay = Number(raw.courtesyUntilDay);
        }
        return { kind, propertyRef, changes };
    }
    if (kind === "set-agency-name") {
        if (!allowedKeys(record, ["kind", "name"], ["kind", "name"]))
            return null;
        const name = boundedString(record.name, 120, true);
        return name == null ? null : { kind, name };
    }
    if (kind === "open-setup") {
        if (!allowedKeys(record, ["kind", "target", "service"], ["kind", "target"]))
            return null;
        if (typeof record.target !== "string" || !SETUP_TARGETS.has(record.target))
            return null;
        const service = record.service === undefined ? undefined : boundedString(record.service, 80);
        if (record.service !== undefined && (!service || /:\/\//.test(service)))
            return null;
        return { kind, target: record.target, ...(service ? { service } : {}) };
    }
    if (kind === "prepare-handoff") {
        if (!allowedKeys(record, ["kind", "draftRef"], ["kind", "draftRef"]))
            return null;
        const draftRef = boundedString(record.draftRef, 240);
        return draftRef ? { kind, draftRef } : null;
    }
    return null;
}
export function parseWorkerAskAction(text) {
    let value;
    try {
        value = JSON.parse(jsonBody(text));
    }
    catch {
        return text.includes(WORKER_ASK_ACTION_PROTOCOL)
            ? { matched: true, error: "Bud returned an incomplete RealBud change. Nothing was applied." }
            : { matched: false };
    }
    if (!value || typeof value !== "object" || Array.isArray(value))
        return { matched: false };
    const record = value;
    if (record.action !== WORKER_ASK_ACTION_PROTOCOL)
        return { matched: false };
    if (!allowedKeys(record, ["action", "proposal"], ["action", "proposal"])) {
        return { matched: true, error: "Bud returned an unsupported RealBud change. Nothing was applied." };
    }
    const proposal = parseWorkerProposal(record.proposal);
    if (!proposal)
        return { matched: true, error: "Bud returned an invalid RealBud change. Nothing was applied." };
    return { matched: true, value: { action: WORKER_ASK_ACTION_PROTOCOL, proposal } };
}
function actionError(message, status = 400, code = "INVALID_ACTION") {
    return Object.assign(new Error(message), { status, code });
}
function uniqueProperty(properties, ref) {
    const clean = ref.toLowerCase().trim();
    const normalized = normalizeAddress(ref);
    const exact = properties.filter((property) => property.id.toLowerCase() === clean || (normalized && normalizeAddress(property.address) === normalized));
    if (exact.length === 1)
        return exact[0];
    const fuzzy = properties.filter((property) => property.address.toLowerCase().includes(clean) || property.tenantName.toLowerCase().includes(clean));
    if (fuzzy.length === 1)
        return fuzzy[0];
    if (exact.length > 1 || fuzzy.length > 1)
        throw actionError("That property reference matches more than one property. Use the full address.", 409, "AMBIGUOUS_PROPERTY");
    throw actionError("I could not find that property in the current book.", 404, "PROPERTY_NOT_FOUND");
}
function uniquePreparableDraft(snapshot, desk, ref, now) {
    const exactDraft = snapshot.drafts.find((draft) => draft.id.toLowerCase() === ref.toLowerCase().trim());
    const property = exactDraft
        ? snapshot.properties.find((item) => item.id === exactDraft.propertyId)
        : uniqueProperty(snapshot.properties, ref);
    if (!property)
        throw actionError("That draft no longer belongs to an active property.", 409, "REVISION_CONFLICT");
    const candidates = snapshot.drafts.flatMap((draft) => {
        if (draft.propertyId !== property.id || draft.status !== "allowed")
            return [];
        if (exactDraft && draft.id !== exactDraft.id)
            return [];
        const work = snapshot.workItems.find((item) => item.id === draft.workItemId || item.draftId === draft.id);
        const capability = desk.capabilityFor(draft.id);
        if (!work || work.state !== "approved" || !capability ||
            capability.expiresAt <= now || capability.revision !== snapshot.revision ||
            capability.proposalHash !== work.proposalHash)
            return [];
        return [{ draft, property, capability, workItemId: work.id, proposalHash: work.proposalHash }];
    });
    if (candidates.length === 1)
        return candidates[0];
    if (candidates.length > 1) {
        throw actionError("More than one approved handoff is ready for that property. Name the draft id shown on Desk.", 409, "AMBIGUOUS_HANDOFF");
    }
    const alreadyPrepared = snapshot.workItems.some((work) => work.propertyId === property.id && ["preparing", "handoff-ready", "confirmed", "effect-unknown"].includes(work.state));
    if (alreadyPrepared) {
        throw actionError("That property's approved handoff is already being prepared or is waiting for your final PMS step.", 409, "NO_CHANGE");
    }
    throw actionError("There is no current approved portal handoff for that property. Allow the wording on Desk first.", 409, "HANDOFF_NOT_READY");
}
function newBase(title, detail, now) {
    return {
        schemaVersion: 1,
        id: randomUUID(),
        status: "pending",
        title,
        detail,
        createdAt: now,
    };
}
function admittedStructuredBulkPlan(snapshot, context) {
    if (snapshot.properties.length < 2)
        return undefined;
    const plan = context?.workRoutingPlan?.(snapshot) ?? currentBookWorkRoutingPlan(snapshot);
    const admitted = readAdmittedAskWorkRoutingPlan(plan);
    if (!admitted)
        return undefined;
    const active = admitted.lanes.filter((lane) => lane.itemCount > 0);
    return active.length === 1 && active[0]?.kind === "structured-batch" ? admitted : undefined;
}
function routePlanFingerprint(plan) {
    if (!plan)
        return null;
    return JSON.stringify({
        selectedMode: plan.selectedMode,
        propertyCount: plan.propertyCount,
        lanes: plan.lanes.filter((lane) => lane.itemCount > 0).map((lane) => ({
            kind: lane.kind,
            state: lane.state,
            itemCount: lane.itemCount,
            batchCount: lane.batchCount,
            concurrency: lane.concurrency,
            isolation: lane.isolation,
        })),
        cloudRequired: plan.boundaries.cloudRequired,
    });
}
export function stageWorkerAskAction(text, context) {
    const parsed = parseWorkerAskAction(text);
    if (!parsed.matched)
        return { matched: false };
    if (!parsed.value)
        return { matched: true, error: parsed.error ?? "Bud returned an invalid RealBud change. Nothing was applied.", status: 400, code: "INVALID_ACTION" };
    try {
        const input = parsed.value.proposal;
        const now = context.now?.() ?? Date.now();
        const snapshot = context.desk.snapshot();
        if (input.kind === "run-routine") {
            const loop = context.loops.listLoops().find((item) => item.id === input.routineId);
            if (!loop)
                throw actionError("That routine does not exist.", 404, "ROUTINE_NOT_FOUND");
            if (!loop.available)
                throw actionError(`${loop.name} is planned but not built yet.`, 409, "ROUTINE_UNAVAILABLE");
            if (!loop.enabled)
                throw actionError(`${loop.name} is paused. Ask to turn it on before running it.`, 409, "ROUTINE_PAUSED");
            const executionPlan = loop.id === "morning-arrears" ? admittedStructuredBulkPlan(snapshot, context) : undefined;
            return {
                matched: true,
                deskChanged: false,
                proposal: {
                    ...newBase(`Run ${loop.name}`, "Run it once now. Its results will land on Desk; nothing will be sent.", now),
                    kind: "run-routine",
                    loopId: loop.id,
                    loopName: loop.name,
                    expectedLoopRevision: loop.revision,
                    ...(executionPlan ? { executionPlan } : {}),
                },
            };
        }
        if (input.kind === "change-routine") {
            const loop = context.loops.listLoops().find((item) => item.id === input.routineId);
            if (!loop)
                throw actionError("That routine does not exist.", 404, "ROUTINE_NOT_FOUND");
            if (input.enabled === true && !loop.available)
                throw actionError(`${loop.name} is planned but not built yet.`, 409, "ROUTINE_UNAVAILABLE");
            const before = { enabled: loop.enabled, time: loop.schedule.time, weekdays: [...loop.schedule.weekdays] };
            const after = {
                enabled: input.enabled ?? before.enabled,
                time: input.time ?? before.time,
                weekdays: input.weekdays ? [...input.weekdays] : [...before.weekdays],
            };
            if (before.enabled === after.enabled && before.time === after.time && before.weekdays.join(",") === after.weekdays.join(",")) {
                throw actionError(`${loop.name} already has that schedule.`, 409, "NO_CHANGE");
            }
            return {
                matched: true,
                deskChanged: false,
                proposal: {
                    ...newBase(`Change ${loop.name}`, "Review the before and after schedule, then Allow to update RealBud's clock.", now),
                    kind: "change-routine",
                    loopId: loop.id,
                    loopName: loop.name,
                    expectedLoopRevision: loop.revision,
                    before,
                    after,
                },
            };
        }
        if (input.kind === "add-property") {
            const beforeIds = new Set(snapshot.book?.bookProposals.map((proposal) => proposal.id) ?? []);
            const staged = context.desk.proposeBook({ items: [input] }, "ask");
            const next = context.desk.snapshot();
            const created = (next.book?.bookProposals ?? []).filter((proposal) => !beforeIds.has(proposal.id));
            if (staged.created !== 1 || created.length !== 1) {
                throw actionError("That property is already in the book or is already waiting for review. Nothing new was staged.", 409, "BOOK_DUPLICATE");
            }
            return {
                matched: true,
                deskChanged: true,
                proposal: {
                    ...newBase("Add property to the book", `${input.address} will be added only after Allow.`, now),
                    kind: "add-property",
                    expectedDeskRevision: next.revision,
                    bookProposalIds: [created[0].id],
                    properties: [{
                            address: input.address,
                            tenantName: input.tenantName,
                            tenantPhone: input.tenantPhone,
                            weeklyRentCents: input.weeklyRentCents,
                        }],
                },
            };
        }
        if (input.kind === "configure-property") {
            const property = uniqueProperty(snapshot.properties, input.propertyRef);
            const candidateOptions = structuredClone(property.options);
            applyOptions(candidateOptions, input.changes);
            const before = {
                rentSource: property.options.rentSource,
                graceDays: property.options.graceDays,
                courtesyUntilDay: property.options.courtesyUntilDay,
                notifyChannel: property.options.notifyChannel,
            };
            const changed = Object.entries(input.changes).some(([key, value]) => before[key] !== value);
            if (!changed)
                throw actionError(`${property.address} already has those options.`, 409, "NO_CHANGE");
            return {
                matched: true,
                deskChanged: false,
                proposal: {
                    ...newBase(`Configure ${property.address}`, "These are agency shop options, not a legal clock. Allow applies them to the property card.", now),
                    kind: "configure-property",
                    expectedDeskRevision: snapshot.revision,
                    propertyId: property.id,
                    address: property.address,
                    before,
                    changes: input.changes,
                },
            };
        }
        if (input.kind === "set-agency-name") {
            const beforeName = snapshot.book?.agency.name ?? "";
            if (beforeName === input.name)
                throw actionError("The agency name is already set to that value.", 409, "NO_CHANGE");
            return {
                matched: true,
                deskChanged: false,
                proposal: {
                    ...newBase("Update agency name", "This changes the agency label shown across Desk, Ask and You.", now),
                    kind: "set-agency-name",
                    expectedDeskRevision: snapshot.revision,
                    beforeName,
                    afterName: input.name,
                },
            };
        }
        if (input.kind === "prepare-handoff") {
            if (snapshot.recovery.active)
                throw actionError("Desk is in recovery, so browser preparation is paused.", 409, "RECOVERY_ACTIVE");
            const resolved = uniquePreparableDraft(snapshot, context.desk, input.draftRef, now);
            if (resolved.draft.kind === "inbound-reply") {
                throw actionError("Inbound replies are copied to the agency mailbox or PMS; they cannot mint a portal handoff.", 409, "HANDOFF_NOT_READY");
            }
            const mode = context.portalMode ?? "practice";
            return {
                matched: true,
                deskChanged: false,
                proposal: {
                    ...newBase(mode === "practice" ? `Prepare ${resolved.property.address} in the practice portal` : `Prepare ${resolved.property.address} in the PMS`, mode === "practice"
                        ? "Allow runs the bounded training handoff. Bud may prefill the approved wording; you still perform the final Submit."
                        : "Allow starts one case-bound, expiring handoff. Bud may prefill the approved wording; you still perform the final Submit.", now),
                    kind: "prepare-handoff",
                    expectedDeskRevision: snapshot.revision,
                    draftId: resolved.draft.id,
                    workItemId: resolved.workItemId,
                    capabilityId: resolved.capability.id,
                    proposalHash: resolved.proposalHash,
                    propertyId: resolved.property.id,
                    address: resolved.property.address,
                    draftKind: resolved.draft.kind,
                    mode,
                },
            };
        }
        const setupDetail = input.target === "connections"
            ? `${input.service ? `${input.service} setup` : "Connection setup"} stays in You. Bud never receives credentials in chat and cannot claim a connection succeeded.`
            : input.target === "worker"
                ? "Open Bud's private worker and model setup in You. Keys stay write-only on this device."
                : "Open the local desktop reminder control in You. It never messages tenants, owners or tradies.";
        return {
            matched: true,
            deskChanged: false,
            proposal: {
                ...newBase(input.target === "connections" ? "Open Connections" : input.target === "worker" ? "Open Worker setup" : "Open Desktop reminders", setupDetail, now),
                kind: "open-setup",
                target: input.target,
                ...(input.service ? { service: input.service } : {}),
            },
        };
    }
    catch (error) {
        return {
            matched: true,
            error: error instanceof Error ? error.message : String(error),
            status: error.status ?? 400,
            code: error.code ?? "INVALID_ACTION",
        };
    }
}
/**
 * Resolve an explicit PM-owned Pocket setup request without spending a model
 * call. This is deliberately narrower than general intent parsing: it can
 * only stage the same navigation-only `open-setup` proposal the worker may
 * request, and potentially external/tenant-facing requests stay with Bud so
 * the normal refusal boundary can explain them.
 */
export function stageDirectAskSetupIntent(text, context) {
    const clean = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if (!clean || clean.length > 500 || !DIRECT_SETUP_VERB.test(clean) ||
        DIRECT_SETUP_NEGATION.test(clean) || DIRECT_SETUP_FORBIDDEN_AUDIENCE.test(clean)) {
        return { matched: false };
    }
    const match = DIRECT_SETUP_SERVICES.find(({ pattern }) => pattern.test(clean));
    if (!match)
        return { matched: false };
    return stageWorkerAskAction(JSON.stringify({
        action: WORKER_ASK_ACTION_PROTOCOL,
        proposal: { kind: "open-setup", target: "connections", service: match.service },
    }), context);
}
function loopMatches(loop, target) {
    return loop.enabled === target.enabled && loop.schedule.time === target.time && loop.schedule.weekdays.join(",") === target.weekdays.join(",");
}
function propertyMatchesSummary(property, summary) {
    return normalizeAddress(property.address) === normalizeAddress(summary.address)
        && property.tenantName === summary.tenantName
        && property.tenantPhone === summary.tenantPhone
        && property.weeklyRentCents === summary.weeklyRentCents;
}
function propertyOptionsMatch(property, changes) {
    return Object.entries(changes).every(([key, value]) => property.options[key] === value);
}
function propertyOptionsStillBefore(property, before, changes) {
    return Object.keys(changes).every((key) => {
        const option = key;
        return property.options[option] === before[option];
    });
}
function openBookProposalMatches(snapshot, id, summary) {
    if (!summary)
        return false;
    const proposal = snapshot.book?.bookProposals.find((item) => item.id === id);
    return Boolean(proposal)
        && normalizeAddress(proposal.address) === normalizeAddress(summary.address)
        && proposal.tenantName === summary.tenantName
        && proposal.tenantPhone === summary.tenantPhone
        && proposal.weeklyRentCents === summary.weeklyRentCents;
}
export async function decideAskAction(proposal, decision, context) {
    const decidedAt = context.now?.() ?? Date.now();
    if (proposal.status !== "pending") {
        if ((decision === "allow" && proposal.status === "allowed") || (decision === "deny" && proposal.status === "denied")) {
            return { proposal };
        }
        throw actionError(`This change is already ${proposal.status}.`, 409, "ACTION_SETTLED");
    }
    if (decision === "deny") {
        let snapshot;
        if (proposal.kind === "add-property") {
            const current = context.desk.snapshot();
            const open = new Set(current.book?.bookProposals.map((item) => item.id) ?? []);
            const allOpen = proposal.bookProposalIds.every((id) => open.has(id));
            const allUnchanged = proposal.bookProposalIds.every((id, index) => openBookProposalMatches(current, id, proposal.properties[index]));
            if (allOpen && allUnchanged)
                snapshot = context.desk.denyBookProposals(proposal.bookProposalIds, current.revision);
            else if (allOpen) {
                throw actionError("This property proposal changed after Bud prepared it. Review it on Desk.", 409, "REVISION_CONFLICT");
            }
            else if (proposal.properties.some((summary) => current.properties.some((property) => propertyMatchesSummary(property, summary)))) {
                throw actionError("This property proposal was already applied and cannot be denied.", 409, "ACTION_SETTLED");
            }
            else if (proposal.bookProposalIds.some((id) => open.has(id))) {
                throw actionError("Only part of this property proposal is still open. Review it on Desk.", 409, "REVISION_CONFLICT");
            }
        }
        return { proposal: { ...proposal, status: "denied", decidedAt }, ...(snapshot ? { snapshot } : {}) };
    }
    if (proposal.kind === "run-routine") {
        const loop = context.loops.listLoops().find((item) => item.id === proposal.loopId);
        if (!loop)
            throw actionError("That routine no longer exists.", 404, "ROUTINE_NOT_FOUND");
        const existing = context.loops.listRuns().find((run) => run.requestId === proposal.id);
        if (existing)
            return { proposal: { ...proposal, status: "allowed", decidedAt }, run: existing };
        if (loop.revision !== proposal.expectedLoopRevision)
            throw actionError("That routine changed after Bud prepared this card. Ask again to use the current clock.", 409, "REVISION_CONFLICT");
        if (proposal.executionPlan !== undefined) {
            const planned = readAdmittedAskWorkRoutingPlan(proposal.executionPlan);
            if (!planned)
                throw actionError("This work card has an unknown or unavailable execution route. Ask again to build a current plan.", 409, "ROUTE_PLAN_INVALID");
            const current = admittedStructuredBulkPlan(context.desk.snapshot(), context);
            if (routePlanFingerprint(planned) !== routePlanFingerprint(current ?? null)) {
                throw actionError("The property book changed after Bud prepared this route. Ask again to review the current batch.", 409, "ROUTE_PLAN_STALE");
            }
        }
        const run = context.loops.runNow(proposal.loopId, proposal.id);
        if (!run)
            throw actionError("Enable this routine before running it.", 409, "ROUTINE_PAUSED");
        return { proposal: { ...proposal, status: "allowed", decidedAt }, run };
    }
    if (proposal.kind === "change-routine") {
        const current = context.loops.listLoops().find((item) => item.id === proposal.loopId);
        if (!current)
            throw actionError("That routine no longer exists.", 404, "ROUTINE_NOT_FOUND");
        if (current.revision !== proposal.expectedLoopRevision) {
            if (loopMatches(current, proposal.after))
                return { proposal: { ...proposal, status: "allowed", decidedAt }, loop: current };
            throw actionError("That routine changed after Bud prepared this card. Ask again to review the current clock.", 409, "REVISION_CONFLICT");
        }
        const loop = context.loops.patchClock(proposal.loopId, {
            enabled: proposal.after.enabled,
            time: proposal.after.time,
            weekdays: proposal.after.weekdays,
            expectedRevision: proposal.expectedLoopRevision,
        });
        return { proposal: { ...proposal, status: "allowed", decidedAt }, loop };
    }
    if (proposal.kind === "add-property") {
        const current = context.desk.snapshot();
        const open = new Set(current.book?.bookProposals.map((item) => item.id) ?? []);
        const alreadyAdded = proposal.properties.every((summary) => current.properties.some((property) => propertyMatchesSummary(property, summary)));
        if (alreadyAdded) {
            const remaining = proposal.bookProposalIds.filter((id) => open.has(id));
            const unchanged = remaining.every((id) => {
                const index = proposal.bookProposalIds.indexOf(id);
                return openBookProposalMatches(current, id, proposal.properties[index]);
            });
            if (!unchanged)
                throw actionError("The staged property changed after Bud prepared it. Review the book on Desk.", 409, "REVISION_CONFLICT");
            const snapshot = remaining.length > 0
                ? context.desk.denyBookProposals(remaining, current.revision)
                : current;
            return { proposal: { ...proposal, status: "allowed", decidedAt }, snapshot };
        }
        const allOpen = proposal.bookProposalIds.every((id) => open.has(id));
        const allUnchanged = proposal.bookProposalIds.every((id, index) => openBookProposalMatches(current, id, proposal.properties[index]));
        if (allOpen && allUnchanged) {
            const snapshot = context.desk.allowBookProposals(proposal.bookProposalIds, current.revision);
            return { proposal: { ...proposal, status: "allowed", decidedAt }, snapshot };
        }
        throw actionError("The book changed after Bud prepared this card. Review the current intake cards on Desk.", 409, "REVISION_CONFLICT");
    }
    if (proposal.kind === "configure-property") {
        const current = context.desk.snapshot();
        const property = current.properties.find((item) => item.id === proposal.propertyId);
        if (!property)
            throw actionError("That property is no longer active in the book.", 409, "REVISION_CONFLICT");
        if (propertyOptionsMatch(property, proposal.changes)) {
            return { proposal: { ...proposal, status: "allowed", decidedAt }, snapshot: current };
        }
        if (current.revision !== proposal.expectedDeskRevision && !propertyOptionsStillBefore(property, proposal.before, proposal.changes)) {
            throw actionError("The book changed after Bud prepared this card. Ask again to review current options.", 409, "REVISION_CONFLICT");
        }
        context.desk.patchProperty(proposal.propertyId, proposal.changes);
        return { proposal: { ...proposal, status: "allowed", decidedAt }, snapshot: context.desk.snapshot() };
    }
    if (proposal.kind === "set-agency-name") {
        const current = context.desk.snapshot();
        if (current.book?.agency.name === proposal.afterName) {
            return { proposal: { ...proposal, status: "allowed", decidedAt }, snapshot: current };
        }
        if (current.revision !== proposal.expectedDeskRevision && current.book?.agency.name !== proposal.beforeName) {
            throw actionError("The agency name changed after Bud prepared this card. Ask again to review the current name.", 409, "REVISION_CONFLICT");
        }
        const snapshot = context.desk.updateAgencyName(proposal.afterName, current.revision);
        return { proposal: { ...proposal, status: "allowed", decidedAt }, snapshot };
    }
    if (proposal.kind === "prepare-handoff") {
        const current = context.desk.snapshot();
        const draft = current.drafts.find((item) => item.id === proposal.draftId);
        const work = current.workItems.find((item) => item.id === proposal.workItemId && item.draftId === proposal.draftId);
        if (!draft || !work || draft.propertyId !== proposal.propertyId || work.propertyId !== proposal.propertyId) {
            throw actionError("That handoff no longer matches the current Desk case.", 409, "REVISION_CONFLICT");
        }
        if (work.proposalHash !== proposal.proposalHash) {
            throw actionError("The approved wording changed after Bud prepared this card. Ask again from the current Desk case.", 409, "REVISION_CONFLICT");
        }
        if (["handoff-ready", "confirmed", "effect-unknown"].includes(work.state)) {
            return { proposal: { ...proposal, status: "allowed", decidedAt }, snapshot: current };
        }
        if (work.state === "preparing" || work.state === "failed") {
            throw actionError("The prior preparation did not reach a safely retryable state. Review the handoff on Desk before trying again.", 409, "HANDOFF_FAILED");
        }
        if (current.recovery.active)
            throw actionError("Desk is in recovery, so browser preparation is paused.", 409, "REVISION_CONFLICT");
        if (current.revision !== proposal.expectedDeskRevision || draft.status !== "allowed" || work.state !== "approved") {
            throw actionError("That Desk case changed after Bud prepared this card. Ask again from the current approved wording.", 409, "REVISION_CONFLICT");
        }
        const capability = context.desk.capabilityFor(draft.id);
        if (!capability || capability.id !== proposal.capabilityId ||
            capability.proposalHash !== proposal.proposalHash || capability.revision !== current.revision ||
            capability.expiresAt <= decidedAt) {
            throw actionError("That browser authorization expired or changed. Re-open the approved Desk wording before preparing it.", 409, "REVISION_CONFLICT");
        }
        if (!context.prepareHandoff)
            throw actionError("Browser preparation is not available in this RealBud runtime.", 409, "HANDOFF_UNAVAILABLE");
        let snapshot;
        try {
            snapshot = await context.prepareHandoff(draft.id);
        }
        catch (error) {
            const detail = redactSecretsInText(error instanceof Error ? error.message : String(error)).slice(0, 200);
            throw actionError(`Preparation did not complete safely${detail ? `: ${detail}` : "."}`, error.status ?? 502, "HANDOFF_FAILED");
        }
        const prepared = snapshot.workItems.find((item) => item.id === proposal.workItemId);
        if (!prepared || prepared.state !== "handoff-ready") {
            throw actionError("Preparation ended without a verified handoff-ready state. Review Desk before trying again.", 502, "HANDOFF_FAILED");
        }
        return { proposal: { ...proposal, status: "allowed", decidedAt }, snapshot };
    }
    return {
        proposal: { ...proposal, status: "allowed", decidedAt },
        navigation: proposal.target,
    };
}
