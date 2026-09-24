import {
  isCompanyPortalTarget, isBeginCompanyPortalBinding, isAcceptCompanyPortalBinding, isRevokeCompanyPortalBinding,
  type CompanyPortalTarget, type CompanyPortalBinding, type CompanyPortalBindingPage,
  type BeginCompanyPortalBinding, type AcceptCompanyPortalBinding, type RevokeCompanyPortalBinding,
} from '../../shared/company-portal';
import { remoteExact, remoteIso } from '../../shared/website-remote-approvers';
import { commandUuid, commandLabel } from '../../shared/website-commands';

/** Public attended target only; never encode a person, credential or proof in this code. */
export function encodeCompanyPortalTarget(target: CompanyPortalTarget): string {
  if (!isCompanyPortalTarget(target)) throw new Error('This mapping target is incomplete. Refresh the company connection.');
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(target).sort(([a], [b]) => a.localeCompare(b))));
  return `rbcp1.${btoa(canonical).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}
export function decodeCompanyPortalTarget(code: string): CompanyPortalTarget {
  if (code.length > 4096 || !/^rbcp1\.[A-Za-z0-9_-]+$/.test(code)) throw new Error('Paste the complete mapping code from the company owner.');
  try {
    const value: unknown = JSON.parse(atob(code.slice(6).replace(/-/g, '+').replace(/_/g, '/')));
    if (!isCompanyPortalTarget(value) || encodeCompanyPortalTarget(value) !== code) throw new Error();
    return value;
  } catch { throw new Error('This mapping code is incomplete or invalid. Copy it again from the company owner.'); }
}
export type CompanyPortalOperation =
  | { action: 'begin'; body: BeginCompanyPortalBinding }
  | { action: 'accept' | 'confirm'; body: AcceptCompanyPortalBinding }
  | { action: 'revoke'; body: RevokeCompanyPortalBinding };
export function isCompanyPortalOperation(value: unknown): value is CompanyPortalOperation {
  return remoteExact(value, ['action', 'body']) && (
    value.action === 'begin' ? isBeginCompanyPortalBinding(value.body)
    : value.action === 'accept' || value.action === 'confirm' ? isAcceptCompanyPortalBinding(value.body)
    : value.action === 'revoke' && isRevokeCompanyPortalBinding(value.body));
}
const identityUuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v);
export function isCompanyPortalBinding(value: unknown): value is CompanyPortalBinding {
  if (!remoteExact(value, ['id','memberId','memberName','revision','phase','current','person','mapTarget','confirmTarget','createdAt','confirmedAt','revokedAt']) ||
      typeof value.id !== 'string' || !commandUuid.test(value.id) || !identityUuid(value.memberId) || !commandLabel(value.memberName,200) ||
      typeof value.revision !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(value.revision) || BigInt(value.revision) > BigInt('9223372036854775807') ||
      !['pending','candidate','confirmed','revoked'].some(p => p === value.phase) || typeof value.current !== 'boolean' ||
      !isCompanyPortalTarget(value.mapTarget) || !isCompanyPortalTarget(value.confirmTarget) || !remoteIso(value.createdAt) ||
      !(value.confirmedAt === null || remoteIso(value.confirmedAt)) || !(value.revokedAt === null || remoteIso(value.revokedAt))) return false;
  const a = value.mapTarget, b = value.confirmTarget;
  if (a.purpose !== 'member-map' || b.purpose !== 'member-confirm' || a.bindingId !== value.id || b.bindingId !== value.id ||
      a.memberId !== value.memberId || b.memberId !== value.memberId || a.companyId !== b.companyId || a.authorityId !== b.authorityId ||
      a.certificateDigest !== b.certificateDigest || a.challengeHash === b.challengeHash) return false;
  const p = value.person;
  if (p !== null && (!remoteExact(p, ['subject','identityEpoch','email','agencyLabel','companyId']) || !identityUuid(p.subject) ||
      !Number.isSafeInteger(p.identityEpoch) || Number(p.identityEpoch) < 1 || Number(p.identityEpoch) > 2147483647 ||
      !commandLabel(p.companyId,200) || typeof p.email !== 'string' || p.email.length > 254 || p.email !== p.email.trim().toLowerCase() ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email) || typeof p.agencyLabel !== 'string' || p.agencyLabel.length > 200 || /[\u0000-\u001f\u007f]/.test(p.agencyLabel))) return false;
  return (value.phase !== 'pending' || p === null) && (!['candidate','confirmed'].includes(String(value.phase)) || p !== null) &&
    (value.phase !== 'confirmed' || value.confirmedAt !== null) && (value.phase === 'revoked' ? value.revokedAt !== null && !value.current : value.revokedAt === null);
}
export function isCompanyPortalBindingPage(value: unknown, offset: number, limit: number): value is CompanyPortalBindingPage {
  return remoteExact(value, ['bindings','offset','hasMore','canManage']) && value.offset === offset && typeof value.hasMore === 'boolean' &&
    typeof value.canManage === 'boolean' && Array.isArray(value.bindings) && value.bindings.length <= limit && value.bindings.every(isCompanyPortalBinding) &&
    new Set(value.bindings.map(b => b.id)).size === value.bindings.length;
}
