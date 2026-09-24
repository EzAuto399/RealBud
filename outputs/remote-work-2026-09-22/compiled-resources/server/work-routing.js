import { availableParallelism, freemem } from "node:os";
const MAX_ITEMS = 10_000;
const MAX_LOCAL_LANES = 2;
const MIN_ACCELERATED_CORES = 4;
const MIN_ACCELERATED_FREE_MEMORY_MB = 4_096;
export const CURRENT_WORK_ROUTING_CAPABILITIES = {
    localAnalysis: false,
    scriptedBrowser: false,
    isolatedBrowserPool: false,
    desktopCua: false,
    cloudAnalysis: false,
    cloudBrowser: false,
    cloudMaxConcurrency: 0,
};
export const WORK_ROUTING_PREFERENCES = [
    "auto",
    "local-standard",
    "local-accelerated",
    "cloud-accelerated",
];
export function normalizeWorkRoutingPreference(value) {
    return typeof value === "string" && WORK_ROUTING_PREFERENCES.includes(value)
        ? value
        : null;
}
function boundedInteger(name, value, maximum = MAX_ITEMS) {
    if (!Number.isInteger(value) || value < 0 || value > maximum) {
        throw Object.assign(new Error(`${name} must be an integer from 0 to ${maximum}`), {
            status: 400,
            code: "invalid-workload-shape",
        });
    }
    return value;
}
function validateCapabilities(capabilities) {
    const cloudMaxConcurrency = boundedInteger("cloudMaxConcurrency", capabilities.cloudMaxConcurrency, 32);
    return { ...capabilities, cloudMaxConcurrency };
}
function validateResources(resources) {
    return {
        cpuCores: boundedInteger("cpuCores", resources.cpuCores, 1_024),
        freeMemoryMb: boundedInteger("freeMemoryMb", resources.freeMemoryMb, 1_048_576),
    };
}
function validateBrowserWork(work) {
    return work.map((item) => {
        const key = item.accountConcurrencyKey;
        if (typeof key !== "string" || !key.trim() || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key)) {
            throw Object.assign(new Error("accountConcurrencyKey must be a bounded opaque value"), {
                status: 400,
                code: "invalid-workload-shape",
            });
        }
        return { accountConcurrencyKey: key };
    });
}
function acceleratedResourceReady(resources) {
    return resources.cpuCores >= MIN_ACCELERATED_CORES
        && resources.freeMemoryMb >= MIN_ACCELERATED_FREE_MEMORY_MB;
}
function localAccelerationUseful(input) {
    const uniqueAccounts = new Set(input.browserWork.map((item) => item.accountConcurrencyKey)).size;
    return (input.analysisItemCount > 1 && input.capabilities.localAnalysis)
        || (uniqueAccounts > 1 && input.capabilities.isolatedBrowserPool);
}
function selectMode(input) {
    const fallbackReasons = [];
    const resourcesReady = acceleratedResourceReady(input.resources);
    const localReady = resourcesReady && localAccelerationUseful(input);
    const cloudReady = input.capabilities.cloudMaxConcurrency > 0
        && (input.capabilities.cloudAnalysis || input.capabilities.cloudBrowser);
    if (input.requestedMode === "cloud-accelerated") {
        if (cloudReady)
            return { selectedMode: "cloud-accelerated", fallbackReasons };
        fallbackReasons.push("Cloud acceleration is not connected and ready; all work remains local.");
        if (localReady)
            return { selectedMode: "local-accelerated", fallbackReasons };
        return { selectedMode: "local-standard", fallbackReasons };
    }
    if (input.requestedMode === "local-accelerated") {
        if (!resourcesReady) {
            fallbackReasons.push(`Local acceleration needs at least ${MIN_ACCELERATED_CORES} CPU cores and ${MIN_ACCELERATED_FREE_MEMORY_MB} MB free memory.`);
            return { selectedMode: "local-standard", fallbackReasons };
        }
        if (!localAccelerationUseful(input)) {
            fallbackReasons.push("No ready independent local lane can use acceleration for this workload.");
            return { selectedMode: "local-standard", fallbackReasons };
        }
        return { selectedMode: "local-accelerated", fallbackReasons };
    }
    if (input.requestedMode === "auto" && localReady) {
        return { selectedMode: "local-accelerated", fallbackReasons };
    }
    return { selectedMode: "local-standard", fallbackReasons };
}
function lane(input) {
    return {
        ...input,
        batchCount: input.batchCount ?? (input.itemCount > 0 && input.concurrency > 0
            ? Math.ceil(input.itemCount / input.concurrency)
            : input.itemCount),
    };
}
function benchmarkFor(kind, benchmarks) {
    if (kind === "structured-batch")
        return benchmarks.structuredBatch;
    if (kind === "local-analysis" || kind === "remote-analysis")
        return benchmarks.analysis;
    if (kind === "scripted-browser" || kind === "isolated-browser" || kind === "remote-browser")
        return benchmarks.browser;
    return benchmarks.desktopCua;
}
function validBenchmark(value) {
    return Boolean(value)
        && Number.isFinite(value.fixedSeconds)
        && value.fixedSeconds >= 0
        && Number.isFinite(value.minimumSecondsPerItem)
        && value.minimumSecondsPerItem >= 0
        && Number.isFinite(value.maximumSecondsPerItem)
        && value.maximumSecondsPerItem >= value.minimumSecondsPerItem;
}
function estimateFor(lanes, benchmarks) {
    const active = lanes.filter((item) => item.itemCount > 0);
    if (!active.length) {
        return {
            basis: "measured",
            minimumSeconds: 0,
            maximumSeconds: 0,
            detail: "There is no work in this plan.",
        };
    }
    if (active.some((item) => item.state !== "ready")) {
        return {
            basis: "unavailable",
            minimumSeconds: null,
            maximumSeconds: null,
            detail: "Timing will appear when every required route is ready.",
        };
    }
    if (!benchmarks) {
        return {
            basis: "unavailable",
            minimumSeconds: null,
            maximumSeconds: null,
            detail: "Timing will appear after this workflow has measured runs.",
        };
    }
    let minimumSeconds = 0;
    let maximumSeconds = 0;
    for (const item of active) {
        const benchmark = benchmarkFor(item.kind, benchmarks);
        if (!validBenchmark(benchmark)) {
            return {
                basis: "unavailable",
                minimumSeconds: null,
                maximumSeconds: null,
                detail: "Timing will appear after every selected route has measured runs.",
            };
        }
        const waves = Math.ceil(item.itemCount / Math.max(1, item.concurrency));
        minimumSeconds += benchmark.fixedSeconds + waves * benchmark.minimumSecondsPerItem;
        maximumSeconds += benchmark.fixedSeconds + waves * benchmark.maximumSecondsPerItem;
    }
    return {
        basis: "measured",
        minimumSeconds: Math.ceil(minimumSeconds),
        maximumSeconds: Math.ceil(maximumSeconds),
        detail: "Range derived from measured runs for the selected route; provider or portal delays can still hold work.",
    };
}
export function planWorkRouting(raw) {
    const requestedMode = raw.requestedMode ?? "auto";
    if (!normalizeWorkRoutingPreference(requestedMode)) {
        throw Object.assign(new Error("requestedMode is not supported"), { status: 400, code: "invalid-workload-shape" });
    }
    const propertyCount = boundedInteger("propertyCount", raw.propertyCount);
    const preferenceRevision = boundedInteger("preferenceRevision", raw.preferenceRevision ?? 0, Number.MAX_SAFE_INTEGER);
    const analysisItemCount = boundedInteger("analysisItemCount", raw.analysisItemCount ?? 0);
    const desktopCuaJobs = boundedInteger("desktopCuaJobs", raw.desktopCuaJobs ?? 0);
    const browserWork = validateBrowserWork(raw.browserWork ?? []);
    boundedInteger("browserWork length", browserWork.length);
    const capabilities = validateCapabilities(raw.capabilities);
    const resources = validateResources(raw.resources);
    const { selectedMode, fallbackReasons } = selectMode({
        requestedMode,
        analysisItemCount,
        browserWork,
        capabilities,
        resources,
    });
    const lanes = [];
    if (propertyCount > 0) {
        lanes.push(lane({
            kind: "structured-batch",
            state: "ready",
            itemCount: propertyCount,
            batchCount: 1,
            concurrency: 1,
            isolation: "realbud-process",
            detail: `${propertyCount} portfolio record${propertyCount === 1 ? "" : "s"} will be validated and evaluated as one local batch.`,
        }));
    }
    if (analysisItemCount > 0) {
        const cloud = selectedMode === "cloud-accelerated" && capabilities.cloudAnalysis;
        const ready = cloud || capabilities.localAnalysis;
        const concurrency = !ready
            ? 0
            : cloud
                ? Math.min(capabilities.cloudMaxConcurrency, analysisItemCount)
                : selectedMode === "local-accelerated"
                    ? Math.min(MAX_LOCAL_LANES, analysisItemCount)
                    : 1;
        lanes.push(lane({
            kind: cloud ? "remote-analysis" : "local-analysis",
            state: ready ? "ready" : "gated",
            itemCount: analysisItemCount,
            concurrency,
            isolation: cloud ? "remote-isolated" : "realbud-workspace",
            detail: ready
                ? `${analysisItemCount} independent analysis item${analysisItemCount === 1 ? "" : "s"} will use ${concurrency} stateless bounded lane${concurrency === 1 ? "" : "s"}.`
                : "Parallel analysis is not yet wired to the pinned worker; the existing serial Bud path remains available for ordinary Ask work.",
        }));
    }
    if (browserWork.length > 0) {
        const uniqueAccounts = new Set(browserWork.map((item) => item.accountConcurrencyKey)).size;
        const cloud = selectedMode === "cloud-accelerated" && capabilities.cloudBrowser;
        const isolated = capabilities.isolatedBrowserPool;
        const scripted = capabilities.scriptedBrowser;
        const ready = cloud || isolated || scripted;
        const maximum = cloud
            ? capabilities.cloudMaxConcurrency
            : isolated && selectedMode === "local-accelerated"
                ? MAX_LOCAL_LANES
                : 1;
        const concurrency = ready ? Math.min(maximum, uniqueAccounts, browserWork.length) : 0;
        lanes.push(lane({
            kind: cloud ? "remote-browser" : isolated ? "isolated-browser" : "scripted-browser",
            state: ready ? "ready" : "gated",
            itemCount: browserWork.length,
            batchCount: uniqueAccounts,
            concurrency,
            isolation: cloud ? "remote-isolated" : "realbud-browser-profile",
            detail: ready
                ? uniqueAccounts === 1
                    ? `${browserWork.length} browser record${browserWork.length === 1 ? "" : "s"} share one account and will stay on one isolated lane.`
                    : `${browserWork.length} browser records span ${uniqueAccounts} independent accounts and will use at most ${concurrency} isolated lanes.`
                : "Browser-bound records remain gated until a typed RealBud-owned adapter and isolated profile runtime are proven.",
        }));
    }
    if (desktopCuaJobs > 0) {
        lanes.push(lane({
            kind: "desktop-cua",
            state: capabilities.desktopCua ? "ready" : "gated",
            itemCount: desktopCuaJobs,
            concurrency: capabilities.desktopCua ? 1 : 0,
            isolation: "visible-desktop",
            detail: capabilities.desktopCua
                ? `${desktopCuaJobs} visible-desktop job${desktopCuaJobs === 1 ? "" : "s"} will run one at a time under the shared computer lease.`
                : "Visible-desktop work remains gated until the named case adapter is ready; it can never run in parallel on one screen.",
        }));
    }
    return {
        kind: "realbud.work-routing.v1",
        schemaVersion: 1,
        preferenceConfigured: raw.preferenceConfigured ?? raw.requestedMode !== undefined,
        preferenceRevision,
        requestedMode,
        selectedMode,
        propertyCount,
        lanes,
        estimate: estimateFor(lanes, raw.benchmarks),
        fallbackReasons,
        boundaries: {
            cloudRequired: false,
            maxIsolatedBrowsers: MAX_LOCAL_LANES,
            maxDesktopCua: 1,
            workerOwnership: "external-pinned-runtime",
            browserOwnership: "realbud-only",
            personalBrowserAccess: false,
            personalHermesAccess: false,
        },
    };
}
export function localResourceSnapshot() {
    return {
        cpuCores: Math.max(1, availableParallelism()),
        freeMemoryMb: Math.max(0, Math.floor(freemem() / (1024 * 1024))),
    };
}
/** Current UI projection. It deliberately describes only capabilities already
 * admitted by the product. Future broker/browser/cloud adapters must opt in
 * explicitly instead of becoming ready because hardware happens to exist. */
export function currentBookWorkRoutingPlan(desk, resources = localResourceSnapshot(), capabilities = CURRENT_WORK_ROUTING_CAPABILITIES, preference = "auto", preferenceConfigured = false, preferenceRevision = 0) {
    return planWorkRouting({
        requestedMode: preference,
        preferenceConfigured,
        preferenceRevision,
        propertyCount: desk.properties.length,
        capabilities,
        resources,
    });
}
