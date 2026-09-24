import { acquirePortalLease, revokePortalLease } from "./cua-bounded.js";
import { recipeAllows } from "./portal-recipe.js";
import { computerLease } from "./computer-lease.js";
async function portalFetch(baseUrl, path, actor, init) {
    const res = await fetch(`${baseUrl}${path}`, {
        ...init,
        signal: AbortSignal.timeout(30_000),
        headers: {
            "content-type": "application/json",
            "x-realbud-actor": actor,
            ...(init?.headers ?? {}),
        },
    });
    const body = (await res.json().catch(() => ({})));
    return { status: res.status, body };
}
export function portalRead(baseUrl, actor = "bud") {
    return portalFetch(baseUrl, "/ledger", actor);
}
export function portalPrefill(baseUrl, body, actor = "bud") {
    return portalFetch(baseUrl, "/prefill", actor, { method: "POST", body: JSON.stringify({ body }) });
}
export function portalSubmit(baseUrl, actor) {
    return portalFetch(baseUrl, "/submit", actor, { method: "POST", body: "{}" });
}
export function portalRevoke(baseUrl) {
    return portalFetch(baseUrl, "/revoke", "human", { method: "POST", body: "{}" });
}
export async function runBoundedPrefill(opts) {
    if (opts.capability.usedAt || opts.capability.invalidatedAt) {
        return { ok: false, error: "portal capability missing or invalidated" };
    }
    if (opts.capability.expiresAt <= opts.now)
        return { ok: false, error: "portal capability expired" };
    if (!recipeAllows(opts.recipe, "prefill-courtesy"))
        return { ok: false, error: "recipe forbids prefill" };
    const lease = acquirePortalLease(opts.capability.workItemId, opts.now, opts.capability.revision);
    try {
        const read = await portalRead(opts.baseUrl, "bud");
        if (read.status !== 200)
            return { ok: false, error: "portal read failed" };
        computerLease.assertHeld(lease, Date.now());
        const prefill = await portalPrefill(opts.baseUrl, opts.body, "bud");
        if (prefill.status !== 200)
            return { ok: false, error: "portal prefill failed" };
        await portalRevoke(opts.baseUrl);
        const forbidden = await portalSubmit(opts.baseUrl, "bud");
        if (forbidden.status !== 403)
            return { ok: false, error: "Bud submit was not refused" };
        return { ok: true };
    }
    finally {
        revokePortalLease(lease);
    }
}
export async function verifyPortalResult(baseUrl) {
    const read = await portalRead(baseUrl, "human");
    if (read.status === 200 && typeof read.body.submitted === "string" && read.body.submitted) {
        return "confirmed";
    }
    return "effect-unknown";
}
