/** Remote enrollment is a separate protocol. It never authorizes a v1 claim. */
import { canonicalWebsiteCommand, commandUuid, commandDigest, commandLabel, isWebsiteCommandDescriptor } from "./website-commands.js";
export const REMOTE_APPROVER_PROTOCOL = 2;
export const REMOTE_CHALLENGE_MS = 10 * 60_000;
export const REMOTE_FRESH_AUTH_MS = 10 * 60_000;
export const REMOTE_APPROVER_MS = 30 * 86_400_000;
export const REMOTE_ENROLLMENT_LIMIT = 64;
export const REMOTE_DISCLOSURE_POLICY = 'exact-reviewed-template-v1';
const uuid = (v) => typeof v === 'string' && commandUuid.test(v);
const personUuid = (v) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const digest = (v) => typeof v === 'string' && commandDigest.test(v);
const positive = (v) => Number.isSafeInteger(v) && Number(v) > 0 && Number(v) <= 2147483647;
export const remoteExact = (v, keys) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
export const remoteIso = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export function isRemoteApproverScope(v) {
    return remoteExact(v, ['descriptorId', 'descriptorRevision', 'disclosureDigest']) && uuid(v.descriptorId) && digest(v.descriptorRevision) && digest(v.disclosureDigest);
}
const scopes = (v) => Array.isArray(v) && v.length > 0 && v.length <= 16 && v.every(isRemoteApproverScope) && new Set(v.map(x => x.descriptorId)).size === v.length;
const parentKeys = ['protocol', 'grantId', 'generation', 'installationId', 'workspaceId', 'workspaceLabel', 'workerBinding', 'descriptors'];
function parent(v) {
    return v.protocol === 2 && uuid(v.grantId) && positive(v.generation) && uuid(v.installationId) && uuid(v.workspaceId) && uuid(v.workerBinding) && commandLabel(v.workspaceLabel) && Array.isArray(v.descriptors) && v.descriptors.length > 0 && v.descriptors.length <= 16 && v.descriptors.every(isWebsiteCommandDescriptor) && new Set(v.descriptors.map(d => d.id)).size === v.descriptors.length;
}
export function isRemoteCommandEnrollment(v) {
    return remoteExact(v, [...parentKeys, 'commandToken']) && parent(v) && digest(v.commandToken);
}
export function isRemoteCommandGrant(v) {
    return remoteExact(v, [...parentKeys, 'companyId', 'enrolledAt', 'revokedAt']) && parent(v) && commandLabel(v.companyId, 200) && remoteIso(v.enrolledAt) && (v.revokedAt === null || remoteIso(v.revokedAt) && v.revokedAt >= v.enrolledAt);
}
export function isRemoteApproverPerson(v) {
    return remoteExact(v, ['subject', 'identityEpoch', 'email', 'agencyLabel', 'companyId']) && personUuid(v.subject) && Number.isSafeInteger(v.identityEpoch) && Number(v.identityEpoch) > 0 && typeof v.email === 'string' && v.email.length <= 254 && v.email === v.email.trim().toLowerCase() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) && typeof v.agencyLabel === 'string' && v.agencyLabel.length <= 200 && !/[\u0000-\u001f\u007f]/.test(v.agencyLabel) && commandLabel(v.companyId, 200);
}
export function isRemoteEnrollmentBegin(v) {
    return remoteExact(v, ['protocol', 'enrollmentId', 'grantId', 'generation', 'challengeHash', 'scopes', 'disclosurePolicy', 'expiresAt', 'approverExpiresAt']) && v.protocol === 2 && uuid(v.enrollmentId) && uuid(v.grantId) && positive(v.generation) && digest(v.challengeHash) && scopes(v.scopes) && v.disclosurePolicy === REMOTE_DISCLOSURE_POLICY && remoteIso(v.expiresAt) && remoteIso(v.approverExpiresAt) && v.approverExpiresAt > v.expiresAt && Date.parse(v.approverExpiresAt) - Date.parse(v.expiresAt) <= REMOTE_APPROVER_MS;
}
export function isRemoteEnrollmentAccept(v) {
    return remoteExact(v, ['protocol', 'enrollmentId', 'challengeSecret']) && v.protocol === 2 && uuid(v.enrollmentId) && digest(v.challengeSecret);
}
export function isRemoteEnrollmentTarget(v) {
    return remoteExact(v, ['protocol', 'enrollmentId', 'grantId', 'generation']) && v.protocol === 2 && uuid(v.enrollmentId) && uuid(v.grantId) && positive(v.generation);
}
export function isRemoteEnrollmentConfirm(v) {
    return remoteExact(v, ['protocol', 'enrollmentId', 'grantId', 'generation', 'candidate']) && isRemoteEnrollmentTarget({ protocol: v.protocol, enrollmentId: v.enrollmentId, grantId: v.grantId, generation: v.generation }) && isRemoteApproverPerson(v.candidate);
}
export function isRemoteApproverGrant(v) {
    return remoteExact(v, ['protocol', 'id', 'generation', 'parentGrantId', 'parentGeneration', 'installationId', 'workspaceId', 'workerBinding', 'companyId', 'person', 'scopes', 'disclosurePolicy', 'enrolledAt', 'expiresAt', 'revokedAt']) && v.protocol === 2 && v.generation === 1 && uuid(v.id) && uuid(v.parentGrantId) && positive(v.parentGeneration) && uuid(v.installationId) && uuid(v.workspaceId) && uuid(v.workerBinding) && commandLabel(v.companyId, 200) && isRemoteApproverPerson(v.person) && v.person.companyId === v.companyId && scopes(v.scopes) && v.disclosurePolicy === REMOTE_DISCLOSURE_POLICY && remoteIso(v.enrolledAt) && remoteIso(v.expiresAt) && v.expiresAt > v.enrolledAt && Date.parse(v.expiresAt) - Date.parse(v.enrolledAt) <= REMOTE_APPROVER_MS && (v.revokedAt === null || remoteIso(v.revokedAt) && v.revokedAt >= v.enrolledAt);
}
export function isRemoteEnrollmentSnapshot(v) {
    if (!remoteExact(v, ['protocol', 'begin', 'target', 'candidate', 'phase', 'approver', 'serverTime']) || v.protocol !== 2 || !isRemoteEnrollmentBegin(v.begin) || !(v.candidate === null || isRemoteApproverPerson(v.candidate)) || typeof v.phase !== 'string' || !['pending', 'candidate', 'confirmed', 'revoked', 'expired', 'stale'].includes(v.phase) || !(v.approver === null || isRemoteApproverGrant(v.approver)) || !remoteIso(v.serverTime))
        return false;
    const target = v.target;
    if (!remoteExact(target, ['workspaceLabel', 'descriptors']) || !commandLabel(target.workspaceLabel) || !Array.isArray(target.descriptors) || target.descriptors.length < 1 || target.descriptors.length > 16 || !target.descriptors.every(isWebsiteCommandDescriptor))
        return false;
    const descriptors = target.descriptors;
    if (new Set(descriptors.map(d => d.id)).size !== descriptors.length || v.begin.scopes.some(s => !descriptors.some(d => d.id === s.descriptorId && d.revision === s.descriptorRevision)))
        return false;
    if (v.phase === 'pending' && (v.candidate !== null || v.approver !== null) || v.phase === 'candidate' && (v.candidate === null || v.approver !== null) || v.phase === 'confirmed' && (v.candidate === null || v.approver === null))
        return false;
    if (v.phase === 'confirmed' && (v.approver.revokedAt !== null || v.approver.expiresAt <= v.serverTime))
        return false;
    if ((v.phase === 'pending' || v.phase === 'candidate') && v.begin.expiresAt <= v.serverTime)
        return false;
    if (v.approver && (v.candidate === null || canonicalWebsiteCommand(v.approver.person) !== canonicalWebsiteCommand(v.candidate) || v.approver.id !== v.begin.enrollmentId || v.approver.parentGrantId !== v.begin.grantId || v.approver.parentGeneration !== v.begin.generation || v.approver.expiresAt !== v.begin.approverExpiresAt || v.approver.disclosurePolicy !== v.begin.disclosurePolicy || canonicalWebsiteCommand(v.approver.scopes) !== canonicalWebsiteCommand(v.begin.scopes)))
        return false;
    return true;
}
/** Authenticated server clock for a new challenge, never renewal of an existing deadline. */
export function isRemoteClockResult(v) { return remoteExact(v, ['serverTime']) && remoteIso(v.serverTime); }
