# Portal person SQL implementation — 2026-09-22

The additive migration implements the agreed two service-role RPCs against the existing PostgreSQL billing schema. It has **not** been applied to any deployed database. The test database matches the billing account primary key, required provisioning fields, nonunique email index and existing service-role billing reads/mutations.

`realbud_portal_person_login(text,text,text)` accepts the trusted server's configured provider origin, verified provider UUID and verified normalized email. A first verified login can bind exactly one preprovisioned account. All matching normalized email rows count, including disabled rows; ambiguity is rejected. The binding is permanent. Later email reuse cannot reassign that provider identity. The callback is responsible for actual provider verification before calling this RPC.

`realbud_require_portal_person(uuid,text,text,text,text,bigint)` checks the permanent subject, issuer/provider, current account/company and identity epoch. It returns the current bounded person document. This is billing identity only and creates no remote approval, workspace or execution grant.

Every billing row has a new stable UUID subject and positive JavaScript-safe identity epoch. Email, company, role and disable transitions increment the epoch, including A-to-B-to-A transitions. Direct epoch reset, subject change and account primary-key change are rejected. Agency label updates do not change authority. Historical billing reads remain compatible; invalid legacy provisioning cannot bind a person until repaired.

An immutable subject/account registry and immutable provider-binding table outlive billing-account deletion. Recreating an account produces a new subject; explicitly reusing a historical subject is rejected. The old provider mapping remains a tombstone and cannot become attached to the replacement row. Registration occurs AFTER INSERT so an ordinary provisioning upsert does not create unused permanent registry rows.

Statement-level advisory locking runs before billing row locks and serializes login/assertion with provisioning and identity changes. RPCs explicitly require READ COMMITTED, the PostgREST default: a repeatable-read snapshot must not preserve authority from before a lock wait. Future atomic effect RPCs must recheck identity in their own properly designed transaction; a separate earlier HTTP/RPC identity assertion is not an atomic authorization of later effects.

All relation references are qualified and all functions use fixed `pg_catalog, public` search paths. Identity tables enable RLS and deny direct access to public/anon/authenticated/service_role. Helper functions also revoke those roles, including explicit service-role grants that may originate from Supabase defaults. Only the two intended security-definer RPCs grant service-role execution. Billing triggers continue to protect direct service-role account updates. Superuser/migration-owner privilege remains administrative trust, as for the existing schema.

Bounded errors are `portal_identity_not_provisioned` (only valid fresh provider, no existing binding and zero matching accounts), `portal_identity_conflict`, `portal_identity_stale`, and `portal_identity_unavailable`. Disabled accounts, old mappings and malformed provisioning cannot enter the unprovisioned-operator fallback. Exact error messages contain no provider/account values.

## Verification

Final frozen source passed **110 assertions** on Node 24.19.0 and disposable PostgreSQL 16.15. The database listened only on a private Unix socket and was stopped and removed afterward. There were no provider, customer, external network or deployment effects.

Tests exercise first binding, immutable issuer/provider mapping, normalized duplicate email rejection, reader/owner state, email/company/role/disabled ABA, direct tampering, delete/recreate tombstones, same-provider replay, competing providers, one provider racing across two accounts, first-binding rollback, no-op upsert, bounded-document rejection without a persisted binding, non-ASCII/UTF16 boundaries, RLS and execution grants.

For rename, disable and concurrent duplicate provisioning, tests hold an actual transaction, observe the competing PostgreSQL backend waiting on the advisory lock, then commit the held mutation and verify rejection. A separate held repeatable-read snapshot taken before disabling an account is rejected. These checks do not infer concurrency merely from two promises being started.

Final SHA-256:

- Migration: `17d9df75b244cb13e356ccfff3c27591aaf7a38aec0f0c4ce003d671cb79904d`
- Test harness: `9b2ffe0e9c867938f86a0fffea1caf422ba8033baa3ac1e1f7fc488c7c143cb0`

Machine evidence: `sql-verification.json`; raw successful result: `sql-tests.log`. Parent-owned real Next/HTTP/browser integration is separate evidence.
