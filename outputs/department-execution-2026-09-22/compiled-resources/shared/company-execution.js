/** Company authority for one assigned case. This is not website approval,
 * provider access, or a general company member session. Secrets are host-only. */
export const COMPANY_EXECUTION_PURPOSE = 'local-department-prepare-v1';
export const COMPANY_EXECUTION_GRANT_MS = 7 * 86_400_000;
export const COMPANY_EXECUTION_LEASE_MS = 300_000;
export const COMPANY_EXECUTION_DISPATCH_MS = 60_000;
const object = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const exact = (v, keys) => Object.keys(v).sort().join(',') === [...keys].sort().join(',');
export const companyExecutionUuid = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v);
const operationId = (v) => companyExecutionUuid(v) && v[14] === '4' && /^[89ab]$/.test(v[19]);
export const companyExecutionSecret = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const decimal = (v) => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= BigInt('9223372036854775807');
const text = (v, max, empty = false) => typeof v === 'string' && v.length <= max && (empty || !!v.trim()) && !v.includes('\0');
const duration = (v, max) => Number.isSafeInteger(v) && Number(v) >= 100 && Number(v) <= max;
const instant = (v) => typeof v === 'string' && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
function recipe(v) {
    return object(v) && exact(v, ['id', 'revision', 'digest', 'instructionDigest']) && text(v.id, 128) && Number.isSafeInteger(v.revision) && Number(v.revision) >= 1 && companyExecutionSecret(v.digest) && companyExecutionSecret(v.instructionDigest);
}
function executor(v) {
    return object(v) && exact(v, ['workspaceId', 'workerBinding']) && text(v.workspaceId, 128) && text(v.workerBinding, 256);
}
export function isCompanyExecutionSource(v) {
    return object(v) && exact(v, ['caseId', 'title', 'description']) && companyExecutionUuid(v.caseId) && text(v.title, 240) && text(v.description, 4000, true);
}
export function isCompanyExecutionSpec(v) {
    return object(v) && exact(v, ['version', 'purpose', 'companyId', 'memberId', 'authorityId', 'certificateDigest', 'departmentId', 'departmentRevision', 'caseId', 'caseFence', 'sourceDigest', 'recipe', 'executor']) &&
        v.version === 1 && v.purpose === COMPANY_EXECUTION_PURPOSE && [v.companyId, v.memberId, v.authorityId, v.departmentId, v.caseId].every(companyExecutionUuid) &&
        decimal(v.departmentRevision) && decimal(v.caseFence) && companyExecutionSecret(v.certificateDigest) && companyExecutionSecret(v.sourceDigest) && recipe(v.recipe) && executor(v.executor);
}
export function isBeginCompanyExecution(v) {
    return object(v) && exact(v, ['version', 'requestId', 'grantSecret', 'departmentId', 'expectedDepartmentRevision', 'caseId', 'expectedCaseFence', 'recipe', 'executor', 'durationMs']) && v.version === 1 && operationId(v.requestId) && companyExecutionSecret(v.grantSecret) && companyExecutionUuid(v.departmentId) && decimal(v.expectedDepartmentRevision) && companyExecutionUuid(v.caseId) && decimal(v.expectedCaseFence) && recipe(v.recipe) && executor(v.executor) && duration(v.durationMs, COMPANY_EXECUTION_GRANT_MS);
}
export function isConfirmCompanyExecution(v) {
    return object(v) && exact(v, ['version', 'requestId', 'grantId', 'expectedRevision', 'grantDigest']) && v.version === 1 && operationId(v.requestId) && operationId(v.grantId) && decimal(v.expectedRevision) && companyExecutionSecret(v.grantDigest);
}
export function isRevokeCompanyExecution(v) {
    return object(v) && exact(v, ['version', 'requestId', 'grantId', 'expectedRevision', 'note']) && v.version === 1 && operationId(v.requestId) && operationId(v.grantId) && decimal(v.expectedRevision) && text(v.note, 2048);
}
export function isAdmitCompanyExecution(v) {
    return object(v) && exact(v, ['version', 'grantId', 'requestId', 'executionId', 'claimSecret', 'ttlMs']) && v.version === 1 && operationId(v.grantId) && operationId(v.requestId) && operationId(v.executionId) && companyExecutionSecret(v.claimSecret) && duration(v.ttlMs, COMPANY_EXECUTION_LEASE_MS);
}
const checkFields = ['version', 'grantId', 'executionId', 'claimSecret', 'fence'];
function check(v) { return v.version === 1 && operationId(v.grantId) && operationId(v.executionId) && companyExecutionSecret(v.claimSecret) && decimal(v.fence); }
export function isCheckCompanyExecution(v) { return object(v) && exact(v, checkFields) && check(v); }
export function isRenewCompanyExecution(v) { return object(v) && exact(v, [...checkFields, 'requestId', 'ttlMs']) && check(v) && operationId(v.requestId) && duration(v.ttlMs, COMPANY_EXECUTION_LEASE_MS); }
export function isSettleCompanyExecution(v) { return object(v) && exact(v, [...checkFields, 'requestId', 'runId', 'outcome', 'note']) && check(v) && operationId(v.requestId) && text(v.runId, 128) && typeof v.outcome === 'string' && ['prepared', 'interrupted', 'failed'].includes(v.outcome) && text(v.note, 2048, true); }
export function isCompanyExecutionReceipt(v) {
    return object(v) && exact(v, ['version', 'grantId', 'receiptId', 'executionId', 'caseId', 'fence', 'leaseExpiresAt', 'dispatchBefore']) && v.version === 1 && [v.grantId, v.receiptId, v.executionId].every(operationId) && companyExecutionUuid(v.caseId) && decimal(v.fence) && instant(v.leaseExpiresAt) && instant(v.dispatchBefore) && Date.parse(v.dispatchBefore) <= Date.parse(v.leaseExpiresAt);
}
export function isCompanyExecutionCheck(v) { return object(v) && exact(v, ['receipt', 'source']) && isCompanyExecutionReceipt(v.receipt) && isCompanyExecutionSource(v.source) && v.receipt.caseId === v.source.caseId; }
export function isCompanyExecutionSettlement(v) { return object(v) && exact(v, ['receiptId', 'caseId', 'fence', 'status', 'outcome', 'runId']) && operationId(v.receiptId) && companyExecutionUuid(v.caseId) && decimal(v.fence) && v.status === 'recovery_required' && typeof v.outcome === 'string' && ['prepared', 'interrupted', 'failed'].includes(v.outcome) && text(v.runId, 128); }
export function isCompanyExecutionGrant(v) {
    return object(v) && exact(v, ['id', 'revision', 'phase', 'current', 'spec', 'digest', 'departmentName', 'memberName', 'source', 'createdAt', 'expiresAt', 'confirmedAt', 'revokedAt']) && operationId(v.id) && decimal(v.revision) && typeof v.phase === 'string' && ['pending', 'active', 'admitted', 'revoked'].includes(v.phase) && typeof v.current === 'boolean' && isCompanyExecutionSpec(v.spec) && companyExecutionSecret(v.digest) && text(v.departmentName, 120) && text(v.memberName, 120) && isCompanyExecutionSource(v.source) && v.source.caseId === v.spec.caseId && instant(v.createdAt) && instant(v.expiresAt) && (v.confirmedAt === null || instant(v.confirmedAt)) && (v.revokedAt === null || instant(v.revokedAt)) && Date.parse(v.expiresAt) > Date.parse(v.createdAt) && Date.parse(v.expiresAt) - Date.parse(v.createdAt) <= COMPANY_EXECUTION_GRANT_MS && (v.confirmedAt === null || Date.parse(v.confirmedAt) >= Date.parse(v.createdAt) && Date.parse(v.confirmedAt) < Date.parse(v.expiresAt)) && (v.revokedAt === null || Date.parse(v.revokedAt) >= Date.parse(v.createdAt)) && (v.phase === 'revoked' ? v.revokedAt !== null && !v.current : v.revokedAt === null) && (v.phase === 'pending' ? v.confirmedAt === null : v.phase === 'revoked' || v.confirmedAt !== null);
}
export function isCompanyExecutionGrantPage(v) { return object(v) && exact(v, ['grants', 'offset', 'hasMore', 'canManage']) && Array.isArray(v.grants) && v.grants.length <= 100 && v.grants.every(isCompanyExecutionGrant) && Number.isSafeInteger(v.offset) && Number(v.offset) >= 0 && Number(v.offset) <= 1000 && typeof v.hasMore === 'boolean' && typeof v.canManage === 'boolean'; }
