export const LEGAL_TRANSITIONS = {
    proposed: ["approved", "denied", "held", "stale", "superseded"],
    approved: ["preparing", "denied", "stale", "superseded"],
    denied: [],
    held: ["proposed", "stale", "superseded", "cancelled"],
    preparing: ["handoff-ready", "failed"],
    "handoff-ready": ["confirmed", "effect-unknown", "handoff-expired"],
    confirmed: [],
    failed: ["proposed", "cancelled"],
    stale: [],
    superseded: [],
    cancelled: [],
    "effect-unknown": ["confirmed", "cancelled"],
    "handoff-expired": ["proposed", "cancelled"],
};
export function canTransition(from, to) {
    return LEGAL_TRANSITIONS[from].includes(to);
}
export function assertTransition(from, to) {
    if (!canTransition(from, to)) {
        throw Object.assign(new Error(`illegal work transition ${from} → ${to}`), { status: 409 });
    }
}
export function draftStatusFor(state) {
    if (state === "denied")
        return "denied";
    if (state === "proposed" || state === "held")
        return "pending";
    return "allowed";
}
export function workStateFromV1Draft(status) {
    if (status === "pending")
        return "proposed";
    if (status === "denied")
        return "denied";
    return "approved";
}
export function occurrenceKey(propertyId, kind, periodDueAt) {
    return `${propertyId}:${kind}:${periodDueAt}`;
}
export function proposalHash(input) {
    const payload = [
        input.propertyId,
        input.kind,
        String(input.periodDueAt),
        input.body,
        input.to,
        input.channel,
    ].join("\n");
    let h = 2166136261;
    for (let i = 0; i < payload.length; i++) {
        h ^= payload.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return `ph-${(h >>> 0).toString(16)}`;
}
