# Remote approver enrollment SQL — 2026-09-22

The additive migration implements protocol 2 parent enrollment and attended, two-party approver enrollment. It creates **no remote execution, request publication or claim path**. Disclosure digests pin separately reviewed local templates; no template text, provider credentials or raw challenge secret is stored here.

All new RPCs are service-role-only security-definer entry points. The internal enrollment table enables RLS and denies direct public, anon, authenticated and service-role access. Internal helpers revoke those roles too, including explicit Supabase default service-role grants. New functions use fixed `pg_catalog, public` search paths and schema-qualified relation references.

## Frozen RPC signatures

- `realbud_enroll_remote_commands(p_report_hash text, p_command_hash text, p_spec jsonb)` returns `RemoteCommandGrant`. `p_spec` is the shared parent enrollment document without `commandToken`; the website passes its hash separately.
- `realbud_revoke_remote_commands(p_hash text, p_grant uuid, p_generation integer)` returns the exact revoked `RemoteCommandGrant` on retry.
- `realbud_remote_enrollment_clock(p_hash text, p_grant uuid, p_generation integer)` returns `{serverTime}` only for a currently admitted protocol 2 parent. New challenges calibrate deadlines from this clock; a retry retains its original begin body and deadlines.
- `realbud_remote_enrollment_begin(p_hash text, p_body jsonb)` accepts `RemoteEnrollmentBegin`.
- `realbud_remote_enrollment_status(p_hash text, p_body jsonb)` and `realbud_remote_enrollment_revoke(p_hash text, p_body jsonb)` accept `RemoteEnrollmentTarget`.
- `realbud_remote_enrollment_confirm(p_hash text, p_body jsonb)` accepts `RemoteEnrollmentConfirm`, including the complete exact public candidate snapshot.
- `realbud_remote_enrollment_accept(p_actor jsonb, p_body jsonb)` accepts the exact body `{protocol: 2, enrollmentId, challengeHash}`. The trusted website hashes the supplied challenge secret before calling SQL.
- `realbud_remote_enrollment_person_revoke(p_actor jsonb, p_enrollment uuid)` permits a currently authenticated person to revoke their own prior enrollment, including an old stale epoch.
- `realbud_remote_enrollment_person_list(p_actor jsonb)` returns `{enrollments: RemoteEnrollmentSnapshot[], serverTime}`, bounded to 64 of the same subject/account/company's enrollments.

The five target RPCs, accept and self-revoke return `RemoteEnrollmentSnapshot`, including `target: {workspaceLabel, descriptors}`. `p_actor` is exactly the trusted server binding `{subject, providerIssuer, providerSubject, accountId, companyId, identityEpoch, authenticatedAt}` with the final field in epoch milliseconds. SQL rechecks the stable provider identity inside the effect transaction. Acceptance additionally requires authentication within ten minutes, evaluated **after** lock acquisition; self-revoke/list require current identity but do not require a new ten-minute login.

Wrong/unknown challenges return the bounded committed sentinel `{error: 'remote_challenge_denied'}`. The route must translate this to a denial. Raising after incrementing would roll back the attempt counter, so this branch deliberately returns. Five wrong attempts prevent further acceptance. Wrong spent challenges cannot invalidate an already confirmed approver. Cross-company attempts reveal no target and do not increment the other office's counter.

Other bounded failures are `invalid_remote_input`, `invalid_remote_grant`, `remote_enrollment_conflict`, `remote_enrollment_capacity`, `remote_protocol_required`, and existing `portal_identity_*` codes. Valid target status can instead return `stale`, `revoked` or `expired`; confirmation in those states returns that snapshot without creating a grant.

## Authority and recovery

Every new transaction obtains the global identity advisory lock before company, installation, account, parent and enrollment locks. Existing command account/enrollment/authority/revoke paths now obtain that global lock first too, avoiding an inverted company/identity ordering. New RPCs require READ COMMITTED so a pre-wait snapshot cannot preserve old identity.

The parent is stored in the existing command grant table with an immutable protocol 2 specification, worker binding, fresh command credential and monotonically increasing generation. A currently active legacy parent must be revoked before switching. Historical protocol 2 presence permanently prevents legacy enrollment for that installation/workspace, even after revocation. A new parent must use a new credential and higher generation.

