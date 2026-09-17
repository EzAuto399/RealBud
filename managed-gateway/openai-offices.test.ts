import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './testing.ts';
import { canonical } from './contracts.ts';
import { OpenAIOffices } from './openai-offices.ts';
import type { OpenAICostsSnapshot } from './openai-costs.ts';

test('OpenAI office key maps to a tenant; monthly USD becomes after-margin AUD; portal never sees wholesale', () => {
  const f = fixture();
  try {
    const offices = new OpenAIOffices(f.ledger);
    offices.mapKey({
      id: 'map-office-a',
      companyId: f.tenant.companyId,
      apiKeyId: 'key_abc123xyz',
      startsAt: Date.parse('2026-06-01T00:00:00Z'),
      endsAt: Date.parse('2027-01-01T00:00:00Z'),
      evidence: 'operator-created-key',
    });
    offices.recordPolicy({
      version: 'openai-policy-a',
      companyId: f.tenant.companyId,
      fxNumerator: '3',
      fxDenominator: '2',
      fxSource: 'fixture-fx',
      method: 'margin',
      basisPoints: 2000,
      apply: true,
    });
    const snapshot: OpenAICostsSnapshot = {
      startTime: 1750000000,
      endTime: 1750600000,
      currency: 'USD',
      updatedAt: f.now(),
      buckets: [
        {
          startTime: Math.floor(Date.parse('2026-08-15T00:00:00Z') / 1000),
          endTime: Math.floor(Date.parse('2026-08-16T00:00:00Z') / 1000),
          totalUsd: '0.06000000',
          byApiKeyId: { key_abc123xyz: '0.06000000' },
        },
      ],
    };
    const preview = offices.previewMonth(snapshot, '2026-08', { [f.tenant.companyId]: 'openai-policy-a' });
    assert.equal(preview.lines.length, 1);
    assert.equal(preview.lines[0]!.status, 'ready');
    assert.equal(preview.lines[0]!.included, false);
    assert.equal(preview.lines[0]!.chargedNanoAud, preview.lines[0]!.retailNanoAud);
    const customer = canonical(offices.customerPreview(f.owner, preview));
    assert(!customer.includes('0.06'));
    assert(!customer.includes('key_abc'));
    assert(!customer.includes('basisPoints'));
    assert(!customer.includes('USD'));
    const committed = offices.commitMonth(snapshot, '2026-08', { [f.tenant.companyId]: 'openai-policy-a' }, preview.previewDigest);
    assert.equal(committed.duplicate, false);
    f.setTime(Date.parse('2026-09-16T00:00:00Z'));
    const invoice = f.billing.finalizeLocalInvoice(f.tenant.companyId, '2026-08', 'agreed-care');
    assert.equal(invoice.lines.some((l) => l.model === 'openai'), true);
    assert(BigInt(invoice.totalCents) > 0n);
    const listed = f.billing.portalInvoices(f.owner);
    assert.equal(listed[0]!.paid, false);
    assert(!canonical(listed).includes('key_abc'));
    assert(!canonical(listed).includes('0.06000000'));
  } finally {
    f.close();
  }
});

test('office policy can skip margin (GST-only) without leaking % to the customer preview', () => {
  const f = fixture();
  try {
    const offices = new OpenAIOffices(f.ledger);
    offices.mapKey({
      id: 'map-office-pass',
      companyId: f.tenant.companyId,
      apiKeyId: 'key_abc123xyz',
      startsAt: Date.parse('2026-06-01T00:00:00Z'),
      endsAt: Date.parse('2027-01-01T00:00:00Z'),
      evidence: 'operator-created-key',
    });
    offices.recordPolicy({
      version: 'openai-policy-pass',
      companyId: f.tenant.companyId,
      fxNumerator: '3',
      fxDenominator: '2',
      fxSource: 'fixture-fx',
      method: 'margin',
      basisPoints: 2000,
      apply: false,
    });
    const snapshot: OpenAICostsSnapshot = {
      startTime: 1750000000,
      endTime: 1750600000,
      currency: 'USD',
      updatedAt: f.now(),
      buckets: [
        {
          startTime: Math.floor(Date.parse('2026-08-15T00:00:00Z') / 1000),
          endTime: Math.floor(Date.parse('2026-08-16T00:00:00Z') / 1000),
          totalUsd: '0.06000000',
          byApiKeyId: { key_abc123xyz: '0.06000000' },
        },
      ],
    };
    const preview = offices.previewMonth(snapshot, '2026-08', { [f.tenant.companyId]: 'openai-policy-pass' });
    assert.equal(preview.lines[0]!.retailNanoAud, '99000000');
    const customer = canonical(offices.customerPreview(f.owner, preview));
    assert(!customer.includes('apply'));
    assert(!customer.includes('basisPoints'));
    assert(!customer.includes('2000'));
    assert(!customer.includes('USD'));
  } finally {
    f.close();
  }
});
