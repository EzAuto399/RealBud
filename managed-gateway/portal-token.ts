/** Shared HMAC portal bearer tokens between the website BFF and managed-gateway. */
import { createHmac, timingSafeEqual } from "node:crypto";
import { requireThat, type PortalPrincipal } from "./contracts.ts";

export type PortalTokenClaims = PortalPrincipal & { exp: number; iat: number };

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf)
    .toString("base64url")
    .replace(/=+$/, "");
}

export function signPortalToken(
  principal: PortalPrincipal,
  secret: string,
  now = Date.now(),
  ttlMs = 5 * 60_000,
): string {
  requireThat(secret.length >= 32, "portal_secret_too_short");
  const claims: PortalTokenClaims = {
    ...principal,
    iat: now,
    exp: now + ttlMs,
  };
  const payload = b64url(JSON.stringify(claims));
  const sig = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function verifyPortalToken(
  token: string,
  secret: string,
  now = Date.now(),
): PortalPrincipal {
  requireThat(secret.length >= 32, "portal_secret_too_short");
  const [payload, sig] = token.split(".");
  requireThat(payload && sig, "unauthenticated", 401);
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(sig, "base64url");
  requireThat(
    given.length === expected.length && timingSafeEqual(given, expected),
    "unauthenticated",
    401,
  );
  let claims: PortalTokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    requireThat(false, "unauthenticated", 401);
  }
  requireThat(
    typeof claims.exp === "number" &&
      typeof claims.iat === "number" &&
      claims.exp > now &&
      claims.iat <= now + 60_000,
    "unauthenticated",
    401,
  );
  requireThat(
    typeof claims.subject === "string" &&
      typeof claims.companyId === "string" &&
      (claims.role === "billing_owner" || claims.role === "billing_reader"),
    "unauthenticated",
    401,
  );
  return {
    subject: claims.subject,
    companyId: claims.companyId,
    role: claims.role,
  };
}
