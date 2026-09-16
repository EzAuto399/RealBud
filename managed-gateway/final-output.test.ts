import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './testing.ts';
import { verifyGrant } from './auth.ts';
import type { ExecutionAuthority, ModelRequest, ProviderAdapter } from './contracts.ts';

for (const boundary of ['after_final_usage', 'between_final_callbacks'] as const) {
  for (const invalidation of ['issuer_revocation', 'grant_expiry', 'lease_revocation', 'lease_abort', 'client_abort'] as const) {
    test(`${invalidation} ${boundary}: no later output, incurred usage settled once, no inference replay`, async () => {
      const f = fixture();
      try {
        const request: ModelRequest = { ...f.request, protocol: 'tools-v1', tools: [], thinking: 'enabled' };
        const grant = f.grant(request, {
          schema: 2, grantVersion: 2, modelCallId: 'final-output-call',
          maxAttemptSpendNanoAud: '1000000000', attemptExpiresAt: f.now() + 120000,
          provider: f.provider.usageNamespace,
          allowedModels: [{ provider: f.provider.usageNamespace, model: request.model, capabilities: ['text'] }],
        });
        const client = new AbortController(), leaseSignal = new AbortController();
        let current = true, invalidated = false, calls = 0, released = 0;
        const invalidate = () => {
          invalidated = true;
          if (invalidation === 'issuer_revocation') f.ledger.revokeIssuer('fixture-host-key');
          if (invalidation === 'grant_expiry') f.setTime(grant.exp);
          if (invalidation === 'lease_revocation') current = false;
          if (invalidation === 'lease_abort') leaseSignal.abort(new Error('lease_revoked'));
          if (invalidation === 'client_abort') client.abort(new Error('client_cancelled'));
        };
        const authority: ExecutionAuthority = {
          async acquire() { return {
            signal: leaseSignal.signal,
            async assertCurrent() { if (!current) throw new Error('lease_revoked'); },
            async release() { released++; },
          }; },
        };
        const provider: ProviderAdapter = { ...f.provider, async *stream() {
          calls++;
          yield { type: 'continuation', message: { role: 'assistant', content: 'PRIVATE_SYNTHETIC_CONTINUATION', reasoning_content: 'SYNTHETIC_REASONING' } };
          yield { type: 'usage', evidence: f.evidence() };
          if (boundary === 'after_final_usage') invalidate();
        } };
        const gateway = f.gateway(provider, authority), events: string[] = [];
        let forbiddenCalls = 0;
        await assert.rejects(gateway.execute(f.envelope(grant), request, async event => {
          if (invalidated) forbiddenCalls++;
          events.push(event.type);
          if (event.type === 'continuation' && boundary === 'between_final_callbacks') invalidate();
        }, client.signal));
        assert.equal(invalidated, true);
        assert.equal(forbiddenCalls, 0, 'a forbidden callback must never be invoked, even if its promise is later rejected');
        assert.deepEqual(events, boundary === 'after_final_usage' ? ['reserved'] : ['reserved', 'continuation']);
        const stored = f.ledger.requests('company-a')[0];
        assert.equal(stored.state, 'settled');
        assert.equal(stored.chargedNanoAud, '19250000');
        assert.deepEqual(stored.units, f.evidence().units);
        assert.equal(f.ledger.exposure('company-a', stored.period), 19250000n);
        assert.equal(released, 1);
        // A fresh transport retry may be denied or recover the existing receipt; it never infers again.
        await gateway.execute(f.envelope(grant), request, async () => {}, new AbortController().signal).catch(() => {});
        assert.equal(calls, 1);
        assert.equal(f.db.all("SELECT seq FROM events WHERE kind='usage_settled'").length, 1);
        f.db.verify();
      } finally { f.close(); }
    });
  }
}

test('cancellation inside the final authority check never eagerly invokes the output callback', async () => {
  const f = fixture(), client = new AbortController();
  try {
    let finalCheck = false;
    const authority: ExecutionAuthority = { async acquire() { return {
      signal: new AbortController().signal,
      async assertCurrent() {
        if (f.ledger.requests('company-a').some(r => r.state === 'settled')) {
          finalCheck = true;
          client.abort(new Error('cancelled_during_final_check'));
        }
      },
      async release() {},
    }; } };
    const events: string[] = [];
    await assert.rejects(f.gateway(f.provider, authority).execute(f.envelope(), f.request, async event => { events.push(event.type); }, client.signal));
    assert.equal(finalCheck, true);
    assert.deepEqual(events, ['reserved', 'delta']);
    assert.equal(f.ledger.requests('company-a')[0].state, 'settled');
  } finally { f.close(); }
});

test('cancellation after invalid usage retains its reservation instead of recording fabricated settlement', async () => {
  const f = fixture(), client = new AbortController();
  try {
    const provider: ProviderAdapter = { ...f.provider, async *stream() {
      yield { type: 'usage', evidence: f.evidence({ units: { input_tokens: 1.5 } }) };
      client.abort(new Error('cancelled_after_bad_usage'));
    } };
    await assert.rejects(f.gateway(provider).execute(f.envelope(), f.request, async () => {}, client.signal));
    const stored = f.ledger.requests('company-a')[0];
    assert.equal(stored.state, 'unknown');
    assert.equal(stored.chargedNanoAud, '0');
    assert.equal(f.ledger.exposure('company-a', stored.period), 165000000n);
  } finally { f.close(); }
});

for (const schema of ['1', '2']) test(`string schema/grantVersion ${schema} is rejected before v2 validation can be bypassed`, () => {
  const f = fixture();
  try {
    const malformed = f.grant(f.request, { schema, grantVersion: schema } as never);
    assert.throws(() => verifyGrant(f.envelope(malformed), f.request, f.ledger), /invalid_grant_scope/);
  } finally { f.close(); }
});
