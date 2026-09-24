import { createHash } from "node:crypto";
import { readExecutionAdapterBinding, } from "./execution-adapters.js";
const MAX_PLAN_MS = 30 * 60_000;
const MAX_INPUT_DIGESTS = 10_000;
const MAX_ALLOWED_ORIGINS = 8;
const MAX_ROUTES = 3;
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
export const WORK_DATA_CLASSES = [
    "portfolio-records",
    "selected-files",
    "bank-credit-metadata",
    "mail-content",
    "calendar-metadata",
    "portal-form-fields",
];
function codedError(message, code = "invalid-work-plan", status = 400) {
    return Object.assign(new Error(message), { code, status });
}
export function workPlanDigest(value) {
    return createHash("sha256").update(value).digest("hex");
}
function boundedId(name, value, maximum = 200) {
    if (typeof value !== "string" || !SAFE_ID.test(value) || value.length > maximum) {
        throw codedError(`${name} is invalid`);
    }
    return value;
}
function boundedInteger(name, value, maximum = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
        throw codedError(`${name} must be a bounded non-negative integer`);
    }
    return Number(value);
}
function finiteTime(name, value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        throw codedError(`${name} must be a finite timestamp`);
    }
    return value;
}
function digest(name, value) {
    if (typeof value !== "string" || !SHA256.test(value))
        throw codedError(`${name} must be a SHA-256 digest`);
    return value;
}
function normalizeDigests(raw) {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_INPUT_DIGESTS) {
        throw codedError("input digests are invalid");
    }
    const values = raw.map((value) => digest("input digest", value));
    if (new Set(values).size !== values.length)
        throw codedError("input digests must be unique", "duplicate-work-input");
    return values;
}
function normalizeDataClasses(raw) {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > WORK_DATA_CLASSES.length) {
        throw codedError("work data classes are invalid");
    }
    const values = raw.map((value) => {
        if (typeof value !== "string" || !WORK_DATA_CLASSES.includes(value)) {
            throw codedError("work data class is unsupported");
        }
        return value;
    });
    if (new Set(values).size !== values.length)
        throw codedError("work data classes must be unique");
    return [...values].sort();
}
function normalizeOrigins(raw) {
    if (raw === undefined)
        return [];
    if (!Array.isArray(raw) || raw.length > MAX_ALLOWED_ORIGINS)
        throw codedError("allowed origins are invalid");
    const values = raw.map((value) => {
        if (typeof value !== "string" || value.length > 300)
            throw codedError("allowed origin is invalid");
        let parsed;
        try {
            parsed = new URL(value);
        }
        catch {
            throw codedError("allowed origin is invalid");
        }
        const localHttp = parsed.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
        if (parsed.username || parsed.password || (parsed.protocol !== "https:" && !localHttp)
            || parsed.pathname !== "/" || parsed.search || parsed.hash)
            throw codedError("allowed origin must be an exact HTTPS or local test origin");
        return parsed.origin;
    });
    return [...new Set(values)].sort();
}
function normalizeRecipe(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw codedError("work recipe is invalid");
    const value = raw;
    const version = boundedInteger("recipe version", value.version, 1_000_000);
    if (version < 1)
        throw codedError("recipe version must be positive");
    return { id: boundedId("recipe id", value.id, 120), version };
}
function normalizeAuthority(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw codedError("work authority is invalid");
    const value = raw;
    if (value.kind === "user-request") {
        if (Object.keys(value).sort().join(",") !== "kind,requestDigest,requestId")
            throw codedError("user request authority is invalid");
        return {
            kind: "user-request",
            requestId: boundedId("authority request id", value.requestId),
            requestDigest: digest("authority request digest", value.requestDigest),
        };
    }
    if (value.kind === "scheduled-routine") {
        if (Object.keys(value).sort().join(",") !== "kind,loopId,loopRevision,occurrenceDigest")
            throw codedError("routine authority is invalid");
        return {
            kind: "scheduled-routine",
            loopId: boundedId("authority loop id", value.loopId, 120),
            loopRevision: boundedInteger("authority loop revision", value.loopRevision),
            occurrenceDigest: digest("authority occurrence digest", value.occurrenceDigest),
        };
    }
    if (value.kind === "allow-decision") {
        if (Object.keys(value).sort().join(",") !== "actionDigest,actionId,actionRevision,kind")
            throw codedError("Allow authority is invalid");
        return {
            kind: "allow-decision",
            actionId: boundedId("authority action id", value.actionId),
            actionRevision: boundedInteger("authority action revision", value.actionRevision),
            actionDigest: digest("authority action digest", value.actionDigest),
        };
    }
    throw codedError("work authority kind is unsupported");
}
const ROUTES = new Set([
    "structured-batch", "local-analysis", "remote-analysis", "scripted-browser",
    "isolated-browser", "remote-browser", "desktop-cua",
]);
function routeFamily(route) {
    if (route === "structured-batch")
        return "structured";
    if (route === "local-analysis" || route === "remote-analysis")
        return "analysis";
    if (route === "desktop-cua")
        return "desktop";
    return "browser";
}
function isRemote(route) {
    return route === "remote-analysis" || route === "remote-browser";
}
function normalizeRoutes(raw, createdAt, expiresAt) {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_ROUTES)
        throw codedError("work route chain is invalid");
    const routes = raw.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item))
            throw codedError("work route is invalid");
        const value = item;
        const keys = Object.keys(value).sort().join(",");
        if (keys !== "route" && keys !== "adapter,route")
            throw codedError("work route has unknown or missing fields");
        if (typeof value.route !== "string" || !ROUTES.has(value.route))
            throw codedError("work route is unsupported");
        const route = value.route;
        if (value.adapter === undefined) {
            if (route !== "structured-batch")
                throw codedError("executable route has no adapter attestation", "adapter-binding-required", 409);
            return { route };
        }
        const adapter = readExecutionAdapterBinding(value.adapter);
        if (adapter.route !== route)
            throw codedError("adapter binding does not match its route", "adapter-binding-mismatch", 409);
        if (adapter.observedAt > createdAt + 5_000)
            throw codedError("adapter binding was observed after the work plan", "adapter-binding-stale", 409);
        if (adapter.expiresAt < expiresAt)
            throw codedError("adapter binding expires before the work plan", "adapter-binding-stale", 409);
        return { route, adapter };
    });
    if (new Set(routes.map((route) => route.route)).size !== routes.length)
        throw codedError("work route chain contains duplicates");
    const family = routeFamily(routes[0].route);
    if (routes.some((route) => routeFamily(route.route) !== family))
        throw codedError("work fallbacks must preserve the workload family");
    if (!isRemote(routes[0].route) && routes.slice(1).some((route) => isRemote(route.route))) {
        throw codedError("a local plan cannot silently escalate to cloud", "cloud-escalation-not-authorized", 409);
    }
    return routes;
}
function planBase(plan) {
    return plan;
}
export function buildWorkPlan(raw) {
    const createdAt = finiteTime("createdAt", raw.createdAt ?? Date.now());
    const expiresAt = finiteTime("expiresAt", raw.expiresAt);
    if (expiresAt <= createdAt || expiresAt > createdAt + MAX_PLAN_MS)
        throw codedError("work plan lifetime is invalid");
    const requestId = boundedId("request id", raw.requestId);
    const authority = normalizeAuthority(raw.authority);
    const authorityDigest = workPlanDigest(JSON.stringify(authority));
    const dataClasses = normalizeDataClasses(raw.dataClasses);
    const routes = normalizeRoutes(raw.routes, createdAt, expiresAt);
    const allowedOrigins = normalizeOrigins(raw.allowedOrigins);
    const effectClass = raw.effectClass ?? "read-only";
    if (effectClass !== "read-only" && effectClass !== "possible-external")
        throw codedError("work effect class is invalid");
    if (typeof raw.concurrencyKey !== "string" || !raw.concurrencyKey.trim() || raw.concurrencyKey.length > 512) {
        throw codedError("work concurrency key is invalid");
    }
    const primary = routes[0];
    const usesBrowser = routeFamily(primary.route) === "browser" || primary.route === "desktop-cua";
    if (usesBrowser !== (allowedOrigins.length > 0)) {
        throw codedError(usesBrowser ? "browser work needs an exact allowed origin" : "non-browser work cannot carry an allowed origin");
    }
    if (effectClass === "possible-external" && authority.kind !== "allow-decision") {
        throw codedError("possible external work requires one exact Allow", "allow-required", 409);
    }
    if (routes.some((route) => isRemote(route.route)) && authority.kind !== "allow-decision") {
        throw codedError("cloud work requires one exact Allow", "cloud-approval-required", 409);
    }
    if (authority.kind === "scheduled-routine" && (effectClass !== "read-only" || allowedOrigins.length > 0
        || routes.some((route) => route.route !== "structured-batch" && route.route !== "local-analysis")))
        throw codedError("scheduled authority is limited to local read and draft preparation", "routine-route-forbidden", 409);
    if (authority.kind === "user-request" && (effectClass !== "read-only" || routes.some((route) => isRemote(route.route)))) {
        throw codedError("a user request alone cannot authorize cloud or possible external work", "allow-required", 409);
    }
    if (effectClass === "read-only" && routes.some((route) => route.adapter?.effect === "prepare-only")) {
        throw codedError("prepare-only adapter cannot enter a read-only plan", "adapter-effect-mismatch", 409);
    }
    if (effectClass === "possible-external" && routes.some((route) => route.adapter?.effect !== "prepare-only")) {
        throw codedError("possible external work needs a prepare-only adapter", "adapter-effect-mismatch", 409);
    }
    if (dataClasses.includes("portal-form-fields") && effectClass !== "possible-external") {
        throw codedError("portal form fields require an exact prepare-only Allow", "allow-required", 409);
    }
    if (dataClasses.includes("bank-credit-metadata")
        && routeFamily(primary.route) !== "browser"
        && primary.route !== "desktop-cua") {
        throw codedError("bank credit metadata requires a browser-family or bounded desktop route");
    }
    if (dataClasses.includes("selected-files") && routeFamily(primary.route) !== "analysis") {
        throw codedError("selected files require an analysis route");
    }
    const id = `plan-${workPlanDigest(requestId).slice(0, 32)}`;
    const base = planBase({
        kind: "realbud.work-plan.v1",
        schemaVersion: 1,
        id,
        requestId,
        createdAt,
        expiresAt,
        bookRevision: boundedInteger("book revision", raw.bookRevision),
        caseRevision: raw.caseRevision == null ? null : boundedInteger("case revision", raw.caseRevision),
        inputDigests: normalizeDigests(raw.inputDigests),
        dataClasses,
        routes,
        concurrencyKeyDigest: workPlanDigest(raw.concurrencyKey),
        allowedOrigins,
        recipe: normalizeRecipe(raw.recipe),
        effectClass,
        authority,
        authorityDigest,
    });
    return { ...base, planDigest: workPlanDigest(JSON.stringify(base)) };
}
/** Validate a persisted/in-process plan by reconstructing the canonical
 * object and comparing its integrity digests. */
