import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { COMPANY_PORTAL_ORIGIN, isCompanyPortalIssue, isCompanyPortalProof, type CompanyPortalProof, type CompanyPortalRedeem } from '../../shared/company-portal.ts';
import { assertVerifiedCompanyPortalProof, createCompanyPortalProofVerifier } from './portal-proof.ts';

const now = Date.parse('2026-09-22T06:00:00.000Z');
function fixture() {
  const input: CompanyPortalRedeem = { version: 1, proofHandle: randomBytes(32).toString('hex'), redemptionId: randomUUID(), target: {
    version: 1, purpose: 'member-map', companyId: randomUUID(), authorityId: randomUUID(), certificateDigest: 'a'.repeat(64),
    bindingId: randomUUID(), memberId: randomUUID(), challengeHash: 'b'.repeat(64), expiresAt: new Date(now + 600_000).toISOString(),
  } };
  const proof: CompanyPortalProof = { version: 1, issuer: COMPANY_PORTAL_ORIGIN, receiptId: randomUUID(), requestId: randomUUID(), redemptionId: input.redemptionId,
    target: structuredClone(input.target), issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), person: {
      subject: randomUUID(), providerIssuer: 'https://identity.example.test', providerSubject: randomUUID(), accountId: 'fictional-account', companyId: 'fictional-agency', identityEpoch: 1,
      email: 'member@example.test', agencyLabel: 'Fictional Agency',
    } };
  return { input, proof };
}
const json = (value: unknown) => Response.json(value);
const verifier = (reply: () => Response | Promise<Response>, clock = () => now) => createCompanyPortalProofVerifier({ fetch: vi.fn(reply) as typeof fetch, now: clock });

