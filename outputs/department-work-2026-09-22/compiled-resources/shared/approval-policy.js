/** Host-classified native memory writes are never shell or standing grants. */
export const HERMES_MEMORY_APPROVAL = 'hermes_memory_write';
export function validMemoryApprovalReview(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        return false;
    const row = value;
    return Object.keys(row).length === 3 && row.complete === true &&
        (row.description === 'Save to memory: add to memory' || row.description === 'Save to memory: add to user profile') &&
        typeof row.content === 'string' && row.content.trim().length > 0 &&
        new TextEncoder().encode(row.content).byteLength <= 65_536;
}
export function reservedApprovalKey(key) {
    const normalized = key.trim().toLowerCase();
    return normalized === HERMES_MEMORY_APPROVAL || normalized.startsWith(`${HERMES_MEMORY_APPROVAL}:`);
}
export function requiresOnceApproval(value) {
    return value.approvalPolicy === 'once' || value.approvalPolicy === 'provider-once' || value.tool === HERMES_MEMORY_APPROVAL;
}
