import { createExecutionAdapterBinding, defineExecutionAdapterManifest, } from "./execution-adapters.js";
import { workDigest, } from "./work-broker.js";
import { buildWorkPlan } from "./work-plan.js";
const ROUTE_ORDER = [
    "structured-batch",
    "local-analysis",
    "scripted-browser",
    "isolated-browser",
    "desktop-cua",
    "remote-analysis",
    "remote-browser",
];
function invalid(message) {
    return Object.assign(new Error(message), { status: 400, code: "invalid-work-simulation" });
}
function validateItem(item) {
    if (typeof item.id !== "string" || !item.id.trim() || item.id.length > 200)
        throw invalid("simulation item id is invalid");
    if (!/^[a-f0-9]{64}$/.test(item.digest))
        throw invalid("simulation item digest is invalid");
    if (!["evidence", "draft", "hold"].includes(item.disposition)) {
        throw invalid("simulation item disposition is invalid");
    }
}
export function partitionSimulationItems(items, maximumItemsPerPartition) {
    if (!Number.isInteger(maximumItemsPerPartition) || maximumItemsPerPartition < 1 || maximumItemsPerPartition > 10_000) {
        throw invalid("simulation partition size is invalid");
    }
    const ids = new Set();
    const digests = new Set();
    for (const item of items) {
        validateItem(item);
        if (ids.has(item.id) || digests.has(item.digest))
            throw invalid("simulation items must be unique");
        ids.add(item.id);
        digests.add(item.digest);
    }
    const partitions = [];
    for (let index = 0; index < items.length; index += maximumItemsPerPartition) {
        partitions.push(items.slice(index, index + maximumItemsPerPartition).map((item) => ({ ...item })));
    }
    return partitions;
}
function browserProfile(route, slot) {
    if (route === "isolated-browser" || route === "scripted-browser") {
        return `realbud-simulated-browser-lane-${slot + 1}`;
    }
    if (route === "remote-browser")
        return `remote-simulated-browser-lane-${slot + 1}`;
    return null;
}
export function simulatedWorkPlan(job) {
    const effectClass = job.effectClass ?? "read-only";
    const createdAt = Math.max(0, job.expiresAt - 10 * 60_000);
    const operation = effectClass === "possible-external"
        ? "prepare-approved-fields"
        : job.route === "local-analysis" || job.route === "remote-analysis"
            ? "analyse-selected-files"
            : "browse-approved-origin";
    const effect = effectClass === "possible-external" ? "prepare-only" : "read-only";
    const transport = job.route === "local-analysis"
        ? "isolated-task"
        : job.route === "remote-analysis" || job.route === "remote-browser"
            ? "remote-lane"
            : job.route === "desktop-cua"
                ? "bounded-cua"
                : "private-browser";
    const route = job.route;
    const adapter = route === "structured-batch"
        ? undefined
        : (() => {
            const manifest = defineExecutionAdapterManifest({
                kind: "realbud.execution-adapter.v1",
                schemaVersion: 1,
                id: `sim-${route}-${effect}`,
                version: 1,
                label: `Simulated ${route}`,
                method: "Offline simulation",
                transport,
                route,
                operations: [operation],
                effect,
                requiresNamedAccount: transport === "private-browser" || transport === "bounded-cua" || transport === "remote-lane",
                requiresExplicitOptIn: transport === "private-browser" || transport === "bounded-cua" || transport === "remote-lane",
                runtimeAvailable: true,
                maxConcurrency: Math.min(1, brokerRouteMaximum(route)),
            });
            const attestation = {
                kind: "realbud.execution-adapter-attestation.v1",
                schemaVersion: 1,
                adapterId: manifest.id,
                adapterVersion: manifest.version,
                configurationGeneration: 1,
                state: "ready",
                observedAt: createdAt,
                expiresAt: job.expiresAt,
                policyDigest: workDigest(`simulation-policy:${route}:${effect}`),
                ...(manifest.requiresNamedAccount ? { accountIdentityDigest: workDigest(`simulation-account:${job.concurrencyKey}`) } : {}),
                ...(manifest.requiresExplicitOptIn ? { explicitOptIn: true } : {}),
                ...(transport === "remote-lane" ? {
                    remotePolicy: {
                        region: "au-southeast-1",
                        retentionHours: 1,
                        deletionSupported: true,
                        encryptionAtRest: true,
                        encryptionInTransit: true,
                        spendCeilingCents: 100,
                        localFallback: true,
                    },
                } : {}),
            };
            return createExecutionAdapterBinding({ manifest, attestation, operation, now: createdAt });
        })();
    const inputDigest = workDigest(JSON.stringify(job.items.map((item) => item.digest)));
    return buildWorkPlan({
        requestId: job.requestId,
        createdAt,
        expiresAt: job.expiresAt,
        bookRevision: job.bookRevision ?? 1,
        caseRevision: job.caseRevision ?? null,
        inputDigests: job.items.map((item) => item.digest),
        dataClasses: route === "structured-batch"
            ? ["portfolio-records"]
            : route === "local-analysis" || route === "remote-analysis"
                ? ["selected-files"]
                : effectClass === "possible-external"
                    ? ["portal-form-fields"]
                    : ["bank-credit-metadata"],
        routes: [{ route, ...(adapter ? { adapter } : {}) }],
        concurrencyKey: job.concurrencyKey,
        allowedOrigins: job.allowedOrigins,
        recipe: job.recipe ?? { id: `simulate-${job.route}`, version: 1 },
        effectClass,
        authority: effectClass === "possible-external" || route === "remote-analysis" || route === "remote-browser"
            ? { kind: "allow-decision", actionId: job.requestId, actionRevision: job.bookRevision ?? 1, actionDigest: inputDigest }
            : { kind: "user-request", requestId: job.requestId, requestDigest: inputDigest },
    });
}
function brokerRouteMaximum(route) {
    if (route === "remote-analysis" || route === "remote-browser")
        return 8;
    if (route === "local-analysis" || route === "isolated-browser")
        return 2;
    return 1;
}
function outputDigest(job) {
    return workDigest(JSON.stringify(job.items.map((item) => [item.digest, item.disposition])));
}
async function executeClaim(broker, claim, job) {
    broker.start(claim);
    await Promise.resolve();
    const behavior = job.behavior ?? "success";
    if (behavior === "retry-once" && claim.receipt.attempts === 1) {
        broker.fail(claim, { code: "simulated-transient", retryable: true });
        return;
    }
    if (behavior === "fail") {
        broker.fail(claim, { code: "simulated-failure", retryable: false });
        return;
    }
    if (behavior === "effect-unknown") {
        broker.markEffectBoundary(claim);
        broker.fail(claim, { code: "simulated-ambiguous-ack", retryable: false });
        return;
    }
    if (job.effectClass === "possible-external")
        broker.markEffectBoundary(claim);
    const digest = outputDigest(job);
    const ready = broker.complete(claim, digest);
    broker.reconcile(ready.id, digest);
}
/**
 * Runs the route topology without network, browser, desktop or model access.
 * The broker sees digests and bounded metadata only; fixture contents and item
 * identities remain in this in-memory harness.
 */