export function readWorkPlan(raw, now = Date.now()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw codedError("work plan is invalid");
    const value = raw;
    const expected = [
        "kind", "schemaVersion", "id", "requestId", "createdAt", "expiresAt", "bookRevision", "caseRevision",
        "inputDigests", "dataClasses", "routes", "concurrencyKeyDigest", "allowedOrigins", "recipe", "effectClass",
        "authority", "authorityDigest", "planDigest",
    ].sort();
    const keys = Object.keys(value).sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
        throw codedError("work plan has unknown or missing fields");
    }
    if (value.kind !== "realbud.work-plan.v1" || value.schemaVersion !== 1)
        throw codedError("work plan version is unsupported");
    const createdAt = finiteTime("createdAt", value.createdAt);
    const expiresAt = finiteTime("expiresAt", value.expiresAt);
    if (createdAt > now + 5_000)
        throw codedError("work plan creation time is in the future");
    if (expiresAt <= now)
        throw codedError("work plan expired", "work-expired", 409);
    const rebuilt = buildWorkPlan({
        requestId: boundedId("request id", value.requestId),
        createdAt,
        expiresAt,
        bookRevision: boundedInteger("book revision", value.bookRevision),
        caseRevision: value.caseRevision == null ? null : boundedInteger("case revision", value.caseRevision),
        inputDigests: normalizeDigests(value.inputDigests),
        dataClasses: normalizeDataClasses(value.dataClasses),
        routes: normalizeRoutes(value.routes, createdAt, expiresAt),
        concurrencyKey: "validation-placeholder",
        allowedOrigins: normalizeOrigins(value.allowedOrigins),
        recipe: normalizeRecipe(value.recipe),
        effectClass: value.effectClass,
        authority: normalizeAuthority(value.authority),
    });
    const concurrencyKeyDigest = digest("concurrency key digest", value.concurrencyKeyDigest);
    const authorityDigest = digest("authority digest", value.authorityDigest);
    const base = {
        ...rebuilt,
        id: boundedId("plan id", value.id),
        concurrencyKeyDigest,
        authorityDigest,
    };
    delete base.planDigest;
    if (base.id !== `plan-${workPlanDigest(base.requestId).slice(0, 32)}`)
        throw codedError("work plan id is invalid");
    if (base.authorityDigest !== workPlanDigest(JSON.stringify(base.authority)))
        throw codedError("work authority integrity check failed");
    const planDigest = digest("plan digest", value.planDigest);
    if (workPlanDigest(JSON.stringify(base)) !== planDigest)
        throw codedError("work plan integrity check failed");
    return { ...base, planDigest };
}
export function workPlanReceiptBinding(plan) {
    return {
        kind: "realbud.work-plan-binding.v1",
        schemaVersion: 1,
        id: plan.id,
        planDigest: plan.planDigest,
        authorityKind: plan.authority.kind,
        authorityDigest: plan.authorityDigest,
        dataClasses: [...plan.dataClasses],
        routes: plan.routes.map(({ route, adapter }) => ({
            route,
            ...(adapter ? { adapter: structuredClone(adapter) } : {}),
        })),
    };
}
export function readWorkPlanReceiptBinding(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw codedError("work plan receipt binding is invalid");
    const value = raw;
    const expected = ["kind", "schemaVersion", "id", "planDigest", "authorityKind", "authorityDigest", "dataClasses", "routes"].sort();
    const keys = Object.keys(value).sort();
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index]))
        throw codedError("work plan receipt binding is malformed");
    if (value.kind !== "realbud.work-plan-binding.v1" || value.schemaVersion !== 1)
        throw codedError("work plan receipt binding version is unsupported");
    if (!["user-request", "scheduled-routine", "allow-decision"].includes(String(value.authorityKind)))
        throw codedError("work plan authority kind is invalid");
    const dataClasses = normalizeDataClasses(value.dataClasses);
    if (!Array.isArray(value.routes) || value.routes.length < 1 || value.routes.length > MAX_ROUTES)
        throw codedError("work plan receipt routes are invalid");
    const routes = value.routes.map((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item))
            throw codedError("work plan receipt route is invalid");
        const route = item;
        const keys = Object.keys(route).sort().join(",");
        if (keys !== "route" && keys !== "adapter,route")
            throw codedError("work plan receipt route has unknown fields");
        if (typeof route.route !== "string" || !ROUTES.has(route.route))
            throw codedError("work plan receipt route is invalid");
        const adapter = route.adapter === undefined ? undefined : readExecutionAdapterBinding(route.adapter);
        if (adapter && adapter.route !== route.route)
            throw codedError("work plan receipt adapter route is invalid");
        if (!adapter && route.route !== "structured-batch")
            throw codedError("work plan receipt adapter binding is missing");
        return {
            route: route.route,
            ...(adapter ? { adapter } : {}),
        };
    });
    if (new Set(routes.map((route) => route.route)).size !== routes.length)
        throw codedError("work plan receipt routes contain duplicates");
    const family = routeFamily(routes[0].route);
    if (routes.some((route) => routeFamily(route.route) !== family))
        throw codedError("work plan receipt fallback family is invalid");
    if (!isRemote(routes[0].route) && routes.slice(1).some((route) => isRemote(route.route))) {
        throw codedError("work plan receipt attempts a cloud escalation");
    }
    return {
        kind: "realbud.work-plan-binding.v1",
        schemaVersion: 1,
        id: boundedId("receipt plan id", value.id),
        planDigest: digest("receipt plan digest", value.planDigest),
        authorityKind: value.authorityKind,
        authorityDigest: digest("receipt authority digest", value.authorityDigest),
        dataClasses,
        routes,
    };
}
