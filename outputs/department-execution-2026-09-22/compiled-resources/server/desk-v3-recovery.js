export function idleRecovery() {
    return { active: false, reason: null, quarantined: [] };
}
export function failClosedRecovery(reason, quarantined = []) {
    return { active: true, reason, quarantined };
}
export function locksForRecovery(recovery) {
    if (!recovery.active)
        return { writes: true, schedules: true, browser: true };
    return { writes: false, schedules: false, browser: false };
}
export function assertOperational(recovery, kind) {
    if (!locksForRecovery(recovery)[kind]) {
        throw Object.assign(new Error(`${kind} are paused while Desk is in recovery`), { status: 409 });
    }
}
