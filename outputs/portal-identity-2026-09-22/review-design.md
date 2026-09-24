# Independent stable portal identity review — 2026-09-22

Scope: read-only review of the existing email-session boundary and the proposed persisted identity seam. No customer/provider data accessed; no deployment. Implementation findings remain pending until actual source review.

## Required adversarial checks

1. First binding reserves both immutable provider subject and one account. Two concurrent subjects with the same verified email cannot each bind the same account. Duplicate normalized account emails reject admission. Company/account provisioning that races binding must yield a coherent binding or denial, never mixed snapshots.
2. Later login/resolution follows the saved subject mapping. Reused email, a recreated provider subject, or a moved account cannot adopt a different person's authority. Missing mapping is not permission to recreate under the old person's ID. Identity incarnation cannot be recreated by delete/reinsert under a reused account key.
3. Email/company/role/disable changes advance identity epoch at database authority. Direct service-role writes as well as provisioning RPC are covered. A→B→A, disable→enable, and delete→reinsert leave previous session/grant identity invalid.
4. Signed v2 objects admit exact bounded identity fields; unknown/malformed version rejects. A failed current-v2 resolution cannot fall through to legacy email lookup. A failed callback bind cannot create a legacy cookie. Legacy cookies remain unable to obtain the new person authority.
5. Service-only binding/resolution RPCs enforce strict parameters, locked current account state, schema qualification and search_path. Table/RPC grants deny public, anon and authenticated reads/writes/execution. A database lookup failure returns bounded no-store responses without identity/credential disclosures.
6. The callback requires supported OTP type, verified immutable provider user identity, and confirmed email. No browser subject/account/company fields are trusted. Only an opaque subject from successful provider authentication feeds binding.
7. Current identity lookup is not the future remote action authorization transaction. Enabling remote actions later must repeat current identity/account epoch checks under the actual effect/claim transaction; an earlier successful gate cannot survive account revocation during awaited work.

## Existing boundaries that must remain explicit

Existing legacy command/install SQL still compares billing email. This feature is a stable identity foundation for future attended enrollment and does not retroactively prove all portal actions are stable-identity authorized. Billing role alone must not become remote execution or private workspace approval permission.

Evidence source: website/lib/session.ts, website/lib/portal-auth.ts, website/lib/billing-accounts.ts, website/lib/db.ts, website/app/auth/callback/route.ts, website/drizzle/0001_billing_accounts.sql, website/supabase/migrations/202609220001_installation_commands.sql, and preserved remote-approval-next-plan.md. No code edits made by reviewer.
