import { REALBUD_VERSION } from "../shared/version.js";
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const LOOP_RUN_STATUSES = ["queued", "running", "completed", "failed", "missed", "interrupted"];
const SETTLED_WORK_STATES = new Set(["denied", "confirmed", "failed", "stale", "superseded", "cancelled", "handoff-expired"]);
function safeLabel(value) {
    return typeof value === "string" && SAFE_LABEL.test(value) ? value : null;
}
function platformLabel(value) {
    return value === "darwin" || value === "win32" || value === "linux" ? value : "other";
}
function architectureLabel(value) {
    return value === "arm64" || value === "x64" ? value : "other";
}
function mobileState(value) {
    return value === "off" || value === "pilot-gated" || value === "setup-required" || value === "connecting" || value === "ready" || value === "attention"
        ? value
        : "off";
}
function workerState(input) {
    if (input.workerBusy)
        return "busy";
    if (!input.worker)
        return "unavailable";
    if (input.worker.runtimeRecovery?.action === "attention" || input.worker.modelRecovery?.action === "attention")
        return "recovery";
    return input.worker.ready ? "ready" : "setup-required";
}
export function supportRuntimeLabels(input) {
    const env = input.env ?? process.env;
    const version = safeLabel(env.REALBUD_APP_VERSION) ?? REALBUD_VERSION;
    const buildId = safeLabel(env.REALBUD_BUILD_ID);
    const distribution = env.REALBUD_PACKAGED === "1" ? "packaged" : "source";
    const nodeMajor = Number.parseInt((input.nodeVersion ?? process.versions.node).split(".")[0] ?? "0", 10);
    return {
        app: {
            version,
            buildId,
            distribution,
            platform: platformLabel(input.platform ?? process.platform),
            architecture: architectureLabel(input.architecture ?? process.arch),
            nodeMajor: Number.isSafeInteger(nodeMajor) && nodeMajor >= 0 ? nodeMajor : 0,
            productMode: input.productMode,
            productionMode: env.REALBUD_PRODUCTION === "1",
        },
        evidence: {
            source: "not-recorded",
            installed: "requires-installed-proof",
            namedOffice: input.pilotContractComplete ? "contract-complete-unproved" : "pilot-gated",
        },
    };
}
export function createSupportReport(input) {
    const generatedAt = new Date(input.now ?? Date.now()).toISOString();
    const labels = supportRuntimeLabels(input);
    const recentRuns = Object.fromEntries(LOOP_RUN_STATUSES.map((status) => [status, 0]));
    for (const run of input.loopRuns.slice(0, 100))
        recentRuns[run.status] += 1;
    const worker = input.worker;
    return {
        kind: "realbud.support-report.v1",
        schemaVersion: 1,
        generatedAt,
        app: labels.app,
        evidence: labels.evidence,
        desk: {
            mode: input.desk.mode,
            revision: input.desk.revision,
            recoveryActive: input.desk.recovery.active,
            properties: input.desk.properties.length,
            sources: input.desk.sources.length,
            openWork: input.desk.workItems.filter((item) => !SETTLED_WORK_STATES.has(item.state)).length,
            pendingDrafts: input.desk.drafts.filter((draft) => draft.status === "pending").length,
            openImportIssues: input.desk.book?.importIssues.filter((issue) => issue.status === "open").length ?? 0,
        },
        worker: {
            state: workerState(input),
            pinVersion: safeLabel(worker?.pin.product) ?? "unknown",
            privateRuntimeInstalled: Boolean(worker?.cli.installed),
            pinMatches: Boolean(worker?.cli.matchesPin),
            packInstalled: Boolean(worker?.pack.installed),
            approvalsManual: Boolean(worker?.pack.approvalsManual),
            modelAttached: Boolean(worker?.model.provider && worker.model.model && worker.model.keyPresent),
        },
        schedules: {
            state: input.routineRecoveryActive ? "recovery" : "ready",
            available: input.loops.filter((loop) => loop.available).length,
            enabled: input.loops.filter((loop) => loop.available && loop.enabled).length,
            recentRuns,
        },
        connections: input.connections.map((connection) => ({
            id: connection.id,
            state: connection.state,
            methods: connection.methods.map((method) => ({ id: method.id, state: method.state })),
        })),
        execution: input.execution.map((adapter) => ({
            id: safeLabel(adapter.id) ?? "invalid-adapter-id",
            state: adapter.state,
            route: adapter.route,
            maxConcurrency: adapter.maxConcurrency,
        })),
        mobile: {
            state: mobileState(input.mobile?.state),
            connectedCount: Number.isSafeInteger(input.mobile?.connectedCount) && Number(input.mobile?.connectedCount) >= 0
                ? Number(input.mobile?.connectedCount)
                : 0,
        },
        recovery: {
            active: input.localRecovery.active,
            issues: input.localRecovery.issues.slice(0, 12).map((issue) => ({
                area: safeLabel(issue.area.replace(/\s+/g, "-")) ?? "local-state",
                action: safeLabel(issue.action) ?? "attention",
            })),
        },
    };
}
