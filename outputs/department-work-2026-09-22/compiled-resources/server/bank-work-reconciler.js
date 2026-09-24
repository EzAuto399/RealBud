import { validateBankObservationBatch } from "./bank-observation.js";
import { createExecutionAdapterBinding, defineExecutionAdapterManifest, } from "./execution-adapters.js";
import { workDigest } from "./work-broker.js";
import { buildWorkPlan } from "./work-plan.js";
export const BANK_OBSERVATION_RECIPE = { id: "bank-credit-observation", version: 1 };
const BANK_BROWSER_MANIFEST = defineExecutionAdapterManifest({
    kind: "realbud.execution-adapter.v1",
    schemaVersion: 1,
    id: "fixture-bank-browser",
    version: 1,
    label: "Fixture bank browser",
    method: "RealBud fixture recipe",
    transport: "private-browser",
    route: "scripted-browser",
    operations: ["read-bank-credits"],
    effect: "read-only",
    requiresNamedAccount: true,
    requiresExplicitOptIn: true,
    runtimeAvailable: true,
    maxConcurrency: 1,
});
function codedError(message, status, code) {
    return Object.assign(new Error(message), { status, code });
}
export function bankObservationDigest(batch) {
    return workDigest(JSON.stringify({
        kind: batch.kind,
        schemaVersion: batch.schemaVersion,
        accountFingerprint: batch.accountFingerprint,
        observedAt: batch.observedAt,
        credits: batch.credits.map((credit) => ({
            transactionDigest: credit.transactionDigest,
            bookedAt: credit.bookedAt,
            amountCents: credit.amountCents,
            referenceDigest: workDigest(credit.reference),
        })),
    }));
}
function assertReceipt(receipt, digest) {
    if (receipt.route !== "scripted-browser" || receipt.effectClass !== "read-only") {
        throw codedError("bank work receipt is not a read-only scripted browser route", 409, "work-not-reconcilable");
    }
    if (receipt.recipe.id !== BANK_OBSERVATION_RECIPE.id || receipt.recipe.version !== BANK_OBSERVATION_RECIPE.version) {
        throw codedError("bank work receipt recipe is invalid", 409, "work-not-reconcilable");
    }
    if (receipt.outputDigest !== digest) {
        throw codedError("bank observation digest does not match its receipt", 409, "work-not-reconcilable");
    }
}
export function reconcileBankObservation(input) {
    validateBankObservationBatch(input.batch);
    const digest = bankObservationDigest(input.batch);
    const receipt = input.broker.get(input.receiptId);
    if (!receipt)
        throw codedError("bank work receipt was not found", 404, "work-not-found");
    assertReceipt(receipt, digest);
    if (receipt.state !== "evidence-ready" && receipt.state !== "reconciled") {
        throw codedError("bank observation is not ready for Desk", 409, "work-not-reconcilable");
    }
    const transactionDigests = input.batch.credits.map((credit) => credit.transactionDigest);
    const alreadyApplied = input.desk.hasBankTransactionDigests(transactionDigests);
    if (receipt.state === "reconciled" && transactionDigests.length > 0 && !alreadyApplied) {
        throw codedError("broker says reconciled but Desk has no matching bank evidence", 503, "work-reconciliation-inconsistent");
    }
    let snapshot = input.desk.snapshot();
    if (!alreadyApplied) {
        if (snapshot.revision !== receipt.bookRevision) {
            throw codedError("stale desk revision", 409, "revision-conflict");
        }
        snapshot = input.desk.importBankObservations(input.batch, receipt.bookRevision);
        if (!input.desk.hasBankTransactionDigests(transactionDigests)) {
            throw codedError("Desk did not retain every bank transaction marker", 503, "work-reconciliation-inconsistent");
        }
    }
    const settled = receipt.state === "reconciled" ? receipt : input.broker.reconcile(receipt.id, digest);
    return { snapshot, receipt: settled, replayedDeskCommit: alreadyApplied };
}
export function runBankObservationImport(input) {
    const now = input.now?.() ?? Date.now();
    validateBankObservationBatch(input.batch);
    const existing = input.broker.getByRequestId(input.requestId);
    if (!existing && input.desk.revision !== input.expectedRevision) {
        throw codedError("stale desk revision", 409, "revision-conflict");
    }
    const digest = bankObservationDigest(input.batch);
    let receipt = existing;
    if (receipt) {
        let normalizedOrigins;
        try {
            normalizedOrigins = [...new Set(input.allowedOrigins.map((origin) => new URL(origin).origin))].sort();
        }
        catch {
            throw codedError("bank allowed origin is invalid", 400, "invalid-work-plan");
        }
        if (receipt.bookRevision !== input.expectedRevision || receipt.caseRevision !== null
            || receipt.route !== "scripted-browser" || receipt.effectClass !== "read-only"
            || receipt.inputDigests.length !== 1 || receipt.inputDigests[0] !== digest
            || receipt.recipe.id !== BANK_OBSERVATION_RECIPE.id || receipt.recipe.version !== BANK_OBSERVATION_RECIPE.version
            || receipt.allowedOrigins.join("\n") !== normalizedOrigins.join("\n"))
            throw codedError("request id is already bound to different bank work", 409, "idempotency-conflict");
    }
    else {
        const expiresAt = now + 10 * 60_000;
        const attestation = {
            kind: "realbud.execution-adapter-attestation.v1",
            schemaVersion: 1,
            adapterId: BANK_BROWSER_MANIFEST.id,
            adapterVersion: BANK_BROWSER_MANIFEST.version,
            configurationGeneration: 1,
            state: "ready",
            observedAt: now,
            expiresAt,
            policyDigest: workDigest("realbud.fixture-bank-browser.policy.v1"),
            accountIdentityDigest: workDigest(`fixture-bank:${input.batch.accountFingerprint}`),
            explicitOptIn: true,
        };
        const adapter = createExecutionAdapterBinding({
            manifest: BANK_BROWSER_MANIFEST,
            attestation,
            operation: "read-bank-credits",
            now,
        });
        const plan = buildWorkPlan({
            requestId: input.requestId,
            createdAt: now,
            expiresAt,
            bookRevision: input.expectedRevision,
            caseRevision: null,
            inputDigests: [digest],
            dataClasses: ["bank-credit-metadata"],
            routes: [{ route: "scripted-browser", adapter }],
            concurrencyKey: `bank:${input.batch.accountFingerprint}`,
            allowedOrigins: input.allowedOrigins,
            recipe: BANK_OBSERVATION_RECIPE,
            effectClass: "read-only",
            authority: { kind: "user-request", requestId: input.requestId, requestDigest: digest },
        });
        receipt = input.broker.admit(plan).receipt;
    }
    if (receipt.state === "queued") {
        const claim = input.broker.leaseNext({
            runnerId: "realbud-bank-observer",
            routes: ["scripted-browser"],
            requestIds: [receipt.requestId],
            leaseMs: 60_000,
        });
        if (!claim)
            throw codedError("bank observation is already running", 409, "work-busy");
        input.broker.start(claim);
        receipt = input.broker.complete(claim, digest);
    }
    if (receipt.state !== "evidence-ready" && receipt.state !== "reconciled") {
        throw codedError(`bank observation cannot resume from ${receipt.state}`, 409, "work-not-reconcilable");
    }
    return reconcileBankObservation({ broker: input.broker, desk: input.desk, receiptId: receipt.id, batch: input.batch });
}
