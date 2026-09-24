/**
 * RealBud operator bearer: the authority for operator-only routes such as
 * `POST /v1/operator/offices/ai-access`. Separate from the billing-owner portal
 * token (`portal-token.ts`) in both secret and claims:
 *
 *   - secret: `REALBUD_GATEWAY_OPERATOR_SECRET`, >=32 chars, never equal to
 *     `REALBUD_GATEWAY_PORTAL_SECRET` (the server refuses to compose operator
 *     routes otherwise);
 *   - claims: exactly `{subject: 'operator:<email>', role: 'realbud_operator',
 *     iat, exp}`, with a window of at most five minutes. No `companyId`: an
 *     operator is not scoped to one office.
 *
 * The wire format is portal-token.ts's (base64url claims, a dot, HMAC-SHA256 of
 * that payload). A portal token never verifies here (wrong role, has a
 * companyId) and an operator token never verifies as a portal token (wrong role,
 * no companyId), even under the same secret. Neither the secret nor a token is
 * ever logged.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { GatewayError, requireThat } from './contracts.ts';

export const OPERATOR_ROLE = 'realbud_operator';
/** The longest window a token may carry, iat to exp. */
export const OPERATOR_TOKEN_MAX_TTL_MS = 5 * 60_000;
const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;

export interface OperatorPrincipal { subject: string; role: typeof OPERATOR_ROLE }
interface OperatorClaims extends OperatorPrincipal { iat: number; exp: number }

export function signOperatorToken(email: string, secret: string, now = Date.now(), ttlMs = OPERATOR_TOKEN_MAX_TTL_MS): string {
  requireThat(secret.length >= 32, 'operator_secret_too_short');
  requireThat(typeof email === 'string' && email.length <= 254 && EMAIL.test(email), 'invalid_operator_email');
  requireThat(Number.isSafeInteger(now) && Number.isSafeInteger(ttlMs) && ttlMs > 0 && ttlMs <= OPERATOR_TOKEN_MAX_TTL_MS, 'invalid_operator_ttl');
  const claims: OperatorClaims = { subject: `operator:${email.toLowerCase()}`, role: OPERATOR_ROLE, iat: now, exp: now + ttlMs };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${createHmac('sha256', secret).update(payload).digest('base64url')}`;
}

/** The verified operator, or `operator_unauthenticated` (401) for anything else. */
export function verifyOperatorToken(token: string, secret: string, now = Date.now()): OperatorPrincipal {
  requireThat(secret.length >= 32, 'operator_unconfigured', 503);
  const fail = (): never => { throw new GatewayError('operator_unauthenticated', 401); };
  const parts = typeof token === 'string' ? token.split('.') : [];
  if (parts.length !== 2 || !parts[0] || !parts[1]) fail();
  const [payload, signature] = parts as [string, string];
  const expected = createHmac('sha256', secret).update(payload).digest();
  const given = Buffer.from(signature, 'base64url');
  if (!(given.length === expected.length && timingSafeEqual(given, expected))) fail();
  let claims: unknown;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { fail(); }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) fail();
  const c = claims as Record<string, unknown>;
  // Exactly these four claims. A portal token carries `companyId` and a billing
  // role, so it is refused here on two counts.
  if (Object.keys(c).sort().join(',') !== 'exp,iat,role,subject') fail();
  if (!(c.role === OPERATOR_ROLE && typeof c.subject === 'string' && c.subject.length <= 320 && c.subject.startsWith('operator:')
    && EMAIL.test(c.subject.slice('operator:'.length)))) fail();
  if (!(typeof c.iat === 'number' && Number.isSafeInteger(c.iat) && typeof c.exp === 'number' && Number.isSafeInteger(c.exp)
    && c.exp > now && c.iat <= now + 60_000 && c.exp > c.iat && c.exp - c.iat <= OPERATOR_TOKEN_MAX_TTL_MS)) fail();
  return { subject: c.subject as string, role: OPERATOR_ROLE };
}
