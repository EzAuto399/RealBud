import { parsePmsExport } from "./csv-ledger.js";
import { CSV_FRESH_MS, isFresh } from "./source-gate.js";
import { workDigest, } from "./work-broker.js";
import { buildWorkPlan } from "./work-plan.js";
export const STRUCTURED_PMS_RECIPE = { id: "pms-structured-import", version: 1 };
function codedError(message, status, code) {
    return Object.assign(new Error(message), { status, code });
}
function validateAggregate(aggregate, now) {
    if (aggregate?.kind !== "realbud.structured-pms-aggregate.v1" || aggregate.schemaVersion !== 1) {
        throw codedError("structured PMS output version is invalid", 400, "invalid-work-output");
    }
    if (!Number.isFinite(aggregate.observedAt) || aggregate.observedAt < 0) {
        throw codedError("structured PMS observation time is invalid", 400, "invalid-work-output");
    }
    if (typeof aggregate.csv !== "string" || !aggregate.csv.trim()) {
        throw codedError("structured PMS output is empty", 400, "invalid-work-output");
    }
    if (!isFresh(aggregate.observedAt, CSV_FRESH_MS, now)) {
        throw codedError(aggregate.observedAt > now ? "PMS export timestamp is in the future" : "PMS export is stale", 409, "stale-work-output");
    }
    // Parse before a worker receipt can become evidence-ready. Desk parses
    // again at its authority boundary; this first pass keeps malformed output
    // out of the durable broker completion state.
    parsePmsExport(aggregate.csv, aggregate.observedAt, "src-work-validation");
}
export function structuredPmsAggregateDigest(aggregate) {
    return workDigest(JSON.stringify({
        kind: aggregate.kind,
        schemaVersion: aggregate.schemaVersion,
        observedAt: aggregate.observedAt,
        csvDigest: workDigest(aggregate.csv),
    }));
}
function markerFor(receipt, outputDigest) {
    return `work:${receipt.id}:${outputDigest}`;
}
function sourceIdFor(receipt) {
    return `src-work-${workDigest(receipt.id).slice(0, 20)}`;
}
function assertReceiptShape(receipt, outputDigest) {
    if (receipt.route !== "structured-batch" || receipt.effectClass !== "read-only") {
        throw codedError("work receipt is not a read-only structured batch", 409, "work-not-reconcilable");
    }
    if (receipt.recipe.id !== STRUCTURED_PMS_RECIPE.id || receipt.recipe.version !== STRUCTURED_PMS_RECIPE.version) {
        throw codedError("work receipt recipe does not match the structured PMS importer", 409, "work-not-reconcilable");
    }
    if (receipt.outputDigest !== outputDigest) {
        throw codedError("work output digest does not match its receipt", 409, "work-not-reconcilable");
    }
}
/**
 * Moves one completed structured worker result into Desk, then settles the
 * broker receipt. The digest-bound Desk source is the cross-file idempotency
 * marker. Desk always commits first; the broker is never reconciled early.
 */
export function reconcileStructuredPmsAggregate(input) {
    const outputDigest = structuredPmsAggregateDigest(input.aggregate);
    const receipt = input.broker.get(input.receiptId);
    if (!receipt)
        throw codedError("work receipt was not found", 404, "work-not-found");
    assertReceiptShape(receipt, outputDigest);
    if (receipt.state !== "evidence-ready" && receipt.state !== "reconciled") {
        throw codedError("work output is not ready for Desk", 409, "work-not-reconcilable");
    }
    const stableKey = markerFor(receipt, outputDigest);
    const alreadyApplied = input.desk.hasSourceStableKey(stableKey);
    if (receipt.state === "reconciled" && !alreadyApplied) {
        throw codedError("broker says reconciled but Desk has no matching commit marker", 503, "work-reconciliation-inconsistent");
    }
    let snapshot = input.desk.snapshot();
    if (!alreadyApplied) {
        if (snapshot.revision !== receipt.bookRevision) {
            throw codedError("Desk changed before worker output could be applied", 409, "revision-conflict");
        }
        snapshot = input.desk.importBrokerCsv({
            csv: input.aggregate.csv,
            observedAt: input.aggregate.observedAt,
            expectedRevision: receipt.bookRevision,
            sourceId: sourceIdFor(receipt),
            sourceLabel: "Brokered PMS export",
            sourceStableKey: stableKey,
        });
        if (!input.desk.hasSourceStableKey(stableKey)) {
            throw codedError("Desk did not retain the work reconciliation marker", 503, "work-reconciliation-inconsistent");
        }
    }
    const settled = receipt.state === "reconciled"
        ? receipt
        : input.broker.reconcile(receipt.id, outputDigest);
    return { snapshot, receipt: settled, replayedDeskCommit: alreadyApplied };
}
/** Admit, execute and reconcile the local structured-import route. Retries
 * reuse the request id and resume from queued/evidence-ready/reconciled state. */
export function runStructuredPmsImport(input) {
    const now = input.now?.() ?? Date.now();
    validateAggregate(input.aggregate, now);
    const existing = input.broker.getByRequestId(input.requestId);
    if (!existing && input.desk.revision !== input.expectedRevision) {
        throw codedError("stale desk revision", 409, "revision-conflict");
    }
    const csvDigest = workDigest(input.aggregate.csv);
    const outputDigest = structuredPmsAggregateDigest(input.aggregate);
    let receipt = existing;
    if (receipt) {
        if (receipt.bookRevision !== input.expectedRevision || receipt.caseRevision !== null
            || receipt.route !== "structured-batch" || receipt.effectClass !== "read-only"
            || receipt.inputDigests.length !== 1 || receipt.inputDigests[0] !== csvDigest
            || receipt.recipe.id !== STRUCTURED_PMS_RECIPE.id || receipt.recipe.version !== STRUCTURED_PMS_RECIPE.version)
            throw codedError("request id is already bound to different work", 409, "idempotency-conflict");
    }
    else {
        const plan = buildWorkPlan({
            requestId: input.requestId,
            createdAt: now,
            expiresAt: now + 10 * 60_000,
            bookRevision: input.expectedRevision,
            caseRevision: null,
            inputDigests: [csvDigest],
            dataClasses: ["portfolio-records"],
            routes: [{ route: "structured-batch" }],
            concurrencyKey: "desk:structured-pms-import",
            recipe: STRUCTURED_PMS_RECIPE,
            effectClass: "read-only",
            authority: {
                kind: "user-request",
                requestId: input.requestId,
                requestDigest: workDigest(JSON.stringify({ csvDigest, outputDigest, expectedRevision: input.expectedRevision })),
            },
        });
        receipt = input.broker.admit(plan).receipt;
    }
    if (receipt.state === "queued") {
        const claim = input.broker.leaseNext({
            runnerId: "realbud-structured-pms-importer",
            routes: ["structured-batch"],
            requestIds: [receipt.requestId],
            leaseMs: 60_000,
        });
        if (!claim)
            throw codedError("structured import is already running", 409, "work-busy");
        input.broker.start(claim);
        receipt = input.broker.complete(claim, outputDigest);
    }
    if (receipt.state !== "evidence-ready" && receipt.state !== "reconciled") {
        throw codedError(`structured import cannot resume from ${receipt.state}`, 409, "work-not-reconcilable");
    }
    return reconcileStructuredPmsAggregate({
        broker: input.broker,
        desk: input.desk,
        receiptId: receipt.id,
        aggregate: input.aggregate,
    });
}
