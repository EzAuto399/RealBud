export const EVALUATOR_CATALOG = [
    { id: 'inbound-triage', version: 1, loopId: 'inbound-triage', mayLaunchCua: false },
    { id: "morning-money", version: 1, loopId: "morning-arrears", mayLaunchCua: false },
    { id: "owner-letter", version: 1, loopId: "owner-letter", mayLaunchCua: false },
];
export function evaluatorForLoop(loopId) {
    return EVALUATOR_CATALOG.find((row) => row.loopId === loopId) ?? null;
}
