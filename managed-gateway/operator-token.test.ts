import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { signOperatorToken, verifyOperatorToken } from './operator-token.ts';
import { signPortalToken, verifyPortalToken } from './portal-token.ts';

const OPERATOR_SECRET = 'fictional-gateway-operator-secret-000001';
const PORTAL_SECRET = 'fictional-gateway-portal-secret-00000001';
const NOW = Date.parse('2026-09-24T00:00:00Z');
const forge = (claims: Record<string, unknown>, secret: string) => {
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
};

test('operator tokens round-trip with the operator subject and role, and expire', () => {
  const token = signOperatorToken('Ops@RealBud.example', OPERATOR_SECRET, NOW, 60_000);
  assert.deepEqual(verifyOperatorToken(token, OPERATOR_SECRET, NOW + 1_000), { subject: 'operator:ops@realbud.example', role: 'realbud_operator' });
  assert.throws(() => verifyOperatorToken(token, OPERATOR_SECRET, NOW + 60_000), /operator_unauthenticated/);
  assert.throws(() => verifyOperatorToken(token, 'another-fictional-operator-secret-00001', NOW + 1_000), /operator_unauthenticated/);
  assert.throws(() => verifyOperatorToken(`${token}x`, OPERATOR_SECRET, NOW + 1_000), /operator_unauthenticated/);
});

test('an operator token is at most five minutes long, at signing and at verification', () => {
  assert.throws(() => signOperatorToken('ops@realbud.example', OPERATOR_SECRET, NOW, 5 * 60_000 + 1), /invalid_operator_ttl/);
  assert.throws(() => signOperatorToken('not-an-email', OPERATOR_SECRET, NOW), /invalid_operator_email/);
  assert.throws(() => signOperatorToken('ops@realbud.example', 'short', NOW), /operator_secret_too_short/);
  const long = forge({ subject: 'operator:ops@realbud.example', role: 'realbud_operator', iat: NOW, exp: NOW + 5 * 60_000 + 1 }, OPERATOR_SECRET);
  assert.throws(() => verifyOperatorToken(long, OPERATOR_SECRET, NOW + 1), /operator_unauthenticated/);
  const extra = forge({ subject: 'operator:ops@realbud.example', role: 'realbud_operator', iat: NOW, exp: NOW + 60_000, companyId: 'company-a' }, OPERATOR_SECRET);
  assert.throws(() => verifyOperatorToken(extra, OPERATOR_SECRET, NOW + 1), /operator_unauthenticated/);
  const bareSubject = forge({ subject: 'ops@realbud.example', role: 'realbud_operator', iat: NOW, exp: NOW + 60_000 }, OPERATOR_SECRET);
  assert.throws(() => verifyOperatorToken(bareSubject, OPERATOR_SECRET, NOW + 1), /operator_unauthenticated/);
});

test('a portal token never verifies as an operator, even under the same secret', () => {
  for (const role of ['billing_owner', 'billing_reader'] as const) {
    const portal = signPortalToken({ subject: 'operator:ops@realbud.example', companyId: 'company-a', role }, OPERATOR_SECRET, NOW, 60_000);
    assert.throws(() => verifyOperatorToken(portal, OPERATOR_SECRET, NOW + 1), /operator_unauthenticated/);
  }
  const portal = signPortalToken({ subject: 'user-a', companyId: 'company-a', role: 'billing_owner' }, PORTAL_SECRET, NOW, 60_000);
  assert.throws(() => verifyOperatorToken(portal, OPERATOR_SECRET, NOW + 1), /operator_unauthenticated/);
});

test('an operator token never verifies as a portal token, even under the same secret', () => {
  const same = signOperatorToken('ops@realbud.example', PORTAL_SECRET, NOW, 60_000);
  assert.throws(() => verifyPortalToken(same, PORTAL_SECRET, NOW + 1), /unauthenticated/);
  const own = signOperatorToken('ops@realbud.example', OPERATOR_SECRET, NOW, 60_000);
  assert.throws(() => verifyPortalToken(own, PORTAL_SECRET, NOW + 1), /unauthenticated/);
});
