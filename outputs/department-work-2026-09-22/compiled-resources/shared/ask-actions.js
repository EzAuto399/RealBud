export const WORKER_ASK_ACTION_PROTOCOL = "realbud.propose-action.v1";
const WORK_ROUTING_PREFERENCES = new Set(["auto", "local-standard", "local-accelerated", "cloud-accelerated"]);
const WORK_ROUTING_MODES = new Set(["local-standard", "local-accelerated", "cloud-accelerated"]);
const WORK_ROUTE_KINDS = new Set([
    "structured-batch",
    "local-analysis",
    "remote-analysis",
    "scripted-browser",
    "isolated-browser",
    "remote-browser",
    "desktop-cua",
]);
const WORK_ROUTE_STATES = new Set(["ready", "gated"]);
const WORK_ROUTE_ISOLATIONS = new Set([
    "realbud-process",
    "realbud-workspace",
    "realbud-browser-profile",
    "remote-isolated",
    "visible-desktop",
]);
function boundedPlanInteger(value, maximum = 10_000) {
    return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
}
function boundedPlanText(value, maximum = 500) {
    return typeof value === "string" && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}
/** Ask messages are durable and may outlive the release that created them.
 * Validate the small, content-free route projection before either rendering
 * it or treating it as pre-execution truth. Unknown versions fail closed. */
export function readAskWorkRoutingPlan(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return null;
    const raw = value;
    if (raw.kind !== "realbud.work-routing.v1" || raw.schemaVersion !== 1 ||
        (raw.preferenceConfigured !== undefined && typeof raw.preferenceConfigured !== "boolean") ||
        (raw.preferenceRevision !== undefined && !boundedPlanInteger(raw.preferenceRevision, Number.MAX_SAFE_INTEGER)) ||
        typeof raw.requestedMode !== "string" || !WORK_ROUTING_PREFERENCES.has(raw.requestedMode) ||
        typeof raw.selectedMode !== "string" || !WORK_ROUTING_MODES.has(raw.selectedMode) ||
        !boundedPlanInteger(raw.propertyCount) || !Array.isArray(raw.lanes) || raw.lanes.length > 7 ||
        !Array.isArray(raw.fallbackReasons) || raw.fallbackReasons.length > 10 ||
        !raw.estimate || typeof raw.estimate !== "object" || Array.isArray(raw.estimate) ||
        !raw.boundaries || typeof raw.boundaries !== "object" || Array.isArray(raw.boundaries))
        return null;
    const lanes = raw.lanes;
    if (!lanes.every((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value))
            return false;
        const lane = value;
        return typeof lane.kind === "string" && WORK_ROUTE_KINDS.has(lane.kind)
            && typeof lane.state === "string" && WORK_ROUTE_STATES.has(lane.state)
            && boundedPlanInteger(lane.itemCount)
            && boundedPlanInteger(lane.batchCount)
            && boundedPlanInteger(lane.concurrency, 32)
            && typeof lane.isolation === "string" && WORK_ROUTE_ISOLATIONS.has(lane.isolation)
            && boundedPlanText(lane.detail);
    }))
        return null;
    if (!raw.fallbackReasons.every((reason) => boundedPlanText(reason)))
        return null;
    const estimate = raw.estimate;
    if (estimate.basis !== "measured" && estimate.basis !== "unavailable")
        return null;
    if (!boundedPlanText(estimate.detail))
        return null;
    if (estimate.basis === "measured") {
        if (typeof estimate.minimumSeconds !== "number" || !Number.isFinite(estimate.minimumSeconds) || estimate.minimumSeconds < 0 ||
            typeof estimate.maximumSeconds !== "number" || !Number.isFinite(estimate.maximumSeconds) || estimate.maximumSeconds < estimate.minimumSeconds)
            return null;
    }
    else if (estimate.minimumSeconds !== null || estimate.maximumSeconds !== null)
        return null;
    const boundaries = raw.boundaries;
    if (boundaries.cloudRequired !== false || boundaries.maxIsolatedBrowsers !== 2 || boundaries.maxDesktopCua !== 1 ||
        boundaries.workerOwnership !== "external-pinned-runtime" || boundaries.browserOwnership !== "realbud-only" ||
        boundaries.personalBrowserAccess !== false || boundaries.personalHermesAccess !== false)
        return null;
    return value;
}
/** Only a wholly ready, non-empty plan may be attached to an admitted task.
 * Gated route projections belong in readiness UI, not in executable cards. */
export function readAdmittedAskWorkRoutingPlan(value) {
    const plan = readAskWorkRoutingPlan(value);
    if (!plan)
        return null;
    const active = plan.lanes.filter((lane) => lane.itemCount > 0);
    return active.length > 0 && active.every((lane) => lane.state === "ready" && lane.concurrency > 0)
        ? plan
        : null;
}
/**
 * Keep the approval contract identical wherever a proposal is presented.
 * This is presentation only: the server-side action broker remains the
 * authority for freshness, scope, idempotency and execution.
 */
export function askActionApprovalCopy(action) {
    switch (action.kind) {
        case "run-routine":
            return {
                permission: `Run ${action.loopName} one time now.`,
                boundary: "Results return to Desk. No message, payment, notice or portal Submit.",
                completed: "The routine ran once and its results are available on Desk.",
            };
        case "change-routine":
            return {
                permission: "Apply only the schedule difference shown below.",
                boundary: "RealBud's clock only. No backfill, message or legal deadline is created.",
                completed: "RealBud's schedule now reflects the approved change.",
            };
        case "add-property":
            return {
                permission: `Add ${action.properties.length === 1 ? "this property" : `these ${action.properties.length} properties`} to the local book.`,
                boundary: "Local book data only. PMS balances remain unverified until a current structured export is matched.",
                completed: `${action.properties.length === 1 ? "The property was" : "The properties were"} added to the local book.`,
            };
        case "configure-property":
            return {
                permission: `Apply the shown shop options to ${action.address}.`,
                boundary: "Agency workflow settings only. This cannot create law, a statutory clock or an external action.",
                completed: "The approved shop options are now on the property.",
            };
        case "set-agency-name":
            return {
                permission: "Change the agency label shown inside RealBud.",
                boundary: "Display and local-book label only. No external account or service is changed.",
                completed: "The agency label was updated across RealBud.",
            };
        case "open-setup":
            return {
                permission: "Open the named setup owner in You.",
                boundary: "Navigation only. No credential is saved and no connection or permission is enabled.",
                completed: "RealBud opened the requested setup owner. Nothing connected automatically.",
            };
        case "prepare-handoff":
            return {
                permission: "Run one case-bound browser preparation using the already allowed wording.",
                boundary: "Bud may prefill only this case. You perform Submit; Bud cannot send, pay or leave the bounded portal route.",
                completed: "The approved handoff is ready for your final review and Submit in the PMS.",
            };
    }
}
