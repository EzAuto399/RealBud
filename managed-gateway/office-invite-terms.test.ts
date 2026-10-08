import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './testing.ts';
import { twoMonthsAfter } from './money.ts';
import { OPERATOR_ROLE } from './operator-token.ts';
import { OfficeAiAccessService } from './office-ai-access.ts';
import { INVITE_TERMS_DIGEST, INVITE_TERMS_REFERENCE, validateInviteAiAcceptance } from './office-invite-terms.ts';
import { latestResaleAcceptance } from './commercial-terms.ts';
import type { ModelviaOperatorClient } from './modelvia-keys.ts';

const companyId = 'office-abcdefghij';
function setup() {
  const f = fixture();
  const receipt = { companyId, inviteId: '12345678-1234-1234-1234-123456789012', acceptanceId: '23456789-1234-1234-1234-123456789012',
    acceptedAt: f.now(), email: 'owner@example.test', termsReference: INVITE_TERMS_REFERENCE, termsDigest: INVITE_TERMS_DIGEST };
  f.ledger.provisionTenant({ ...f.tenant, companyId, licenseId: 'license-invite', goLiveAt: f.now(), includedUntil: twoMonthsAfter(f.now()), goLiveEvidence: `terms-accepted-${receipt.acceptanceId}` });
  let customers = 0; const synced: unknown[] = [];
  const modelvia = {
    async setCustomerAccess() { customers++; return { active: true, created: customers === 1, monthlyCapNanoAud: '200000000000' }; },
    async ensureCustomerTerms() { throw Error('Unexpected fallback'); },
    async customerTermsReadiness() { return 'ready'; },
    async syncResaleTerms(_id: string, terms: unknown) { synced.push(terms); return { state: 'active', created: synced.length === 1 }; },
  } as unknown as ModelviaOperatorClient;
  const service = new OfficeAiAccessService({ ledger: f.ledger, modelvia,
    terms: { clientFundedCompanies: new Set(), clientFundedReference: 'fixture-internal', resale: { clientMarkupBasisPoints: 3000, termsReference: INVITE_TERMS_REFERENCE } } });
  const body = { companyId, customerId: `realbud-${companyId}`, name: 'Fictional Office', access: { mode: 'default' }, onboardingAcceptance: receipt };
  return { f, receipt, body, service, synced, customers: () => customers, actor: { role: OPERATOR_ROLE, subject: 'operator:ops@example.test' } as const };
}

test('accepted invite activates resale and retry records exactly one acceptance without monthly care terms', async () => {
  const s = setup(); try {
    assert.equal((await s.service.set(s.actor, s.body)).terms?.state, 'active');
    assert.equal((await s.service.set(s.actor, s.body)).terms?.state, 'active');
    const events = s.f.db.all<{ kind: string }>('SELECT kind FROM events WHERE tenant=?', companyId);
    assert.equal(events.filter(e => e.kind === 'ai_resale_terms_accepted').length, 1);
    assert.equal(events.filter(e => e.kind === 'office_invite_ai_acceptance_imported').length, 1);
    assert.equal(events.filter(e => e.kind === 'commercial_terms_accepted').length, 0);
    assert.equal(latestResaleAcceptance(s.f.ledger, companyId)?.markupBasisPoints, 3000);
    assert.deepEqual(s.synced[0], s.synced[1]);
  } finally { s.f.close(); }
});

test('missing invite receipt still requires acceptance', async () => {
  const s = setup(); try {
    const { onboardingAcceptance: _, ...body } = s.body;
    assert.equal((await s.service.set(s.actor, body)).terms?.state, 'acceptance_required');
    assert.equal(s.synced.length, 0);
  } finally { s.f.close(); }
});

test('wrong office, unknown terms, altered digest, future date and unrelated entitlement refuse before Modelvia', async () => {
  const s = setup(); try {
    for (const patch of [{ companyId: 'office-klmnopqrst' }, { termsReference: 'unreviewed' }, { termsDigest: '0'.repeat(64) },
      { acceptedAt: s.f.now() + 1 }, { acceptanceId: '34567890-1234-1234-1234-123456789012' }, { email: 'bad' }, { markupBasisPoints: 0 }]) {
      await assert.rejects(s.service.set(s.actor, { ...s.body, onboardingAcceptance: { ...s.receipt, ...patch } }));
    }
    assert.equal(s.customers(), 0); assert.equal(s.synced.length, 0);
    assert.equal(latestResaleAcceptance(s.f.ledger, companyId), undefined);
  } finally { s.f.close(); }
});

test('old invite never replaces a newer negotiated markup', async () => {
  const s = setup(); try {
    const newer = { period: '2026-09', version: 'negotiated-v2', markupBasisPoints: 1500, termsReference: 'negotiated', acceptanceReference: 'accepted-newer' };
    s.f.db.append(companyId, 'ai_resale_terms_accepted', null, s.f.now(), newer);
    await s.service.set(s.actor, s.body);
    assert.deepEqual(latestResaleAcceptance(s.f.ledger, companyId), newer);
    assert.deepEqual(s.synced[0], { clientMarkupBasisPoints: 1500, acceptanceReference: 'accepted-newer' });
  } finally { s.f.close(); }
});

test('changed receipt cannot overwrite imported evidence', async () => {
  const s = setup(); try {
    await s.service.set(s.actor, s.body);
    await assert.rejects(s.service.set(s.actor, { ...s.body, onboardingAcceptance: { ...s.receipt, email: 'other@example.test' } }), /invite_acceptance_mismatch/);
    assert.equal(s.customers(), 1);
    assert.equal(s.synced.length, 1);
  } finally { s.f.close(); }
});

test('receipt validation rejects a matching acceptance on another day', () => {
  const s = setup(); try {
    assert.throws(() => validateInviteAiAcceptance(s.f.ledger, companyId, { ...s.receipt, acceptedAt: s.f.now() - 86_400_000 }), /invite_acceptance_mismatch/);
  } finally { s.f.close(); }
});
