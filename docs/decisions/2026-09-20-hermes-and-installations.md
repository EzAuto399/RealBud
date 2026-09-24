# Hermes identity and website installation links

Status: implemented and verified locally; hosted rollout pending. Scope: desktop worker integration and an account portal inventory. No deployment or customer rollout is implied.

## Decision

Keep the reviewed, unmodified Hermes release mechanism (recommended 0.21.3) and existing ACP approval broker. One authenticated member selects one private Hermes profile for setup, OAuth, readiness, Ask, scheduled work and connected apps. Freeze that selection for each asynchronous operation. Restore saved identity before listening or resuming work. A missing profile needs setup; never copy another member's credentials to make it appear ready. An existing desktop data directory cannot be rebound to another person.

Use an account-owner-issued, short-lived pairing code to associate a desktop installation with a website office. The desktop creates its own random installation credential and persists it before redemption, making a lost response recoverable. The website stores only hashes. Redemption and revocation are transactional and company-scoped; disabled accounts cannot issue or redeem links. Reporting includes application/worker versions, readiness and timestamps, never prompts, documents, customer records or provider keys. Link status is separate from worker readiness and billing entitlements.

The website may show installations and revoke their reporting link. It does not execute remote commands, grant local service administration, provision model access or claim a device is currently online from old telemetry. Remote execution would require a separate authenticated command and approval protocol.

## Alternatives

A shared profile is simpler but mixes private memory and credentials. Passing a mutable global member into every helper can change identity mid-operation; an async scope instead freezes it. An open desktop port or browser-to-localhost bridge complicates origin, session and network boundaries; outbound reporting keeps the desktop API local. A reusable office secret cannot safely express one-device revocation; individual installation credentials can.

## Validation

Synthetic worker tests must cover concurrent members, setup/argv/fingerprint agreement, warm-process replacement and no base-profile fallback. Installation tests must cover response loss, expiry, duplicate redemption, cross-office and disabled-account access, revocation, stale reporting and safe persistence. Build/type checks cover both repositories; inspect desktop and portal layouts. Live database migration, hosted deployment, installer delivery and customer acceptance remain separate gates.

## Verification receipt — 20 September 2026

- Existing configured RealBud runtime: Hermes 0.21.3, clean checkout at `345cd2b057a452236de401d3534b8502a7465e8d` (the reviewed release tag). Read-only version/source verification; no runtime replacement or paid model call.
- Full desktop suite: 230 files passed, 9 skipped; 2,632 tests passed, 86 skipped. Subsequent focused suites cover the final OAuth, identity, reporting and recovery changes (128 then 19 tests passed). Tests that require additional external conditions remain skipped in the broad run.
- Actual local PostgreSQL company-host/second-client tests: 11 tests passed with `REALBUD_TEST_POSTGRES=1`. This includes the existing encrypted joining contract plus saved-identity recovery.
- Built-server two-seat script passed: separate profile argv and send restrictions on both processes. Server compiler/bundler passed after final changes.
- Website tests: 11 passed. A separate disposable PostgreSQL test passed owner/reader and office isolation, one-use redemption, response-loss replay, expiry, concurrent redemption, disabled accounts, revocation, RLS and RPC grants.
- Desktop production build, website production build and final desktop type checks passed. New website files pass lint. Global website lint still has two pre-existing failures: render-time Date.now in account/page.tsx and a home link in app/page.tsx.
- Browser QA exercised the real local Next account routes against a fictional Supabase API: account filtering, code creation, revocation, unauthenticated/cross-origin rejection, reader mutation denial, disabled account denial, malformed redemption and missing report credentials. Desktop UI linking used a synthetic response; the actual private-file/retry/report transport is covered by its server tests.
- Visually inspected 1365px desktop and 390px mobile, light/dark. Fixed hidden mobile account navigation. Images are in `outputs/hermes-installations-2026-09-20/`. No browser runtime errors.
- `scripts/qa-installations-ui.mjs` reproduces browser checks with a supplied PLAYWRIGHT_MODULE; `website/scripts/test-installations-postgres.mjs` reproduces database checks with a local PostgreSQL binary directory.

## Remaining live gates

The subsequent [solo/local-office review](../SOLO-AND-LOCAL-OFFICE-REVIEW-2026-09-20.md)
also identifies product lifecycle gates: same-person private Bud continuity on
joining, resumable enrollment, leaving/disconnecting, member management and host
backup/restore. The isolation implemented here is a necessary boundary; it does
not yet make those transitions seamless. That review records the local host-ID
validation fix, clearer settings and the proposed stable workspace identity.

Apply the website Supabase migration, deploy the website and deliver the desktop build before the new website account link is available to customers. Then verify pairing, reporting and revocation from installed devices against the deployed office, including a second office and reader account. No migration, deployment, installer replacement, customer-data access or live model task was performed in this work.

The separate managed AI routing service and service entitlement/provisioning work are still separate integration gates. A reporting link does not complete them. Remote task submission, approval and delivery through the website is not implemented by this protocol; its contract needs to be designed independently before the website can operate a desktop.
