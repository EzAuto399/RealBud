import { normalizeOrigin } from "./recipes.js";
import { isPortalRuleSurface } from "./rules.js";
/** Validate approval input at the server boundary. A client cannot invent a
 * provider behavior or turn a denial/answer into a wider permission scope. */
export function parseRequestDecision(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw Object.assign(new Error("request decision must be an object"), { status: 400 });
    }
    const body = value;
    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
    if (!requestId || requestId.length > 200) {
        throw Object.assign(new Error("requestId must be 1–200 characters"), { status: 400 });
    }
    if (body.behavior !== "allow" && body.behavior !== "deny" && body.behavior !== "answer") {
        throw Object.assign(new Error("behavior must be allow, deny, or answer"), { status: 400 });
    }
    if (body.scope !== undefined && body.scope !== "once" && body.scope !== "session") {
        throw Object.assign(new Error("scope must be once or session"), { status: 400 });
    }
    if (body.scope === "session" && body.behavior !== "allow") {
        throw Object.assign(new Error("session scope is only valid for allow decisions"), { status: 400 });
    }
    if (body.message !== undefined && (typeof body.message !== "string" || body.message.length > 4_000)) {
        throw Object.assign(new Error("message must be at most 4000 characters"), { status: 400 });
    }
    let rule;
    if (body.rule !== undefined) {
        if (!body.rule || typeof body.rule !== "object" || Array.isArray(body.rule)) {
            throw Object.assign(new Error("rule must name a portal surface and origin"), { status: 400 });
        }
        const row = body.rule;
        if (!isPortalRuleSurface(row.surface)) {
            throw Object.assign(new Error("rule surface must be portal-read or portal-prefill"), { status: 400 });
        }
        const origin = typeof row.origin === "string" ? normalizeOrigin(row.origin) : null;
        if (!origin) {
            throw Object.assign(new Error("Use a portal hostname like propertyme.com.au — no path or port."), {
                status: 400,
            });
        }
        rule = { surface: row.surface, origin };
    }
    return {
        requestId,
        decision: {
            behavior: body.behavior,
            ...(typeof body.message === "string" ? { message: body.message } : {}),
            ...(body.scope === "once" || body.scope === "session" ? { scope: body.scope } : {}),
        },
        ...(rule ? { rule } : {}),
    };
}