export async function runWorkSimulation(broker, jobs) {
    if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > 2_000)
        throw invalid("simulation job count is invalid");
    const requestIds = new Set();
    const itemIds = new Set();
    const itemDigests = new Set();
    for (const job of jobs) {
        if (requestIds.has(job.requestId))
            throw invalid("simulation request ids must be unique");
        requestIds.add(job.requestId);
        if (!Array.isArray(job.items) || job.items.length < 1)
            throw invalid("simulation job has no items");
        if (broker.routeCapacity(job.route) < 1)
            throw invalid("simulation route is gated");
        if (job.behavior === "effect-unknown" && job.effectClass !== "possible-external") {
            throw invalid("unknown-effect simulation requires a possible external effect boundary");
        }
        for (const item of job.items) {
            validateItem(item);
            if (itemIds.has(item.id) || itemDigests.has(item.digest))
                throw invalid("simulation items must be unique across jobs");
            itemIds.add(item.id);
            itemDigests.add(item.digest);
        }
    }
    const admissions = broker.admitBatch(jobs.map(simulatedWorkPlan));
    const jobByRequest = new Map(jobs.map((job) => [job.requestId, job]));
    for (const admission of admissions) {
        const job = jobByRequest.get(admission.receipt.requestId);
        if ((job.behavior ?? "success") === "cancel-before-run") {
            broker.cancel(admission.receipt.id, admission.receipt.cancellationGeneration);
        }
    }
    let maxConcurrentTotal = 0;
    let maxConcurrentAnalysis = 0;
    let maxConcurrentBrowsers = 0;
    let maxConcurrentDesktopCua = 0;
    let maxConcurrentPerSerializationKey = 0;
    const profiles = new Set();
    const maximumWaves = jobs.length * 5 + 10;
    for (let wave = 0; wave < maximumWaves; wave += 1) {
        const claims = [];
        for (const route of ROUTE_ORDER) {
            const capacity = broker.routeCapacity(route);
            for (let slot = 0; slot < capacity; slot += 1) {
                const claim = broker.leaseNext({
                    runnerId: `sim-${route}-${slot + 1}`,
                    routes: [route],
                    requestIds: [...requestIds],
                    leaseMs: 60_000,
                });
                if (!claim)
                    break;
                const job = jobByRequest.get(claim.receipt.requestId);
                if (!job)
                    throw new Error("simulation receipt lost its in-memory fixture");
                claims.push({ claim, job, route, slot });
                const profile = browserProfile(route, slot);
                if (profile)
                    profiles.add(profile);
            }
        }
        if (claims.length === 0) {
            const pending = broker.list().filter((receipt) => requestIds.has(receipt.requestId) && ["queued", "leased", "running"].includes(receipt.state));
            if (pending.length > 0)
                throw new Error("simulation stalled with pending work");
            break;
        }
        maxConcurrentTotal = Math.max(maxConcurrentTotal, claims.length);
        maxConcurrentAnalysis = Math.max(maxConcurrentAnalysis, claims.filter(({ route }) => route === "local-analysis" || route === "remote-analysis").length);
        maxConcurrentBrowsers = Math.max(maxConcurrentBrowsers, claims.filter(({ route }) => route === "scripted-browser" || route === "isolated-browser" || route === "remote-browser").length);
        maxConcurrentDesktopCua = Math.max(maxConcurrentDesktopCua, claims.filter(({ route }) => route === "desktop-cua").length);
        const activeByKey = new Map();
        for (const { job } of claims)
            activeByKey.set(job.concurrencyKey, (activeByKey.get(job.concurrencyKey) ?? 0) + 1);
        maxConcurrentPerSerializationKey = Math.max(maxConcurrentPerSerializationKey, ...activeByKey.values());
        await Promise.all(claims.map(({ claim, job }) => executeClaim(broker, claim, job)));
    }
    const receipts = broker.list().filter((receipt) => requestIds.has(receipt.requestId));
    const byRequest = new Map(receipts.map((receipt) => [receipt.requestId, receipt]));
    const outcomes = [];
    const seenOutcomes = new Set();
    let duplicateItems = 0;
    for (const job of jobs) {
        const receipt = byRequest.get(job.requestId);
        if (!receipt)
            continue;
        for (const item of job.items) {
            if (seenOutcomes.has(item.id))
                duplicateItems += 1;
            seenOutcomes.add(item.id);
            outcomes.push({
                id: item.id,
                disposition: receipt.state === "reconciled" ? item.disposition : "hold",
                receiptState: receipt.state,
            });
        }
    }
    const receiptStates = {};
    for (const receipt of receipts)
        receiptStates[receipt.state] = (receiptStates[receipt.state] ?? 0) + 1;
    return {
        offline: true,
        totalItems: itemIds.size,
        evidenceItems: outcomes.filter((item) => item.disposition === "evidence").length,
        draftItems: outcomes.filter((item) => item.disposition === "draft").length,
        heldItems: outcomes.filter((item) => item.disposition === "hold").length,
        missingItems: itemIds.size - seenOutcomes.size,
        duplicateItems,
        aggregationBatches: 1,
        admittedReceipts: admissions.filter((item) => !item.duplicate).length,
        duplicateAdmissions: admissions.filter((item) => item.duplicate).length,
        maxConcurrentTotal,
        maxConcurrentAnalysis,
        maxConcurrentBrowsers,
        maxConcurrentDesktopCua,
        maxConcurrentPerSerializationKey,
        browserProfiles: [...profiles].sort(),
        receiptStates,
        outcomes,
    };
}
