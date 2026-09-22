/** Attended identity mapping only. None of these objects authorizes a worker or a case. */
import { remoteExact, remoteIso } from './website-remote-approvers.ts';
import { commandDigest, commandUuid, commandLabel } from './website-commands.ts';

export const COMPANY_PORTAL_ORIGIN = 'https://realbud.app';
export const COMPANY_PORTAL_CHALLENGE_MS = 10 * 60_000;
export const COMPANY_PORTAL_PROOF_MS = 60_000;
export type CompanyPortalPurpose = 'member-map' | 'member-confirm';
export type CompanyPortalTarget = {
  version: 1; purpose: CompanyPortalPurpose; companyId: string; authorityId: string;
  certificateDigest: string; bindingId: string; memberId: string; challengeHash: string; expiresAt: string;
};
/** Full identity binding is exchanged server to server; the member-facing view uses the projection below. */
export type CompanyPortalPerson = {
  subject: string; providerIssuer: string; providerSubject: string; accountId: string;
  companyId: string; identityEpoch: number; email: string; agencyLabel: string;
};
export type CompanyPortalIssue = { version: 1; requestId: string; proofHandle: string; target: CompanyPortalTarget };
export type CompanyPortalIssued = { version: 1; requestId: string; target: CompanyPortalTarget; expiresAt: string };
export type CompanyPortalRedeem = { version: 1; proofHandle: string; target: CompanyPortalTarget; redemptionId: string };
export type CompanyPortalProof = {
  version: 1; issuer: typeof COMPANY_PORTAL_ORIGIN; receiptId: string; requestId: string;
  redemptionId: string; target: CompanyPortalTarget; person: CompanyPortalPerson; issuedAt: string; expiresAt: string;
};
export type CompanyPortalBinding = {
  id: string; memberId: string; memberName: string; revision: string;
  phase: 'pending' | 'candidate' | 'confirmed' | 'revoked'; current: boolean;
  person: Pick<CompanyPortalPerson, 'subject' | 'identityEpoch' | 'email' | 'agencyLabel' | 'companyId'> | null;
  mapTarget: CompanyPortalTarget; confirmTarget: CompanyPortalTarget;
  createdAt: string; confirmedAt: string | null; revokedAt: string | null;
};
export type BeginCompanyPortalBinding = { version: 1; requestId: string; memberId: string };
export type AcceptCompanyPortalBinding = { version: 1; bindingId: string; requestId: string; expectedRevision: string; proofHandle: string };
export type RevokeCompanyPortalBinding = { version: 1; bindingId: string; requestId: string; expectedRevision: string; note: string };
export type CompanyPortalBindingPage = { bindings: CompanyPortalBinding[]; offset: number; hasMore: boolean; canManage: boolean };

const uuid = (v: unknown): v is string => typeof v === 'string' && commandUuid.test(v);
const identityUuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && commandDigest.test(v);
const revision = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9][0-9]{0,18})$/.test(v) && BigInt(v) <= BigInt('9223372036854775807');
export function isCompanyPortalTarget(v: unknown): v is CompanyPortalTarget {
  return remoteExact(v, ['version','purpose','companyId','authorityId','certificateDigest','bindingId','memberId','challengeHash','expiresAt']) &&
    v.version === 1 && (v.purpose === 'member-map' || v.purpose === 'member-confirm') && identityUuid(v.companyId) && uuid(v.authorityId) &&
    digest(v.certificateDigest) && uuid(v.bindingId) && identityUuid(v.memberId) && digest(v.challengeHash) && remoteIso(v.expiresAt);
}
export function isCompanyPortalPerson(v: unknown): v is CompanyPortalPerson {
  if (!remoteExact(v, ['subject','providerIssuer','providerSubject','accountId','companyId','identityEpoch','email','agencyLabel']) ||
      !identityUuid(v.subject) || !identityUuid(v.providerSubject) || !commandLabel(v.accountId,200) || !commandLabel(v.companyId,200) ||
      !Number.isSafeInteger(v.identityEpoch) || Number(v.identityEpoch) < 1 || Number(v.identityEpoch) > 2147483647 ||
      typeof v.email !== 'string' || v.email.length > 254 || v.email !== v.email.trim().toLowerCase() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email) ||
      typeof v.agencyLabel !== 'string' || v.agencyLabel.length > 200 || /[\u0000-\u001f\u007f]/.test(v.agencyLabel) || typeof v.providerIssuer !== 'string') return false;
  try { const url = new URL(v.providerIssuer); return url.protocol === 'https:' && url.origin === v.providerIssuer && !url.username && !url.password; }
  catch { return false; }
}
export function isCompanyPortalIssue(v: unknown): v is CompanyPortalIssue {
  return remoteExact(v, ['version','requestId','proofHandle','target']) && v.version === 1 && uuid(v.requestId) && digest(v.proofHandle) && isCompanyPortalTarget(v.target);
}
export function isCompanyPortalIssued(v: unknown): v is CompanyPortalIssued {
  return remoteExact(v, ['version','requestId','target','expiresAt']) && v.version === 1 && uuid(v.requestId) && isCompanyPortalTarget(v.target) && remoteIso(v.expiresAt) && v.expiresAt <= v.target.expiresAt;
}
export function isCompanyPortalRedeem(v: unknown): v is CompanyPortalRedeem {
  return remoteExact(v, ['version','proofHandle','target','redemptionId']) && v.version === 1 && digest(v.proofHandle) && uuid(v.redemptionId) && isCompanyPortalTarget(v.target);
}
export function isCompanyPortalProof(v: unknown): v is CompanyPortalProof {
  return remoteExact(v, ['version','issuer','receiptId','requestId','redemptionId','target','person','issuedAt','expiresAt']) && v.version === 1 && v.issuer === COMPANY_PORTAL_ORIGIN &&
    uuid(v.receiptId) && uuid(v.requestId) && uuid(v.redemptionId) && isCompanyPortalTarget(v.target) && isCompanyPortalPerson(v.person) &&
    remoteIso(v.issuedAt) && remoteIso(v.expiresAt) && v.expiresAt > v.issuedAt && v.expiresAt <= v.target.expiresAt && Date.parse(v.expiresAt) - Date.parse(v.issuedAt) <= COMPANY_PORTAL_PROOF_MS;
}
export function isBeginCompanyPortalBinding(v: unknown): v is BeginCompanyPortalBinding {
  return remoteExact(v, ['version','requestId','memberId']) && v.version === 1 && uuid(v.requestId) && identityUuid(v.memberId);
}
export function isAcceptCompanyPortalBinding(v: unknown): v is AcceptCompanyPortalBinding {
  return remoteExact(v, ['version','bindingId','requestId','expectedRevision','proofHandle']) && v.version === 1 && uuid(v.bindingId) && uuid(v.requestId) && revision(v.expectedRevision) && digest(v.proofHandle);
}
export function isRevokeCompanyPortalBinding(v: unknown): v is RevokeCompanyPortalBinding {
  return remoteExact(v, ['version','bindingId','requestId','expectedRevision','note']) && v.version === 1 && uuid(v.bindingId) && uuid(v.requestId) && revision(v.expectedRevision) && typeof v.note === 'string' && v.note.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(v.note);
}
