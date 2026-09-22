/** Attended identity mapping only. None of these objects authorizes a worker or a case. */
import { remoteExact, remoteIso } from "./website-remote-approvers.js";
import { commandDigest, commandUuid, commandLabel } from "./website-commands.js";
export const COMPANY_PORTAL_ORIGIN = 'https://realbud.app';
export const COMPANY_PORTAL_CHALLENGE_MS = 10 * 60_000;
export const COMPANY_PORTAL_PROOF_MS = 60_000;
const uuid = (v) => typeof v === 'string' && commandUuid.test(v);
const identityUuid = (v) => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const digest = (v) => typeof v === 'string' && commandDigest.test(v);
const revision = (v) => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= BigInt('9223372036854775807');
export function isCompanyPortalTarget(v) {
    return remoteExact(v, ['version', 'purpose', 'companyId', 'authorityId', 'certificateDigest', 'bindingId', 'memberId', 'challengeHash', 'expiresAt']) &&
        v.version === 1 && (v.purpose === 'member-map' || v.purpose === 'member-confirm') && identityUuid(v.companyId) && uuid(v.authorityId) &&
        digest(v.certificateDigest) && uuid(v.bindingId) && identityUuid(v.memberId) && digest(v.challengeHash) && remoteIso(v.expiresAt);
}
export function isCompanyPortalPerson(v) {
    if (!remoteExact(v, ['subject', 'providerIssuer', 'providerSubject', 'accountId', 'companyId', 'identityEpoch', 'email', 'agencyLabel']) ||
        !identityUuid(v.subject) || !identityUuid(v.providerSubject) || !commandLabel(v.accountId, 200) || !commandLabel(v.companyId, 200) ||
        !Number.isSafeInteger(v.identityEpoch) || Number(v.identityEpoch) < 1 || Number(v.identityEpoch) > 2147483647 ||
        typeof v.email !== 'string' || v.email.length > 254 || v.email !== v.email.trim().toLowerCase() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) ||
        typeof v.agencyLabel !== 'string' || v.agencyLabel.length > 200 || /[\u0000-\u001f\u007f]/.test(v.agencyLabel) || typeof v.providerIssuer !== 'string')
        return false;
    try {
        const url = new URL(v.providerIssuer);
        return url.protocol === 'https:' && url.origin === v.providerIssuer && !url.username && !url.password;
    }
    catch {
        return false;
    }
}
export function isCompanyPortalIssue(v) {
    return remoteExact(v, ['version', 'requestId', 'proofHandle', 'target']) && v.version === 1 && uuid(v.requestId) && digest(v.proofHandle) && isCompanyPortalTarget(v.target);
}
export function isCompanyPortalIssued(v) {
    return remoteExact(v, ['version', 'requestId', 'target', 'expiresAt']) && v.version === 1 && uuid(v.requestId) && isCompanyPortalTarget(v.target) && remoteIso(v.expiresAt) && v.expiresAt <= v.target.expiresAt;
}
export function isCompanyPortalRedeem(v) {
    return remoteExact(v, ['version', 'proofHandle', 'target', 'redemptionId']) && v.version === 1 && digest(v.proofHandle) && uuid(v.redemptionId) && isCompanyPortalTarget(v.target);
}
export function isCompanyPortalProof(v) {
    return remoteExact(v, ['version', 'issuer', 'receiptId', 'requestId', 'redemptionId', 'target', 'person', 'issuedAt', 'expiresAt']) && v.version === 1 && v.issuer === COMPANY_PORTAL_ORIGIN &&
        uuid(v.receiptId) && uuid(v.requestId) && uuid(v.redemptionId) && isCompanyPortalTarget(v.target) && isCompanyPortalPerson(v.person) &&
        remoteIso(v.issuedAt) && remoteIso(v.expiresAt) && v.expiresAt > v.issuedAt && v.expiresAt <= v.target.expiresAt && Date.parse(v.expiresAt) - Date.parse(v.issuedAt) <= COMPANY_PORTAL_PROOF_MS;
}
export function isBeginCompanyPortalBinding(v) {
    return remoteExact(v, ['version', 'requestId', 'memberId']) && v.version === 1 && uuid(v.requestId) && identityUuid(v.memberId);
}
export function isAcceptCompanyPortalBinding(v) {
    return remoteExact(v, ['version', 'bindingId', 'requestId', 'expectedRevision', 'proofHandle']) && v.version === 1 && uuid(v.bindingId) && uuid(v.requestId) && revision(v.expectedRevision) && digest(v.proofHandle);
}
export function isRevokeCompanyPortalBinding(v) {
    return remoteExact(v, ['version', 'bindingId', 'requestId', 'expectedRevision', 'note']) && v.version === 1 && uuid(v.bindingId) && uuid(v.requestId) && revision(v.expectedRevision) && typeof v.note === 'string' && v.note.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(v.note);
}