describe('company host independent portal identity verifier', () => {
  it('calls only the fixed HTTPS endpoint without member, provider, session or command credentials', async () => {
    const { input, proof } = fixture();
    const request = vi.fn(async () => json(proof));
    const value = await createCompanyPortalProofVerifier({ fetch: request, now: () => now })(input);
    expect(request).toHaveBeenCalledOnce();
    const [url, options] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://realbud.app/api/company-portal/redeem');
    expect(options).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer', headers: { 'content-type': 'application/json', accept: 'application/json' } });
    expect(JSON.parse(String(options.body))).toEqual(input);
    expect(assertVerifiedCompanyPortalProof(value, input, now)).toEqual(proof);
    expect(Object.isFrozen(value.person)).toBe(true); expect(Object.isFrozen(value.target)).toBe(true);
    expect(() => assertVerifiedCompanyPortalProof(proof, input, now)).toThrow('portal_proof_denied');
    expect(() => assertVerifiedCompanyPortalProof(structuredClone(value), input, now)).toThrow('portal_proof_denied');
    expect(() => assertVerifiedCompanyPortalProof(value, { ...input, proofHandle: 'f'.repeat(64) }, now)).toThrow('portal_proof_denied');
    expect(() => assertVerifiedCompanyPortalProof(value, input, now + 60_000)).toThrow('portal_proof_stale');
  });

  it.each(['companyId','authorityId','certificateDigest','bindingId','memberId','challengeHash','purpose','expiresAt'] as const)('rejects a receipt for another target %s', async key => {
    const { input, proof } = fixture();
    const values = { companyId: randomUUID(), authorityId: randomUUID(), certificateDigest: 'c'.repeat(64), bindingId: randomUUID(), memberId: randomUUID(), challengeHash: 'd'.repeat(64), purpose: 'member-confirm', expiresAt: new Date(now + 599_000).toISOString() };
    (proof.target as unknown as Record<string, unknown>)[key] = values[key];
    await expect(verifier(() => json(proof))(input)).rejects.toThrow('portal_proof_denied');
  });

  it('rejects self-asserted evidence, nonce substitution, excess fields and malformed identity', async () => {
    const { input, proof } = fixture();
    for (const value of [
      { ...proof, issuer: 'https://untrusted.example.test' }, { ...proof, redemptionId: randomUUID() },
      { ...proof, approved: true }, { ...proof, person: { ...proof.person, identityEpoch: 0 } },
      { ...proof, person: { ...proof.person, providerIssuer: 'http://identity.example.test' } },
      { ...proof, person: { ...proof.person, providerIssuer: 'https://user:password@identity.example.test' } },
      { ...proof, person: { ...proof.person, providerIssuer: 'https://identity.example.test/path' } },
    ]) await expect(verifier(() => json(value))(input)).rejects.toThrow('portal_proof_denied');
    const fetcher = vi.fn(async () => json(proof));
    await expect(createCompanyPortalProofVerifier({ fetch: fetcher, now: () => now })({ ...input, memberToken: 'secret' } as CompanyPortalRedeem)).rejects.toThrow('portal_proof_denied');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('uses a snapshot of target and handle while I/O is pending', async () => {
    const { input, proof } = fixture(); const original = structuredClone(input);
    let finish!: (reply: Response) => void;
    const pending = verifier(() => new Promise<Response>(resolve => { finish = resolve; }))(input);
    input.target.memberId = randomUUID(); input.proofHandle = 'c'.repeat(64);
    finish(json(proof)); const result = await pending;
    expect(assertVerifiedCompanyPortalProof(result, original, now)).toEqual(proof);
    expect(() => assertVerifiedCompanyPortalProof(result, input, now)).toThrow('portal_proof_denied');
  });

  it('does not cache a previously accepted proof or convert an expired deadline into a fresh one', async () => {
    const { input, proof } = fixture(); let clock = now;
    const fetcher = vi.fn(async () => json(proof));
    const verify = createCompanyPortalProofVerifier({ fetch: fetcher, now: () => clock });
    await verify(input); clock += 60_000;
    await expect(verify(input)).rejects.toThrow('portal_proof_stale'); expect(fetcher).toHaveBeenCalledTimes(2);
    const future = { ...proof, issuedAt: new Date(now + 1).toISOString() };
    await expect(verifier(() => json(future))(input)).rejects.toThrow('portal_proof_stale');
    const extended = { ...proof, expiresAt: new Date(now + 60_001).toISOString() };
    await expect(verifier(() => json(extended))(input)).rejects.toThrow('portal_proof_denied');
  });

  it('fails closed on slow streaming, excessive content, redirects, malformed JSON and failed requests', async () => {
    const { input, proof } = fixture();
    for (const response of [new Response('x'.repeat(16_385), { headers: { 'content-type': 'application/json' } }),
      new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '999999' } }),
      new Response(JSON.stringify(proof), { headers: { 'content-type': 'text/html' } }), new Response('not json', { headers: { 'content-type': 'application/json' } }),
      new Response(null, { status: 302, headers: { location: 'https://example.test' } }), new Response(null, { status: 503 }),
    ]) await expect(verifier(() => response)(input)).rejects.toThrow('portal_proof_unavailable');
    for (const [status, code] of [[403,'denied'],[401,'denied'],[409,'stale']] as const) await expect(verifier(() => new Response(null, { status }))(input)).rejects.toThrow(`portal_proof_${code}`);
    const cancel = vi.fn();
    const stalled = new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'content-type': 'application/json' } });
    await expect(createCompanyPortalProofVerifier({ fetch: vi.fn(async () => stalled), now: () => now, timeoutMs: 10 })(input)).rejects.toThrow('portal_proof_unavailable');
    expect(cancel).toHaveBeenCalledOnce();
    await expect(verifier(() => { throw new Error('private diagnostic'); })(input)).rejects.toThrow(/^portal_proof_unavailable$/);
  });

  it('keeps bridge proofs disjoint from remote worker approval protocols', () => {
    const { input, proof } = fixture();
    expect(isCompanyPortalIssue({ version: 1, requestId: randomUUID(), proofHandle: input.proofHandle, target: input.target })).toBe(true);
    expect(isCompanyPortalProof({ ...proof, target: { ...input.target, purpose: 'effect-admission' } })).toBe(false);
    expect(isCompanyPortalProof({ ...proof, protocol: 2 })).toBe(false);
    expect(isCompanyPortalProof({ ...proof, person: { ...proof.person, subject: '00000000-0000-7000-8000-000000000001' } })).toBe(true);
  });
});
