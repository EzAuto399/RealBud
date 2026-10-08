/** Import the billing owner's EXISTING website invite acceptance. This does not
 * accept monthly care terms or let an operator invent a price. Only the exact
 * published invitation terms are recognised, and the entitlement must already
 * name the same acceptance. The authenticated website supplies the stored row,
 * never receipt fields supplied by the browser. */
import { exact, object, requireThat } from './contracts.ts';
import { digest, type UsageLedger } from './ledger.ts';
import { latestResaleAcceptance, type ResaleAcceptance } from './commercial-terms.ts';

export const INVITE_TERMS_REFERENCE = 'realbud-office-terms-2026-09-26-ai-resale-30pct';
export const INVITE_TERMS_DIGEST = '6d59a45d7941359e50d3941f65e2b7b2b962f9099e53c5c306e4d1f3094f0ca8';
export interface InviteAiAcceptance {
  companyId: string; inviteId: string; acceptanceId: string; acceptedAt: number;
  email: string; termsReference: string; termsDigest: string;
}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function validateInviteAiAcceptance(ledger: UsageLedger, companyId: string, value: unknown): InviteAiAcceptance {
  object(value);
  exact(value, ['companyId', 'inviteId', 'acceptanceId', 'acceptedAt', 'email', 'termsReference', 'termsDigest']);
  requireThat(value.companyId === companyId && /^office-[a-z2-7]{10}$/.test(companyId), 'invite_acceptance_mismatch', 409);
  requireThat(typeof value.inviteId === 'string' && UUID.test(value.inviteId) && typeof value.acceptanceId === 'string' && UUID.test(value.acceptanceId), 'invite_acceptance_invalid', 409);
  requireThat(value.termsReference === INVITE_TERMS_REFERENCE && value.termsDigest === INVITE_TERMS_DIGEST, 'invite_terms_unrecognised', 409);
  requireThat(typeof value.email === 'string' && value.email === value.email.trim().toLowerCase() && value.email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email), 'invite_acceptance_invalid', 409);
  requireThat(Number.isSafeInteger(value.acceptedAt) && (value.acceptedAt as number) > 0 && (value.acceptedAt as number) <= ledger.now(), 'invite_acceptance_invalid', 409);
  const tenant = ledger.tenant(companyId);
  requireThat(tenant.goLiveEvidence === `terms-accepted-${value.acceptanceId}` && new Date(value.acceptedAt as number).toISOString().slice(0, 10) === new Date(tenant.goLiveAt).toISOString().slice(0, 10), 'invite_acceptance_mismatch', 409);
  const previous = ledger.db.get<{ body: string }>('SELECT body FROM events WHERE tenant=? AND kind=? ORDER BY seq DESC LIMIT 1', companyId, 'office_invite_ai_acceptance_imported');
  if (previous) requireThat(JSON.parse(previous.body).receiptDigest === digest(value), 'invite_acceptance_mismatch', 409);
  return value as unknown as InviteAiAcceptance;
}

/** Idempotent and append-only. An old invitation must never replace the price
 * from a later monthly acceptance. No monthly commercial acceptance is created. */
export function recordInviteAiAcceptance(ledger: UsageLedger, receipt: InviteAiAcceptance, subject: string): void {
  ledger.db.transaction(() => {
    const previous = ledger.db.get<{ body: string }>('SELECT body FROM events WHERE tenant=? AND kind=? ORDER BY seq DESC LIMIT 1', receipt.companyId, 'office_invite_ai_acceptance_imported');
    if (previous) {
      requireThat(JSON.parse(previous.body).receiptDigest === digest(receipt), 'invite_acceptance_mismatch', 409);
      return;
    }
    const existing = latestResaleAcceptance(ledger, receipt.companyId);
    ledger.db.append(receipt.companyId, 'office_invite_ai_acceptance_imported', null, ledger.now(), { subject, receipt, receiptDigest: digest(receipt), keptExistingAcceptance: !!existing });
    if (existing) return;
    const acceptance: ResaleAcceptance = {
      period: new Date(receipt.acceptedAt).toISOString().slice(0, 7), version: `invite-${receipt.inviteId}`,
      markupBasisPoints: 3000, termsReference: receipt.termsReference,
      acceptanceReference: `${receipt.termsReference}@${digest(receipt).slice(0, 32)}`,
    };
    ledger.db.append(receipt.companyId, 'ai_resale_terms_accepted', null, ledger.now(), acceptance);
  });
}
