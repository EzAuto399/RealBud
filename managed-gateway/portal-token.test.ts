import { test } from "node:test";
import assert from "node:assert/strict";
import { signPortalToken, verifyPortalToken } from "./portal-token.ts";

test("portal tokens round-trip and expire", () => {
  const secret = "x".repeat(32);
  const now = Date.parse("2026-09-16T00:00:00Z");
  const token = signPortalToken(
    { subject: "user_abc", companyId: "company-a", role: "billing_owner" },
    secret,
    now,
    60_000,
  );
  const principal = verifyPortalToken(token, secret, now + 1_000);
  assert.equal(principal.companyId, "company-a");
  assert.equal(principal.role, "billing_owner");
  assert.throws(() => verifyPortalToken(token, secret, now + 120_000));
  assert.throws(() => verifyPortalToken(token, "y".repeat(32), now + 1_000));
});