Legacy submit, authority, claim, ack, poll, cancel, revoke and inventory paths reject or omit protocol 2 before replay or emission. Even a misrouted protocol 2 envelope under a legacy parent is excluded. Ordinary protocol 1 work remains functional on a workspace that has never opted into protocol 2.

Begin fixes the challenge and approver expiry, admits at most ten minutes and thirty days respectively, checks exact descriptor/revision scope against the parent and caps retained enrollment rows at 64 per parent. A person also has a 64-row admission bound matching their inventory. Acceptance records a verified candidate only. Local confirmation requires the exact candidate snapshot and appends a separate approver grant whose ID is the enrollment ID and generation is 1. Renewal uses a new immutable enrollment ID and requires revocation or expiry of the prior approver for that parent/person. Identical retries return the same persisted grant and expiry.

Disable/re-enable, company reassignment and other identity epoch changes keep old enrollment stale. Parent or installation revocation and challenge/approver expiry also hold the authority. A currently authenticated same person may self-revoke their old epoch; that operation cannot reactivate it. Timestamps are captured after locks so concurrent confirmation followed by revoke cannot produce a revocation earlier than enrollment.

## Verification

The final candidate passed **153 assertions** on Node 24.19.0 and disposable PostgreSQL 16.15, with no TCP listener, external network, customer/provider calls or deployed mutation. All owned database/process fixtures were stopped and removed.

Tests cover exact retries, scope mismatch, target presentation, wrong/cross-company/report credentials, freshness, competing-person acceptance, same-person acceptance and confirmation races, durable challenge failure counts, spent challenge behavior, self-revoke and renewal, identity disable/company ABA, challenge expiry, protocol isolation before legacy replay, monotonic renewal, legacy operation on an untouched workspace, capacity, RLS and helper permission denial. Returned parent/snapshot documents are checked with the actual shared TypeScript validators.

Three cases inspect actual PostgreSQL backend advisory-lock waiting: identity disable before accept; freshness expiration during the wait; and revoke beginning before another held transaction confirms and commits. The latter checks `revokedAt >= enrolledAt`. This is stronger than simply starting two promises concurrently.

Candidate SHA-256:

- Migration: `172f2dc4ba95d01ffa74e81428599031238bb0ed85ebe8cd816a563d08a3ab07`
- Test: `b3490e0c3f15da3f43ff5538a7b0379909b318f7b54db8677f6e140562588ce7`
- Shared contract tested: `fc7b4c2f3f0a0e85d0e7cc16a98dcac74ba44743d5ff261d51c1bb926f828c71`

Machine evidence: `sql-verification.json`; raw result: `sql-tests.log`. Website, actual HTTP/browser and desktop lifecycle evidence are separate parent-owned checks.

## Clock and exact freshness follow-up

The authenticated clock RPC prevents a fast client clock from extending requested TTL past the authoritative server bound. No maximum TTL was relaxed. Tests use the returned clock to construct a challenge and verify later clock calls and begin replay preserve the original deadline; report credentials, cross-company credentials, wrong generations, revoked parents/installations and public calls cannot obtain it.

Independent review found SQL accepted authentication exactly 600,000 milliseconds old while the website rejected that age. A test temporarily replaces the built-in clock only inside the disposable PostgreSQL fixture, runs the exact boundary and restores the original built-in definition in `finally`. The old implementation reproduced the failure in `sql-freshness-boundary-red.log`. The final implementation rejects age 600,000 and accepts 599,999, while the separate real lock-wait test still exercises elapsed time using the ordinary clock.

The earlier 127-assertion receipt, log and report remain preserved as `sql-127-*`; this 140-assertion receipt supersedes their source hashes.

## Observed stale authority is terminal

The enrollment now records a private `stale_at` when a snapshot first observes invalid authority. This update occurs while the existing identity/parent transaction locks are held. It preserves candidate/approver history and adds no field to the public document. All subsequent status, acceptance replay, confirmation replay and personal inventory remain stale even if a display label returns to its previous value or another sole billing owner is re-enabled. Explicit revocation remains available; reactivation requires a new attended enrollment. A future execution claim must respect the enrollment's latched state rather than infer authority from the retained historical approver document alone.

The final 153-assertion run proves both label A-to-B-to-A and separate sole-owner disable/re-enable with an unchanged reader identity. It checks person-list and desktop-status consistency, confirms that an exact old confirmation/acceptance does not reactivate, and verifies self-revocation still works. The earlier 140-assertion receipt/log/report are preserved as `sql-140-*`.
