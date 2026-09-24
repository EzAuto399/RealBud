// Immutable handoff authorization. Presentation cannot widen it.
// URL checks compare exact URL.origin — never string prefixes.
import { CLOSED_HANDOFF_OPERATIONS, FORBIDDEN_HANDOFF_ACTIONS } from "../shared/desk-v3.js";
export function exactOrigin(url) {
    return new URL(url).origin;
}
export function originAllowed(candidate, allowed) {
    let origin;
    try {
        origin = exactOrigin(candidate);
    }
    catch {
        return false;
    }
    return allowed.includes(origin);
}
export function assertAllowedOrigin(candidate, allowed) {
    if (!originAllowed(candidate, allowed)) {
        throw Object.assign(new Error("origin is not on the authorization"), { status: 403 });
    }
}
export function assertRoutineCannotMint(source) {
    if (source === "routine") {
        throw Object.assign(new Error("a routine cannot mint or launch browser authorization"), { status: 403 });
    }
}
export function freezeAuthorization(auth) {
    if (!CLOSED_HANDOFF_OPERATIONS.includes(auth.operation)) {
        throw Object.assign(new Error("handoff operation is not closed"), { status: 403 });
    }
    if (auth.allowedActions.some((action) => FORBIDDEN_HANDOFF_ACTIONS.includes(action))) {
        throw Object.assign(new Error("Submit/Send/Pay stay forbidden"), { status: 403 });
    }
    return {
        ...auth,
        allowedOrigins: [...auth.allowedOrigins],
        allowedActions: [...auth.allowedActions],
    };
}
export function withPresentation(auth, _presentation) {
    return auth;
}
export function sameAuthorization(a, b) {
    return (a.operation === b.operation &&
        a.caseId === b.caseId &&
        a.proposalId === b.proposalId &&
        a.revisionId === b.revisionId &&
        a.proposalHash === b.proposalHash &&
        a.propertyId === b.propertyId &&
        a.tenancyId === b.tenancyId &&
        a.bindingId === b.bindingId &&
        a.recipeId === b.recipeId &&
        a.recipeVersion === b.recipeVersion &&
        a.expiresAt === b.expiresAt &&
        a.allowedOrigins.join("\0") === b.allowedOrigins.join("\0") &&
        a.allowedActions.join("\0") === b.allowedActions.join("\0"));
}
